import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AuditTrail, type AuditEvent } from "./audit/audit-trail";
import {
  createManualCaptureProposal,
  createKnowledgeSystemProposal,
  createSourcedCaptureProposal,
  type AgentActionProposal,
  type ManualCaptureAction
} from "./actions/action-proposal";
import {
  VaultActionService,
  type WritePreview,
  type WriteResult
} from "./actions/vault-action-service";
import {
  createDefaultPermissionPolicy,
  PolicyEngine,
  type PolicyAction,
  type PermissionPolicy,
  type PolicyDecision
} from "./policy/policy-engine";
import { DeepSeekClient } from "./services/deepseek-client";
import { GlmClient } from "./services/glm-client";
import { NoUsableWebResultsError, TavilyClient } from "./services/tavily-client";
import { InFlightRequestGate } from "./services/in-flight-request-gate";
import {
  getNoWebResultMessage,
  shouldUseGeneralKnowledgeFallback,
  type WebFallbackPolicy
} from "./services/web-answer-policy";
import {
  DEFAULT_SETTINGS,
  KnowledgeLoopSettingTab,
  type KnowledgeLoopSettings
} from "./settings";
import {
  MarkdownKnowledgeIndex,
  type MarkdownIndexSummary
} from "./indexing/markdown-knowledge-index";
import type { MarkdownSearchResult } from "./indexing/markdown-search";
import {
  AttachmentIndex,
  getAttachmentMimeType,
  type AttachmentIndexRecord,
  type AttachmentScanSummary
} from "./indexing/attachment-index";
import {
  AttachmentBatchQueue,
  type AttachmentBatchLimits,
  type AttachmentBatchQueueState,
  type AttachmentBatchStatus
} from "./indexing/attachment-batch-queue";
import { hashArrayBuffer } from "./domain/content-hash";
import {
  renderWebAnswerCaptureContent,
  type WebSearchResult
} from "./services/web-search";
import { ENV_TEMPLATE, readEnvValue } from "./services/env";
import { AGENT_VIEW_TYPE, KnowledgeLoopAgentView } from "./views/agent-view";
import {
  renderKnowledgeMapContent,
  renderKnowledgeNodeContent,
  selectSourcesForKnowledgeMap,
  type KnowledgeIntegrationSession,
  type KnowledgeIntegrationSource,
  type KnowledgeMapNode
} from "./integration/knowledge-system";
import { formatPastedContent } from "./paste/paste-formatter";
import { PasteFormatPreviewModal } from "./views/paste-format-preview-modal";
import {
  createGardenerSources,
  type GardenerPlan
} from "./gardener/knowledge-gardener";
import {
  createAgentRun,
  type AgentRun,
  type AgentRunPlan,
  type AgentRunStep,
  type AgentToolCall
} from "./runtime/agent-runtime";
import { AgentRunStore } from "./runtime/agent-run-store";
import {
  createAgentToolRegistry,
  type AgentToolExecutionResult
} from "./runtime/agent-tools";
import {
  AgentSessionStore,
  applyProfileMemorySuggestions,
  buildAgentMemoryContext,
  buildAgentProfileSkeleton,
  createAgentMemorySource,
  getAgentProfilePath,
  isAgentMemoryPath,
  parseAgentSessionTranscript,
  renderNewAgentSession,
  renderSessionExchange,
  renderSessionToolResult,
  type AgentSession,
  type AgentSessionMessage,
  type AgentSessionStoreState
} from "./memory/agent-memory";

interface PersistedPluginData {
  settings?: Partial<KnowledgeLoopSettings>;
  auditEvents?: AuditEvent[];
  attachmentRecords?: AttachmentIndexRecord[];
  attachmentBatchQueue?: AttachmentBatchQueueState;
  agentRuns?: AgentRun[];
  agentSessions?: AgentSessionStoreState;
}

type PermissionPolicyPatch = Omit<Partial<PermissionPolicy>, "enabled"> & {
  enabled?: Partial<Record<PolicyAction, boolean>>;
};

export interface WebSearchRun {
  answer: string;
  sources: WebSearchResult[];
  mode: "web-grounded" | "deepseek-general";
  fallbackReason?: "no-usable-web-results";
  autoAppendedPath?: string;
  autoAppendError?: string;
}

export interface ProviderKeyStatus {
  deepSeek: boolean;
  glm: boolean;
  tavily: boolean;
}

export interface AttachmentBatchRunResult {
  indexed: number;
  failed: number;
  pending: number;
  stoppedReason: "completed" | "paused" | "budget-exhausted";
  lastPath?: string;
}

type RuntimeAnswerArtifact =
  | { kind: "vault"; query: string; content: string; sources: MarkdownSearchResult[] }
  | { kind: "web"; query: string; content: string; sources: WebSearchResult[] };

export interface AgentSessionPreview {
  session: AgentSession;
  preview: WritePreview;
}

export interface AgentMemoryStatus {
  profilePath: string;
  profileExists: boolean;
  activeSession: AgentSession | null;
  sessionCount: number;
}

export default class KnowledgeLoopAgentPlugin extends Plugin {
  settings: KnowledgeLoopSettings = DEFAULT_SETTINGS;
  private deepSeekApiKey = "";
  private glmApiKey = "";
  private tavilyApiKey = "";
  private providerKeyStatus: ProviderKeyStatus = { deepSeek: false, glm: false, tavily: false };
  private auditTrail = new AuditTrail();
  private markdownIndex!: MarkdownKnowledgeIndex;
  private attachmentIndex = new AttachmentIndex();
  private attachmentBatchQueue = new AttachmentBatchQueue();
  private recoveredAttachmentCount = 0;
  private attachmentBatchRun: Promise<AttachmentBatchRunResult> | null = null;
  private agentRunStore = new AgentRunStore();
  private agentSessionStore = new AgentSessionStore();
  private agentToolRegistry!: ReturnType<typeof createAgentToolRegistry>;
  private runtimeArtifacts: {
    answer?: RuntimeAnswerArtifact;
    knowledgeMap?: KnowledgeIntegrationSession;
    writePreview?: WritePreview;
  } = {};
  private vaultActionService!: VaultActionService;
  private saveQueue: Promise<void> = Promise.resolve();
  private requestGate = new InFlightRequestGate();

  async onload(): Promise<void> {
    await this.loadSettings();
    if (this.recoveredAttachmentCount > 0) {
      await this.savePluginData();
      new Notice(`已恢复 ${this.recoveredAttachmentCount} 个在关闭前中断的附件任务。`);
    }
    await this.reloadApiKeyFromEnv();
    this.markdownIndex = new MarkdownKnowledgeIndex(
      this.app.vault,
      (path) => isAgentMemoryPath(path, this.settings.permissions.agentMemoryFolder)
    );
    this.vaultActionService = new VaultActionService(
      this.app.vault,
      () => this.getPolicyEngine(),
      () => ({
        inboxFolder: this.settings.permissions.inboxFolder,
        dailyFolder: this.settings.permissions.dailyFolder,
        knowledgeSystemFolder: this.settings.permissions.knowledgeSystemFolder,
        agentMemoryFolder: this.settings.permissions.agentMemoryFolder
      }),
      (decision) => this.recordPolicyDecision(decision)
    );
    this.agentToolRegistry = this.createRuntimeToolRegistry();

    this.registerView(
      AGENT_VIEW_TYPE,
      (leaf) => new KnowledgeLoopAgentView(leaf, this)
    );

    this.addRibbonIcon("brain-circuit", "Open Knowledge Loop Agent", () => {
      void this.activateAgentView();
    });

    this.addCommand({
      id: "open-agent-view",
      name: "Open agent panel",
      callback: () => void this.activateAgentView()
    });

    this.addCommand({
      id: "test-glm-connection",
      name: "Test GLM vision connection",
      callback: () => void this.testGlmConnection()
    });

    this.addCommand({
      id: "test-deepseek-connection",
      name: "Test DeepSeek connection",
      callback: () => void this.testDeepSeekConnection()
    });

    this.addCommand({
      id: "paste-as-normalized-markdown",
      name: "Paste as normalized Markdown",
      editorCallback: (editor) => {
        void this.formatClipboardIntoEditor(editor);
      }
    });

    this.addCommand({
      id: "repair-selected-formatting",
      name: "Repair selected formatting with Agent",
      editorCallback: (editor) => {
        void this.repairSelectedFormatting(editor);
      }
    });

    this.addSettingTab(new KnowledgeLoopSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          void this.markdownIndex.refreshFile(file, this.getPolicyEngine());
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.markdownIndex.remove(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || !this.markdownIndex.has(oldPath)) {
          return;
        }
        this.markdownIndex.remove(oldPath);
        void this.markdownIndex.refreshFile(file, this.getPolicyEngine(), true);
      })
    );
  }

  async onunload(): Promise<void> {
    this.attachmentBatchQueue.setRunning(false);
    await this.savePluginData();
    this.runtimeArtifacts = {};
    this.deepSeekApiKey = "";
    this.glmApiKey = "";
    this.tavilyApiKey = "";
    this.providerKeyStatus = { deepSeek: false, glm: false, tavily: false };
    await this.app.workspace.detachLeavesOfType(AGENT_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    const rawData = (await this.loadData()) as unknown;
    const persisted: PersistedPluginData = isPersistedPluginData(rawData)
      ? rawData
      : { settings: isRecord(rawData) ? (rawData as Partial<KnowledgeLoopSettings>) : {} };
    const savedSettings = persisted.settings ?? {};
    const savedPermissions: Partial<PermissionPolicy> = savedSettings.permissions ?? {};

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...savedSettings,
      permissions: {
        ...createDefaultPermissionPolicy(),
        ...savedPermissions,
        enabled: {
          ...createDefaultPermissionPolicy().enabled,
          ...savedPermissions.enabled
        }
      }
    };
    this.settings.webFallbackPolicy = normalizeWebFallbackPolicy(this.settings.webFallbackPolicy);
    this.auditTrail = new AuditTrail(persisted.auditEvents ?? []);
    this.attachmentIndex = new AttachmentIndex(persisted.attachmentRecords ?? []);
    this.recoveredAttachmentCount = this.attachmentIndex.resumeInterrupted();
    this.attachmentBatchQueue = new AttachmentBatchQueue(persisted.attachmentBatchQueue);
    this.agentRunStore = new AgentRunStore(persisted.agentRuns ?? []);
    this.agentSessionStore = new AgentSessionStore(persisted.agentSessions);
  }

  async updateSettings(patch: Partial<KnowledgeLoopSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    if (patch.permissions) {
      this.markdownIndex?.clear();
    }
    await this.savePluginData();
  }

  async updatePermissionPolicy(patch: PermissionPolicyPatch): Promise<void> {
    const current = this.settings.permissions;
    await this.updateSettings({
      permissions: {
        ...current,
        ...patch,
        enabled: {
          ...current.enabled,
          ...patch.enabled
        }
      }
    });
  }

  async resetPermissionPolicy(): Promise<void> {
    await this.updateSettings({ permissions: createDefaultPermissionPolicy() });
  }

  hasDeepSeekApiKey(): boolean {
    return Boolean(this.deepSeekApiKey.trim());
  }

  hasGlmApiKey(): boolean {
    return Boolean(this.glmApiKey.trim());
  }

  hasTavilyApiKey(): boolean {
    return Boolean(this.tavilyApiKey.trim());
  }

  getProviderKeyStatus(): ProviderKeyStatus {
    return { ...this.providerKeyStatus };
  }

  getEnvFilePath(): string {
    return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/.env`;
  }

  async reloadApiKeyFromEnv(): Promise<ProviderKeyStatus> {
    const envPath = this.getEnvFilePath();
    if (!(await this.app.vault.adapter.exists(envPath))) {
      await this.app.vault.adapter.write(envPath, ENV_TEMPLATE);
      this.deepSeekApiKey = "";
      this.glmApiKey = "";
      this.tavilyApiKey = "";
      this.providerKeyStatus = { deepSeek: false, glm: false, tavily: false };
      return this.getProviderKeyStatus();
    }

    const contents = await this.app.vault.adapter.read(envPath);
    this.deepSeekApiKey = readEnvValue(contents, "DEEPSEEK_API_KEY") ?? "";
    this.glmApiKey = readEnvValue(contents, "GLM_API_KEY") ?? "";
    this.tavilyApiKey = readEnvValue(contents, "TAVILY_API_KEY") ?? "";
    this.providerKeyStatus = {
      deepSeek: this.hasDeepSeekApiKey(),
      glm: this.hasGlmApiKey(),
      tavily: this.hasTavilyApiKey()
    };
    return this.getProviderKeyStatus();
  }

  async testGlmConnection(): Promise<void> {
    if (!this.hasGlmApiKey()) {
      new Notice("请在插件目录的 .env 文件中填写 GLM_API_KEY，然后重新加载。 ");
      return;
    }

    new Notice("正在测试 GLM 连通性…");
    try {
      const result = await this.requestGate.run("glm-connection-test", () => this.getGlmClient().testConnection());
      this.auditTrail.recordProviderTest("succeeded", `GLM 连通性测试成功：${result.model}`);
      await this.savePluginData();
      new Notice(`GLM 连接成功：${result.model}${result.requestId ? `（${result.requestId}）` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "发生未知错误。";
      this.auditTrail.recordProviderTest("failed", "GLM 连通性测试失败。详情请查看通知提示。");
      await this.savePluginData();
      new Notice(`GLM 连接失败：${message}`);
    }
  }

  async testDeepSeekConnection(): Promise<void> {
    if (!this.hasDeepSeekApiKey()) {
      new Notice("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
      return;
    }

    new Notice("正在测试 DeepSeek 连通性…");
    try {
      const result = await this.requestGate.run("deepseek-connection-test", () => this.getDeepSeekClient().testConnection());
      this.auditTrail.recordProviderTest("succeeded", `DeepSeek 连通性测试成功：${result.model}`);
      await this.savePluginData();
      new Notice(`DeepSeek 连接成功：${result.model}${result.requestId ? `（${result.requestId}）` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "发生未知错误。";
      this.auditTrail.recordProviderTest("failed", "DeepSeek 连通性测试失败。详情请查看通知提示。");
      await this.savePluginData();
      new Notice(`DeepSeek 连接失败：${message}`);
    }
  }

  recordPolicyDecision(decision: PolicyDecision): void {
    this.auditTrail.recordPolicyDecision(decision);
    void this.savePluginData();
  }

  getRecentAuditEvents(limit = 5): AuditEvent[] {
    return this.auditTrail.getRecent(limit);
  }

  async rebuildMarkdownIndex(): Promise<MarkdownIndexSummary> {
    const summary = await this.markdownIndex.rebuild(this.getPolicyEngine());
    new Notice(`Markdown 索引完成：${summary.indexedFiles} 个文件，${summary.chunkCount} 个片段。`);
    return summary;
  }

  searchKnowledge(query: string): MarkdownSearchResult[] {
    return [
      ...this.markdownIndex.search(query),
      ...this.attachmentIndex.search(query, this.getPolicyEngine())
    ]
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);
  }

  async scanAttachments(): Promise<AttachmentScanSummary> {
    const summary = this.attachmentIndex.scan(this.app.vault.getFiles(), this.getPolicyEngine());
    await this.savePluginData();
    new Notice(`附件扫描完成：新增/更新队列 ${summary.queued}，未变化 ${summary.unchanged}，未授权 ${summary.blocked}。`);
    return summary;
  }

  getAttachmentBatchStatus(): AttachmentBatchStatus {
    return this.attachmentBatchQueue.getStatus(
      this.attachmentIndex.pendingCount,
      this.getAttachmentBatchLimits()
    );
  }

  async pauseAttachmentBatch(): Promise<AttachmentBatchStatus> {
    this.attachmentBatchQueue.pause();
    await this.savePluginData();
    return this.getAttachmentBatchStatus();
  }

  async resumeAttachmentBatch(): Promise<AttachmentBatchStatus> {
    this.attachmentBatchQueue.resume();
    await this.savePluginData();
    return this.getAttachmentBatchStatus();
  }

  async processAttachmentBatch(): Promise<AttachmentBatchRunResult> {
    if (this.attachmentBatchRun) {
      return this.attachmentBatchRun;
    }

    let shared: Promise<AttachmentBatchRunResult>;
    shared = this.runAttachmentBatch().finally(() => {
      if (this.attachmentBatchRun === shared) {
        this.attachmentBatchRun = null;
      }
    });
    this.attachmentBatchRun = shared;
    return shared;
  }

  async processNextAttachment(): Promise<{ path: string; kind: string; textLength: number } | null> {
    if (!this.hasGlmApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 GLM_API_KEY，然后重新加载。 ");
    }
    const record = this.attachmentIndex.nextPending();
    if (!record) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (!(file instanceof TFile)) {
      this.attachmentIndex.markFailed(record.path, "附件已不存在或不是文件。");
      await this.savePluginData();
      throw new Error("待处理附件已不存在；索引队列已更新。 ");
    }

    const indexDecision = this.getPolicyEngine().decide({ action: "indexAttachments", targetPath: file.path });
    const uploadDecision = this.getPolicyEngine().decide({ action: "sendToGlm", targetPath: file.path });
    this.recordPolicyDecision(indexDecision);
    this.recordPolicyDecision(uploadDecision);
    if (!indexDecision.allowed || !uploadDecision.allowed) {
      this.attachmentIndex.markFailed(file.path, "附件索引或 GLM 上传权限未获授权。");
      await this.savePluginData();
      throw new Error("附件索引或 GLM 上传权限未获授权。 ");
    }

    const maxBytes = record.kind === "pdf" ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
    if (file.stat.size > maxBytes) {
      this.attachmentIndex.markFailed(file.path, `文件超过当前 ${Math.round(maxBytes / 1024 / 1024)} MB 处理上限。`);
      await this.savePluginData();
      throw new Error(`文件过大，当前处理上限为 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
    }

    const budget = this.attachmentBatchQueue.reserveAttempt(
      file.stat.size,
      this.getAttachmentBatchLimits()
    );
    if (!budget.allowed) {
      await this.savePluginData();
      throw new AttachmentBatchBlockedError(budget.blockedBy ?? "budget", budget.reason ?? "附件处理暂不可用。", budget.waitMs);
    }
    if (!this.attachmentIndex.markProcessing(file.path)) {
      await this.savePluginData();
      return null;
    }
    await this.savePluginData();

    try {
      const binary = await this.app.vault.readBinary(file);
      const base64 = arrayBufferToBase64(binary);
      const result = await this.requestGate.run(`glm-attachment:${file.path}`, () => record.kind === "pdf"
        ? this.getGlmClient().extractPdf(base64)
        : this.getGlmClient().describeImage(base64, getAttachmentMimeType(record.kind, file.extension))
      );
      this.attachmentIndex.markIndexed(file.path, {
        type: record.kind,
        pathOrUrl: file.path,
        locator: record.kind === "pdf" ? "document" : "image",
        contentHash: hashArrayBuffer(binary),
        parserVersion: result.parserVersion
      }, result.content);
      this.attachmentBatchQueue.markProcessed(file.path);
      this.auditTrail.recordModelRequest("succeeded", `GLM ${record.kind === "pdf" ? "OCR" : "视觉"}解析成功。`);
      await this.savePluginData();
      new Notice(`附件已索引：${file.path}`);
      return { path: file.path, kind: record.kind, textLength: result.content.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知附件解析错误。";
      this.attachmentIndex.markFailed(file.path, message);
      this.attachmentBatchQueue.markError(message);
      this.auditTrail.recordModelRequest("failed", `GLM ${record.kind === "pdf" ? "OCR" : "视觉"}解析失败。`);
      await this.savePluginData();
      throw error;
    }
  }

  private async runAttachmentBatch(): Promise<AttachmentBatchRunResult> {
    if (!this.hasGlmApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 GLM_API_KEY，然后重新加载。 ");
    }

    let indexed = 0;
    let failed = 0;
    let lastPath: string | undefined;
    let stoppedReason: AttachmentBatchRunResult["stoppedReason"] = "completed";
    this.attachmentBatchQueue.setRunning(true);
    await this.savePluginData();

    try {
      while (this.attachmentIndex.pendingCount > 0) {
        if (this.attachmentBatchQueue.isPaused()) {
          stoppedReason = "paused";
          break;
        }

        const delayMs = this.attachmentBatchQueue.getDelayMs();
        if (delayMs > 0) {
          await this.waitForAttachmentSlot(delayMs);
          continue;
        }

        try {
          const result = await this.processNextAttachment();
          if (!result) {
            break;
          }
          indexed += 1;
          lastPath = result.path;
        } catch (error) {
          if (error instanceof AttachmentBatchBlockedError) {
            if (error.kind === "rate-limit") {
              await this.waitForAttachmentSlot(error.waitMs ?? this.attachmentBatchQueue.getDelayMs());
              continue;
            }
            stoppedReason = error.kind === "paused" ? "paused" : "budget-exhausted";
            break;
          }
          failed += 1;
        }
      }
    } finally {
      this.attachmentBatchQueue.setRunning(false);
      await this.savePluginData();
    }

    return { indexed, failed, pending: this.attachmentIndex.pendingCount, stoppedReason, lastPath };
  }

  private createRuntimeToolRegistry(): ReturnType<typeof createAgentToolRegistry> {
    return createAgentToolRegistry({
      "index:rebuild-markdown": async () => {
        const summary = await this.rebuildMarkdownIndex();
        return { summary: `已索引 ${summary.indexedFiles} 个文件和 ${summary.chunkCount} 个片段。` };
      },
      "index:scan-attachments": async () => {
        const summary = await this.scanAttachments();
        return { summary: `附件扫描完成：已入队 ${summary.queued}，未变化 ${summary.unchanged}，未授权 ${summary.blocked}。` };
      },
      "index:process-attachments": async () => {
        const result = await this.processAttachmentBatch();
        if (result.stoppedReason === "budget-exhausted" || result.stoppedReason === "paused") {
          throw new RuntimeToolBlockedError(`附件批处理${result.stoppedReason === "paused" ? "已暂停" : "达到预算"}：已完成 ${result.indexed} 项，剩余 ${result.pending} 项。`);
        }
        return { summary: `附件批处理完成：成功 ${result.indexed} 项，失败 ${result.failed} 项。` };
      },
      "research:answer-vault": async ({ goal }) => {
        try {
          const answer = await this.answerFromKnowledge(goal);
          this.runtimeArtifacts.answer = { kind: "vault", query: goal, content: answer.content, sources: answer.sources };
          return { summary: `已生成带 ${answer.sources.length} 条本地来源的回答。`, artifact: "answer" };
        } catch (error) {
          if (error instanceof LocalKnowledgeUnavailableError) {
            return {
              summary: error.message,
              replanFeedback: error.replanFeedback,
              replanExclusions: [{ tool: "research", action: "answer-vault" }]
            };
          }
          throw error;
        }
      },
      "research:answer-web": async ({ goal }) => {
        const answer = await this.searchWeb(goal);
        this.runtimeArtifacts.answer = { kind: "web", query: goal, content: answer.answer, sources: answer.sources };
        return { summary: answer.mode === "web-grounded" ? `已生成联网回答：${answer.sources.length} 条网页来源。` : "联网无可用网页结果，已生成明确标识的通用回答。", artifact: "answer" };
      },
      "organize:maintenance-plan": async ({ goal }) => {
        const report = await this.analyzeKnowledgeMaintenance(goal);
        return { summary: `知识库维护分析完成：发现 ${report.findings.length} 项问题。${report.summary}` };
      },
      "organize:knowledge-map": async ({ goal }) => {
        const session = await this.createKnowledgeMap(goal, "search-results", goal);
        this.runtimeArtifacts.knowledgeMap = session;
        return { summary: `已生成知识地图：${session.map.nodes.length} 个节点。`, artifact: "knowledge-map" };
      },
      "organize:knowledge-node": async () => {
        const session = this.requireRuntimeKnowledgeMap();
        const node = session.map.nodes.find((candidate) => candidate.priority === "high") ?? session.map.nodes[0];
        if (!node) {
          throw new RuntimeToolBlockedError("本次知识地图没有可展开的节点。 ");
        }
        const preview = await this.previewKnowledgeNode(session, node.id);
        this.runtimeArtifacts.writePreview = preview;
        return { summary: `已为“${node.title}”生成写入预览，仍需单独确认写入。`, artifact: "write-preview" };
      },
      "note:preview-inbox": async () => this.createRuntimeNotePreview("createInboxNote"),
      "note:preview-daily": async () => this.createRuntimeNotePreview("appendDailyNote"),
      "note:preview-knowledge-map": async () => {
        const preview = await this.previewKnowledgeMap(this.requireRuntimeKnowledgeMap());
        this.runtimeArtifacts.writePreview = preview;
        return { summary: "已生成知识地图写入预览，仍需单独确认写入。", artifact: "write-preview" };
      },
      "editor:normalize-paste": async () => {
        await this.formatClipboardIntoEditor(this.requireActiveEditor());
        return { summary: "已打开规范化粘贴预览；确认后才会写入编辑器。" };
      },
      "editor:repair-selection": async () => {
        await this.repairSelectedFormatting(this.requireActiveEditor());
        return { summary: "已请求选区格式修复；请在预览中确认是否替换。" };
      },
      "system:diagnose": async () => ({ summary: this.describeRuntimeStatus() }),
      "system:test-deepseek": async () => {
        await this.testDeepSeekConnection();
        return { summary: "已完成 DeepSeek 连通性测试；结果已写入审计记录。" };
      },
      "system:test-glm": async () => {
        await this.testGlmConnection();
        return { summary: "已完成 GLM 连通性测试；结果已写入审计记录。" };
      }
    });
  }

  private requireRuntimeKnowledgeMap(): KnowledgeIntegrationSession {
    if (!this.runtimeArtifacts.knowledgeMap) {
      throw new RuntimeToolBlockedError("此步骤需要本次运行先生成知识地图；运行重启后请重新生成。 ");
    }
    return this.runtimeArtifacts.knowledgeMap;
  }

  private requireActiveEditor(): Editor {
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!editor) {
      throw new RuntimeToolBlockedError("此步骤需要在 Obsidian 中打开一个可编辑的 Markdown 笔记。 ");
    }
    return editor;
  }

  private async createRuntimeNotePreview(type: ManualCaptureAction): Promise<AgentToolExecutionResult> {
    const answer = this.runtimeArtifacts.answer;
    if (!answer) {
      throw new RuntimeToolBlockedError("此步骤需要本次运行先生成问答结果；运行重启后请重新获取回答。 ");
    }
    const preview = answer.kind === "vault"
      ? await this.suggestCaptureFromAnswer(type, answer.content, answer.sources)
      : answer.sources.length
        ? await this.previewWebSearchCapture(type, answer.query, answer.content, answer.sources)
        : null;
    if (!preview) {
      throw new RuntimeToolBlockedError("通用联网兜底回答没有可追溯网页来源，不能自动生成写入预览。 ");
    }
    this.runtimeArtifacts.writePreview = preview;
    return { summary: `已生成${type === "createInboxNote" ? " Inbox" : " Daily"}写入预览，仍需单独确认写入。`, artifact: "write-preview" };
  }

  private describeRuntimeStatus(): string {
    const providers = this.getProviderKeyStatus();
    const attachments = this.getAttachmentBatchStatus();
    return `服务：DeepSeek ${providers.deepSeek ? "已配置" : "未配置"}，GLM ${providers.glm ? "已配置" : "未配置"}，Tavily ${providers.tavily ? "已配置" : "未配置"}；附件队列待处理 ${attachments.pending}，状态 ${attachments.mode}；最近审计 ${this.getRecentAuditEvents(1)[0]?.reason ?? "暂无"}。`;
  }

  private async waitForAttachmentSlot(delayMs: number): Promise<void> {
    let remaining = delayMs;
    while (remaining > 0 && !this.attachmentBatchQueue.isPaused()) {
      const duration = Math.min(250, remaining);
      await new Promise<void>((resolve) => window.setTimeout(resolve, duration));
      remaining -= duration;
    }
  }

  getLatestAgentRunForActiveSession(): AgentRun | null {
    const session = this.agentSessionStore.getActive();
    return session ? this.agentRunStore.getLatestForSession(session.id) : null;
  }

  getRuntimeWritePreview(): WritePreview | null {
    return this.runtimeArtifacts.writePreview ?? null;
  }

  getAgentMemoryStatus(): AgentMemoryStatus {
    const profilePath = getAgentProfilePath(this.settings.permissions.agentMemoryFolder);
    return {
      profilePath,
      profileExists: this.app.vault.getAbstractFileByPath(profilePath) instanceof TFile,
      activeSession: this.agentSessionStore.getActive(),
      sessionCount: this.agentSessionStore.getAll().length
    };
  }

  getAgentSessions(): AgentSession[] {
    return this.agentSessionStore.getAll();
  }

  async getActiveSessionTranscript(): Promise<AgentSessionMessage[]> {
    const session = this.agentSessionStore.getActive();
    if (!session) {
      return [];
    }
    const file = this.app.vault.getAbstractFileByPath(session.path);
    if (!(file instanceof TFile)) {
      this.agentSessionStore.remove(session.id);
      await this.savePluginData();
      return [];
    }
    const decision = this.getPolicyEngine().decide({ action: "readVault", targetPath: session.path });
    this.recordPolicyDecision(decision);
    if (!decision.allowed) {
      throw new Error(`会话读取被权限策略拒绝：${decision.reason}`);
    }
    return parseAgentSessionTranscript(await this.app.vault.read(file));
  }

  async activateAgentSession(sessionId: string): Promise<AgentSession> {
    const session = this.agentSessionStore.get(sessionId);
    if (!session) {
      throw new Error("找不到指定的 Agent 会话。 ");
    }
    if (!(this.app.vault.getAbstractFileByPath(session.path) instanceof TFile)) {
      this.agentSessionStore.remove(session.id);
      await this.savePluginData();
      throw new Error("会话笔记已被删除，无法继续。 ");
    }
    const active = this.agentSessionStore.activate(session);
    await this.savePluginData();
    return active;
  }

  async previewAgentSession(title: string): Promise<AgentSessionPreview> {
    const session = this.agentSessionStore.create(title, this.settings.permissions.agentMemoryFolder);
    const content = renderNewAgentSession(session);
    const preview = await this.previewAction({
      type: "createAgentSession",
      title: session.title,
      sessionPath: session.path,
      content,
      sources: [createAgentMemorySource(session.path, content, "session-created")]
    });
    return { session, preview };
  }

  async confirmAgentSession(prepared: AgentSessionPreview): Promise<AgentSession> {
    if (
      prepared.preview.proposal.type !== "createAgentSession" ||
      prepared.preview.targetPath !== prepared.session.path
    ) {
      throw new Error("会话预览与目标不一致；请重新创建会话。 ");
    }
    const result = await this.applyWritePreview(prepared.preview);
    if (result.targetPath !== prepared.session.path) {
      throw new Error("会话目标在确认前发生变化；请重新创建会话。 ");
    }
    const session = this.agentSessionStore.activate(prepared.session);
    await this.savePluginData();
    return session;
  }

  async closeActiveAgentSession(): Promise<AgentSession | null> {
    await this.appendActiveSessionEntry(renderSessionToolResult("会话", "用户结束了当前会话。"));
    const session = this.agentSessionStore.closeActive();
    if (session) {
      await this.savePluginData();
    }
    return session;
  }

  async openAgentMemoryNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error("Agent 记忆笔记不存在或已被删除。 ");
    }
    await this.app.workspace.openLinkText(path, "", false);
  }

  async previewAgentProfile(): Promise<WritePreview> {
    const profilePath = getAgentProfilePath(this.settings.permissions.agentMemoryFolder);
    if (this.app.vault.getAbstractFileByPath(profilePath)) {
      throw new Error("用户画像已存在；请直接打开并编辑，或从当前会话生成更新预览。 ");
    }
    const content = buildAgentProfileSkeleton();
    return this.previewAction({
      type: "updateAgentProfile",
      content,
      sources: [createAgentMemorySource(profilePath, content, "profile-created")]
    });
  }

  async previewProfileMemoryUpdate(): Promise<WritePreview> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    const session = this.agentSessionStore.getActive();
    if (!session) {
      throw new Error("请先创建或切换到一个 Agent 会话。 ");
    }
    const sessionContent = await this.readMemoryForModel(session.path, "当前会话");
    if (!sessionContent.trim()) {
      throw new Error("当前会话没有可用于更新用户画像的内容。 ");
    }
    const profilePath = getAgentProfilePath(this.settings.permissions.agentMemoryFolder);
    const profileContent = await this.readMemoryForModel(profilePath, "用户画像", true);
    try {
      const suggestions = await this.requestGate.run(`agent-profile:${session.id}:${session.updatedAt}`, () =>
        this.getDeepSeekClient().suggestProfileMemory(profileContent, sessionContent)
      );
      if (!suggestions.length) {
        throw new Error("当前会话没有适合加入用户画像的稳定信息。 ");
      }
      const content = applyProfileMemorySuggestions(profileContent, suggestions, session.path);
      const preview = await this.previewAction({
        type: "updateAgentProfile",
        content,
        sources: [createAgentMemorySource(session.path, sessionContent, "profile-suggestion")]
      });
      this.auditTrail.recordModelRequest("succeeded", `DeepSeek 用户画像建议成功：${suggestions.length} 项。`);
      await this.savePluginData();
      return preview;
    } catch (error) {
      this.auditTrail.recordModelRequest("failed", "DeepSeek 用户画像建议失败。详情请查看通知提示。");
      await this.savePluginData();
      throw error;
    }
  }

  async startAgentRun(goal: string): Promise<AgentRun> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      throw new Error("请输入 Agent 运行目标。 ");
    }
    try {
      const memoryContext = await this.buildModelMemoryContext();
      const plan = await this.requestGate.run(`agent-runtime-plan:${normalizedGoal}`, () =>
        this.getDeepSeekClient().planAgentRun(normalizedGoal, memoryContext)
      );
      this.runtimeArtifacts = {};
      const run = this.agentRunStore.add(createAgentRun(
        normalizedGoal,
        plan,
        new Date(),
        this.agentSessionStore.getActive()?.id
      ));
      await this.appendActiveSessionEntry(renderSessionExchange(
        normalizedGoal,
        `已生成 Agent 运行计划：${plan.summary}\n\n${plan.steps.map((step, index) => `${index + 1}. ${step.title}：${step.reason}`).join("\n")}`
      ));
      this.auditTrail.recordAgentRun("succeeded", run.id, `Agent 运行计划已生成：${run.steps.length} 个有限步骤。`);
      await this.savePluginData();
      return run;
    } catch (error) {
      this.auditTrail.recordAgentRun("failed", "agent-plan", "Agent 运行计划生成失败。详情请查看通知提示。");
      await this.savePluginData();
      throw error;
    }
  }

  async replanAgentRun(
    runId: string,
    replanFeedback = "",
    excludedCalls: AgentToolCall[] = []
  ): Promise<AgentRun> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    const run = this.agentRunStore.get(runId);
    if (!run || run.status === "cancelled" || (run.status === "completed" && !replanFeedback.trim())) {
      throw new Error("该 Agent 运行不存在或已经结束。 ");
    }
    if (run.replanCount >= 1) {
      throw new Error("每次 Agent 运行最多重新规划一次；请新建运行继续。 ");
    }
    const memoryContext = await this.buildModelMemoryContext();
    const plan = await this.requestGate.run(`agent-runtime-replan:${runId}:${run.replanCount}`, () =>
      this.getDeepSeekClient().planAgentRun(run.goal, memoryContext, replanFeedback)
    );
    if (excludedCalls.some((excluded) => plan.steps.some((step) => step.tool === excluded.tool && step.action === excluded.action))) {
      throw new Error("替代计划仍重复安排了已知无结果的工具动作；已拒绝该计划。请发送新的目标继续。 ");
    }
    const updated = this.agentRunStore.replaceIncompleteSteps(runId, plan);
    if (!updated) {
      throw new Error("该 Agent 运行正在执行，暂时不能重新规划。 ");
    }
    const replanLabel = replanFeedback.trim() ? "Agent 自动调整计划" : "Agent 重新规划";
    this.auditTrail.recordAgentRun("succeeded", runId, `${replanLabel}：${plan.steps.length} 个步骤。`);
    await this.appendActiveSessionEntry(renderSessionToolResult(replanLabel, `${plan.summary}\n${plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join("\n")}`));
    await this.savePluginData();
    return updated;
  }

  async executeAgentRunStep(runId: string, stepId: string, confirmed = false): Promise<AgentRun> {
    const run = this.agentRunStore.get(runId);
    const step = run?.steps.find((candidate) => candidate.id === stepId);
    if (!run || !step) {
      throw new Error("Agent 运行或步骤不存在。 ");
    }
    if (step.requiresConfirmation && !confirmed) {
      throw new Error("该步骤会调用模型、处理附件或打开笔记，需要用户确认。 ");
    }
    const started = this.agentRunStore.startStep(runId, stepId);
    if (!started) {
      throw new Error("该步骤当前不可执行。 ");
    }
    await this.savePluginData();

    try {
      this.runtimeArtifacts.writePreview = undefined;
      const result = await this.agentToolRegistry.execute({
        goal: started.run.goal,
        run: started.run,
        step: started.step
      });
      const resultSummary = result.summary;
      const updated = this.agentRunStore.finishStep(runId, stepId, "completed", resultSummary);
      if (!updated) {
        throw new Error("无法更新 Agent 步骤状态。 ");
      }
      this.auditTrail.recordAgentRun("succeeded", runId, `步骤完成：${step.tool}。${resultSummary}`);
      await this.appendActiveSessionEntry(renderSessionToolResult(step.title, resultSummary));
      await this.savePluginData();
      if (result.replanFeedback && updated.replanCount < 1) {
        try {
          return await this.replanAgentRun(runId, result.replanFeedback, result.replanExclusions);
        } catch (replanError) {
          const replanMessage = replanError instanceof Error ? replanError.message : "未知错误。";
          this.auditTrail.recordAgentRun("failed", runId, `Agent 自动调整计划失败：${replanMessage}`);
          await this.appendActiveSessionEntry(renderSessionToolResult("Agent 自动调整计划", `失败：${replanMessage}`));
          await this.savePluginData();
        }
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知 Agent 工具错误。";
      const status = isRuntimeBlockedError(error) ? "blocked" : "failed";
      const updated = this.agentRunStore.finishStep(runId, stepId, status, message);
      this.auditTrail.recordAgentRun("failed", runId, `步骤${status === "blocked" ? "被阻止" : "失败"}：${step.tool}。${message}`);
      await this.appendActiveSessionEntry(renderSessionToolResult(step.title, `${status === "blocked" ? "被阻止" : "失败"}：${message}`));
      await this.savePluginData();
      if (!updated) {
        throw new Error("无法更新 Agent 步骤状态。 ");
      }
      return updated;
    }
  }

  async retryAgentRunStep(runId: string, stepId: string): Promise<AgentRun> {
    const updated = this.agentRunStore.retryStep(runId, stepId);
    if (!updated) {
      throw new Error("该步骤当前不能重试。 ");
    }
    await this.savePluginData();
    return updated;
  }

  async skipAgentRunStep(runId: string, stepId: string): Promise<AgentRun> {
    const updated = this.agentRunStore.skipStep(runId, stepId);
    if (!updated) {
      throw new Error("该步骤当前不能跳过。 ");
    }
    this.auditTrail.recordAgentRun("succeeded", runId, "用户跳过了 Agent 步骤。 ");
    await this.savePluginData();
    return updated;
  }

  async cancelAgentRun(runId: string): Promise<AgentRun> {
    const updated = this.agentRunStore.cancel(runId);
    if (!updated) {
      throw new Error("运行中或已完成的 Agent 任务不能取消。 ");
    }
    this.auditTrail.recordAgentRun("succeeded", runId, "Agent 运行已取消。 ");
    await this.savePluginData();
    return updated;
  }

  private async analyzeKnowledgeMaintenance(goal: string): Promise<GardenerPlan> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      throw new Error("请输入知识库维护目标。 ");
    }
    // The maintenance loop intentionally works on editable Markdown knowledge.
    // Attachments already feed that knowledge through their own indexing workflow.
    const candidates = this.markdownIndex.search(normalizedGoal, 16);
    const sources = createGardenerSources(candidates.filter((candidate) => {
      const decision = this.getPolicyEngine().decide({
        action: "sendToGlm",
        targetPath: candidate.chunk.source.pathOrUrl
      });
      this.recordPolicyDecision(decision);
      return decision.allowed;
    }));
    if (sources.length < 2) {
      throw new Error("没有找到至少两条可发送给模型的相关本地来源。请先重建索引或换一个更具体的目标。 ");
    }

    try {
      const memoryContext = await this.buildModelMemoryContext();
      const plan = await this.requestGate.run(`knowledge-gardener:${normalizedGoal}`, () =>
        this.getDeepSeekClient().planKnowledgeMaintenance(normalizedGoal, sources, memoryContext)
      );
      const findings = plan.findings.map((finding, index) => {
        const links = finding.sourceIds
          .map((id) => sources.find((source) => source.id === id))
          .filter((source): source is NonNullable<typeof source> => Boolean(source))
          .map((source) => `[[${source.source.pathOrUrl}]]`)
          .join("、");
        return `${index + 1}. ${finding.title}：${finding.detail}${links ? `（${links}）` : ""}`;
      }).join("\n");
      this.auditTrail.recordModelRequest("succeeded", `DeepSeek 知识库维护分析成功：${sources.length} 个来源片段。`);
      await this.appendActiveSessionEntry(renderSessionExchange(
        normalizedGoal,
        `知识库维护分析：${plan.summary}\n\n${findings || "未发现明确的重叠、冲突、缺口或过时内容。"}`
      ));
      await this.savePluginData();
      return plan;
    } catch (error) {
      this.auditTrail.recordModelRequest("failed", "DeepSeek 知识库维护分析失败。详情请查看通知提示。");
      await this.savePluginData();
      throw error;
    }
  }

  async formatClipboardIntoEditor(editor: Editor): Promise<void> {
    try {
      const clipboard = await navigator.clipboard.read();
      const htmlItem = clipboard.find((item) => item.types.includes("text/html"));
      const textItem = clipboard.find((item) => item.types.includes("text/plain"));
      const html = htmlItem ? await (await htmlItem.getType("text/html")).text() : undefined;
      const text = textItem ? await (await textItem.getType("text/plain")).text() : "";
      if (!text && !html) {
        throw new Error("剪贴板中没有可转换的文本或 HTML 内容。 ");
      }
      const result = formatPastedContent({ text, html });
      new PasteFormatPreviewModal(this.app, editor, result, "粘贴格式预览").open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取剪贴板内容。";
      new Notice(`粘贴格式化失败：${message}`);
    }
  }

  async repairSelectedFormatting(editor: Editor): Promise<void> {
    const selected = editor.getSelection();
    if (!selected.trim()) {
      new Notice("请先选中需要修复的表格或富文本。 ");
      return;
    }
    if (!this.hasDeepSeekApiKey()) {
      new Notice("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("请在一个 Vault 内的 Markdown 笔记中执行格式修复。 ");
      return;
    }
    const decision = this.getPolicyEngine().decide({ action: "sendToGlm", targetPath: file.path });
    this.recordPolicyDecision(decision);
    if (!decision.allowed) {
      new Notice(`格式修复被权限策略拒绝：${decision.reason}`);
      return;
    }

    try {
      const suggestion = await this.requestGate.run(`paste-repair:${file.path}:${selected}`, () =>
        this.getDeepSeekClient().repairPasteFormatting(selected)
      );
      const result = {
        markdown: suggestion.markdown,
        recommendedOutput: "markdown" as const,
        report: {
          kind: "rich-text" as const,
          repairedCellCount: 0,
          warnings: suggestion.warnings
        }
      };
      this.auditTrail.recordModelRequest("succeeded", "DeepSeek 选中内容格式修复成功。 ");
      await this.savePluginData();
      new PasteFormatPreviewModal(this.app, editor, result, "Agent 格式修复预览").open();
    } catch (error) {
      this.auditTrail.recordModelRequest("failed", "DeepSeek 选中内容格式修复失败。 ");
      await this.savePluginData();
      const message = error instanceof Error ? error.message : "未知错误。";
      new Notice(`格式修复失败：${message}`);
    }
  }

  async createKnowledgeMap(
    topic: string,
    scope: "current-note" | "search-results" | "folder",
    value: string
  ): Promise<KnowledgeIntegrationSession> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      throw new Error("请先输入知识体系主题。 ");
    }

    const { sources, scopeLabel } = await this.collectKnowledgeIntegrationSources(scope, value);
    if (!sources.length) {
      throw new Error("当前范围没有可发送给模型的已授权笔记片段。 ");
    }
    const mapSources = selectSourcesForKnowledgeMap(sources);
    const map = await this.requestGate.run(`knowledge-map:${scope}:${value.trim()}:${normalizedTopic}`, () =>
      this.getDeepSeekClient().createKnowledgeMap(normalizedTopic, mapSources)
    );
    const session: KnowledgeIntegrationSession = {
      id: `knowledge-map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      topic: normalizedTopic,
      scopeLabel,
      createdAt: new Date().toISOString(),
      sources: mapSources,
      map
    };
    this.auditTrail.recordModelRequest("succeeded", `DeepSeek 知识地图生成成功：${mapSources.length} 个来源片段。`);
    await this.savePluginData();
    return session;
  }

  async previewKnowledgeMap(session: KnowledgeIntegrationSession): Promise<WritePreview> {
    const proposal = createKnowledgeSystemProposal(
      `${session.topic}-知识地图`,
      renderKnowledgeMapContent(session.topic, session.map, session.scopeLabel, session.createdAt),
      session.sources.map((source) => source.source)
    );
    return this.previewAction(proposal);
  }

  async previewKnowledgeNode(
    session: KnowledgeIntegrationSession,
    nodeId: string
  ): Promise<WritePreview> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    const node = session.map.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new Error("找不到指定的知识节点。 ");
    }
    const nodeSources = session.sources.filter((source) => node.sourceIds.includes(source.id));
    if (!nodeSources.length) {
      throw new Error("该知识节点没有已授权来源。 ");
    }
    const draft = await this.requestGate.run(`knowledge-node:${session.id}:${node.id}`, () =>
      this.getDeepSeekClient().composeKnowledgeNode(session.topic, node, nodeSources)
    );
    const proposal = createKnowledgeSystemProposal(
      node.title,
      renderKnowledgeNodeContent(draft),
      nodeSources.filter((source) => draft.sourceIds.includes(source.id)).map((source) => source.source)
    );
    const preview = await this.previewAction(proposal);
    this.auditTrail.recordModelRequest("succeeded", `DeepSeek 知识节点草稿生成成功：${node.title}`);
    await this.savePluginData();
    return preview;
  }

  async answerFromKnowledge(question: string): Promise<{
    content: string;
    sources: MarkdownSearchResult[];
  }> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }

    const candidates = this.searchKnowledge(question);
    if (!candidates.length) {
      throw new LocalKnowledgeUnavailableError(
        "本地知识库没有找到相关来源，已请求 Agent 改用替代计划。",
        "本地知识库检索为 0 条结果。不要再次安排 research:answer-vault；请根据用户目标选择其他有信息增益的动作，例如在需要时安排联网研究。"
      );
    }

    const permittedSources = candidates.filter((candidate) => {
      const decision = this.getPolicyEngine().decide({
        action: "sendToGlm",
        targetPath: candidate.chunk.source.pathOrUrl
      });
      this.recordPolicyDecision(decision);
      return decision.allowed;
    });

    if (!permittedSources.length) {
      throw new LocalKnowledgeUnavailableError(
        "检索到本地内容，但没有来源获准发送给模型，已请求 Agent 改用替代计划。",
        "本地检索虽有命中，但没有任何来源获准外发给模型。不要再次安排 research:answer-vault；请根据用户目标选择不依赖这些来源的替代动作。"
      );
    }

    try {
      const memoryContext = await this.buildModelMemoryContext();
      const response = await this.requestGate.run(`deepseek-knowledge:${question.trim()}`, () =>
        this.getDeepSeekClient().answerWithSources(
          question,
          permittedSources.map((result, index) => ({
            id: index + 1,
            path: result.chunk.source.pathOrUrl,
            locator: result.chunk.source.locator,
            content: result.chunk.content
          })),
          memoryContext
        )
      );
      this.auditTrail.recordModelRequest("succeeded", `DeepSeek 来源问答成功：${response.model}`);
      await this.appendActiveSessionEntry(renderSessionExchange(question, response.content));
      await this.savePluginData();
      return { content: response.content, sources: permittedSources };
    } catch (error) {
      this.auditTrail.recordModelRequest("failed", "DeepSeek 来源问答失败。详情请查看通知提示。");
      await this.savePluginData();
      throw error;
    }
  }

  async searchWeb(query: string): Promise<WebSearchRun> {
    if (!this.hasTavilyApiKey() || !this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中同时填写 TAVILY_API_KEY 和 DEEPSEEK_API_KEY，然后重新加载。 ");
    }

    const decision = this.getPolicyEngine().decide({ action: "webSearch" });
    this.recordPolicyDecision(decision);
    if (!decision.allowed) {
      throw new Error(`联网搜索被权限策略拒绝：${decision.reason}`);
    }

    try {
      const memoryContext = await this.buildModelMemoryContext();
      const response = await this.requestGate.run(`tavily-web:${query.trim()}`, async () => {
        try {
          const search = await this.getTavilyClient().search(query, this.settings.webSearchResultLimit);
          const answer = await this.getDeepSeekClient().answerFromWeb(query, search.sources, memoryContext);
          return { ...answer, sources: search.sources, mode: "web-grounded" as const, tavilyRequestId: search.requestId };
        } catch (error) {
          if (!(error instanceof NoUsableWebResultsError)) {
            throw error;
          }
          if (!shouldUseGeneralKnowledgeFallback(this.settings.webFallbackPolicy, query)) {
            throw new Error(getNoWebResultMessage(this.settings.webFallbackPolicy, query));
          }

          const answer = await this.getDeepSeekClient().answerFromGeneralKnowledge(query, memoryContext);
          return {
            ...answer,
            sources: [],
            mode: "deepseek-general" as const,
            fallbackReason: "no-usable-web-results" as const
          };
        }
      });
      this.auditTrail.recordModelRequest("succeeded", response.mode === "web-grounded"
        ? `Tavily 检索 + DeepSeek 联网问答成功：${response.model}${response.tavilyRequestId ? `（Tavily ${response.tavilyRequestId}）` : ""}`
        : `Tavily 未返回可用网页结果，已降级为 DeepSeek 通用回答：${response.model}`
      );

      const run: WebSearchRun = {
        answer: response.content,
        sources: response.sources,
        mode: response.mode,
        ...(response.mode === "deepseek-general" ? { fallbackReason: response.fallbackReason } : {})
      };
      await this.appendActiveSessionEntry(renderSessionExchange(
        query,
        `${response.mode === "web-grounded" ? "联网回答" : "通用回答（未获得可用网页来源）"}\n\n${response.content}`
      ));
      if (response.mode === "web-grounded" && this.settings.autoAppendWebSearchToDaily) {
        try {
          const preview = await this.previewWebSearchCapture(
            "appendDailyNote",
            query,
            response.content,
            response.sources
          );
          const result = await this.applyWritePreview(preview);
          run.autoAppendedPath = result.targetPath;
        } catch (error) {
          run.autoAppendError = error instanceof Error ? error.message : "联网结果自动追加失败。";
        }
      }

      await this.savePluginData();
      return run;
    } catch (error) {
      this.auditTrail.recordModelRequest("failed", "Tavily 检索或 DeepSeek 联网问答失败。详情请查看通知提示。");
      await this.savePluginData();
      throw error;
    }
  }

  async previewManualCapture(
    type: ManualCaptureAction,
    subject: string,
    content: string
  ): Promise<WritePreview> {
    return this.previewAction(createManualCaptureProposal(type, subject, content));
  }

  async previewWebSearchCapture(
    type: ManualCaptureAction,
    query: string,
    answer: string,
    sources: WebSearchResult[]
  ): Promise<WritePreview> {
    if (!sources.length) {
      throw new Error("通用回答没有联网来源，不能作为联网结果写入。请使用手动笔记沉淀保存。 ");
    }
    const proposal = createSourcedCaptureProposal(
      type,
      query,
      renderWebAnswerCaptureContent(query, answer),
      sources.map((source) => source.source)
    );
    return this.previewAction(proposal);
  }

  async suggestCaptureFromAnswer(
    type: ManualCaptureAction,
    answer: string,
    sources: MarkdownSearchResult[]
  ): Promise<WritePreview> {
    if (!this.hasDeepSeekApiKey()) {
      throw new Error("请在插件目录的 .env 文件中填写 DEEPSEEK_API_KEY，然后重新加载。 ");
    }
    if (!sources.length) {
      throw new Error("没有可追溯来源，不能生成自动笔记提案。 ");
    }

    const stillPermitted = sources.every((source) => {
      const decision = this.getPolicyEngine().decide({
        action: "sendToGlm",
        targetPath: source.chunk.source.pathOrUrl
      });
      this.recordPolicyDecision(decision);
      return decision.allowed;
    });
    if (!stillPermitted) {
      throw new Error("来源的模型外发权限已变更；请重新检索后再生成笔记提案。 ");
    }

    try {
      const suggestion = await this.requestGate.run(`deepseek-capture:${type}:${answer.trim()}`, () =>
        this.getDeepSeekClient().suggestCapture(answer, type)
      );
      const proposal = createSourcedCaptureProposal(
        type,
        suggestion.subject,
        suggestion.content,
        sources.map((source) => source.chunk.source)
      );
      const preview = await this.previewAction(proposal);
      this.auditTrail.recordModelRequest("succeeded", `DeepSeek 笔记提案成功：${this.settings.deepSeekModel}`);
      await this.savePluginData();
      return preview;
    } catch (error) {
      this.auditTrail.recordModelRequest("failed", "DeepSeek 笔记提案失败。详情请查看通知提示。");
      await this.savePluginData();
      throw error;
    }
  }

  async applyWritePreview(preview: WritePreview): Promise<WriteResult> {
    try {
      const result = await this.vaultActionService.apply(preview);
      this.auditTrail.recordVaultWrite(
        preview.proposal.type,
        result.targetPath,
        "succeeded",
        result.created ? "已创建新笔记。" : "已追加到现有笔记。"
      );
      if (
        this.runtimeArtifacts.writePreview &&
        this.runtimeArtifacts.writePreview.targetPath === preview.targetPath &&
        this.runtimeArtifacts.writePreview.afterContent === preview.afterContent
      ) {
        this.runtimeArtifacts.writePreview = undefined;
      }
      await this.savePluginData();
      new Notice(`${result.created ? "已创建" : "已追加"}：${result.targetPath}`);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误。";
      this.auditTrail.recordVaultWrite(preview.proposal.type, preview.targetPath, "failed", "Vault 写入失败。");
      await this.savePluginData();
      throw new Error(reason);
    }
  }

  private async activateAgentView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: AGENT_VIEW_TYPE, active: true });
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  private async savePluginData(): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => this.saveData({
      settings: this.settings,
      auditEvents: this.auditTrail.toJSON(),
      attachmentRecords: this.attachmentIndex.toJSON(),
      attachmentBatchQueue: this.attachmentBatchQueue.toJSON(),
      agentRuns: this.agentRunStore.toJSON(),
      agentSessions: this.agentSessionStore.toJSON()
      }));
    await this.saveQueue;
  }

  private getPolicyEngine(): PolicyEngine {
    return new PolicyEngine(this.settings.permissions);
  }

  private getGlmClient(): GlmClient {
    return new GlmClient({
      apiKey: this.glmApiKey,
      model: this.settings.glmModel,
      timeoutMs: this.settings.requestTimeoutMs
    });
  }

  private getAttachmentBatchLimits(): AttachmentBatchLimits {
    return {
      dailyRequestLimit: this.settings.attachmentDailyRequestLimit,
      dailyInputBytesLimit: this.settings.attachmentDailyInputMbLimit * 1024 * 1024,
      requestIntervalMs: this.settings.attachmentRequestIntervalMs
    };
  }

  private getDeepSeekClient(): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: this.deepSeekApiKey,
      model: this.settings.deepSeekModel,
      timeoutMs: this.settings.requestTimeoutMs
    });
  }

  private getTavilyClient(): TavilyClient {
    return new TavilyClient({
      apiKey: this.tavilyApiKey,
      timeoutMs: this.settings.requestTimeoutMs
    });
  }

  private async collectKnowledgeIntegrationSources(
    scope: "current-note" | "search-results" | "folder",
    value: string
  ): Promise<{ sources: KnowledgeIntegrationSource[]; scopeLabel: string }> {
    const trimmedValue = value.trim();
    let candidates: Array<{ chunk: MarkdownSearchResult["chunk"] }>;
    let scopeLabel: string;

    if (scope === "current-note") {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== "md") {
        throw new Error("请先打开一篇 Markdown 笔记，再使用当前笔记作为整合范围。 ");
      }
      candidates = this.markdownIndex.getForPath(file.path).map((chunk) => ({ chunk }));
      scopeLabel = `当前笔记：${file.path}`;
    } else if (scope === "search-results") {
      if (!trimmedValue) {
        throw new Error("请输入用于选择整合资料的搜索关键词。 ");
      }
      candidates = this.searchKnowledge(trimmedValue);
      scopeLabel = `搜索结果：${trimmedValue}`;
    } else {
      const folder = trimmedValue.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!folder) {
        throw new Error("请输入 Vault 内的资料文件夹路径。 ");
      }
      candidates = this.markdownIndex.getInFolder(folder).map((chunk) => ({ chunk }));
      scopeLabel = `文件夹：${folder}`;
    }

    const sources: KnowledgeIntegrationSource[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const source = candidate.chunk.source;
      const decision = this.getPolicyEngine().decide({ action: "sendToGlm", targetPath: source.pathOrUrl });
      this.recordPolicyDecision(decision);
      const key = `${source.pathOrUrl}:${source.locator}:${source.contentHash}`;
      if (!decision.allowed || seen.has(key)) {
        continue;
      }
      seen.add(key);
      sources.push({
        id: `S${sources.length + 1}`,
        source,
        title: candidate.chunk.heading ?? source.pathOrUrl.split("/").pop() ?? source.pathOrUrl,
        content: candidate.chunk.content
      });
    }
    return { sources, scopeLabel };
  }

  private async previewAction(proposal: AgentActionProposal): Promise<WritePreview> {
    return this.vaultActionService.preview(proposal);
  }

  private async buildModelMemoryContext(): Promise<string> {
    const profilePath = getAgentProfilePath(this.settings.permissions.agentMemoryFolder);
    const profileContent = await this.readOptionalMemoryForModel(profilePath, "用户画像");
    const activeSession = this.agentSessionStore.getActive();
    const sessionContent = activeSession
      ? await this.readOptionalMemoryForModel(activeSession.path, "当前会话")
      : "";
    return buildAgentMemoryContext(profileContent, sessionContent).content;
  }

  private async readOptionalMemoryForModel(path: string, label: string): Promise<string> {
    try {
      return await this.readMemoryForModel(path, label, true);
    } catch {
      return "";
    }
  }

  private async readMemoryForModel(path: string, label: string, allowMissing = false): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (allowMissing) {
        return "";
      }
      throw new Error(`${label}笔记不存在或已被删除。 `);
    }
    const readDecision = this.getPolicyEngine().decide({ action: "readVault", targetPath: path });
    this.recordPolicyDecision(readDecision);
    if (!readDecision.allowed) {
      throw new Error(`${label}读取被权限策略拒绝：${readDecision.reason}`);
    }
    const sendDecision = this.getPolicyEngine().decide({ action: "sendToGlm", targetPath: path });
    this.recordPolicyDecision(sendDecision);
    if (!sendDecision.allowed) {
      throw new Error(`${label}不能发送给模型：${sendDecision.reason}`);
    }
    return this.app.vault.read(file);
  }

  private async appendActiveSessionEntry(entry: string): Promise<void> {
    const session = this.agentSessionStore.getActive();
    if (!session || !entry.trim()) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(session.path);
    if (!(file instanceof TFile)) {
      this.agentSessionStore.remove(session.id);
      await this.savePluginData();
      return;
    }
    try {
      const preview = await this.previewAction({
        type: "appendAgentSession",
        sessionPath: session.path,
        content: entry,
        sources: [createAgentMemorySource(session.path, entry, "session-entry")]
      });
      if (!preview.existedBefore) {
        throw new Error("当前会话笔记已不存在。 ");
      }
      await this.vaultActionService.apply(preview);
      this.agentSessionStore.touch(session.id);
      this.auditTrail.recordVaultWrite("appendAgentSession", session.path, "succeeded", "已追加 Agent 会话记录。 ");
    } catch (error) {
      this.auditTrail.recordVaultWrite("appendAgentSession", session.path, "failed", "Agent 会话记录追加失败。 ");
    }
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedPluginData(value: unknown): value is PersistedPluginData {
  return isRecord(value) && "settings" in value;
}

function normalizeWebFallbackPolicy(value: unknown): WebFallbackPolicy {
  return value === "disabled" || value === "always-with-warning" || value === "stable-only"
    ? value
    : DEFAULT_SETTINGS.webFallbackPolicy;
}

class AttachmentBatchBlockedError extends Error {
  constructor(
    readonly kind: "paused" | "budget" | "rate-limit",
    message: string,
    readonly waitMs?: number
  ) {
    super(message);
    this.name = "AttachmentBatchBlockedError";
  }
}

class RuntimeToolBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeToolBlockedError";
  }
}

class LocalKnowledgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly replanFeedback: string
  ) {
    super(message);
    this.name = "LocalKnowledgeUnavailableError";
  }
}

function isRuntimeBlockedError(error: unknown): boolean {
  return error instanceof RuntimeToolBlockedError || error instanceof AttachmentBatchBlockedError;
}
