import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type WebContents } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createDefaultPermissionPolicy,
  PolicyEngine
} from "../core/policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";
import { createNodeMarkdownIndexStore } from "../core/desktop/node-markdown-index-store";
import {
  PortableMarkdownKnowledgeIndex,
  type MarkdownIndexSummary
} from "../core/indexing/portable-markdown-knowledge-index";
import {
  DesktopAgentService,
  type DesktopAgentStreamOptions
} from "../core/desktop/desktop-agent-service";
import { StreamCancelledError } from "../core/services/fetch-api-request";
import { DesktopSessionService } from "../core/desktop/desktop-session-service";
import { DesktopWriteService } from "../core/desktop/desktop-write-service";
import { DesktopWikiService } from "../core/desktop/desktop-wiki-service";
import { DesktopAttachmentService, type DesktopAttachmentState } from "../core/desktop/desktop-attachment-service";
import { DesktopRelationService } from "../core/desktop/desktop-relation-service";
import { DesktopAgentRuntime } from "../core/desktop/desktop-agent-runtime";
import { DesktopKnowledgeSystemService } from "../core/desktop/desktop-knowledge-system-service";
import { DesktopMaintenanceService } from "../core/desktop/desktop-maintenance-service";
import { DesktopWikiVerificationService } from "../core/desktop/desktop-wiki-verification-service";
import { detectDesktopAgentIntent } from "../core/desktop/desktop-intent-router";
import { formatPastedContent } from "../core/paste/paste-formatter";
import type { AgentSessionStoreState } from "../core/memory/agent-memory";
import { readEnvValue } from "../core/services/env";
import { createTrayController, type TrayController } from "./tray-controller";
import type { WebFallbackPolicy } from "../core/services/web-answer-policy";
import {
  getStandaloneWorkspaceName,
  migrateObsidianVault,
  previewObsidianVaultMigration
} from "../core/desktop/obsidian-vault-migrator";
import type {
  DesktopSearchHit,
  DesktopAgentResponse,
  DesktopAgentStreamEvent,
  DesktopAgentRequestContext,
  DesktopNoteEntry,
  ObsidianMigrationState,
  ProviderStatus,
  SessionStatus,
  WorkspaceState,
  AgentRunView,
  WritePreviewView
} from "./shared/desktop-api";
import { LAUNCH_USAGE, parseLaunchArguments } from "./launch-args";

const WINDOW_OPTIONS = {
  width: 1120,
  height: 760,
  minWidth: 760,
  minHeight: 560,
  title: "知识环",
  backgroundColor: "#fafafa",
  webPreferences: {
    preload: join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false
  }
};

const DESKTOP_ENV_TEMPLATE = [
  "# 知识环桌面端模型配置。此文件只保存在本机应用数据目录，请勿提交或分享。",
  "# DeepSeek 负责文本与图片解析；Tavily 只检索网页。DeepSeek Vision 当前不支持 PDF。",
  "DEEPSEEK_API_KEY=",
  "DEEPSEEK_MODEL=deepseek-v4-flash",
  "DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp",
  "TAVILY_API_KEY=",
  "WEB_FALLBACK_POLICY=stable-only",
  ""
].join("\n");

class DesktopKnowledgeWorkspace {
  private rootPath: string | null = null;
  private repository: NodeFileSystemKnowledgeRepository | null = null;
  private index: PortableMarkdownKnowledgeIndex | null = null;
  private summary: MarkdownIndexSummary | null = null;
  private sessionService: DesktopSessionService | null = null;
  private writeService: DesktopWriteService | null = null;
  private wikiService: DesktopWikiService | null = null;
  private attachmentService: DesktopAttachmentService | null = null;
  private relationService: DesktopRelationService | null = null;
  private readonly activeAnswerStreams = new Map<string, AbortController>();
  private wikiVerificationService: DesktopWikiVerificationService | null = null;
  private agentRuntime: DesktopAgentRuntime | null = null;
  private knowledgeService: DesktopKnowledgeSystemService | null = null;
  private maintenanceService: DesktopMaintenanceService | null = null;
  private activeNotePath: string | null = null;
  private sessionStates: Record<string, AgentSessionStoreState> = {};
  private didLoadSessionStates = false;
  private readonly policy = new PolicyEngine(createDefaultPermissionPolicy());

  /** Currently open knowledge base, used to tell a repeated launch apart. */
  get currentRootPath(): string | null {
    return this.rootPath;
  }

  async restore(): Promise<WorkspaceState | null> {
    try {
      const raw = await readFile(getWorkspaceStatePath(), "utf8");
      const saved = JSON.parse(raw) as { rootPath?: unknown };
      return typeof saved.rootPath === "string" ? this.open(saved.rootPath) : null;
    } catch {
      return null;
    }
  }

  async choose(): Promise<WorkspaceState | null> {
    const result = await dialog.showOpenDialog({
      title: "选择知识库目录",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled || !result.filePaths[0] ? null : this.open(result.filePaths[0]);
  }

  async migrateFromObsidian(): Promise<ObsidianMigrationState | null> {
    const sourceResult = await dialog.showOpenDialog({
      title: "选择原始 Obsidian 知识库",
      buttonLabel: "选择此知识库",
      properties: ["openDirectory"]
    });
    const sourcePath = sourceResult.filePaths[0];
    if (sourceResult.canceled || !sourcePath) {
      return null;
    }

    const preview = await previewObsidianVaultMigration(sourcePath);
    const confirmation = await dialog.showMessageBox({
      type: "question",
      buttons: ["继续迁移", "取消"],
      defaultId: 0,
      cancelId: 1,
      title: "确认迁移 Obsidian 知识库",
      message: "将复制 " + preview.noteCount + " 篇笔记和 " + preview.attachmentCount + " 个附件。",
      detail: "会保留原目录与链接；不会复制 .obsidian 配置、Git 元数据或插件密钥。原始知识库不会被修改。"
    });
    if (confirmation.response !== 0) {
      return null;
    }

    const destinationResult = await dialog.showOpenDialog({
      title: "选择迁移后知识库的存放位置",
      buttonLabel: "存放到此处",
      properties: ["openDirectory", "createDirectory"]
    });
    const parentDirectory = destinationResult.filePaths[0];
    if (destinationResult.canceled || !parentDirectory) {
      return null;
    }

    const migration = await migrateObsidianVault(
      sourcePath,
      join(parentDirectory, getStandaloneWorkspaceName(sourcePath))
    );
    return {
      workspace: await this.open(migration.destinationPath),
      noteCount: migration.noteCount,
      attachmentCount: migration.attachmentCount,
      totalFiles: migration.totalFiles
    };
  }

  async getState(): Promise<WorkspaceState | null> {
    return this.rootPath && this.summary ? this.toState() : null;
  }

  async search(query: string): Promise<DesktopSearchHit[]> {
    if (!this.index) {
      throw new Error("请先选择本地知识库目录。");
    }
    return this.index.search(query.trim(), 8).map((result) => ({
      sourcePath: result.chunk.source.pathOrUrl,
      heading: result.chunk.heading,
      excerpt: result.excerpt,
      score: result.score
    }));
  }

  async listNotes(): Promise<DesktopNoteEntry[]> {
    if (!this.repository) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    return (await this.repository.listMarkdownFiles())
      .filter((file) => !isInternalWorkspacePath(file.path))
      .map((file) => ({
        path: file.path,
        title: basename(file.path).replace(/\.md$/i, "")
      }));
  }

  async answer(
    question: string,
    context: DesktopAgentRequestContext = {},
    stream?: DesktopAgentStreamOptions
  ): Promise<DesktopAgentResponse> {
    if (!this.index) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const route = detectDesktopAgentIntent({ question, activeNotePath: context.activeNotePath });
    if (route.intent !== "answer") {
      const response = await this.executeIntent(route.intent, route.subject, route.notePath, route.sessionTitle);
      if (route.intent !== "close-session" && this.sessionService) {
        await this.sessionService.appendActionExchange(question, response.content, formatIntentAction(route.intent));
        await this.persistSessionState();
      }
      return response;
    }
    const memoryContext = this.sessionService
      ? (await this.sessionService.getMemoryContext()).content
      : "";
    const agent = new DesktopAgentService(this.index, {
      ...(await readDesktopAgentConfiguration()),
      memoryContext,
      activeNotePath: context.activeNotePath ?? this.activeNotePath,
      attachmentSearch: this.attachmentService?.search.bind(this.attachmentService)
    });
    const answer = await agent.answer(question, "auto", stream);
    if (this.sessionService) {
      await this.sessionService.appendExchange(question, answer.content);
      await this.persistSessionState();
    }
    return { ...answer, intent: "answer" };
  }

  /**
   * Same contract as {@link answer}, but pushes progressive text to the renderer
   * while the model is still writing. Non-answer intents simply produce no deltas.
   */
  async answerStream(
    question: string,
    context: DesktopAgentRequestContext,
    runId: string,
    sender: WebContents
  ): Promise<DesktopAgentResponse> {
    const controller = new AbortController();
    this.activeAnswerStreams.set(runId, controller);
    const emit = (event: DesktopAgentStreamEvent): void => {
      if (!sender.isDestroyed()) {
        sender.send("agent:answer-stream-event", event);
      }
    };
    try {
      const response = await this.answer(question, context, {
        onDelta: (text) => emit({ runId, type: "delta", text }),
        onReset: () => emit({ runId, type: "reset" }),
        signal: controller.signal
      });
      emit({ runId, type: "done" });
      return response;
    } catch (error) {
      emit({
        runId,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        cancelled: error instanceof StreamCancelledError
      });
      throw error;
    } finally {
      this.activeAnswerStreams.delete(runId);
    }
  }

  cancelAnswerStream(runId: string): void {
    this.activeAnswerStreams.get(runId)?.abort();
  }

  private async executeIntent(
    intent: Exclude<ReturnType<typeof detectDesktopAgentIntent>["intent"], "answer">,
    subject?: string,
    notePath?: string,
    sessionTitle?: string
  ): Promise<DesktopAgentResponse> {
    switch (intent) {
      case "start-session": {
        const session = await this.createSession(sessionTitle ?? "新会话");
        return actionResponse(intent, `已开始会话「${session.title ?? "新会话"}」，后续问答会自动追加到同一份笔记。`, { sessionStatus: session });
      }
      case "close-session": {
        const session = await this.closeSession();
        return actionResponse(intent, "已结束当前会话。", { sessionStatus: session });
      }
      case "open-profile": {
        if (!this.sessionService) {
          throw new Error("请先选择或迁移本地知识库。");
        }
        const profilePath = await this.sessionService.ensureProfile();
        return actionResponse(intent, "已准备用户画像，可在预览中直接编辑长期偏好、背景和目标。", { profilePath });
      }
      case "remember-profile": {
        if (!subject) {
          return actionResponse(intent, "请在“记住”后说明要保存的稳定信息，例如“记住我偏好简洁的中文回答”。");
        }
        if (!this.sessionService) {
          throw new Error("请先选择或迁移本地知识库。");
        }
        const result = await this.sessionService.rememberProfile(subject);
        return actionResponse(intent, result.changed ? `已记入用户画像：${subject}` : "这条信息已存在于用户画像中。", { profilePath: result.path });
      }
      case "forget-profile": {
        if (!subject) {
          return actionResponse(intent, "请说明要忘记的画像内容，例如“忘记我偏好详细回答”。");
        }
        if (!this.sessionService) {
          throw new Error("请先选择或迁移本地知识库。");
        }
        const result = await this.sessionService.forgetProfile(subject);
        return actionResponse(intent, result.removedCount
          ? `已从用户画像移除 ${result.removedCount} 条与“${subject}”匹配的记忆。`
          : "用户画像中没有找到匹配的已确认记忆。", { profilePath: result.path });
      }
      case "open-assistant-state": {
        if (!this.sessionService) {
          throw new Error("请先选择或迁移本地知识库。");
        }
        const assistantStatePath = await this.sessionService.ensureAssistantState();
        return actionResponse(intent, "已打开助手状态：这里记录当前关注与最近已执行的 Agent 动作。", { assistantStatePath });
      }
      case "set-current-focus": {
        if (!subject) {
          return actionResponse(intent, "请在“设为当前重点”后说明需要持续跟进的事项。");
        }
        if (!this.sessionService) {
          throw new Error("请先选择或迁移本地知识库。");
        }
        const assistantStatePath = await this.sessionService.setCurrentFocus(subject);
        return actionResponse(intent, `已将当前重点设为：${subject}`, { assistantStatePath });
      }
      case "compile-wiki": {
        if (!subject) {
          return actionResponse(intent, "请说明要编译的 Wiki 主题，例如“编译 LangGraph LLM Wiki”。");
        }
        const result = await this.compileWiki(subject);
        return actionResponse(intent, `已编译 LLM Wiki「${result.topic}」：使用 ${result.sourceCount} 条本地资料，写入 ${result.pageCount} 个页面。`);
      }
      case "expand-wiki": {
        if (!subject) {
          return actionResponse(intent, "请说明要补全的 Wiki 主题，例如“补全 LangGraph LLM Wiki”。");
        }
        const result = await this.compileWiki(subject, "expand");
        return actionResponse(intent, [
          `已补全 LLM Wiki「${result.topic}」：使用 ${result.sourceCount} 条本地资料，写入 ${result.pageCount} 个页面。`,
          `本轮新增覆盖 ${result.coverage.added} 条，变更/新片段 ${result.coverage.changed} 条，复用上下文 ${result.coverage.reused} 条；仍有 ${result.coverage.remainingCandidates} 篇候选资料待覆盖。`,
          result.sourceHealth.missing || result.sourceHealth.changed || result.sourceHealth.unverified
            ? `历史来源检查：已变化 ${result.sourceHealth.changed} 个，已删除 ${result.sourceHealth.missing} 个，不可核验 ${result.sourceHealth.unverified} 个；这些内容仍需核验。`
            : "历史来源检查：当前依赖来源均可本地复核。"
        ].join("\n"));
      }
      case "inspect-wiki-sources": {
        if (!subject) {
          return actionResponse(intent, "请说明要检查来源的 Wiki 主题，例如“检查 LangGraph LLM Wiki 来源”。");
        }
        const result = await this.inspectWikiSources(subject);
        return actionResponse(intent, [
          `LLM Wiki「${result.topic}」的本地来源检查完成：有效 ${result.sourceHealth.active} 个，已变化 ${result.sourceHealth.changed} 个，已删除 ${result.sourceHealth.missing} 个，当前不可核验 ${result.sourceHealth.unverified} 个。`,
          result.sourceHealth.missing || result.sourceHealth.changed || result.sourceHealth.unverified
            ? "这些来源不会被当作确定事实依据；需要时可再执行“联网核验 … LLM Wiki”。"
            : "当前本地来源与已编译版本一致。"
        ].join("\n"));
      }
      case "process-images": {
        const scan = await this.scanAttachments();
        const result = await this.processAttachments();
        return actionResponse(intent, `图片解析完成：发现 ${scan.queued} 张待处理图片，成功解析 ${result.indexed} 张，失败 ${result.failed} 张，剩余 ${result.pending} 张。${scan.unsupportedPdfCount ? `已跳过 ${scan.unsupportedPdfCount} 份 PDF（DeepSeek Vision 暂不支持 PDF）。` : ""}`);
      }
      case "format-clipboard": {
        const result = this.formatClipboard();
        return actionResponse(intent, result.changed
          ? `已将剪贴板整理为 Markdown（${result.quality.kind}），现在可以直接粘贴；修复 ${result.quality.repairedCellCount} 个单元格。${result.quality.warnings.length ? " " + result.quality.warnings.join(" ") : ""}`
          : "剪贴板内容无需调整。");
      }
      case "complete-relations": {
        if (!notePath) {
          return actionResponse(intent, "请先在目录中打开目标笔记，或在消息中写明相对路径，例如“补全 [[后端/LangGraph.md]] 的关联”。");
        }
        const result = await this.completeRelations(notePath);
        return actionResponse(intent, result.relationCount
          ? `已为「${result.path}」补充 ${result.relationCount} 条关联：${result.summary}`
          : `关联分析完成：${result.summary}`);
      }
      case "verify-wiki": {
        if (!subject) {
          return actionResponse(intent, "请说明要联网核验的 Wiki 主题，例如“联网核验 LangGraph LLM Wiki”。");
        }
        const report = await this.verifyWiki(subject);
        return actionResponse(intent, report.summary, { wikiVerification: report });
      }
    }
  }

  async saveAnswer(
    action: "createInboxNote" | "appendDailyNote",
    subject: string,
    content: string,
    sources: DesktopAgentResponse["sources"]
  ): Promise<{ targetPath: string; created: boolean }> {
    if (!this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const preview = await this.writeService.previewAnswer(action, subject, content, sources);
    return this.writeService.apply(preview);
  }

  private async compileWiki(topic: string, mode: "compile" | "expand" = "compile"): Promise<{
    topic: string;
    pageCount: number;
    sourceCount: number;
    updatedCount: number;
    paths: string[];
    coverage: { added: number; changed: number; reused: number; remainingCandidates: number };
    sourceHealth: { active: number; changed: number; missing: number; unverified: number };
  }> {
    if (!this.repository || !this.index) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, configuration);
    const result = await this.wikiService.compile(topic, mode);
    this.summary = await this.index.sync(this.policy);
    return result;
  }

  private async inspectWikiSources(topic: string) {
    if (!this.repository || !this.index) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, configuration);
    return this.wikiService.inspectSources(topic);
  }

  private async scanAttachments(): Promise<{ queued: number; unchanged: number; blocked: number; removed: number; unsupportedPdfCount: number }> {
    if (!this.attachmentService || !this.rootPath) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const result = await this.attachmentService.scan();
    await this.persistAttachmentState();
    return result;
  }

  private async processAttachments(): Promise<{ indexed: number; failed: number; pending: number }> {
    if (!this.attachmentService || !this.rootPath) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const result = await this.attachmentService.processAll();
    await this.persistAttachmentState();
    return result;
  }

  private formatClipboard(): { changed: boolean; text: string; quality: { kind: string; repairedCellCount: number; warnings: string[] } } {
    const before = clipboard.readText();
    const result = formatPastedContent({ text: before, html: clipboard.readHTML() });
    clipboard.writeText(result.markdown);
    return { changed: result.markdown !== before, text: result.markdown, quality: result.report };
  }

  private async completeRelations(path: string): Promise<{ path: string; summary: string; relationCount: number }> {
    if (!this.repository || !this.index) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.relationService = new DesktopRelationService(this.repository, this.index, this.policy, configuration);
    const preview = await this.relationService.preview(path);
    const result = await this.relationService.apply(preview);
    this.summary = await this.index.sync(this.policy);
    return result;
  }

  private async verifyWiki(question: string) {
    if (!this.repository) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    this.wikiVerificationService = new DesktopWikiVerificationService(
      this.repository,
      this.policy,
      await readDesktopAgentConfiguration()
    );
    return this.wikiVerificationService.verify(question);
  }

  async createWikiUpdatePreview(id: string) {
    if (!this.wikiVerificationService) {
      throw new Error("请先完成一次 Wiki 联网核验。 ");
    }
    return this.wikiVerificationService.createUpdatePreview(id);
  }

  private getSessionStatus(): SessionStatus {
    const active = this.sessionService?.activeSession;
    return active
      ? { active: true, title: active.title, path: active.path }
      : { active: false };
  }

  private async createSession(title: string): Promise<SessionStatus> {
    if (!this.sessionService) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    await this.sessionService.createSession(title);
    await this.persistSessionState();
    return this.getSessionStatus();
  }

  private async closeSession(): Promise<SessionStatus> {
    if (this.sessionService?.activeSession) {
      await this.sessionService.appendActionExchange("结束当前会话", "已结束当前会话。", "结束会话");
    }
    this.sessionService?.closeSession();
    await this.persistSessionState();
    return this.getSessionStatus();
  }

  async previewSource(path: string) {
    if (!this.repository) {
      throw new Error("当前没有已打开的知识库。");
    }
    const file = await this.findMarkdownSource(path);
    if (!file) {
      throw new Error("来源笔记已不存在或不再是 Markdown 文件。");
    }
    return {
      path: file.path,
      title: basename(file.path).replace(/\.md$/i, ""),
      content: await this.repository.readText(file.path)
    };
  }

  async openSource(path: string): Promise<void> {
    if (!this.repository || !this.rootPath) {
      throw new Error("当前没有已打开的知识库。");
    }
    const file = await this.findMarkdownSource(path);
    if (!file) {
      throw new Error("来源笔记已不存在或不再是 Markdown 文件。");
    }
    const error = await shell.openPath(join(this.rootPath, file.path));
    if (error) {
      throw new Error("无法打开来源笔记：" + error);
    }
  }

  private async findMarkdownSource(path: string) {
    if (!this.repository) {
      return null;
    }
    const normalizedPath = path.split("#", 1)[0].trim().replace(/\\/g, "/");
    if (!normalizedPath || /^https?:\/\//i.test(normalizedPath)) {
      return null;
    }
    const direct = await this.repository.getMarkdownFile(normalizedPath);
    if (direct) {
      return direct;
    }
    if (normalizedPath.toLowerCase().endsWith(".md")) {
      return null;
    }
    const expectedPath = `${normalizedPath}.md`.toLowerCase();
    const matches = (await this.repository.listMarkdownFiles()).filter((candidate) =>
      candidate.path.toLowerCase() === expectedPath || candidate.path.toLowerCase().endsWith(`/${expectedPath}`)
    );
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Index a knowledge base and make it current. Public because the launch
   * arguments can name a directory directly, bypassing the folder picker.
   */
  async open(rootPath: string): Promise<WorkspaceState> {
    const repository = new NodeFileSystemKnowledgeRepository(rootPath);
    const index = new PortableMarkdownKnowledgeIndex(
      repository,
      (path) =>
        path.startsWith(".obsidian/") ||
        path.startsWith(".knowledge-loop-agent/") ||
        path.startsWith("00 Inbox/Agent/"),
      { store: createNodeMarkdownIndexStore(getIndexSnapshotPath()), rootPath }
    );
    const summary = await index.sync(this.policy);

    this.rootPath = rootPath;
    this.repository = repository;
    this.index = index;
    this.writeService = new DesktopWriteService(repository, this.policy);
    const attachmentConfiguration = await readDesktopAgentConfiguration();
    this.attachmentService = new DesktopAttachmentService(
      repository,
      this.policy,
      attachmentConfiguration,
      await readAttachmentState(rootPath)
    );
    this.summary = summary;
    await this.restoreSessionService(rootPath, repository);
    await saveWorkspacePath(rootPath);
    return this.toState();
  }

  private async restoreSessionService(
    rootPath: string,
    repository: NodeFileSystemKnowledgeRepository
  ): Promise<void> {
    if (!this.didLoadSessionStates) {
      this.sessionStates = await readSessionStates();
      this.didLoadSessionStates = true;
    }
    this.sessionService = new DesktopSessionService(repository, this.sessionStates[rootPath] ?? {});
  }

  private async persistSessionState(): Promise<void> {
    if (!this.rootPath || !this.sessionService) {
      return;
    }
    this.sessionStates[this.rootPath] = this.sessionService.state;
    await writeSessionStates(this.sessionStates);
  }

  private async persistAttachmentState(): Promise<void> {
    if (!this.rootPath || !this.attachmentService) {
      return;
    }
    const states = await readAttachmentStates();
    states[this.rootPath] = this.attachmentService.toState();
    await writeAttachmentStates(states);
  }

  /**
   * Build the semantic agent runtime.
   *
   * Explicit operational commands still use the regex intent router; every
   * knowledge goal now goes through a model-proposed, user-confirmed plan.
   */
  private async createAgentRuntime(): Promise<DesktopAgentRuntime> {
    if (!this.repository || !this.index || !this.writeService || !this.attachmentService) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const configuration = await readDesktopAgentConfiguration();
    const repository = this.repository;
    const index = this.index;
    const write = this.writeService;
    this.knowledgeService = new DesktopKnowledgeSystemService(index, this.policy, write, {
      deepSeekApiKey: configuration.deepSeekApiKey,
      deepSeekModel: configuration.deepSeekModel,
      requestTimeoutMs: configuration.requestTimeoutMs,
      knowledgeSystemFolder: KNOWLEDGE_SYSTEM_FOLDER
    });
    this.maintenanceService = new DesktopMaintenanceService(index, this.policy, {
      deepSeekApiKey: configuration.deepSeekApiKey,
      deepSeekModel: configuration.deepSeekModel,
      requestTimeoutMs: configuration.requestTimeoutMs
    });
    this.relationService = new DesktopRelationService(repository, index, this.policy, configuration);
    this.wikiService = new DesktopWikiService(repository, index, this.policy, {
      deepSeekApiKey: configuration.deepSeekApiKey,
      deepSeekModel: configuration.deepSeekModel,
      requestTimeoutMs: configuration.requestTimeoutMs,
      knowledgeSystemFolder: KNOWLEDGE_SYSTEM_FOLDER
    });
    const agent = new DesktopAgentService(index, {
      ...configuration,
      activeNotePath: this.activeNotePath,
      attachmentSearch: this.attachmentService.search.bind(this.attachmentService)
    });
    const runtime = new DesktopAgentRuntime(
      {
        index,
        policy: this.policy,
        agent,
        wiki: this.wikiService,
        knowledge: this.knowledgeService,
        maintenance: this.maintenanceService,
        attachments: this.attachmentService,
        relation: this.relationService,
        write,
        knowledgeSystemFolder: KNOWLEDGE_SYSTEM_FOLDER,
        deepSeekApiKey: () => configuration.deepSeekApiKey,
        deepSeekModel: () => configuration.deepSeekModel,
        requestTimeoutMs: () => configuration.requestTimeoutMs,
        activeNotePath: () => this.activeNotePath,
        formatClipboard: async () => {
          const result = this.formatClipboard();
          return { content: result.text, changed: result.changed };
        },
        describeStatus: () => this.describeStatus(configuration)
      },
      {
        deepSeekApiKey: () => configuration.deepSeekApiKey,
        deepSeekModel: () => configuration.deepSeekModel,
        requestTimeoutMs: () => configuration.requestTimeoutMs,
        hasTavilyApiKey: () => Boolean(configuration.tavilyApiKey.trim()),
        hasRelevantWiki: async (goal) => {
          const pages = await this.wikiService?.searchPages(goal, 1) ?? [];
          return pages.length > 0;
        }
      }
    );
    this.agentRuntime = runtime;
    return runtime;
  }

  private requireRuntime(): DesktopAgentRuntime {
    if (!this.agentRuntime) {
      throw new Error("请先生成一个 Agent 运行计划。");
    }
    return this.agentRuntime;
  }

  private describeStatus(configuration: Awaited<ReturnType<typeof readDesktopAgentConfiguration>>): string {
    return [
      `知识库：${this.rootPath ?? "未选择"}`,
      `索引 ${this.summary?.indexedFiles ?? 0} 篇笔记、${this.summary?.chunkCount ?? 0} 个片段`,
      `DeepSeek ${configuration.deepSeekApiKey.trim() ? "已配置" : "未配置"}`,
      `Tavily ${configuration.tavilyApiKey.trim() ? "已配置" : "未配置"}`
    ].join("；") + "。";
  }

  setActiveNote(path: string | null): void {
    this.activeNotePath = path ?? null;
  }

  async planRun(goal: string): Promise<AgentRunView> {
    const runtime = await this.createAgentRuntime();
    return toAgentRunView(await runtime.plan(goal));
  }

  async runStep(runId: string, stepId: string): Promise<AgentRunView> {
    return toAgentRunView(await this.requireRuntime().executeStep(runId, stepId, true));
  }

  async skipStep(runId: string, stepId: string): Promise<AgentRunView> {
    return toAgentRunView(await this.requireRuntime().skipStep(runId, stepId));
  }

  async cancelRun(runId: string): Promise<AgentRunView> {
    return toAgentRunView(await this.requireRuntime().cancel(runId));
  }

  async getWritePreviews(): Promise<WritePreviewView[]> {
    const state = this.requireRuntime().getState();
    return (state.writePreviews ?? []).map((preview) => ({
      targetPath: preview.targetPath,
      existedBefore: preview.existedBefore,
      beforeContent: preview.beforeContent,
      afterContent: preview.afterContent
    }));
  }

  /** Write only what the user has previewed. */
  async applyWritePreviews(): Promise<string[]> {
    const runtime = this.requireRuntime();
    const state = runtime.getState();
    const previews = state.writePreviews ?? [];
    if (!previews.length || !this.writeService) {
      throw new Error("当前没有待确认的写入预览。");
    }
    const written: string[] = [];
    for (const preview of previews) {
      const result = await this.writeService.apply(preview);
      written.push(result.targetPath);
    }
    if (state.wikiDraft) {
      await this.wikiService?.persistRegistry(state.wikiDraft.registry);
    }
    this.summary = this.index ? await this.index.sync(this.policy) : this.summary;
    return written;
  }

  private toState(): WorkspaceState {
    if (!this.rootPath || !this.summary) {
      throw new Error("知识库尚未初始化。");
    }
    return {
      rootPath: this.rootPath,
      displayName: basename(this.rootPath),
      indexedFiles: this.summary.indexedFiles,
      skippedFiles: this.summary.skippedFiles,
      chunkCount: this.summary.chunkCount
    };
  }
}

const KNOWLEDGE_SYSTEM_FOLDER = "知识体系/Agent";

function toAgentRunView(run: {
  id: string;
  goal: string;
  status: "planned" | "running" | "completed" | "cancelled";
  planSummary: string;
  replanCount: number;
  steps: Array<{
    id: string;
    tool: string;
    action: string;
    title: string;
    reason: string;
    requiresConfirmation: boolean;
    status: "pending" | "running" | "completed" | "skipped" | "failed" | "blocked";
    resultSummary?: string;
  }>;
}): AgentRunView {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    planSummary: run.planSummary,
    replanCount: run.replanCount,
    steps: run.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      action: step.action,
      title: step.title,
      reason: step.reason,
      requiresConfirmation: step.requiresConfirmation,
      status: step.status,
      ...(step.resultSummary ? { resultSummary: step.resultSummary } : {})
    }))
  };
}

const workspace = new DesktopKnowledgeWorkspace();

/**
 * Arguments the user typed or put in a shortcut. `electron .` leaves the app
 * path in argv[1]; a packaged app starts its own arguments right there.
 */
function userArguments(argv: string[] = process.argv): string[] {
  return app.isPackaged ? argv.slice(1) : argv.slice(2);
}

function warnAboutUnusablePath(path: string): void {
  dialog.showErrorBox(
    "知识环无法打开这个知识库",
    `目录不存在：\n${path}\n\n请检查快捷方式里的路径，应用将沿用上次打开的知识库。`
  );
}

/** Bring the existing window forward instead of starting a second copy. */
let trayController: TrayController | null = null;
/** Set while quitting, so the close handler stops intercepting hides. */
let isQuitting = false;

/**
 * Ask the renderer to put the cursor in the question box. The window may still
 * be loading right after a summon, in which case the listener does not exist
 * yet and the request has to wait for it.
 */
function requestComposerFocus(window: BrowserWindow): void {
  const send = (): void => window.webContents.send("app:focus-composer");
  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", send);
    return;
  }
  send();
}

function summonMainWindow(): void {
  const existing = BrowserWindow.getAllWindows()[0];
  const window = existing ?? createWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  requestComposerFocus(window);
}

function hideMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    return;
  }
  window.hide();
  trayController?.notifyHidden();
}

function toggleMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isVisible()) {
    hideMainWindow();
    return;
  }
  summonMainWindow();
}

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

async function switchToRequestedVault(argv: string[]): Promise<void> {
  const { requestedRootPath, unusableRootPath } = parseLaunchArguments(userArguments(argv));
  if (unusableRootPath) {
    warnAboutUnusablePath(unusableRootPath);
    return;
  }
  if (!requestedRootPath || requestedRootPath === workspace.currentRootPath) {
    return;
  }
  const state = await workspace.open(requestedRootPath);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("workspace:opened", state);
  }
}

async function openInitialWorkspace(): Promise<void> {
  const { requestedRootPath, unusableRootPath, showHelp } = parseLaunchArguments(userArguments());
  if (showHelp) {
    await dialog.showMessageBox({ type: "info", title: "知识环", message: LAUNCH_USAGE, buttons: ["知道了"] });
  }
  if (unusableRootPath) {
    warnAboutUnusablePath(unusableRootPath);
  }
  if (requestedRootPath) {
    await workspace.open(requestedRootPath);
    return;
  }
  await workspace.restore();
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(WINDOW_OPTIONS);
  window.webContents.on("console-message", (details) => {
    console.error("[renderer]", details.sourceId + ":" + details.lineNumber, details.message);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error("[renderer-load]", errorCode, errorDescription, validatedUrl);
  });
  // Closing parks the app in the tray: reopening is then instant, and the
  // index and conversation stay in memory. Quitting is a tray menu item.
  window.on("close", (event) => {
    if (isQuitting || !trayController) {
      return;
    }
    event.preventDefault();
    hideMainWindow();
  });
  void window.loadFile(join(__dirname, "renderer", "index.html")).catch((error) => {
    console.error("[renderer-load]", error);
    dialog.showErrorBox("无法加载界面", error instanceof Error ? error.message : String(error));
  });
  return window;
}

function getWorkspaceStatePath(): string {
  return join(app.getPath("userData"), "workspace.json");
}

function getDesktopEnvPath(): string {
  return join(app.getPath("userData"), ".env");
}

function getSessionStatePath(): string {
  return join(app.getPath("userData"), "sessions.json");
}

async function saveWorkspacePath(rootPath: string): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(getWorkspaceStatePath(), JSON.stringify({ rootPath }, null, 2), "utf8");
}

async function readSessionStates(): Promise<Record<string, AgentSessionStoreState>> {
  try {
    const raw = await readFile(getSessionStatePath(), "utf8");
    const parsed = JSON.parse(raw) as { byWorkspace?: Record<string, AgentSessionStoreState> };
    return parsed.byWorkspace ?? {};
  } catch {
    return {};
  }
}

async function writeSessionStates(states: Record<string, AgentSessionStoreState>): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(getSessionStatePath(), JSON.stringify({ byWorkspace: states }, null, 2), "utf8");
}

function getAttachmentStatePath(): string {
  return join(app.getPath("userData"), "attachments.json");
}

function getIndexSnapshotPath(): string {
  return join(app.getPath("userData"), "index-snapshot.json");
}

async function readAttachmentStates(): Promise<Record<string, DesktopAttachmentState>> {
  try {
    const raw = await readFile(getAttachmentStatePath(), "utf8");
    const parsed = JSON.parse(raw) as { byWorkspace?: Record<string, DesktopAttachmentState> };
    return parsed.byWorkspace ?? {};
  } catch {
    return {};
  }
}

async function readAttachmentState(rootPath: string): Promise<DesktopAttachmentState> {
  const states = await readAttachmentStates();
  return states[rootPath] ?? {};
}

async function writeAttachmentStates(states: Record<string, DesktopAttachmentState>): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(getAttachmentStatePath(), JSON.stringify({ byWorkspace: states }, null, 2), "utf8");
}

async function ensureDesktopEnvFile(): Promise<void> {
  try {
    const current = await readFile(getDesktopEnvPath(), "utf8");
    const normalized = migrateDesktopEnv(current);
    if (normalized !== current) {
      await writeFile(getDesktopEnvPath(), normalized, "utf8");
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(getDesktopEnvPath(), DESKTOP_ENV_TEMPLATE, "utf8");
  }
}

function migrateDesktopEnv(contents: string): string {
  const lines = contents
    .split(/\r?\n/u)
    .filter((line) => !/^GLM_(?:API_KEY|MODEL)\s*=/iu.test(line) && !/GLM.*(?:图片|PDF|解析)/iu.test(line));
  if (!lines.some((line) => /^DEEPSEEK_VISION_MODEL\s*=/iu.test(line))) {
    const modelIndex = lines.findIndex((line) => /^DEEPSEEK_MODEL\s*=/iu.test(line));
    lines.splice(Math.max(0, modelIndex + 1), 0, "DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp");
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readDesktopAgentConfiguration(): Promise<{
  deepSeekApiKey: string;
  deepSeekModel: string;
  deepSeekVisionModel: string;
  tavilyApiKey: string;
  requestTimeoutMs: number;
  webSearchResultLimit: number;
  webFallbackPolicy: WebFallbackPolicy;
}> {
  await ensureDesktopEnvFile();
  const contents = await readFile(getDesktopEnvPath(), "utf8");
  return {
    deepSeekApiKey: readEnvValue(contents, "DEEPSEEK_API_KEY") ?? "",
    deepSeekModel: readEnvValue(contents, "DEEPSEEK_MODEL") ?? "deepseek-v4-flash",
    deepSeekVisionModel: readEnvValue(contents, "DEEPSEEK_VISION_MODEL") ?? "deepseek-v4-flash-vision-exp",
    tavilyApiKey: readEnvValue(contents, "TAVILY_API_KEY") ?? "",
    requestTimeoutMs: 60_000,
    webSearchResultLimit: 5,
    webFallbackPolicy: parseWebFallbackPolicy(readEnvValue(contents, "WEB_FALLBACK_POLICY"))
  };
}

async function getProviderStatus(): Promise<ProviderStatus> {
  await ensureDesktopEnvFile();
  const contents = await readFile(getDesktopEnvPath(), "utf8");
  return {
    deepSeekConfigured: Boolean(readEnvValue(contents, "DEEPSEEK_API_KEY")),
    tavilyConfigured: Boolean(readEnvValue(contents, "TAVILY_API_KEY")),
    deepSeekVisionConfigured: Boolean(readEnvValue(contents, "DEEPSEEK_API_KEY"))
  };
}

async function openDesktopEnvFile(): Promise<void> {
  await ensureDesktopEnvFile();
  const error = await shell.openPath(getDesktopEnvPath());
  if (error) {
    throw new Error("无法打开本地模型配置文件：" + error);
  }
}

function parseWebFallbackPolicy(value: string | null): WebFallbackPolicy {
  return value === "disabled" || value === "always-with-warning" || value === "stable-only"
    ? value
    : "stable-only";
}

function isInternalWorkspacePath(path: string): boolean {
  return path.startsWith(".obsidian/") || path.startsWith(".knowledge-loop-agent/");
}

function actionResponse(
  intent: Exclude<ReturnType<typeof detectDesktopAgentIntent>["intent"], "answer">,
  content: string,
  extra: Pick<DesktopAgentResponse, "wikiVerification" | "sessionStatus" | "profilePath" | "assistantStatePath"> = {}
): DesktopAgentResponse {
  return {
    content,
    intent,
    mode: "local",
    evidenceComplete: true,
    sources: [],
    ...extra
  };
}

function formatIntentAction(intent: Exclude<ReturnType<typeof detectDesktopAgentIntent>["intent"], "answer">): string {
  const names: Record<typeof intent, string> = {
    "start-session": "开始会话",
    "close-session": "结束会话",
    "open-profile": "查看用户画像",
    "remember-profile": "更新用户画像",
    "forget-profile": "遗忘用户画像",
    "open-assistant-state": "查看助手状态",
    "set-current-focus": "设置当前重点",
    "compile-wiki": "编译 LLM Wiki",
    "expand-wiki": "补全 LLM Wiki",
    "inspect-wiki-sources": "检查 Wiki 来源",
    "process-images": "解析图片",
    "format-clipboard": "整理剪贴板",
    "complete-relations": "补全笔记关联",
    "verify-wiki": "联网核验 Wiki"
  };
  return names[intent];
}

ipcMain.handle("workspace:choose", () => workspace.choose());
ipcMain.handle("workspace:migrate-obsidian", () => workspace.migrateFromObsidian());
ipcMain.handle("workspace:get", () => workspace.getState());
ipcMain.handle("provider:get-status", () => getProviderStatus());
ipcMain.handle("provider:open-config", () => openDesktopEnvFile());
ipcMain.handle("agent:answer", (_event, question: string, context: DesktopAgentRequestContext | undefined) => workspace.answer(question, context));
ipcMain.handle(
  "agent:answer-stream",
  (event, question: string, context: DesktopAgentRequestContext | undefined, runId: string) =>
    workspace.answerStream(question, context ?? {}, runId ?? "", event.sender)
);
ipcMain.handle("agent:answer-cancel", (_event, runId: string) => workspace.cancelAnswerStream(runId ?? ""));
ipcMain.handle("answer:save", (_event, action, subject, content, sources) => workspace.saveAnswer(action, subject, content, sources));
ipcMain.handle("wiki:create-update-preview", (_event, id: string) => workspace.createWikiUpdatePreview(id));
ipcMain.handle("knowledge:search", (_event, query: string) => workspace.search(query));
ipcMain.handle("knowledge:list-notes", () => workspace.listNotes());
ipcMain.handle("knowledge:preview-source", (_event, path: string) => workspace.previewSource(path));
ipcMain.handle("knowledge:open-source", (_event, path: string) => workspace.openSource(path));
ipcMain.handle("agent:plan-run", (_event, goal: string, notePath?: string) => {
  if (typeof notePath === "string") {
    workspace.setActiveNote(notePath);
  }
  return workspace.planRun(goal);
});
ipcMain.handle("agent:run-step", (_event, runId: string, stepId: string) => workspace.runStep(runId, stepId));
ipcMain.handle("agent:skip-step", (_event, runId: string, stepId: string) => workspace.skipStep(runId, stepId));
ipcMain.handle("agent:cancel-run", (_event, runId: string) => workspace.cancelRun(runId));
ipcMain.handle("write:get-previews", () => workspace.getWritePreviews());
ipcMain.handle("write:apply-previews", () => workspace.applyWritePreviews());

// One instance only: opening the app twice would index the same vault twice,
// and a shortcut is bound to be clicked while the window is already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    void switchToRequestedVault(argv).catch((error: unknown) => {
      console.error("[second-instance]", error);
      dialog.showErrorBox("知识环", error instanceof Error ? error.message : String(error));
    });
  });

  app.whenReady().then(async () => {
    app.setName("知识环");
    Menu.setApplicationMenu(null);
    await ensureDesktopEnvFile();
    await openInitialWorkspace();
    createWindow();

    try {
      trayController = createTrayController({
        summon: summonMainWindow,
        toggle: toggleMainWindow,
        isVisible: () => BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        chooseVault: () => {
          // The picker is easier to relate to with the window behind it, and the
          // picked vault has to be announced to a renderer that exists.
          summonMainWindow();
          void workspace.choose().catch((error: unknown) => {
            console.error("[tray]", error);
          });
        },
        quit: () => app.quit()
      });
    } catch (error) {
      // A missing tray icon is a degraded app, not a failed start — the window
      // keeps working and closing it quits as before.
      console.error("[tray] 托盘创建失败：", error);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[startup]", error);
    dialog.showErrorBox("知识环启动失败", `无法初始化本地应用数据目录：${message}`);
    app.quit();
  });
}

// The tray owns the lifetime now, so closing every window no longer quits —
// otherwise hiding on close and quitting on close would contradict each other.
app.on("before-quit", () => {
  isQuitting = true;
  trayController?.dispose();
});

app.on("window-all-closed", () => {
  // Without a tray there is nothing left to bring the app back with.
  if (!trayController) {
    app.quit();
  }
});
