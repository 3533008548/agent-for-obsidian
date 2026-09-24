import type { GardenerPlan } from "../gardener/knowledge-gardener";
import type { KnowledgeIntegrationSession } from "../integration/knowledge-system";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { PolicyEngine } from "../policy/policy-engine";
import { createAgentToolRegistry, type AgentToolExecutors } from "../runtime/agent-tools";
import {
  LocalKnowledgeUnavailableError,
  RuntimeToolBlockedError
} from "../runtime/agent-runtime-errors";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import type { DesktopWritePreview } from "./desktop-write-service";
import type { DesktopAgentAnswer, DesktopAgentService } from "./desktop-agent-service";
import type { DesktopAttachmentService } from "./desktop-attachment-service";
import type { DesktopKnowledgeSystemService } from "./desktop-knowledge-system-service";
import type { DesktopMaintenanceService } from "./desktop-maintenance-service";
import type { DesktopRelationPreview, DesktopRelationService } from "./desktop-relation-service";
import type {
  DesktopWikiCompileDraft,
  DesktopWikiPageContent,
  DesktopWikiService
} from "./desktop-wiki-service";
import type { LlmWikiPageRecord } from "../wiki/llm-wiki-system";

/**
 * Artefacts produced by steps in one run.
 *
 * Later steps read what earlier steps produced, exactly like the plugin
 * runtime. It is deliberately in-memory: nothing here is a source of truth.
 */
export interface DesktopRuntimeState {
  answer?: DesktopAgentAnswer & { query: string };
  knowledgeMap?: KnowledgeIntegrationSession;
  maintenance?: GardenerPlan;
  wikiCandidates?: LlmWikiPageRecord[];
  wikiPages?: DesktopWikiPageContent[];
  wikiDraft?: DesktopWikiCompileDraft;
  writePreviews?: DesktopWritePreview[];
  relationPreview?: DesktopRelationPreview;
}

export interface DesktopRuntimeToolDependencies {
  index: PortableMarkdownKnowledgeIndex;
  policy: PolicyEngine;
  agent: DesktopAgentService;
  wiki: DesktopWikiService;
  knowledge: DesktopKnowledgeSystemService;
  maintenance: DesktopMaintenanceService;
  attachments: DesktopAttachmentService;
  relation: DesktopRelationService;
  write: DesktopWritePreviewFactory;
  state: DesktopRuntimeState;
  knowledgeSystemFolder: string;
  deepSeekApiKey: () => string;
  deepSeekModel: () => string;
  requestTimeoutMs: () => number;
  activeNotePath: () => string | null;
  formatClipboard: () => Promise<{ content: string; changed: boolean }>;
  describeStatus: () => string;
}

/** The desktop shell supplies previews through `DesktopWriteService`. */
export interface DesktopWritePreviewFactory {
  previewAnswer(
    action: "createInboxNote" | "appendDailyNote",
    subject: string,
    content: string,
    sources: Array<{ path: string; heading: string | null; excerpt: string }>
  ): Promise<DesktopWritePreview>;
  previewPath(targetPath: string, content: string): Promise<DesktopWritePreview>;
  previewExistingNote(notePath: string, afterContent: string): Promise<DesktopWritePreview>;
}

const NO_LOCAL_EVIDENCE_FEEDBACK = "本地检索没有可用证据。不要再次安排 research:answer-vault；请根据用户目标选择有信息增益的替代动作，例如 research:answer-web。";
const NO_WIKI_PAGES_FEEDBACK = "当前 LLM Wiki 没有命中页面。不要再次安排 research:wiki-search；请根据用户目标选择有信息增益的替代动作，例如 research:answer-web。";
const WIKI_UNREADABLE_FEEDBACK = "命中的 LLM Wiki 页面已不可读取。不要再次安排 research:wiki-read；请改用有信息增益的补证动作，例如 research:answer-web。";

export function createDesktopRuntimeToolRegistry(
  deps: DesktopRuntimeToolDependencies
): ReturnType<typeof createAgentToolRegistry> {
  const executors: AgentToolExecutors = {
    "index:rebuild-markdown": async () => {
      const summary = await deps.index.rebuild(deps.policy);
      return { summary: `已索引 ${summary.indexedFiles} 个文件和 ${summary.chunkCount} 个片段。` };
    },
    "index:scan-attachments": async () => {
      const summary = await deps.attachments.scan();
      const unsupported = summary.unsupportedPdfCount
        ? `，${summary.unsupportedPdfCount} 个 PDF 暂不在桌面端解析`
        : "";
      return {
        summary: `附件扫描完成：已入队 ${summary.queued}，未变化 ${summary.unchanged}，未授权 ${summary.blocked}${unsupported}。`
      };
    },
    "index:process-attachments": async () => {
      const result = await deps.attachments.processAll();
      if (result.pending > 0 && result.indexed === 0) {
        throw new RuntimeToolBlockedError(`附件批处理未能完成：成功 ${result.indexed} 项，失败 ${result.failed} 项，剩余 ${result.pending} 项。`);
      }
      return { summary: `附件批处理完成：成功 ${result.indexed} 项，失败 ${result.failed} 项，剩余 ${result.pending} 项。` };
    },
    "research:answer-vault": async ({ goal }) => {
      try {
        const answer = await deps.agent.answer(goal, "local-only");
        deps.state.answer = { ...answer, query: goal };
        return {
          summary: `已生成带 ${answer.sources.length} 条本地来源的回答。`,
          artifact: "answer"
        };
      } catch (error) {
        if (error instanceof LocalKnowledgeUnavailableError) {
          return createRecoveryResult(error.message, error.replanFeedback, "answer-vault");
        }
        throw error;
      }
    },
    "research:wiki-search": async ({ goal }) => {
      const candidates = await deps.wiki.searchPages(goal);
      if (!candidates.length) {
        return createRecoveryResult("当前 LLM Wiki 没有命中页面，Agent 已自动规划补证步骤。", NO_WIKI_PAGES_FEEDBACK, "wiki-search");
      }
      deps.state.wikiCandidates = candidates;
      return { summary: `LLM Wiki 搜索命中 ${candidates.length} 个页面：${candidates.map((page) => page.title).join("、")}。` };
    },
    "research:wiki-read": async () => {
      const candidates = deps.state.wikiCandidates;
      if (!candidates?.length) {
        return createRecoveryResult("当前 LLM Wiki 没有命中页面，Agent 已自动规划补证步骤。", NO_WIKI_PAGES_FEEDBACK, "wiki-search");
      }
      const pages = await deps.wiki.readPages(candidates);
      if (!pages.length) {
        return createRecoveryResult("命中的 LLM Wiki 页面已不可读取，Agent 已自动规划补证步骤。", WIKI_UNREADABLE_FEEDBACK, "wiki-read");
      }
      deps.state.wikiPages = mergeWikiPages(deps.state.wikiPages, pages);
      return { summary: `已阅读 ${pages.length} 个 Wiki 页面：${pages.map((page) => page.title).join("、")}。` };
    },
    "research:wiki-follow": async () => {
      const pages = deps.state.wikiPages;
      if (!pages?.length) {
        throw new RuntimeToolBlockedError("此步骤需要本次运行先阅读 Wiki 页面；请重新执行 Wiki 遍历。");
      }
      const linked = await deps.wiki.followPages(pages.map((page) => page.path));
      if (!linked.length) {
        return { summary: "已读页面没有可继续跟随的 Wiki 链接；将使用当前证据回答。" };
      }
      const followed = await deps.wiki.readPages(linked);
      deps.state.wikiPages = mergeWikiPages(pages, followed);
      return { summary: followed.length ? `已沿 Wiki 链接继续阅读：${followed.map((page) => page.title).join("、")}。` : "可跟随的链接均不可读取；将使用当前证据回答。" };
    },
    "research:answer-wiki": async ({ goal }) => {
      const pages = deps.state.wikiPages;
      if (!pages?.length) {
        throw new RuntimeToolBlockedError("此步骤需要本次运行先阅读 Wiki 页面；请重新执行 Wiki 遍历。");
      }
      try {
        const answer = await deps.wiki.answerFromPages(goal, pages);
        deps.state.answer = {
          content: answer.content,
          mode: "local",
          evidenceComplete: true,
          sources: pages.map((page) => ({ path: page.path, heading: page.title, excerpt: "" })),
          query: goal
        };
        return { summary: `已基于 ${answer.paths.length} 个 Wiki 页面生成回答。`, artifact: "answer" };
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误。";
        return createRecoveryResult(message, WIKI_UNREADABLE_FEEDBACK, "answer-wiki");
      }
    },
    "research:answer-web": async ({ goal }) => {
      const answer = await deps.agent.answerFromWeb(goal);
      deps.state.answer = { ...answer, query: goal };
      return {
        summary: answer.mode === "web"
          ? "已生成联网回答。"
          : "联网无可用网页结果，已生成明确标识的通用回答。",
        artifact: "answer"
      };
    },
    "organize:maintenance-plan": async ({ goal }) => {
      const plan = await deps.maintenance.analyze(goal);
      deps.state.maintenance = plan;
      return { summary: `知识库维护分析完成：发现 ${plan.findings.length} 项问题。${plan.summary}` };
    },
    "organize:note-relations": async () => {
      const path = deps.activeNotePath();
      if (!path) {
        throw new RuntimeToolBlockedError("请先在目录中打开一篇笔记，再请求补全关联。");
      }
      const preview = await deps.relation.preview(path);
      if (!preview.afterContent) {
        return { summary: `关联分析完成：${preview.summary} 未发现需要补充的高置信度关联。` };
      }
      deps.state.relationPreview = preview;
      deps.state.writePreviews = [await deps.write.previewExistingNote(preview.path, preview.afterContent)];
      return { summary: `关联分析完成：已生成 ${preview.relationCount} 条关联的写入预览。`, artifact: "write-preview" };
    },
    "organize:knowledge-map": async ({ goal }) => {
      const session = await deps.knowledge.createMap(goal);
      deps.state.knowledgeMap = session;
      deps.state.writePreviews = [await deps.knowledge.previewMap(session)];
      return {
        summary: `已生成知识地图：${session.map.nodes.length} 个节点，并已生成知识体系笔记写入预览。`,
        artifact: "write-preview"
      };
    },
    "organize:compile-wiki": async ({ goal }) => {
      const draft = await deps.wiki.compileDraft(goal);
      const previews: DesktopWritePreview[] = [];
      for (const page of draft.pages) {
        previews.push(await deps.write.previewPath(page.targetPath, page.content));
      }
      deps.state.wikiDraft = draft;
      deps.state.writePreviews = previews;
      return {
        summary: `已生成 LLM Wiki：${draft.pages.length} 个页面、${draft.sourceCount} 条来源；已生成写入预览。`,
        artifact: "write-preview"
      };
    },
    "organize:knowledge-node": async () => {
      const session = deps.state.knowledgeMap;
      if (!session) {
        throw new RuntimeToolBlockedError("此步骤需要本次运行先生成知识地图。");
      }
      const node = session.map.nodes.find((candidate) => candidate.priority === "high") ?? session.map.nodes[0];
      if (!node) {
        throw new RuntimeToolBlockedError("本次知识地图没有可展开的节点。");
      }
      deps.state.writePreviews = [await deps.knowledge.previewNode(session, node.id)];
      return { summary: `已为“${node.title}”生成写入预览，仍需单独确认写入。`, artifact: "write-preview" };
    },
    "note:preview-inbox": async () => createNotePreview(deps, "createInboxNote"),
    "note:preview-daily": async () => createNotePreview(deps, "appendDailyNote"),
    "note:preview-knowledge-map": async () => {
      const session = deps.state.knowledgeMap;
      if (!session) {
        throw new RuntimeToolBlockedError("此步骤需要本次运行先生成知识地图。");
      }
      deps.state.writePreviews = [await deps.knowledge.previewMap(session)];
      return { summary: "已生成知识地图写入预览，仍需单独确认写入。", artifact: "write-preview" };
    },
    "editor:normalize-paste": async () => {
      const result = await deps.formatClipboard();
      return {
        summary: result.changed ? "已把剪贴板整理为规范 Markdown，现在可以直接粘贴。" : "剪贴板内容无需调整。"
      };
    },
    "editor:repair-selection": async () => {
      throw new RuntimeToolBlockedError("桌面端没有编辑器选区；请使用“规范化粘贴”或先复制要修复的内容。");
    },
    "system:diagnose": async () => ({ summary: deps.describeStatus() }),
    "system:test-deepseek": async () => {
      const result = await createDeepSeekClient(deps).testConnection();
      return { summary: `DeepSeek 连通性测试通过，模型 ${result.model}。` };
    },
    "system:test-glm": async () => {
      throw new RuntimeToolBlockedError("桌面端不使用 GLM；图片解析由 DeepSeek Vision 提供。");
    }
  };
  return createAgentToolRegistry(executors);

  function createRecoveryResult(
    summary: string,
    replanFeedback: string,
    action: "answer-vault" | "wiki-search" | "wiki-read" | "answer-wiki"
  ) {
    const tool = action.startsWith("wiki") || action === "answer-wiki" ? "research" : "research";
    return {
      summary,
      replanFeedback,
      replanExclusions: [{ tool, action } as const],
      autoContinue: true
    };
  }
}

async function createNotePreview(
  deps: DesktopRuntimeToolDependencies,
  action: "createInboxNote" | "appendDailyNote"
) {
  const answer = deps.state.answer;
  if (!answer || !answer.content.trim()) {
    throw new RuntimeToolBlockedError("此步骤需要本次运行先生成一个回答。");
  }
  const subject = answer.query.trim() || "未命名主题";
  const preview = await deps.write.previewAnswer(action, subject, answer.content, answer.sources);
  deps.state.writePreviews = [preview];
  return {
    summary: `已生成${action === "createInboxNote" ? " Inbox 笔记" : "主题 Daily"}写入预览：${preview.targetPath}。`,
    artifact: "write-preview" as const
  };
}

function createDeepSeekClient(deps: DesktopRuntimeToolDependencies): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: deps.deepSeekApiKey(),
    model: deps.deepSeekModel(),
    slowResponseMs: deps.requestTimeoutMs(),
    postJson: postJsonWithFetch
  });
}

function mergeWikiPages(
  current: DesktopWikiPageContent[] | undefined,
  incoming: DesktopWikiPageContent[]
): DesktopWikiPageContent[] {
  const merged = [...(current ?? [])];
  for (const page of incoming) {
    if (!merged.some((candidate) => candidate.path === page.path)) {
      merged.push(page);
    }
  }
  return merged;
}

export { NO_LOCAL_EVIDENCE_FEEDBACK };
