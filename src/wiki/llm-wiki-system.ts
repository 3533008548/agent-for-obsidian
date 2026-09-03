import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import type { KnowledgeIntegrationSession, KnowledgeIntegrationSource, KnowledgeMapNode } from "../integration/knowledge-system";

export const LLM_WIKI_FOLDER = "LLM Wiki";
const ERROR_BOOK_RELATIVE_PATH = `${LLM_WIKI_FOLDER}/_system/Error Book.md`;

export function extractLlmWikiTopic(goal: string): string {
  const beforeWiki = goal.split(/(?:llm\s*)?wiki|知识\s*百科|笔记\s*百科/iu)[0]?.trim() ?? "";
  const compiledFromTopic = beforeWiki.match(/(.+?)(?:相关)?(?:笔记|资料|知识库|知识体系)?\s*(?:整理|整合|编译|生成|创建|构建)(?:成)?$/u)?.[1];
  const directTopic = beforeWiki.match(/(?:整理|整合|编译|生成|创建|构建)(?:一份|一个)?\s*(.+)$/u)?.[1];
  const topic = ((compiledFromTopic ?? directTopic ?? beforeWiki) || goal)
    .replace(/^(?:请|帮我|为我|将|把|基于|针对|关于|库里(?:的)?|知识库(?:中)?(?:的)?|现有(?:的)?)+/u, "")
    .replace(/(?:相关)?(?:笔记|资料|知识库|知识体系)$/u, "")
    .replace(/[，。！？、]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return topic || "未命名主题";
}

export type LlmWikiTopicStatus = "fresh" | "stale";
export type LlmWikiErrorType = "dangling-link" | "missing-source" | "source-stale";

export interface LlmWikiPageRecord {
  path: string;
  title: string;
  summary: string;
  aliases: string[];
  links: string[];
  sourcePaths: string[];
}

export interface LlmWikiTopicRecord {
  id: string;
  topic: string;
  indexPath: string;
  status: LlmWikiTopicStatus;
  updatedAt: string;
  sourceHashes: Array<Pick<SourceRef, "pathOrUrl" | "contentHash">>;
  pages: LlmWikiPageRecord[];
}

export interface LlmWikiError {
  id: string;
  type: LlmWikiErrorType;
  path: string;
  detail: string;
  rule: string;
  status: "open" | "closed";
  observedAt: string;
}

export interface LlmWikiRegistry {
  version: 1;
  topics: LlmWikiTopicRecord[];
  errorBook: LlmWikiError[];
}

export interface LlmWikiPageDraft extends LlmWikiPageRecord {
  relativePath: string;
  content: string;
  sources: SourceRef[];
}

export interface LlmWikiCompilation {
  topic: string;
  pages: LlmWikiPageDraft[];
  nextRegistry: LlmWikiRegistry;
}

export interface LlmWikiSearchResult {
  page: LlmWikiPageRecord;
  score: number;
}

export function createLlmWikiRegistry(value?: Partial<LlmWikiRegistry>): LlmWikiRegistry {
  return {
    version: 1,
    topics: Array.isArray(value?.topics) ? value!.topics.filter(isTopicRecord) : [],
    errorBook: Array.isArray(value?.errorBook) ? value!.errorBook.filter(isErrorRecord) : []
  };
}

export function compileLlmWikiTopic(
  session: KnowledgeIntegrationSession,
  registry: LlmWikiRegistry,
  knowledgeSystemFolder: string
): LlmWikiCompilation {
  const wikiRootPath = `${normalizePath(knowledgeSystemFolder)}/${LLM_WIKI_FOLDER}`;
  const topicFolder = sanitizePathSegment(session.topic);
  const topicRelativeFolder = `${LLM_WIKI_FOLDER}/${topicFolder}`;
  const topicIndexPath = `${wikiRootPath}/${topicFolder}/概览.md`;
  const conceptPages = createConceptPages(session, topicRelativeFolder, topicIndexPath, wikiRootPath);
  const topicPage = createTopicPage(session, topicRelativeFolder, topicIndexPath, conceptPages);
  const sourceHashes = uniqueSources(session.sources.map((source) => source.source)).map((source) => ({
    pathOrUrl: source.pathOrUrl,
    contentHash: source.contentHash
  }));
  const topicRecord: LlmWikiTopicRecord = {
    id: topicFolder,
    topic: session.topic,
    indexPath: topicIndexPath,
    status: "fresh",
    updatedAt: session.createdAt,
    sourceHashes,
    pages: [topicPage, ...conceptPages].map(toPageRecord)
  };
  const topics = [...registry.topics.filter((topic) => topic.id !== topicRecord.id), topicRecord]
    .sort((left, right) => left.topic.localeCompare(right.topic));
  const globalIndex = createGlobalIndexPage(topics, wikiRootPath, session.sources.map((source) => source.source));
  const preliminaryPages = [globalIndex, topicPage, ...conceptPages];
  const validationErrors = validateWikiPages(preliminaryPages, topics, session.createdAt);
  const errorBook = mergeErrorBook(registry.errorBook, validationErrors, topicRecord.id);
  const errorBookPage = createErrorBookPage(errorBook, wikiRootPath, session.sources.map((source) => source.source));
  const pages = [globalIndex, topicPage, ...conceptPages, errorBookPage];

  return {
    topic: session.topic,
    pages,
    nextRegistry: { version: 1, topics, errorBook }
  };
}

export function searchLlmWiki(registry: LlmWikiRegistry, query: string, limit = 4): LlmWikiSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return [];
  }
  const terms = extractTerms(normalized);
  return registry.topics
    .flatMap((topic) => topic.pages)
    .map((page) => ({ page, score: scorePage(page, normalized, terms) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.page.path.localeCompare(right.page.path))
    .slice(0, limit);
}

export function getLinkedWikiPages(registry: LlmWikiRegistry, pages: LlmWikiPageRecord[], limit = 3): LlmWikiPageRecord[] {
  const visited = new Set(pages.map((page) => page.path));
  const pageByPath = new Map(registry.topics.flatMap((topic) => topic.pages).map((page) => [page.path, page]));
  const linked: LlmWikiPageRecord[] = [];
  for (const page of pages) {
    for (const path of page.links) {
      const target = pageByPath.get(path);
      if (!target || visited.has(target.path)) {
        continue;
      }
      visited.add(target.path);
      linked.push(target);
      if (linked.length >= limit) {
        return linked;
      }
    }
  }
  return linked;
}

export function markLlmWikiSourceStale(registry: LlmWikiRegistry, sourcePath: string, observedAt = new Date().toISOString()): LlmWikiRegistry {
  const normalizedPath = normalizePath(sourcePath);
  const staleTopics = registry.topics.filter((topic) => topic.sourceHashes.some((source) => normalizePath(source.pathOrUrl) === normalizedPath));
  if (!staleTopics.length) {
    return registry;
  }
  const staleIds = new Set(staleTopics.map((topic) => topic.id));
  const topics = registry.topics.map((topic) => staleIds.has(topic.id) ? { ...topic, status: "stale" as const } : topic);
  const existingKeys = new Set(registry.errorBook.filter((error) => error.status === "open").map((error) => `${error.type}:${error.path}`));
  const errors = [...registry.errorBook];
  for (const topic of staleTopics) {
    if (!existingKeys.has(`source-stale:${topic.indexPath}`)) {
      errors.push({
        id: `source-stale-${hashText(topic.indexPath)}`,
        type: "source-stale",
        path: topic.indexPath,
        detail: `来源“${sourcePath}”已变化，主题“${topic.topic}”需要增量编译。`,
        rule: "来源哈希变化时，重新编译引用该来源的 Wiki 页面。",
        status: "open",
        observedAt
      });
    }
  }
  return { ...registry, topics, errorBook: errors.slice(-120) };
}

export function isLlmWikiPath(path: string, knowledgeSystemFolder: string): boolean {
  return normalizePath(path).startsWith(`${normalizePath(knowledgeSystemFolder)}/${LLM_WIKI_FOLDER}/`);
}

function createConceptPages(
  session: KnowledgeIntegrationSession,
  topicRelativeFolder: string,
  topicIndexPath: string,
  wikiRootPath: string
): LlmWikiPageDraft[] {
  const sourceById = new Map(session.sources.map((source) => [source.id, source]));
  const pages = session.map.nodes.map((node) => {
    const relativePath = `${topicRelativeFolder}/概念/${node.id}-${sanitizePathSegment(node.title)}.md`;
    const path = `${wikiRootPath}/${relativePath.slice(LLM_WIKI_FOLDER.length + 1)}`;
    const nodeSources = node.sourceIds
      .map((id) => sourceById.get(id))
      .filter((source): source is KnowledgeIntegrationSource => Boolean(source));
    const related = session.map.nodes
      .filter((candidate) => candidate.id !== node.id && sharesSource(node, candidate))
      .slice(0, 3)
      .map((candidate) => `${wikiRootPath}/${topicRelativeFolder.slice(LLM_WIKI_FOLDER.length + 1)}/概念/${candidate.id}-${sanitizePathSegment(candidate.title)}.md`);
    const links = [topicIndexPath, ...related];
    const sources = uniqueSources(nodeSources.map((source) => source.source));
    return {
      path,
      relativePath,
      title: node.title,
      summary: node.summary,
      aliases: [node.id],
      links,
      sourcePaths: sources.map((source) => source.pathOrUrl),
      sources,
      content: [
        renderPageMetadata("concept", session.topic, links, sources, session.createdAt),
        `> [!info] 概念页 · ${session.topic}`,
        `> 返回主题：[[${topicIndexPath}|${session.topic}]]`,
        "",
        "## 核心说明",
        "",
        node.summary,
        "",
        "## 关联概念",
        "",
        ...(related.length ? related.map((relatedPath) => `- [[${relatedPath}]]`) : ["- 当前资料未识别出直接关联的概念页。"]),
        "",
        "## 原始证据",
        "",
        ...renderSources(nodeSources),
        ""
      ].join("\n")
    };
  });
  return pages;
}

function createTopicPage(
  session: KnowledgeIntegrationSession,
  topicRelativeFolder: string,
  topicIndexPath: string,
  concepts: LlmWikiPageDraft[]
): LlmWikiPageDraft {
  const sources = uniqueSources(session.sources.map((source) => source.source));
  const links = concepts.map((concept) => concept.path);
  return {
    path: topicIndexPath,
    relativePath: `${topicRelativeFolder}/概览.md`,
    title: `${session.topic} · LLM Wiki`,
    summary: session.map.overview,
    aliases: [session.topic],
    links,
    sourcePaths: sources.map((source) => source.pathOrUrl),
    sources,
    content: [
      renderPageMetadata("topic", session.topic, links, sources, session.createdAt),
      `> [!abstract] ${session.topic}`,
      `> 由 ${session.sources.length} 条原始资料编译；细节请回查来源。`,
      "",
      "## 主题概览",
      "",
      session.map.overview,
      "",
      "## 概念导航",
      "",
      ...concepts.map((concept) => `- [[${concept.path}|${concept.title}]]：${concept.summary}`),
      "",
      "## 已知差异",
      "",
      ...(session.map.conflicts.length ? session.map.conflicts.map((item) => `- ${item}`) : ["- 当前资料中未发现明确冲突。"]),
      "",
      "## 待补充",
      "",
      ...(session.map.gaps.length ? session.map.gaps.map((item) => `- ${item}`) : ["- 当前资料未识别出明确缺口。"]),
      "",
      "## 原始资料",
      "",
      ...renderSources(session.sources),
      ""
    ].join("\n")
  };
}

function createGlobalIndexPage(topics: LlmWikiTopicRecord[], wikiRootPath: string, sources: SourceRef[]): LlmWikiPageDraft {
  const path = `${wikiRootPath}/index.md`;
  const links = [...topics.map((topic) => topic.indexPath), `${wikiRootPath}/_system/Error Book.md`];
  return {
    path,
    relativePath: `${LLM_WIKI_FOLDER}/index.md`,
    title: "LLM Wiki",
    summary: "个人知识库的主题入口。",
    aliases: ["知识百科"],
    links,
    sourcePaths: sources.map((source) => source.pathOrUrl),
    sources: uniqueSources(sources),
    content: [
      renderPageMetadata("global-index", "LLM Wiki", links, sources, new Date().toISOString()),
      "> [!info] LLM Wiki 入口",
      "> 主题页由原始资料增量编译；标记为“需更新”的主题有来源变化。",
      "",
      "## 已编译主题",
      "",
      ...(topics.length
        ? topics.map((topic) => `- [[${topic.indexPath}|${topic.topic}]]${topic.status === "stale" ? " · 需更新" : ""}`)
        : ["- 尚未编译主题。"]),
      "",
      `- [[${wikiRootPath}/_system/Error Book|Error Book]]`,
      ""
    ].join("\n")
  };
}

function createErrorBookPage(errors: LlmWikiError[], wikiRootPath: string, sources: SourceRef[]): LlmWikiPageDraft {
  const path = `${wikiRootPath}/_system/Error Book.md`;
  const openErrors = errors.filter((error) => error.status === "open");
  return {
    path,
    relativePath: ERROR_BOOK_RELATIVE_PATH,
    title: "LLM Wiki Error Book",
    summary: "Wiki 编译中的结构与来源问题。",
    aliases: ["Error Book"],
    links: [],
    sourcePaths: sources.map((source) => source.pathOrUrl),
    sources: uniqueSources(sources),
    content: [
      renderPageMetadata("error-book", "LLM Wiki", [], sources, new Date().toISOString()),
      "> [!info] Error Book",
      "> 记录可复用的 Wiki 结构与来源修复规则。",
      "",
      "## 未关闭问题",
      "",
      ...(openErrors.length
        ? openErrors.map((error) => `- **${error.type}** · [[${error.path}]]：${error.detail}\n  - 规则：${error.rule}`)
        : ["- 当前没有未关闭的问题。"]),
      ""
    ].join("\n")
  };
}

function validateWikiPages(pages: LlmWikiPageDraft[], topics: LlmWikiTopicRecord[], observedAt: string): LlmWikiError[] {
  const globalIndex = pages.find((page) => page.relativePath === `${LLM_WIKI_FOLDER}/index.md`);
  const errorBookPath = globalIndex ? globalIndex.path.replace(/\/index\.md$/u, "/_system/Error Book.md") : "";
  const knownPaths = new Set([
    ...pages.map((page) => page.path),
    ...topics.flatMap((topic) => topic.pages.map((page) => page.path)),
    ...(errorBookPath ? [errorBookPath] : [])
  ]);
  const errors: LlmWikiError[] = [];
  for (const page of pages) {
    if (!page.sources.length) {
      errors.push(createError("missing-source", page.path, "页面没有原始来源。", "每个 Wiki 页面必须保留至少一条原始来源。", observedAt));
    }
    for (const link of page.links) {
      if (!knownPaths.has(link)) {
        errors.push(createError("dangling-link", page.path, `链接目标不存在：${link}`, "生成 Wiki 链接前必须确认目标页面已在注册表中。", observedAt));
      }
    }
  }
  return errors;
}

function mergeErrorBook(previous: LlmWikiError[], current: LlmWikiError[], refreshedTopicId: string): LlmWikiError[] {
  const refreshedPrefix = `/${refreshedTopicId}/`;
  const retained = previous.map((error) => (
    error.status === "open" && error.path.includes(refreshedPrefix)
      ? { ...error, status: "closed" as const }
      : error
  ));
  const existing = new Set(retained.map((error) => `${error.type}:${error.path}:${error.detail}`));
  for (const error of current) {
    const key = `${error.type}:${error.path}:${error.detail}`;
    if (!existing.has(key)) {
      retained.push(error);
    }
  }
  return retained.slice(-120);
}

function createError(type: LlmWikiErrorType, path: string, detail: string, rule: string, observedAt: string): LlmWikiError {
  return {
    id: `${type}-${hashText(`${path}:${detail}`)}`,
    type,
    path,
    detail,
    rule,
    status: "open",
    observedAt
  };
}

function renderPageMetadata(kind: string, topic: string, links: string[], sources: SourceRef[], updatedAt: string): string {
  return `<!-- knowledge-loop-agent:llm-wiki\n${JSON.stringify({ version: 2, kind, topic, links, sources: sources.map((source) => ({ path: source.pathOrUrl, hash: source.contentHash })), updatedAt })}\n-->`;
}

function renderSources(sources: KnowledgeIntegrationSource[]): string[] {
  return sources.map((source) => `- [[${source.source.pathOrUrl}|${source.title}]]${source.source.locator ? ` · ${source.source.locator}` : ""}`);
}

function sharesSource(left: KnowledgeMapNode, right: KnowledgeMapNode): boolean {
  return left.sourceIds.some((sourceId) => right.sourceIds.includes(sourceId));
}

function toPageRecord(page: LlmWikiPageDraft): LlmWikiPageRecord {
  const { relativePath: _relativePath, content: _content, sources: _sources, ...record } = page;
  return record;
}

function uniqueSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.type}:${source.pathOrUrl}:${source.locator}:${source.contentHash}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scorePage(page: LlmWikiPageRecord, query: string, terms: string[]): number {
  const title = page.title.toLocaleLowerCase();
  const aliases = page.aliases.join(" ").toLocaleLowerCase();
  const summary = page.summary.toLocaleLowerCase();
  let score = title.includes(query) ? 20 : aliases.includes(query) ? 16 : summary.includes(query) ? 10 : 0;
  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (aliases.includes(term)) score += 6;
    if (summary.includes(term)) score += 3;
  }
  return score;
}

function extractTerms(value: string): string[] {
  return [...new Set([
    ...(value.match(/[a-z0-9][a-z0-9._-]*/gu) ?? []),
    ...(value.match(/[\u3400-\u9fff]{2,}/gu) ?? [])
  ])];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/u, "");
}

function sanitizePathSegment(value: string): string {
  const result = value
    .normalize("NFKC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 96);
  return result || "未命名";
}

function isTopicRecord(value: unknown): value is LlmWikiTopicRecord {
  return Boolean(value && typeof value === "object" &&
    typeof (value as LlmWikiTopicRecord).id === "string" &&
    typeof (value as LlmWikiTopicRecord).topic === "string" &&
    Array.isArray((value as LlmWikiTopicRecord).pages));
}

function isErrorRecord(value: unknown): value is LlmWikiError {
  return Boolean(value && typeof value === "object" &&
    typeof (value as LlmWikiError).id === "string" &&
    typeof (value as LlmWikiError).type === "string" &&
    typeof (value as LlmWikiError).status === "string");
}
