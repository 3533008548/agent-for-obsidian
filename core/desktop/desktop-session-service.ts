import {
  AgentSessionStore,
  applyProfileMemorySuggestions,
  buildAgentMemoryContext,
  buildAgentProfileSkeleton,
  getAgentProfilePath,
  removeProfileMemorySuggestions,
  renderNewAgentSession,
  renderSessionExchange,
  type ProfileMemoryCategory,
  type AgentMemoryContext,
  type AgentSession,
  type AgentSessionStoreState
} from "../memory/agent-memory";
import {
  conversationLogPath,
  parseConversationLog,
  renderCapturePatch,
  renderTurnLine,
  type ConversationCapture,
  type ConversationLogMode,
  type ConversationLogTurn
} from "../memory/conversation-log";
import type { DesktopAgentSource } from "./desktop-agent-service";
import {
  appendAssistantStateAction,
  buildAssistantStateSkeleton,
  getAssistantStatePath,
  setAssistantFocus
} from "../memory/assistant-state";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

const DEFAULT_MEMORY_FOLDER = "00 Inbox/Agent";

export class DesktopSessionService {
  private readonly store: AgentSessionStore;
  /** Last turn written in this process, so a capture can be filed against it. */
  private lastTurnId: string | null = null;

  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    state: AgentSessionStoreState = {},
    private readonly memoryFolder = DEFAULT_MEMORY_FOLDER
  ) {
    this.store = new AgentSessionStore(state);
  }

  get activeSession(): AgentSession | null {
    return this.store.getActive();
  }

  get state(): AgentSessionStoreState {
    return this.store.toJSON();
  }

  /**
   * Opens a session if none is active — the conversation itself now starts one.
   *
   * Sessions used to exist only after the user asked for one, and everything
   * said before that was dropped: `appendExchange` had nothing to append to and
   * returned silently, so weeks of conversation left no trace on disk.
   */
  async ensureSession(defaultTitle: string): Promise<AgentSession> {
    const active = this.store.getActive();
    if (active) {
      return active;
    }
    return this.createSession(defaultTitle);
  }

  async createSession(title: string): Promise<AgentSession> {
    const session = this.store.create(title, this.memoryFolder);
    await this.repository.createText(session.path, renderNewAgentSession(session));
    return this.store.activate(session);
  }

  closeSession(): AgentSession | null {
    return this.store.closeActive();
  }

  /**
   * Records one exchange in both forms.
   *
   * The transcript lines up with what the user read; the log carries the parts
   * that are interface state. Writing both from one call is what keeps them
   * from drifting apart.
   */
  async appendTurn(input: {
    question: string;
    content: string;
    intent?: string;
    toolName?: string;
    mode?: ConversationLogMode;
    evidenceComplete?: boolean;
    sources?: DesktopAgentSource[];
    decisionTrail?: string[];
  }): Promise<string | null> {
    const active = this.store.getActive();
    if (!active) {
      return null;
    }
    const now = new Date();
    await this.repository.appendText(active.path, renderSessionExchange(input.question, input.content, now,
      input.toolName ? { toolName: input.toolName, summary: input.content } : undefined));

    if (input.intent && input.intent !== "answer") {
      await this.appendAssistantAction(input.toolName ?? input.intent, input.content, active.path);
    }

    const turnId = `${now.getTime()}`;
    const turn: ConversationLogTurn = {
      turnId,
      at: now.toISOString(),
      question: input.question,
      content: input.content,
      mode: input.mode ?? "local",
      evidenceComplete: input.evidenceComplete ?? false,
      sources: input.sources ?? [],
      decisionTrail: input.decisionTrail ?? [],
      ...(input.intent ? { intent: input.intent } : {})
    };
    await this.repository.appendText(
      conversationLogPath(active.path, active.id),
      renderTurnLine(turn)
    );
    this.store.touch(active.id);
    this.lastTurnId = turnId;
    return turnId;
  }

  /**
   * Records that an answer was filed into a note.
   *
   * Without this the answer would come back from a replay looking unsaved, and
   * its capture buttons along with it.
   */
  async markCaptured(turnId: string | undefined, action: ConversationCapture["action"], targetPath: string): Promise<void> {
    const active = this.store.getActive();
    const id = turnId ?? this.lastTurnId;
    if (!active || !id) {
      return;
    }
    await this.repository.appendText(
      conversationLogPath(active.path, active.id),
      renderCapturePatch(id, { action, targetPath, at: new Date().toISOString() })
    );
  }

  /** Every turn of the active session, restored for the interface. */
  async readConversationLog(): Promise<ConversationLogTurn[]> {
    const active = this.store.getActive();
    if (!active) {
      return [];
    }
    try {
      return parseConversationLog(await this.repository.readRaw(conversationLogPath(active.path, active.id)));
    } catch {
      // No log yet is the normal case: a session only grows one as it is used.
      return [];
    }
  }

  async appendExchange(question: string, answer: string): Promise<void> {
    const active = this.store.getActive();
    if (!active) {
      return;
    }
    await this.repository.appendText(active.path, renderSessionExchange(question, answer));
    this.store.touch(active.id);
  }

  async appendActionExchange(question: string, answer: string, actionName: string): Promise<void> {
    const active = this.store.getActive();
    if (active) {
      await this.repository.appendText(active.path, renderSessionExchange(question, answer, new Date(), {
        toolName: actionName,
        summary: answer
      }));
      this.store.touch(active.id);
    }
    await this.appendAssistantAction(actionName, answer, active?.path);
  }

  async getMemoryContext(): Promise<AgentMemoryContext> {
    const profile = await this.readOptional(getAgentProfilePath(this.memoryFolder));
    const assistantState = await this.readOptional(getAssistantStatePath(this.memoryFolder));
    const active = this.store.getActive();
    const session = active ? await this.readOptional(active.path) : "";
    return buildAgentMemoryContext(profile, session, assistantState);
  }

  async ensureProfile(): Promise<string> {
    const path = getAgentProfilePath(this.memoryFolder);
    const current = await this.readOptional(path);
    if (!current) {
      await this.repository.createText(path, buildAgentProfileSkeleton());
    }
    return path;
  }

  async ensureAssistantState(): Promise<string> {
    const path = getAssistantStatePath(this.memoryFolder);
    const current = await this.readOptional(path);
    if (!current) {
      await this.repository.createText(path, buildAssistantStateSkeleton());
    }
    return path;
  }

  async rememberProfile(content: string): Promise<{ path: string; changed: boolean }> {
    const path = await this.ensureProfile();
    const current = await this.readOptional(path);
    const updated = applyProfileMemorySuggestions(current, [{
      category: inferProfileMemoryCategory(content),
      content: content.trim()
    }], this.store.getActive()?.path);
    if (updated === current) {
      return { path, changed: false };
    }
    await this.repository.writeText(path, updated);
    return { path, changed: true };
  }

  async forgetProfile(content: string): Promise<{ path: string; removedCount: number }> {
    const path = await this.ensureProfile();
    const current = await this.readOptional(path);
    const updated = removeProfileMemorySuggestions(current, content);
    if (updated.removedCount) {
      await this.repository.writeText(path, updated.content);
    }
    return { path, removedCount: updated.removedCount };
  }

  async setCurrentFocus(focus: string): Promise<string> {
    const path = await this.ensureAssistantState();
    const current = await this.readOptional(path);
    await this.repository.writeText(path, setAssistantFocus(current, focus, this.store.getActive()?.path));
    return path;
  }

  private async appendAssistantAction(name: string, summary: string, sessionPath?: string): Promise<void> {
    const path = await this.ensureAssistantState();
    const current = await this.readOptional(path);
    await this.repository.writeText(path, appendAssistantStateAction(current, { name, summary, sessionPath }));
  }

  private async readOptional(path: string): Promise<string> {
    return (await this.repository.getMarkdownFile(path))
      ? this.repository.readText(path)
      : "";
  }
}

function inferProfileMemoryCategory(content: string): ProfileMemoryCategory {
  if (/(?:目标|计划|职业|求职|学习方向|想要)/u.test(content)) {
    return "goal";
  }
  if (/(?:偏好|喜欢|风格|语言|简洁|详细|回答方式)/u.test(content)) {
    return "preference";
  }
  if (/(?:约束|限制|不要|不能|必须|只允许)/u.test(content)) {
    return "constraint";
  }
  return "fact";
}
