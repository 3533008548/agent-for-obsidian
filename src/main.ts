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
import { DeepSeekClient } from "../core/services/deepseek-client";
import { postJsonWithFetch } from "../core/services/fetch-api-request";
import { DesktopSessionService } from "../core/desktop/desktop-session-service";
import { isInternalLibraryPath } from "../core/memory/agent-memory";
import { normalizeQuestionToStem } from "../core/notes/note-naming";
import { DesktopWriteService, type DesktopDeleteResult, type DesktopWritePreview } from "../core/desktop/desktop-write-service";
import { TRASH_FOLDER } from "../core/policy/policy-engine";
import type { DeleteNotePreview } from "../core/desktop/desktop-delete-service";
import { DesktopWikiService, type DesktopTopicSurveyDraft } from "../core/desktop/desktop-wiki-service";
import { topicOfNote, type TopicRegistry } from "../core/wiki/topic-registry";
import { planIngest, renderIngestPlan, type IngestPlan } from "../core/wiki/ingest-plan";
import { findOverlappingWikiPages, type LlmWikiRegistry } from "../core/wiki/llm-wiki-system";
import { DesktopAttachmentService, type DesktopAttachmentState } from "../core/desktop/desktop-attachment-service";
import { DesktopRelationService } from "../core/desktop/desktop-relation-service";
import { runAnswerLoop } from "../core/desktop/desktop-answer-loop";
import { shouldRewriteFollowUp } from "../core/desktop/question-rewrite";
import {
  DesktopMaintenanceService,
  type DesktopOverlapScan
} from "../core/desktop/desktop-maintenance-service";
import {
  DesktopNoteRenameService,
  type DesktopNoteRenamePlan,
  type DesktopRenameApplyResult
} from "../core/desktop/desktop-note-rename-service";
import { DesktopWikiVerificationService } from "../core/desktop/desktop-wiki-verification-service";
import { detectDesktopAgentIntent } from "../core/desktop/desktop-intent-router";
import { formatPastedContent } from "../core/paste/paste-formatter";
import type { AgentSessionStoreState } from "../core/memory/agent-memory";
import { readEnvValue } from "../core/services/env";
import type { WebFallbackPolicy } from "../core/services/web-answer-policy";
import type {
  DesktopSearchHit,
  DesktopAgentResponse,
  DesktopAgentStreamEvent,
  DesktopAgentRequestContext,
  DesktopNoteEntry,
  ProviderStatus,
  RestoredConversationMessage,
  ConversationResume,
  SessionStatus,
  WorkspaceState,
  WritePreviewView,
  DeletePreviewView,
  WikiHealthReview
} from "./shared/desktop-api";

/**
 * Where the agent keeps files that are about itself, not notes for the user.
 *
 * Everything under it is excluded from the index — which is also why session
 * transcripts cannot feed the search corpus back into their own answers.
 */
const DEFAULT_AGENT_MEMORY_FOLDER = "00 Inbox/Agent";

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
  /** A drafted library map waiting for the user to confirm the write. */
  private surveyPreview: DesktopWritePreview | null = null;
  /** Topic table the drafted map was built from; written with the map. */
  private surveyRegistry: TopicRegistry | null = null;
  /** A drafted rename plan waiting for the user to read it. */
  private tidyPreview: DesktopWritePreview | null = null;
  /** A drafted overlap report, whether the user asked for it or the scan did. */
  private overlapPreview: DesktopWritePreview | null = null;
  /**
   * A drafted Wiki compilation, one preview per page.
   *
   * An array rather than a single preview because a topic writes several pages
   * at once, and they are the same decision: a half-written topic is worse than
   * either extreme. They go in and out with the ordinary flow so that confirming
   * a compilation needs the same click as confirming one note.
   */
  private wikiPreviews: DesktopWritePreview[] = [];
  /**
   * The registry the drafted pages were built from.
   *
   * Written only after the pages land. Writing it earlier would record sources
   * for pages that were never written, and the next compile would treat a topic
   * as covered when its pages do not exist.
   */
  private wikiRegistry: LlmWikiRegistry | null = null;
  /** An approved placement waiting to be compiled, held only for one turn. */
  private pendingIngest: { notePath: string; plan: IngestPlan } | null = null;
  /** A deletion the user has not agreed to yet. Nothing has been removed. */
  private pendingDelete: DeleteNotePreview | null = null;
  private wikiService: DesktopWikiService | null = null;
  private attachmentService: DesktopAttachmentService | null = null;
  private relationService: DesktopRelationService | null = null;
  private readonly activeAnswerStreams = new Map<string, AbortController>();
  private wikiVerificationService: DesktopWikiVerificationService | null = null;
  /**
   * Topic table cache, read once when the vault is opened and refreshed
   * whenever a survey is written. The overlap scan needs it synchronously.
   */
  private topicRegistry: TopicRegistry | null = null;
  private activeNotePath: string | null = null;
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
      .filter((file) => !isInternalWorkspacePath(file.path, DEFAULT_AGENT_MEMORY_FOLDER))
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
    // Talking is what opens a session, not asking permission to open one.
    if (route.intent !== "close-session") {
      await this.ensureActiveSession(question);
    }
    if (route.intent !== "answer") {
      const response = await this.executeIntent(route.intent, route.subject, route.notePath, route.sessionTitle);
      if (route.intent !== "close-session" && this.sessionService) {
        await this.sessionService.appendTurn({
          question,
          content: response.content,
          intent: route.intent,
          toolName: formatIntentAction(route.intent)
        });
        await this.persistSessionState();
      }
      return response;
    }
    const memoryContext = this.sessionService
      ? (await this.sessionService.getMemoryContext()).content
      : "";
    const configuration = await readDesktopAgentConfiguration();
    // A follow-up is resolved against the recent conversation *before*
    // retrieval, because the retriever only sees the question the user typed.
    const interpretation = await this.interpretFollowUp(question, memoryContext, configuration);
    const agent = new DesktopAgentService(this.index, {
      ...configuration,
      memoryContext,
      activeNotePath: context.activeNotePath ?? this.activeNotePath,
      attachmentSearch: this.attachmentService?.search.bind(this.attachmentService),
      // The Wiki leads retrieval when it has been compiled. Read through the
      // service that owns the registry so retrieval never parses it itself, and
      // skipped entirely when no topic exists — the library then answers exactly
      // as it did before any of this.
      wikiRegistry: await this.readWikiRegistryIfAny()
    });
    // The conversation loop replaces the hardcoded recovery chain: after local
    // evidence falls short, the model — not the code — picks the next action.
    const answer = await runAnswerLoop(interpretation.question, stream, {
      service: agent,
      capabilities: {
        hasTavily: Boolean(configuration.tavilyApiKey.trim()),
        webFallbackPolicy: configuration.webFallbackPolicy
      },
      lastRunTrace: () => this.lastRunTrace(),
      decide: (decisionQuestion, entries, capabilities) =>
        new DeepSeekClient({
          apiKey: configuration.deepSeekApiKey,
          model: configuration.deepSeekModel,
          slowResponseMs: configuration.requestTimeoutMs,
          postJson: postJsonWithFetch
        }).decideNextAction(decisionQuestion, entries, capabilities)
    });
    let turnId: string | null = null;
    if (this.sessionService) {
      // The log keeps the user's own words; the interpretation is a lookup
      // detail, not a new question they asked.
      turnId = await this.sessionService.appendTurn({
        question,
        content: answer.content,
        intent: "answer",
        mode: answer.mode,
        evidenceComplete: answer.evidenceComplete,
        sources: answer.sources,
        decisionTrail: answer.decisionTrail
      });
      await this.persistSessionState();
    }
    return {
      ...answer,
      ...(turnId ? { turnId } : {}),
      decisionTrail: answer.decisionTrail,
      ...(interpretation.changed ? { interpretedQuestion: interpretation.question } : {}),
      intent: "answer" as const
    };
  }

  /**
   * Fills in the subject a follow-up left out.
   *
   * "为什么要有随机数" reaches the retriever as written, and the retriever has
   * no idea it means the TLS handshake from two turns ago. One model call
   * against the recent transcript turns it into a question that stands on its
   * own. Anything unexpected — no key, unparsable answer, a question that
   * already names its subject — returns the original untouched.
   */
  private async interpretFollowUp(
    question: string,
    memoryContext: string,
    configuration: Awaited<ReturnType<typeof readDesktopAgentConfiguration>>
  ): Promise<{ question: string; changed: boolean }> {
    const original = { question, changed: false };
    if (!configuration.deepSeekApiKey.trim() || !shouldRewriteFollowUp(question)) {
      return original;
    }
    try {
      const result = await new DeepSeekClient({
        apiKey: configuration.deepSeekApiKey,
        model: configuration.deepSeekModel,
        slowResponseMs: configuration.requestTimeoutMs,
        postJson: postJsonWithFetch
      }).rewriteFollowUp(question, memoryContext);
      return result.changed ? { question: result.rewritten, changed: true } : original;
    } catch (error) {
      console.error("[question-rewrite]", error);
      return original;
    }
  }

  /**
   * What the previous turn actually did, for questions about the agent itself.
   *
   * There is no run plan any more, so the trace comes from the conversation
   * log: every answer turn records the decision trail the loop really walked,
   * and every non-answer turn records which operation ran. That is a truer
   * account of "what just happened" than a plan would have been.
   */
  private async lastRunTrace(): Promise<string | null> {
    const turns = await this.sessionService?.readConversationLog() ?? [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      if (turn.intent && turn.intent !== "answer") {
        return `上一轮执行了操作「${formatIntentAction(turn.intent)}」，回复：${turn.content.slice(0, 200)}`;
      }
      if (turn.decisionTrail.length) {
        return `上一轮问题「${turn.question}」，实际执行过程：${turn.decisionTrail.join("；")}`;
      }
    }
    return null;
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
      case "survey-wiki": {
        const result = await this.surveyTopics();
        const parts = [
          `已梳理 ${result.noteCount} 篇可外发笔记，划分为 ${result.topicNames.length} 个主题：${result.topicNames.join("、")}。`,
          result.overview,
          "地图已生成写入预览，确认后写入知识库；之后可以对某个主题说「编译 X LLM Wiki」。"
        ];
        if (result.skippedCount) {
          parts.push(`注意：${result.skippedCount} 篇笔记被权限策略阻断，未参与划分。`);
        }
        if (result.failedBatches) {
          parts.push(`注意：${result.failedBatches} 个批次划分失败，这些笔记可能没有被归入任何主题。`);
        }
        parts.push(`地图将写入：${result.relativePath}`);
        return actionResponse(intent, parts.join("\n"));
      }
      case "tidy-notes": {
        const result = await this.tidyNoteNames();
        if (!result.count && !result.blocked && !result.needsDecision) {
          return actionResponse(intent, `已扫描 ${result.scanned} 篇笔记，没有以问句命名的笔记。`);
        }
        const parts = [
          `扫描了 ${result.scanned} 篇笔记：${result.count} 篇建议改名，${result.needsDecision} 篇规则取不出干净的主题名，${result.blocked} 篇目标名已被占用。清单已生成写入预览：${result.targetPath}。`
        ];
        if (result.blocked) {
          parts.push("被占用的通常是重复笔记，建议合并后再处理。");
        }
        parts.push("清单写入后查看，确认无误再说「执行改名」；执行前会先把整个知识库复制到目录外做备份。");
        return actionResponse(intent, parts.join("\n"));
      }
      case "rename-notes": {
        const result = await this.applyNoteRenames();
        const parts = [
          `已备份 ${result.backupFileCount} 篇笔记到 ${result.backupPath}。`,
          `改名 ${result.renamed.length} 篇，同步修复了 ${result.linksRewritten.length} 篇笔记里的双链。`
        ];
        if (result.failures.length) {
          parts.push(`遇到错误即停止：${result.failures[0]?.path} —— ${result.failures[0]?.error}`);
        }
        return actionResponse(intent, parts.join("\n"));
      }
      case "scan-duplicates": {
        const result = await this.scanNoteOverlaps();
        if (!result.actionable) {
          return actionResponse(
            intent,
            `已扫描 ${result.scanned} 篇笔记，挑出 ${result.compared} 对做比对，没有发现需要处理的重复。`
          );
        }
        const parts = [
          `扫描了 ${result.scanned} 篇笔记，挑出 ${result.compared} 对做比对，${result.actionable} 对需要处理：`,
          `合并 ${result.merge}、抽取公共部分 ${result.extract}、只加关联 ${result.link}、存在冲突 ${result.conflict}。`,
          `清单已生成写入预览：${result.targetPath}。`
        ];
        if (result.failedBatches) {
          parts.push(`有 ${result.failedBatches} 批比对调用失败，这些对没有出现在清单里。`);
        }
        parts.push("清单只提建议，不会自动改动笔记。合并按追加式执行——另一篇整体并入，不删段，所以不丢信息。");
        return actionResponse(intent, parts.join("\n"));
      }
      case "ingest-note": {
        // One command, two steps: the first turn proposes, the next one compiles.
        // Deciding placement and writing the pages are kept apart on purpose —
        // the placement is what the user has to agree to, and once it is
        // remembered there is no second guessing between the two.
        if (this.pendingIngest) {
          return actionResponse(intent, await this.executeIngest());
        }
        return actionResponse(intent, await this.planNoteIngest());
      }
      case "list-uncompiled": {
        return actionResponse(intent, await this.listUncompiledNotes());
      }
      case "compile-wiki": {
        if (!subject) {
          // Not a dead end any more. "What should I compile" is the useful
          // answer here, and it is the question this branch was really asking.
          return actionResponse(
            intent,
            [
              "没有指定主题。与其让你先想主题，不如先看还没被收录的笔记：",
              "",
              await this.listUncompiledNotes()
            ].join("\n")
          );
        }
        const result = await this.compileWiki(subject);
        return actionResponse(intent, [
          `已起草 LLM Wiki「${result.topic}」：使用 ${result.sourceCount} 条本地资料，涉及 ${result.pageCount} 个页面。确认后才会写入知识库。`,
          describeNodeDrafts(result)
        ].join("\n"));
      }
      case "expand-wiki": {
        if (!subject) {
          return actionResponse(intent, "请说明要补全的 Wiki 主题，例如“补全 LangGraph LLM Wiki”。");
        }
        const result = await this.compileWiki(subject, "expand");
        return actionResponse(intent, [
          `已补全 LLM Wiki「${result.topic}」的草稿：使用 ${result.sourceCount} 条本地资料，涉及 ${result.pageCount} 个页面。确认后才会写入知识库。`,
          `本轮新增覆盖 ${result.coverage.added} 条，变更/新片段 ${result.coverage.changed} 条，复用上下文 ${result.coverage.reused} 条；仍有 ${result.coverage.remainingCandidates} 篇候选资料待覆盖。`,
          result.sourceHealth.missing || result.sourceHealth.changed || result.sourceHealth.unverified
            ? `历史来源检查：已变化 ${result.sourceHealth.changed} 个，已删除 ${result.sourceHealth.missing} 个，不可核验 ${result.sourceHealth.unverified} 个；这些内容仍需核验。`
            : "历史来源检查：当前依赖来源均可本地复核。",
          describeNodeDrafts(result)
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
      case "wiki-overlap": {
        // Read-only on purpose: which pairs to merge is the user's call, and
        // deletion already has its own confirmed two-step flow.
        if (!this.wikiService) {
          throw new Error("请先选择或迁移本地知识库。 ");
        }
        const registry = await this.wikiService.currentRegistry();
        const pairs = findOverlappingWikiPages(registry);
        if (!pairs.length) {
          return actionResponse(intent, "没有发现内容或标题明显重叠的 Wiki 页面。");
        }
        return actionResponse(intent, [
          `发现 ${pairs.length} 对疑似重叠的 Wiki 页面（按重合度从高到低）：`,
          ...pairs.map((pair) => `- [${pair.topic}] ${pair.aTitle} ⟷ ${pair.bTitle}（${pair.signals.join("；")}）\n  ${pair.a}\n  ${pair.b}`),
          "",
          "这些多半是多次增量编译对同一概念另起标题留下的。确认保留哪一篇后，另一篇用删除流程处理即可；也可以把保留标题告诉我，校对时按它统一。"
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
    sources: DesktopAgentResponse["sources"],
    turnId?: string
  ): Promise<{ targetPath: string; created: boolean }> {
    if (!this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const preview = await this.writeService.previewAnswer(action, subject, content, sources);
    const result = await this.writeService.apply(preview);
    // Recorded so a replay of this conversation shows the answer as saved
    // instead of offering the capture buttons a second time. Losing the note
    // must not lose this bookkeeping.
    try {
      await this.sessionService?.markCaptured(turnId, action, result.targetPath);
    } catch (error) {
      console.error("[conversation-log]", error);
    }
    return result;
  }

  /**
   * The Wiki's registry, or null when there is nothing compiled to lead with.
   *
   * Failure is swallowed on purpose. A malformed registry is a real problem, but
   * it is not a reason to refuse to answer a question about something else
   * entirely — the caller falls back to plain ranking, which is exactly how the
   * library behaved before any topic was compiled.
   */
  private async readWikiRegistryIfAny(): Promise<LlmWikiRegistry | null> {
    if (!this.repository || !this.index || !this.policy) {
      return null;
    }
    try {
      const configuration = await readDesktopAgentConfiguration();
      const service = new DesktopWikiService(this.repository, this.index, this.policy, {
        ...configuration,
        agentMemoryFolder: this.agentMemoryFolder
      });
      const registry = await service.currentRegistry();
      return registry.topics.length ? registry : null;
    } catch (error) {
      console.error("[wiki-retrieval]", error);
      return null;
    }
  }

  /**
   * Where the agent's own notes live, so they stay out of the compile queue.
   * Passed in rather than defaulted inside the service: the index was built with
   * this path, and a service guessing a different one would report a list that
   * disagrees with what the index holds.
   */
  private get agentMemoryFolder(): string {
    return DEFAULT_AGENT_MEMORY_FOLDER;
  }

  /**
   * A report of what ingesting the current note would do, and nothing more.
   *
   * No compile, no preview, no write. That restraint is the feature: a placement
   * decided here becomes the input to every later compile, so a wrong one is
   * worth catching before it is written rather than after.
   */
  private async planNoteIngest(): Promise<string> {
    if (!this.repository || !this.index || !this.policy) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    if (!this.wikiService) {
      const configuration = await readDesktopAgentConfiguration();
      this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, {
        ...configuration,
        agentMemoryFolder: this.agentMemoryFolder
      });
    }

    // The active note is the one the user is looking at, which is what "收录这篇"
    // means without being told. Falling back to a search keeps the command usable
    // from the chat box when no note is open.
    const targetPath = this.activeNotePath ?? (await this.pickNoteToIngest());
    if (!targetPath) {
      const pending = await this.wikiService.listUncompiledNotes(5);
      if (!pending.notes.length) {
        return "所有可外发的笔记都已经收录进 LLM Wiki 了。";
      }
      return [
        "没有指定要收录哪篇。请先在左侧打开一篇笔记，或者说“还有哪些没收录”。",
        "",
        `待收录的前几篇：${pending.notes.map((note) => note.title).join("、")}`
      ].join("\n");
    }

    const file = await this.repository.getMarkdownFile(targetPath);
    if (!file) {
      throw new Error(`找不到笔记：${targetPath}`);
    }
    const text = await this.repository.readText(targetPath);
    const title = targetPath.slice(targetPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");

    const decision = await this.wikiService.planNotePlacement({
      notePath: targetPath,
      noteTitle: title,
      noteText: text
    });
    const registry = await this.wikiService.currentRegistry();

    // The note's own current text, so a note already compiled but since edited
    // reads as changed rather than as nothing to do.
    const sourceTexts = new Map<string, string | null>([[targetPath, text]]);
    const plan = planIngest({ notePath: targetPath, noteTitle: title, decision, registry, sourceTexts });

    // Kept for the confirming turn. Held in memory only: an ingest plan that
    // survived a restart would name topics as they were before the edits that
    // happened in between, and the user would be agreeing to a stale decision.
    this.pendingIngest = { notePath: targetPath, plan };
    return renderIngestPlan(plan);
  }

  /**
   * Run the compiles an approved plan called for.
   *
   * Each topic is compiled through the ordinary preview path, so the pages
   * arrive as a preview like anything else and the user still reads them. The
   * plan only ever decided *where* the note goes; what the pages say is a
   * separate thing to agree to.
   */
  private async executeIngest(): Promise<string> {
    const pending = this.pendingIngest;
    if (!pending) {
      return "没有待执行的收录计划。请先说“收录这篇”。";
    }
    const topics =
      pending.plan.action === "update-topics" || pending.plan.action === "already-covered"
        ? pending.plan.topics
        : [];
    if (!topics.length) {
      this.pendingIngest = null;
      return pending.plan.summary;
    }

    const lines: string[] = [];
    for (const topic of topics) {
      const result = await this.compileWiki(topic.topic, "expand");
      lines.push(
        `「${result.topic}」：使用 ${result.sourceCount} 份资料，起草 ${result.pageCount} 个页面（${result.paths
          .map((path) => path.split("/").pop())
          .join("、")}）。`
      );
    }
    this.pendingIngest = null;
    lines.push("");
    lines.push("确认这些页面后再写入知识库。");
    return lines.join("\n");
  }

  /**
   * A note to place when the user named none.
   *
   * The most recently modified uncompiled note, so "收录这篇" after writing
   * something means that something.
   */
  private async pickNoteToIngest(): Promise<string | null> {
    const pending = await this.wikiService!.listUncompiledNotes(1);
    return pending.notes[0]?.path ?? null;
  }

  private async listUncompiledNotes(): Promise<string> {
    if (!this.repository || !this.index || !this.policy) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    if (!this.wikiService) {
      const configuration = await readDesktopAgentConfiguration();
      this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, {
        ...configuration,
        agentMemoryFolder: this.agentMemoryFolder
      });
    }
    const pending = await this.wikiService.listUncompiledNotes(15);
    if (!pending.notes.length) {
      return `LLM Wiki 已收录 ${pending.compiledCount} 份资料，可外发的笔记没有遗漏。`;
    }
    return [
      `还有 ${pending.notes.length} 篇笔记未收录（可外发笔记共 ${pending.total} 篇）：`,
      ...pending.notes.map((note) => `- ${note.title}（${note.path}）`),
      "",
      "打开其中一篇后说“收录这篇”，我会先给出归属计划，确认后再编译。"
    ].join("\n");
  }

  private async compileWiki(topic: string, mode: "compile" | "expand" = "compile"): Promise<{
    topic: string;
    pageCount: number;
    sourceCount: number;
    updatedCount: number;
    paths: string[];
    coverage: { added: number; changed: number; reused: number; remainingCandidates: number };
    sourceHealth: { active: number; changed: number; missing: number; unverified: number };
    composedNodes: number;
    fallbackNodes: string[];
  }> {
    if (!this.repository || !this.index || !this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, {
      ...configuration,
      agentMemoryFolder: this.agentMemoryFolder
    });

    // Draft, then preview, then write. A compilation rewrites several pages at
    // once and rewrites them over the previous version, so reading them before
    // they land is the only point at which a wrong page is still cheap.
    const draft = await this.wikiService.compileDraft(topic, mode);
    const previous = this.wikiPreviews;
    this.wikiPreviews = [];
    try {
      const prepared: DesktopWritePreview[] = [];
      for (const page of draft.pages) {
        prepared.push(await this.writeService.previewPath(page.targetPath, page.content));
      }
      this.wikiPreviews = prepared;
    } catch (error) {
      // A failure part-way through must not leave half the pages pending: the
      // user would confirm a partial topic they never saw described as a whole.
      this.wikiPreviews = previous;
      throw error;
    }
    this.wikiRegistry = draft.registry;

    return {
      topic: draft.topic,
      pageCount: draft.pages.length,
      sourceCount: draft.sourceCount,
      updatedCount: draft.pages.length,
      paths: draft.pages.map((page) => page.targetPath),
      coverage: draft.coverage,
      sourceHealth: draft.sourceHealth,
      composedNodes: draft.composedNodes,
      fallbackNodes: draft.fallbackNodes
    };
  }

  /**
   * Proofs pages whose source notes were deleted — the repair a deleted source
   * actually admits. Unlike an expansion compile this makes no model call and
   * runs no retrieval: the pages are rewritten to drop the dead citations and
   * the topic's records are pruned once the previews are confirmed.
   */
  async auditWikiMissingSources(topic: string): Promise<{
    topic: string;
    pageCount: number;
    removedSources: string[];
    paths: string[];
  }> {
    if (!this.repository || !this.index || !this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, {
      ...configuration,
      agentMemoryFolder: this.agentMemoryFolder
    });
    const audit = await this.wikiService.auditMissingSources(topic);
    const previous = this.wikiPreviews;
    this.wikiPreviews = [];
    try {
      const prepared: DesktopWritePreview[] = [];
      for (const page of audit.pages) {
        prepared.push(await this.writeService.previewPath(page.path, page.content));
      }
      this.wikiPreviews = prepared;
    } catch (error) {
      this.wikiPreviews = previous;
      throw error;
    }
    this.wikiRegistry = audit.registry;
    return {
      topic: audit.topic,
      pageCount: audit.pages.length,
      removedSources: audit.removedSources,
      paths: audit.pages.map((page) => page.path)
    };
  }

  private async surveyTopics(): Promise<DesktopTopicSurveyDraft> {
    if (!this.repository || !this.index || !this.policy || !this.writeService) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const configuration = await readDesktopAgentConfiguration();
    this.wikiService = new DesktopWikiService(this.repository, this.index, this.policy, configuration);
    const draft = await this.wikiService.surveyTopics();
    // Preview first, like every other write: the map is a note the user should
    // read before it joins the vault. The topic table it was built from waits
    // for the same confirmation.
    this.surveyPreview = await this.writeService.previewPath(draft.relativePath, draft.content);
    this.surveyRegistry = draft.registry;
    return draft;
  }

  /**
   * Proposes subject-style names for question-named notes.
   *
   * Deliberately produces a preview, not a rename: renaming rewrites other
   * notes' links, which is exactly the kind of bulk change that should be read
   * before it is applied.
   */
  private async tidyNoteNames(): Promise<DesktopNoteRenamePlan> {
    if (!this.repository || !this.index || !this.writeService || !this.rootPath) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const service = new DesktopNoteRenameService(this.repository, this.index, this.policy, this.rootPath);
    const targetPath = `${KNOWLEDGE_SYSTEM_FOLDER}/Agent/笔记命名整理建议.md`;
    const result = await service.plan(targetPath);
    this.tidyPreview = await this.writeService.previewPath(targetPath, result.content);
    return result;
  }

  /**
   * Applies the rename plan: backup, rename, rewrite links, delete old files.
   *
   * Only ever reached by an explicit "执行改名" after the plan has been read.
   */
  private async applyNoteRenames(): Promise<DesktopRenameApplyResult> {
    if (!this.repository || !this.index || !this.rootPath) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const service = new DesktopNoteRenameService(this.repository, this.index, this.policy, this.rootPath);
    const result = await service.apply();
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

  /**
   * Re-checks every compiled Wiki topic against the notes on disk.
   *
   * Local file reads only — no model call — so it is cheap enough to run when
   * the vault opens. Returns null when no vault is open yet.
   */
  async reviewWikiHealth(): Promise<WikiHealthReview | null> {
    if (!this.repository || !this.index) {
      return null;
    }
    if (!this.wikiService) {
      this.wikiService = new DesktopWikiService(
        this.repository,
        this.index,
        this.policy,
        await readDesktopAgentConfiguration()
      );
    }
    return this.wikiService.reviewHealth();
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

  /**
   * Starts a session named after whatever the conversation is about.
   *
   * The first question becomes the session title through the same naming used
   * for notes, so "什么是分布式系统" opens a session called "分布式系统" rather
   * than one called after the sentence.
   */
  /**
   * The last session, read back off disk.
   *
   * The renderer keeps its conversation in memory, so a restart used to start
   * every session at zero even once the exchanges were being written. This is
   * what fills the window back in.
   */
  async resumeConversation(): Promise<ConversationResume | null> {
    const active = this.sessionService?.activeSession;
    if (!active || !this.sessionService) {
      return null;
    }
    const turns = await this.sessionService.readConversationLog();
    if (!turns.length) {
      return null;
    }
    return {
      sessionTitle: active.title,
      sessionPath: active.path,
      messages: turns.flatMap((turn) => {
        const messages: RestoredConversationMessage[] = [
          { id: `${turn.turnId}-user`, role: "user", text: turn.question }
        ];
        if (turn.content.trim()) {
          messages.push({
            id: `${turn.turnId}-agent`,
            role: "agent",
            text: turn.content,
            question: turn.question,
            sources: turn.sources,
            ...(turn.decisionTrail.length ? { decisionTrail: turn.decisionTrail } : {}),
            ...(turn.captured ? { savedPath: turn.captured.targetPath } : {})
          });
        }
        return messages;
      })
    };
  }

  private async ensureActiveSession(question: string): Promise<void> {
    if (!this.sessionService || this.sessionService.activeSession) {
      return;
    }
    const title = normalizeQuestionToStem(question);
    await this.sessionService.ensureSession(title && title !== "未命名主题" ? title : "新会话");
    await this.persistSessionState();
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

  /**
   * Save an in-place note edit.
   *
   * Goes through the same preview/apply pair as every other write, so the
   * optimistic check applies: if the note changed on disk since it was opened,
   * the save is refused rather than overwriting someone else's edit.
   */
  async saveNoteEdit(path: string, content: string): Promise<{ targetPath: string }> {
    if (!this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const file = await this.findMarkdownSource(path);
    if (!file) {
      throw new Error("笔记已不存在或不再是 Markdown 文件。 ");
    }
    const preview = await this.writeService.previewExistingNote(file.path, content);
    const result = await this.writeService.apply(preview);
    this.summary = this.index ? await this.index.sync(this.policy) : this.summary;
    return { targetPath: result.targetPath };
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
   * Reveal the trash in the file manager.
   *
   * Deletions are recoverable, but "recoverable" only helps if the user can find
   * the folder. It may not exist yet — nothing has been deleted — so it is
   * created on demand rather than left as a missing path.
   */
  async openTrashFolder(): Promise<{ path: string }> {
    if (!this.rootPath) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const trashPath = join(this.rootPath, TRASH_FOLDER);
    await mkdir(trashPath, { recursive: true });
    const error = await shell.openPath(trashPath);
    if (error) {
      throw new Error(`无法打开回收站文件夹：${error}`);
    }
    return { path: trashPath };
  }

  private async open(rootPath: string): Promise<WorkspaceState> {
    const repository = new NodeFileSystemKnowledgeRepository(rootPath);
    const index = new PortableMarkdownKnowledgeIndex(
      repository,
      // The same predicate the note list uses, so the two cannot disagree about
      // what counts as the user's knowledge.
      (path) => isInternalLibraryPath(path, DEFAULT_AGENT_MEMORY_FOLDER),
      { store: createNodeMarkdownIndexStore(getIndexSnapshotPath()), rootPath }
    );
    const summary = await index.sync(this.policy);

    this.rootPath = rootPath;
    this.repository = repository;
    this.index = index;
    this.writeService = new DesktopWriteService(repository, this.policy, "daily", "daily", "知识体系/Agent", index);
    const attachmentConfiguration = await readDesktopAgentConfiguration();
    this.attachmentService = new DesktopAttachmentService(
      repository,
      this.policy,
      attachmentConfiguration,
      await readAttachmentState(rootPath)
    );
    this.summary = summary;
    await this.restoreSessionService(rootPath, repository);
    await this.refreshTopicRegistry(repository, index);
    await saveWorkspacePath(rootPath);
    // Deliberately not awaited: a scan costs model calls and must never slow
    // down or block opening the vault.
    void this.maybeAutoScanOverlaps();
    return this.toState();
  }

  /**
   * Reads the topic table once so the overlap scan can compare same-topic notes
   * synchronously. A missing or unreadable table is not an error: the scan just
   * loses its topic signal.
   */
  private async refreshTopicRegistry(
    repository: NodeFileSystemKnowledgeRepository,
    index: PortableMarkdownKnowledgeIndex
  ): Promise<void> {
    try {
      const configuration = await readDesktopAgentConfiguration();
      this.topicRegistry = await new DesktopWikiService(repository, index, this.policy, {
        ...configuration,
        knowledgeSystemFolder: KNOWLEDGE_SYSTEM_FOLDER
      }).readTopicRegistry();
    } catch (error) {
      console.error("[topic-registry]", error);
      this.topicRegistry = null;
    }
  }

  /**
   * Runs the duplicate scan on its own schedule.
   *
   * The desktop app has no timer of its own, so "periodic" means: every time
   * the vault is opened, check whether enough time or enough new notes have
   * passed. The outcome is a write preview, never an edit.
   */
  private async maybeAutoScanOverlaps(): Promise<void> {
    try {
      if (!this.repository || !this.index || !this.writeService) {
        return;
      }
      const configuration = await readDesktopAgentConfiguration();
      if (!configuration.deepSeekApiKey.trim()) {
        return;
      }
      const state = await this.readOverlapScanState();
      const noteCount = this.summary?.indexedFiles ?? 0;
      const now = Date.now();
      const last = state?.lastScanAt ? Date.parse(state.lastScanAt) : Number.NaN;
      const elapsed = Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY;
      if (elapsed < AUTO_SCAN_MIN_INTERVAL_MS) {
        return;
      }
      // A quiet library does not need rescanning, but one left alone for a
      // month should be looked at even if nothing new was added.
      const grew = !state || noteCount - state.noteCount >= AUTO_SCAN_NOTE_GROWTH;
      if (!grew && elapsed < AUTO_SCAN_MAX_INTERVAL_MS) {
        return;
      }
      await this.scanNoteOverlaps();
      await this.writeOverlapScanState({ lastScanAt: new Date().toISOString(), noteCount });
    } catch (error) {
      console.error("[overlap-scan:auto]", error);
    }
  }

  /**
   * Looks for notes that overlap and drafts a report.
   *
   * The report only ever proposes: merging or extracting rewrites notes the
   * user wrote, so neither happens without a preview being read first.
   */
  private async scanNoteOverlaps(): Promise<DesktopOverlapScan> {
    if (!this.index || !this.writeService) {
      throw new Error("请先选择或迁移本地知识库。");
    }
    const configuration = await readDesktopAgentConfiguration();
    const service = new DesktopMaintenanceService(this.index, this.policy, configuration);
    const targetPath = `${KNOWLEDGE_SYSTEM_FOLDER}/Agent/重复笔记检查.md`;
    const result = await service.scanNoteOverlaps(targetPath, this.topicMapForScan());
    this.overlapPreview = await this.writeService.previewPath(targetPath, result.content);
    return result;
  }

  /** Path → topic name, so same-topic notes are compared even when worded differently. */
  private topicMapForScan(): Map<string, string> | undefined {
    const registry = this.topicRegistry;
    if (!registry) {
      return undefined;
    }
    const names = new Map(registry.topics.map((topic) => [topic.id, topic.name]));
    const map = new Map<string, string>();
    for (const [path, assignment] of Object.entries(registry.assignments)) {
      const name = names.get(assignment.topicId);
      if (name) {
        map.set(path, name);
      }
    }
    return map.size ? map : undefined;
  }

  private async readOverlapScanState(): Promise<{ lastScanAt?: string; noteCount: number } | null> {
    if (!this.repository) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(await this.repository.readText(OVERLAP_SCAN_STATE_PATH));
      if (typeof parsed !== "object" || parsed === null) {
        return null;
      }
      const record = parsed as { lastScanAt?: unknown; noteCount?: unknown };
      return {
        ...(typeof record.lastScanAt === "string" ? { lastScanAt: record.lastScanAt } : {}),
        noteCount: typeof record.noteCount === "number" ? record.noteCount : 0
      };
    } catch {
      return null;
    }
  }

  private async writeOverlapScanState(state: { lastScanAt: string; noteCount: number }): Promise<void> {
    if (!this.repository) {
      return;
    }
    await this.repository.writeText(OVERLAP_SCAN_STATE_PATH, JSON.stringify(state));
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

  /** Everything drafted outside a conversation: the library map, rename plan and overlap report. */
  private collectPreviews(): DesktopWritePreview[] {
    return [this.surveyPreview, this.tidyPreview, this.overlapPreview, ...this.wikiPreviews].filter(
      (preview): preview is DesktopWritePreview => Boolean(preview)
    );
  }

  async getWritePreviews(): Promise<WritePreviewView[]> {
    return this.collectPreviews().map((preview) => ({
      targetPath: preview.targetPath,
      existedBefore: preview.existedBefore,
      beforeContent: preview.beforeContent,
      afterContent: preview.afterContent
    }));
  }

  /** Write only what the user has previewed. */
  async applyWritePreviews(): Promise<string[]> {
    const previews = this.collectPreviews();
    if (!previews.length || !this.writeService) {
      throw new Error("当前没有待确认的写入预览。");
    }
    const written: string[] = [];
    for (const preview of previews) {
      const result = await this.writeService.apply(preview);
      written.push(result.targetPath);
    }
    if (this.surveyRegistry) {
      await this.wikiService?.persistTopicRegistry(this.surveyRegistry);
      // Routing reads the table from memory, so the new one replaces the cache
      // instead of waiting for the next restart.
      this.topicRegistry = this.surveyRegistry;
      this.surveyRegistry = null;
    }
    // The Wiki's own registry is written here, after the pages. Doing it the
    // other way round would record sources for pages that do not exist, and the
    // next compile would skip them as already covered.
    if (this.wikiRegistry) {
      await this.wikiService?.persistRegistry(this.wikiRegistry);
      this.wikiRegistry = null;
    }
    this.surveyPreview = null;
    this.tidyPreview = null;
    this.overlapPreview = null;
    this.wikiPreviews = [];
    this.summary = this.index ? await this.index.sync(this.policy) : this.summary;
    return written;
  }

  /**
   * Deletion is a two-step conversation on purpose.
   *
   * `previewDelete` only decides *what* would go and shows it; `confirmDelete`
   * is the single place a note actually leaves its folder. The agent can call
   * the first one on its own, but never the second — the user has to press it.
   */
  async previewDeleteNote(targetPath: string, reason?: string): Promise<DeletePreviewView> {
    if (!this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    const preview = await this.writeService.previewDelete({ targetPath, reason });
    this.pendingDelete = preview;
    return toDeletePreviewView(preview);
  }

  /** The deletion the agent proposed, if any, for the confirmation card. */
  getPendingDelete(): DeletePreviewView | null {
    return this.pendingDelete ? toDeletePreviewView(this.pendingDelete) : null;
  }

  async confirmDelete(manifestPath?: string): Promise<DesktopDeleteResult> {
    if (!this.writeService) {
      throw new Error("请先选择或迁移本地知识库。 ");
    }
    if (manifestPath) {
      const restored = await this.writeService.restoreFromTrash(manifestPath);
      this.summary = this.index ? await this.index.sync(this.policy) : this.summary;
      return { targetPath: restored.targetPath, trashPath: "", manifestPath: "", deletedAt: "" };
    }
    if (!this.pendingDelete) {
      throw new Error("当前没有待确认的删除。");
    }
    const result = await this.writeService.applyDelete(this.pendingDelete);
    this.pendingDelete = null;
    this.summary = this.index ? await this.index.sync(this.policy) : this.summary;
    return result;
  }

  /** Drop a pending deletion without touching the filesystem. */
  cancelDelete(): void {
    this.pendingDelete = null;
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

/** Keeps the note's own content out of the renderer's delete card. */
function toDeletePreviewView(preview: DeleteNotePreview): DeletePreviewView {
  return {
    targetPath: preview.targetPath,
    trashPath: preview.trashPath,
    reason: preview.reason,
    excerpt: preview.excerpt,
    inboundLinks: preview.inboundLinks
  };
}
/** Scan bookkeeping, kept beside the notes it describes but not a note itself. */
const OVERLAP_SCAN_STATE_PATH = `${KNOWLEDGE_SYSTEM_FOLDER}/_system/重复检查.json`;
const AUTO_SCAN_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_SCAN_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** New notes since the last scan that make a rescan worth paying for. */
const AUTO_SCAN_NOTE_GROWTH = 5;

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

/**
 * Paths the app keeps for itself, which must never surface as knowledge.
 *
 * One predicate for both the index and the note list, because the two drifting
 * apart is what previously made a deleted note still answer questions: it was
 * gone from the tree but still in the corpus.
 */
function isInternalWorkspacePath(path: string, agentMemoryFolder = DEFAULT_AGENT_MEMORY_FOLDER): boolean {
  return isInternalLibraryPath(path, agentMemoryFolder);
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

/**
 * How much of a Wiki was actually written by the model.
 *
 * Concept pages that fell back to their knowledge-map summary are still
 * outline entries, and the user should be able to tell them apart from pages
 * that were composed from the evidence.
 */
function describeNodeDrafts(result: { composedNodes: number; fallbackNodes: string[] }): string {
  if (!result.composedNodes && !result.fallbackNodes.length) {
    return "";
  }
  const failed = result.fallbackNodes.length
    ? `${result.fallbackNodes.length} 个概念页未能撰写、仍为提纲摘要（${result.fallbackNodes.join("、")}）`
    : "";
  const written = result.composedNodes ? `${result.composedNodes} 个概念页由模型依据证据撰写` : "";
  return [written, failed].filter(Boolean).join("；") + (written || failed ? "。" : "");
}

type DesktopIntent = Exclude<ReturnType<typeof detectDesktopAgentIntent>["intent"], "answer">;

/** Accepts a raw string because the conversation log stores intents untyped. */
function formatIntentAction(intent: DesktopIntent | string): string {
  const names: Record<DesktopIntent, string> = {
    "start-session": "开始会话",
    "close-session": "结束会话",
    "open-profile": "查看用户画像",
    "remember-profile": "更新用户画像",
    "forget-profile": "遗忘用户画像",
    "open-assistant-state": "查看助手状态",
    "set-current-focus": "设置当前重点",
    "compile-wiki": "编译 LLM Wiki",
    "ingest-note": "收录笔记计划",
    "list-uncompiled": "查看待收录笔记",
    "survey-wiki": "梳理知识库主题",
    "expand-wiki": "补全 LLM Wiki",
    "inspect-wiki-sources": "检查 Wiki 来源",
    "process-images": "解析图片",
    "format-clipboard": "整理剪贴板",
    "complete-relations": "补全笔记关联",
    "verify-wiki": "联网核验 Wiki",
    "wiki-overlap": "检查 Wiki 重复页面",
    "tidy-notes": "整理笔记命名",
    "rename-notes": "执行笔记改名",
    "scan-duplicates": "检查重复笔记"
  };
  return names[intent as DesktopIntent] ?? intent;
}

ipcMain.handle("workspace:choose", () => workspace.choose());
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
ipcMain.handle("answer:save", (_event, action, subject, content, sources, turnId) => workspace.saveAnswer(action, subject, content, sources, turnId));
ipcMain.handle("session:resume", () => workspace.resumeConversation());
ipcMain.handle("wiki:create-update-preview", (_event, id: string) => workspace.createWikiUpdatePreview(id));
ipcMain.handle("wiki:audit-missing-sources", (_event, topic: string) => workspace.auditWikiMissingSources(topic));
ipcMain.handle("wiki:health-review", () => workspace.reviewWikiHealth());
ipcMain.handle("knowledge:search", (_event, query: string) => workspace.search(query));
ipcMain.handle("knowledge:list-notes", () => workspace.listNotes());
ipcMain.handle("knowledge:preview-source", (_event, path: string) => workspace.previewSource(path));
ipcMain.handle("knowledge:open-source", (_event, path: string) => workspace.openSource(path));
ipcMain.handle("note:save-edit", (_event, path: string, content: string) => workspace.saveNoteEdit(path, content));
ipcMain.handle("write:get-previews", () => workspace.getWritePreviews());
ipcMain.handle("write:apply-previews", () => workspace.applyWritePreviews());
ipcMain.handle("note:preview-delete", (_event, targetPath: string, reason?: string) =>
  workspace.previewDeleteNote(targetPath, reason)
);
ipcMain.handle("note:get-pending-delete", () => workspace.getPendingDelete());
ipcMain.handle("note:confirm-delete", (_event, manifestPath?: string) => workspace.confirmDelete(manifestPath));
ipcMain.handle("note:cancel-delete", () => workspace.cancelDelete());
ipcMain.handle("note:open-trash", () => workspace.openTrashFolder());

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
