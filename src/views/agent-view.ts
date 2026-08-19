import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { WritePreview } from "../actions/vault-action-service";
import { getAgentToolDefinition, type AgentRun } from "../runtime/agent-runtime";
import type { AgentSession, AgentSessionMessage } from "../memory/agent-memory";
import type { AgentSessionPreview } from "../main";
import type KnowledgeLoopAgentPlugin from "../main";

export const AGENT_VIEW_TYPE = "knowledge-loop-agent-view";

type PendingSession = AgentSessionPreview & { queuedPrompt?: string };

export class KnowledgeLoopAgentView extends ItemView {
  private chatEl: HTMLElement | null = null;
  private composer: HTMLTextAreaElement | null = null;
  private agentRun: AgentRun | null = null;
  private pendingSession: PendingSession | null = null;
  private pendingWritePreview: WritePreview | null = null;
  private busy = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: KnowledgeLoopAgentPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return AGENT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Knowledge Loop Agent";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("knowledge-loop-agent-view");

    this.renderHeader(contentEl);
    this.chatEl = contentEl.createDiv({ cls: "knowledge-loop-agent-chat" });
    this.renderComposer(contentEl);
    void this.renderChat();
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "knowledge-loop-agent-header" });
    const title = header.createDiv({ cls: "knowledge-loop-agent-title" });
    title.createEl("strong", { text: "Knowledge Loop" });
    title.createEl("span", { text: "Agent" });

    const controls = header.createDiv({ cls: "knowledge-loop-agent-session-controls" });
    const status = this.plugin.getAgentMemoryStatus();
    const sessionSelect = controls.createEl("select", { cls: "knowledge-loop-agent-session-select" });
    sessionSelect.add(new Option("新会话", ""));
    for (const session of this.plugin.getAgentSessions()) {
      sessionSelect.add(new Option(
        `${session.status === "active" ? "● " : ""}${session.title}`,
        session.id,
        false,
        session.id === status.activeSession?.id
      ));
    }
    sessionSelect.addEventListener("change", () => {
      if (!sessionSelect.value) {
        void this.beginSession("新会话");
        return;
      }
      void this.switchSession(sessionSelect.value);
    });

    this.createButton(controls, "+", "新建会话", () => this.beginSession("新会话"));
    this.createButton(controls, "↗", "打开当前会话", async () => {
      const current = this.plugin.getAgentMemoryStatus().activeSession;
      if (!current) {
        this.addTransientMessage("请先创建或切换一个会话。", "system");
        return;
      }
      await this.plugin.openAgentMemoryNote(current.path);
    });
    this.createButton(controls, "画像", "创建或打开用户画像", () => this.openProfile());
    this.createButton(controls, "记住", "从当前会话生成画像更新预览", () => this.updateProfile());
    if (status.activeSession) {
      this.createButton(controls, "结束", "结束当前会话", () => this.closeSession(), "knowledge-loop-agent-quiet-danger");
    }
  }

  private renderComposer(container: HTMLElement): void {
    const composer = container.createDiv({ cls: "knowledge-loop-agent-composer" });
    const inputWrap = composer.createDiv({ cls: "knowledge-loop-agent-composer-input" });
    this.composer = inputWrap.createEl("textarea", {
      attr: {
        placeholder: "告诉 Agent 你想完成什么…",
        rows: "2",
        "aria-label": "向 Agent 发送消息"
      }
    });
    this.composer.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    inputWrap.createDiv({ cls: "knowledge-loop-agent-composer-hint", text: "Ctrl + Enter 发送" });
    const send = this.createButton(composer, "发送", "发送给 Agent", () => this.sendMessage(), "mod-cta");
    send.addClass("knowledge-loop-agent-send");
  }

  private async renderChat(): Promise<void> {
    const chat = this.chatEl;
    if (!chat) {
      return;
    }
    chat.empty();
    const status = this.plugin.getAgentMemoryStatus();
    if (!status.activeSession) {
      this.renderEmptyState(chat);
    } else {
      try {
        const messages = await this.plugin.getActiveSessionTranscript();
        if (!messages.length) {
          this.renderWelcome(chat, status.activeSession);
        } else {
          for (const message of messages) {
            await this.renderMessage(chat, message);
          }
        }
      } catch (error) {
        this.renderPlainMessage(chat, "system", `无法读取会话：${errorMessage(error)}`);
      }
    }

    if (this.pendingSession) {
      this.renderSessionPreview(chat, this.pendingSession);
    }
    if (this.pendingWritePreview) {
      this.renderWritePreview(chat, this.pendingWritePreview);
    }
    const currentRun = this.agentRun ?? this.plugin.getLatestAgentRunForActiveSession();
    if (currentRun && currentRun.status !== "completed" && currentRun.status !== "cancelled") {
      this.renderRunCard(chat, currentRun);
    }
    chat.scrollTop = chat.scrollHeight;
  }

  private renderEmptyState(chat: HTMLElement): void {
    const empty = chat.createDiv({ cls: "knowledge-loop-agent-empty" });
    empty.createEl("h3", { text: "从一个目标开始" });
    empty.createEl("p", { text: "直接描述你想查找、整理、回顾或沉淀的知识。第一次发送会先创建一份同名会话笔记，确认后 Agent 才会执行。" });
    const suggestions = empty.createDiv({ cls: "knowledge-loop-agent-suggestions" });
    for (const prompt of [
      "整理我的 RAG 笔记，找出缺口并给出下一步",
      "基于知识库解释监督学习的损失函数",
      "检查当前知识库的运行状态"
    ]) {
      const button = this.createButton(suggestions, prompt, `使用示例：${prompt}`, () => {
        if (this.composer) {
          this.composer.value = prompt;
          this.composer.focus();
        }
      });
      button.addClass("knowledge-loop-agent-suggestion");
    }
  }

  private renderWelcome(chat: HTMLElement, session: AgentSession): void {
    const welcome = chat.createDiv({ cls: "knowledge-loop-agent-welcome" });
    welcome.createEl("strong", { text: session.title });
    welcome.createEl("p", { text: "会话已创建。描述一个目标，Agent 会选择最少的必要工具并在每次外部调用或写入前征求确认。" });
  }

  private async renderMessage(container: HTMLElement, message: AgentSessionMessage): Promise<void> {
    const bubble = container.createDiv({ cls: `knowledge-loop-agent-message is-${message.role}` });
    const meta = bubble.createDiv({ cls: "knowledge-loop-agent-message-meta" });
    meta.setText(message.role === "user" ? "你" : message.role === "tool" ? "Agent 工具" : "Agent");
    if (message.label) {
      meta.createEl("span", { text: message.label });
    }
    if (message.role === "tool") {
      bubble.createEl("pre", { text: message.content });
      return;
    }
    const body = bubble.createDiv({ cls: "knowledge-loop-agent-message-body" });
    await MarkdownRenderer.renderMarkdown(message.content, body, "", this);
  }

  private renderPlainMessage(container: HTMLElement, role: "agent" | "system", content: string): void {
    const bubble = container.createDiv({ cls: `knowledge-loop-agent-message is-${role}` });
    bubble.createDiv({ cls: "knowledge-loop-agent-message-meta", text: role === "agent" ? "Agent" : "提示" });
    bubble.createDiv({ cls: "knowledge-loop-agent-message-body", text: content });
  }

  private renderSessionPreview(chat: HTMLElement, pending: PendingSession): void {
    const card = this.createCard(chat, "创建新会话", `将在 ${pending.session.path} 创建一份本地会话笔记。`);
    const actions = card.createDiv({ cls: "knowledge-loop-agent-card-actions" });
    this.createButton(actions, "确认创建", "确认创建会话", () => this.confirmSession(), "mod-cta");
    this.createButton(actions, "取消", "取消创建会话", () => {
      this.pendingSession = null;
      void this.renderChat();
    });
  }

  private renderWritePreview(chat: HTMLElement, preview: WritePreview): void {
    const title = preview.proposal.type === "updateAgentProfile" ? "用户画像更新预览" : "Agent 写入预览";
    const card = this.createCard(chat, title, `目标：${preview.targetPath}`);
    card.createEl("pre", { text: preview.afterContent });
    const actions = card.createDiv({ cls: "knowledge-loop-agent-card-actions" });
    this.createButton(actions, "确认写入", "确认执行本次写入", async () => {
      await this.plugin.applyWritePreview(preview);
      this.pendingWritePreview = null;
      await this.renderChat();
    }, "mod-cta");
    this.createButton(actions, "取消", "取消本次写入", () => {
      this.pendingWritePreview = null;
      void this.renderChat();
    });
  }

  private renderRunCard(chat: HTMLElement, run: AgentRun): void {
    const card = this.createCard(chat, "Agent 计划", run.planSummary);
    const steps = card.createEl("ol", { cls: "knowledge-loop-agent-plan" });
    for (const step of run.steps) {
      const item = steps.createEl("li", { cls: `is-${step.status}` });
      item.createEl("strong", { text: step.title });
      item.createEl("span", { text: ` · ${getAgentToolDefinition(step).name}` });
      item.createEl("small", { text: step.resultSummary ?? step.reason });
      if (step.status === "pending") {
        const actions = item.createDiv({ cls: "knowledge-loop-agent-card-actions" });
        const label = step.requiresConfirmation ? "确认并执行" : "执行下一步";
        this.createButton(actions, label, `${label}：${step.title}`, () => this.updateRun(
          () => this.plugin.executeAgentRunStep(run.id, step.id, step.requiresConfirmation),
          true
        ), "mod-cta");
        this.createButton(actions, "跳过", `跳过：${step.title}`, () => this.updateRun(() => this.plugin.skipAgentRunStep(run.id, step.id)));
        break;
      }
      if (step.status === "failed" || step.status === "blocked") {
        const actions = item.createDiv({ cls: "knowledge-loop-agent-card-actions" });
        this.createButton(actions, "重试", `重试：${step.title}`, () => this.updateRun(() => this.plugin.retryAgentRunStep(run.id, step.id)), "mod-cta");
        this.createButton(actions, "跳过", `跳过：${step.title}`, () => this.updateRun(() => this.plugin.skipAgentRunStep(run.id, step.id)));
        break;
      }
    }
    const actions = card.createDiv({ cls: "knowledge-loop-agent-card-actions" });
    if (run.replanCount < 1 && run.status !== "running") {
      this.createButton(actions, "重新规划", "重新规划剩余步骤", () => this.updateRun(() => this.plugin.replanAgentRun(run.id)));
    }
    this.createButton(actions, "取消计划", "取消本次 Agent 计划", () => this.updateRun(() => this.plugin.cancelAgentRun(run.id)), "knowledge-loop-agent-quiet-danger");
  }

  private createCard(container: HTMLElement, title: string, description: string): HTMLElement {
    const card = container.createDiv({ cls: "knowledge-loop-agent-card" });
    card.createEl("strong", { text: title });
    card.createEl("p", { text: description });
    return card;
  }

  private createButton(
    container: HTMLElement,
    text: string,
    ariaLabel: string,
    onClick: () => void | Promise<void>,
    className?: string
  ): HTMLButtonElement {
    const button = container.createEl("button", { text, cls: className });
    button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", () => void this.withBusy(onClick));
    return button;
  }

  private async sendMessage(): Promise<void> {
    const goal = this.composer?.value.trim() ?? "";
    if (!goal) {
      return;
    }
    if (!this.plugin.getAgentMemoryStatus().activeSession) {
      await this.beginSession(goal.slice(0, 80), goal);
      return;
    }
    await this.startRun(goal);
  }

  private async beginSession(title: string, queuedPrompt?: string): Promise<void> {
    this.pendingSession = { ...await this.plugin.previewAgentSession(title), queuedPrompt };
    await this.renderChat();
  }

  private async confirmSession(): Promise<void> {
    const pending = this.pendingSession;
    if (!pending) {
      return;
    }
    await this.plugin.confirmAgentSession(pending);
    this.pendingSession = null;
    if (this.composer) {
      this.composer.value = "";
    }
    if (pending.queuedPrompt) {
      await this.startRun(pending.queuedPrompt);
    }
    this.render();
  }

  private async switchSession(sessionId: string): Promise<void> {
    await this.plugin.activateAgentSession(sessionId);
    this.agentRun = null;
    this.pendingSession = null;
    this.render();
  }

  private async closeSession(): Promise<void> {
    await this.plugin.closeActiveAgentSession();
    this.agentRun = null;
    this.render();
  }

  private async startRun(goal: string): Promise<void> {
    this.agentRun = await this.plugin.startAgentRun(goal);
    if (this.composer) {
      this.composer.value = "";
    }
    await this.renderChat();
  }

  private async updateRun(action: () => Promise<AgentRun>, syncWritePreview = false): Promise<void> {
    this.agentRun = await action();
    if (syncWritePreview) {
      this.pendingWritePreview = this.plugin.getRuntimeWritePreview();
    }
    await this.renderChat();
  }

  private async openProfile(): Promise<void> {
    const status = this.plugin.getAgentMemoryStatus();
    if (status.profileExists) {
      await this.plugin.openAgentMemoryNote(status.profilePath);
      return;
    }
    this.pendingWritePreview = await this.plugin.previewAgentProfile();
    await this.renderChat();
  }

  private async updateProfile(): Promise<void> {
    this.pendingWritePreview = await this.plugin.previewProfileMemoryUpdate();
    await this.renderChat();
  }

  private async withBusy(action: () => void | Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.contentEl.addClass("is-busy");
    try {
      await action();
    } catch (error) {
      this.addTransientMessage(errorMessage(error), "system");
    } finally {
      this.busy = false;
      this.contentEl.removeClass("is-busy");
    }
  }

  private addTransientMessage(content: string, role: "agent" | "system"): void {
    if (this.chatEl) {
      this.renderPlainMessage(this.chatEl, role, content);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误。";
}
