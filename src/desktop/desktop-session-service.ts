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
  appendAssistantStateAction,
  buildAssistantStateSkeleton,
  getAssistantStatePath,
  setAssistantFocus
} from "../memory/assistant-state";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

const DEFAULT_MEMORY_FOLDER = "00 Inbox/Agent";

export class DesktopSessionService {
  private readonly store: AgentSessionStore;

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

  async createSession(title: string): Promise<AgentSession> {
    const session = this.store.create(title, this.memoryFolder);
    await this.repository.createText(session.path, renderNewAgentSession(session));
    return this.store.activate(session);
  }

  closeSession(): AgentSession | null {
    return this.store.closeActive();
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
