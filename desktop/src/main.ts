import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createDefaultPermissionPolicy,
  PolicyEngine
} from "../../src/policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "../../src/desktop/node-file-system-knowledge-repository";
import {
  PortableMarkdownKnowledgeIndex,
  type MarkdownIndexSummary
} from "../../src/indexing/portable-markdown-knowledge-index";
import { DesktopAgentService } from "../../src/desktop/desktop-agent-service";
import { DesktopSessionService } from "../../src/desktop/desktop-session-service";
import { DesktopWriteService } from "../../src/desktop/desktop-write-service";
import { DesktopWikiService } from "../../src/desktop/desktop-wiki-service";
import { DesktopAttachmentService, type DesktopAttachmentState } from "../../src/desktop/desktop-attachment-service";
import { DesktopRelationService } from "../../src/desktop/desktop-relation-service";
import { DesktopWikiVerificationService } from "../../src/desktop/desktop-wiki-verification-service";
import { detectDesktopAgentIntent } from "../../src/desktop/desktop-intent-router";
import { formatPastedContent } from "../../src/paste/paste-formatter";
import type { AgentSessionStoreState } from "../../src/memory/agent-memory";
import { readEnvValue } from "../../src/services/env";
import type { WebFallbackPolicy } from "../../src/services/web-answer-policy";
import {
  getStandaloneWorkspaceName,
  migrateObsidianVault,
  previewObsidianVaultMigration
} from "../../src/desktop/obsidian-vault-migrator";
import type {
  DesktopSearchHit,
  DesktopAgentResponse,
  DesktopAgentRequestContext,
  DesktopNoteEntry,
  ObsidianMigrationState,
  ProviderStatus,
  SessionStatus,
  WorkspaceState
} from "./shared/desktop-api";

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
  private wikiVerificationService: DesktopWikiVerificationService | null = null;
  private sessionStates: Record<string, AgentSessionStoreState> = {};
  private didLoadSessionStates = false;
  private readonly policy = new PolicyEngine(createDefaultPermissionPolicy());

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

  async answer(question: string, context: DesktopAgentRequestContext = {}): Promise<DesktopAgentResponse> {
    if (!this.index) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const route = detectDesktopAgentIntent({ question, activeNotePath: context.activeNotePath });
    if (route.intent !== "answer") {
      return this.executeIntent(route.intent, route.subject, route.notePath, route.sessionTitle);
    }
    const memoryContext = this.sessionService
      ? (await this.sessionService.getMemoryContext()).content
      : "";
    const agent = new DesktopAgentService(this.index, {
      ...(await readDesktopAgentConfiguration()),
      memoryContext,
      attachmentSearch: this.attachmentService?.search.bind(this.attachmentService)
    });
    const answer = await agent.answer(question);
    if (this.sessionService) {
      await this.sessionService.appendExchange(question, answer.content);
      await this.persistSessionState();
    }
    return { ...answer, intent: "answer" };
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
      case "compile-wiki": {
        if (!subject) {
          return actionResponse(intent, "请说明要编译的 Wiki 主题，例如“编译 LangGraph LLM Wiki”。");
        }
        const result = await this.compileWiki(subject);
        return actionResponse(intent, `已编译 LLM Wiki「${result.topic}」：使用 ${result.sourceCount} 条本地资料，写入 ${result.pageCount} 个页面。`);
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

  private async compileWiki(topic: string): Promise<{
    topic: string;
    pageCount: number;
    sourceCount: number;
    updatedCount: number;
    paths: string[];
  }> {
    if (!this.repository || !this.index) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, configuration);
    const result = await this.wikiService.compile(topic);
    this.summary = await this.index.rebuild(this.policy);
    return result;
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
    const result = await this.relationService.complete(path);
    this.summary = await this.index.rebuild(this.policy);
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

  private async open(rootPath: string): Promise<WorkspaceState> {
    const repository = new NodeFileSystemKnowledgeRepository(rootPath);
    const index = new PortableMarkdownKnowledgeIndex(
      repository,
      (path) =>
        path.startsWith(".obsidian/") ||
        path.startsWith(".knowledge-loop-agent/") ||
        path.startsWith("00 Inbox/Agent/")
    );
    const summary = await index.rebuild(this.policy);

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

const workspace = new DesktopKnowledgeWorkspace();

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(WINDOW_OPTIONS);
  window.webContents.on("console-message", (details) => {
    console.error("[renderer]", details.sourceId + ":" + details.lineNumber, details.message);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error("[renderer-load]", errorCode, errorDescription, validatedUrl);
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
  extra: Pick<DesktopAgentResponse, "wikiVerification" | "sessionStatus" | "profilePath"> = {}
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

ipcMain.handle("workspace:choose", () => workspace.choose());
ipcMain.handle("workspace:migrate-obsidian", () => workspace.migrateFromObsidian());
ipcMain.handle("workspace:get", () => workspace.getState());
ipcMain.handle("provider:get-status", () => getProviderStatus());
ipcMain.handle("provider:open-config", () => openDesktopEnvFile());
ipcMain.handle("agent:answer", (_event, question: string, context: DesktopAgentRequestContext | undefined) => workspace.answer(question, context));
ipcMain.handle("answer:save", (_event, action, subject, content, sources) => workspace.saveAnswer(action, subject, content, sources));
ipcMain.handle("wiki:create-update-preview", (_event, id: string) => workspace.createWikiUpdatePreview(id));
ipcMain.handle("knowledge:search", (_event, query: string) => workspace.search(query));
ipcMain.handle("knowledge:list-notes", () => workspace.listNotes());
ipcMain.handle("knowledge:preview-source", (_event, path: string) => workspace.previewSource(path));
ipcMain.handle("knowledge:open-source", (_event, path: string) => workspace.openSource(path));

app.whenReady().then(async () => {
  app.setName("知识环");
  Menu.setApplicationMenu(null);
  await ensureDesktopEnvFile();
  await workspace.restore();
  createWindow();

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
