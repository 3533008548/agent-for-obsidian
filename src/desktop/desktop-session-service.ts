import {
  AgentSessionStore,
  buildAgentMemoryContext,
  buildAgentProfileSkeleton,
  getAgentProfilePath,
  renderNewAgentSession,
  renderSessionExchange,
  type AgentMemoryContext,
  type AgentSession,
  type AgentSessionStoreState
} from "../memory/agent-memory";
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

  async getMemoryContext(): Promise<AgentMemoryContext> {
    const profile = await this.readOptional(getAgentProfilePath(this.memoryFolder));
    const active = this.store.getActive();
    const session = active ? await this.readOptional(active.path) : "";
    return buildAgentMemoryContext(profile, session);
  }

  async ensureProfile(): Promise<string> {
    const path = getAgentProfilePath(this.memoryFolder);
    const current = await this.readOptional(path);
    if (!current) {
      await this.repository.createText(path, buildAgentProfileSkeleton());
    }
    return path;
  }

  private async readOptional(path: string): Promise<string> {
    return (await this.repository.getMarkdownFile(path))
      ? this.repository.readText(path)
      : "";
  }
}
