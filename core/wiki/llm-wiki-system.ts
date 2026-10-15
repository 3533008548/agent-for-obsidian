import { hashText } from "../domain/content-hash";
import { humanizeLocator } from "../domain/source-ref";
import type { SourceRef } from "../domain/source-ref";
import { tokenizeForSearch } from "../indexing/bm25";
import { renderKnowledgeNodeContent } from "../integration/knowledge-system";
import type {
  KnowledgeIntegrationSession,
  KnowledgeIntegrationSource,
  KnowledgeMapNode,
  KnowledgeNodeDraft
} from "../integration/knowledge-system";

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

/**
 * A source note as the registry remembers it.
 *
 * `contentHash` alone cannot answer "what changed" — a typo and a rewrite both
 * produce an unrelated value, so every small correction would read as a full
 * replacement. `blockHashes` keeps the per-block values that make the difference
 * a position instead of a guess. It is optional because registries written
 * before the split carry only the single hash; those degrade to "assume
 * changed" rather than pretending to know.
 */
export interface LlmWikiSourceRecord {
  pathOrUrl: string;
  contentHash: string;
  blockHashes?: string[];
}

export interface LlmWikiTopicRecord {
  id: string;
  topic: string;
  indexPath: string;
  status: LlmWikiTopicStatus;
  updatedAt: string;
  sourceHashes: LlmWikiSourceRecord[];
  coverage?: LlmWikiCoverage;
  sourceHealth?: LlmWikiSourceHealth[];
  pages: LlmWikiPageRecord[];
}

export type LlmWikiCompilationMode = "compile" | "expand";

export interface LlmWikiCoverageReport {
  mode: LlmWikiCompilationMode;
  added: number;
  changed: number;
  reused: number;
  remainingCandidates: number;
}

/** Cumulative source evidence used to keep incremental compilation from restarting at the same notes. */
export interface LlmWikiCoverage {
  seenSourceHashes: Array<Pick<SourceRef, "pathOrUrl" | "contentHash">>;
  lastExpansionAt?: string;
  lastReport?: LlmWikiCoverageReport;
}

export type LlmWikiSourceStatus = "active" | "changed" | "missing" | "unverified";

/** Health is derived from the current local files; it never restores deleted source text. */
export interface LlmWikiSourceHealth {
  pathOrUrl: string;
  status: LlmWikiSourceStatus;
  checkedAt: string;
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

export interface LlmWikiCompilationOptions {
  mode?: LlmWikiCompilationMode;
  coverageReport?: LlmWikiCoverageReport;
  sourceHealth?: LlmWikiSourceHealth[];
  /**
   * Model-written bodies for concept nodes, keyed by node id.
   *
   * Writing them costs one call per node, so the caller decides how many it is
   * willing to pay for; nodes without a draft keep the knowledge-map summary
   * and the page stays an outline entry rather than failing the compilation.
   */
  nodeDrafts?: ReadonlyMap<string, KnowledgeNodeDraft>;
  /**
   * Overrides the folder id derived from the topic name.
   *
   * The topic table gives every theme one stable id, so "RAG" and "RAG 检索"
   * resolve to the same folder instead of opening two. Without an override the
   * id comes from the wording the user happened to type.
   */
  topicId?: string;
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
  knowledgeSystemFolder: string,
  options: LlmWikiCompilationOptions = {}
): LlmWikiCompilation {
  const wikiRootPath = `${normalizePath(knowledgeSystemFolder)}/${LLM_WIKI_FOLDER}`;
  const topicFolder = options.topicId?.trim() || getLlmWikiTopicId(session.topic);
  const topicRelativeFolder = `${LLM_WIKI_FOLDER}/${topicFolder}`;
  const topicIndexPath = `${wikiRootPath}/${topicFolder}/概览.md`;
  const conceptPages = createConceptPages(session, topicRelativeFolder, topicIndexPath, wikiRootPath, options.nodeDrafts);
  const previousTopic = registry.topics.find((topic) => topic.id === topicFolder);
  const retainedConcepts = options.mode === "expand"
    ? retainExistingConceptPages(previousTopic, topicIndexPath, conceptPages)
    : [];
  const topicPage = createTopicPage(session, topicRelativeFolder, topicIndexPath, conceptPages, retainedConcepts);
  const currentSourceHashes = uniqueSources(session.sources.map((source) => source.source)).map((source) => ({
    pathOrUrl: source.pathOrUrl,
    contentHash: source.contentHash
  }));
  const previousCoverage = previousTopic?.coverage?.seenSourceHashes ?? previousTopic?.sourceHashes ?? [];
  const sourceHashes = options.mode === "expand"
    ? mergeSourceHashes(previousTopic?.sourceHashes ?? [], currentSourceHashes)
    : currentSourceHashes;
  const coverage: LlmWikiCoverage = {
    seenSourceHashes: mergeSourceHashes(previousCoverage, currentSourceHashes),
    ...(options.mode === "expand" ? { lastExpansionAt: session.createdAt } : previousTopic?.coverage?.lastExpansionAt ? { lastExpansionAt: previousTopic.coverage.lastExpansionAt } : {}),
    ...(options.coverageReport ? { lastReport: options.coverageReport } : previousTopic?.coverage?.lastReport ? { lastReport: previousTopic.coverage.lastReport } : {})
  };
  const sourceHealth = options.sourceHealth ?? previousTopic?.sourceHealth;
  const topicRecord: LlmWikiTopicRecord = {
    id: topicFolder,
    topic: session.topic,
    indexPath: topicIndexPath,
    status: hasSourceHealthIssue(sourceHealth) ? "stale" : "fresh",
    updatedAt: session.createdAt,
    sourceHashes,
    coverage,
    ...(sourceHealth?.length ? { sourceHealth } : {}),
    pages: [toPageRecord(topicPage), ...conceptPages.map(toPageRecord), ...retainedConcepts]
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

/**
 * Keeps concept page paths stable across compiles.
 *
 * A page path is `概念/${node.id}-${title}.md`, and both parts come from a
 * freshly generated map: the model re-derives titles from the sources on every
 * run, and ids are positional. The same concept therefore landed on a new path
 * each expansion while retainExistingConceptPages kept the old pages — one
 * recompile, one set of near-duplicate pages. Matching nodes back to the
 * previous pages by title and re-adopting their ids makes an expansion
 * overwrite in place; genuinely new concepts still get fresh ids.
 */
export function stabilizeWikiNodeIds(
  nodes: KnowledgeMapNode[],
  previousTopic: LlmWikiTopicRecord | undefined
): KnowledgeMapNode[] {
  if (!previousTopic?.pages.length || !nodes.length) {
    return nodes;
  }
  const idByTitle = new Map<string, string>();
  for (const page of previousTopic.pages) {
    const match = page.path.match(/\/概念\/([^/]+)-([^/]+)\.md$/u);
    if (!match) {
      continue;
    }
    const key = normalizeConceptTitle(match[2]!);
    if (key && !idByTitle.has(key)) {
      idByTitle.set(key, match[1]!);
    }
  }
  if (!idByTitle.size) {
    return nodes;
  }
  const claimed = new Set<string>();
  return nodes.map((node) => {
    const existingId = idByTitle.get(normalizeConceptTitle(node.title));
    if (!existingId || claimed.has(existingId)) {
      return node;
    }
    claimed.add(existingId);
    return { ...node, id: existingId };
  });
}

function normalizeConceptTitle(title: string): string {
  return title.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export interface WikiPageOverlapPair {
  a: string;
  b: string;
  aTitle: string;
  bTitle: string;
  topic: string;
  score: number;
  signals: string[];
}

/** Read-only: repeated expansion compiles leave near-duplicate pages behind. */
export function findOverlappingWikiPages(registry: LlmWikiRegistry, limit = 12): WikiPageOverlapPair[] {
  const pages = registry.topics.flatMap((topic) => topic.pages
    .filter((page) => page.path.includes("/概念/"))
    .map((page) => ({
      path: page.path,
      title: page.title,
      topic: topic.topic,
      text: new Set(tokenizeForSearch(`${page.title} ${page.summary}`).slice(0, 200)),
      titleTokens: new Set(tokenizeForSearch(page.title))
    })));

  const pairs: WikiPageOverlapPair[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const left = pages[i]!;
      const right = pages[j]!;
      const signals: string[] = [];
      let score = 0;

      let shared = 0;
      for (const token of left.text) {
        if (right.text.has(token)) {
          shared += 1;
        }
      }
      const smaller = Math.min(left.text.size, right.text.size);
      const containment = smaller ? shared / smaller : 0;
      if (shared >= 4 && containment >= 0.6) {
        score = containment;
        signals.push(`标题与摘要重合 ${Math.round(containment * 100)}%`);
      }

      let titleShared = 0;
      for (const token of left.titleTokens) {
        if (right.titleTokens.has(token)) {
          titleShared += 1;
        }
      }
      const titleUnion = left.titleTokens.size + right.titleTokens.size - titleShared;
      const titleOverlap = titleUnion ? titleShared / titleUnion : 0;
      if (titleShared >= 2 && titleOverlap >= 0.7) {
        score = Math.max(score, titleOverlap);
        signals.push("标题近同");
      }

      if (signals.length) {
        pairs.push({
          a: left.path,
          b: right.path,
          aTitle: left.title,
          bTitle: right.title,
          topic: left.topic === right.topic ? left.topic : `${left.topic} / ${right.topic}`,
          score,
          signals
        });
      }
    }
  }
  return pairs
    .sort((left, right) => right.score - left.score || left.a.localeCompare(right.a) || left.b.localeCompare(right.b))
    .slice(0, limit);
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
  const staleTopics = registry.topics.filter((topic) => getTopicSourceHashes(topic)
    .some((source) => normalizePath(source.pathOrUrl) === normalizedPath));
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

export function updateLlmWikiTopicSourceHealth(
  registry: LlmWikiRegistry,
  topicId: string,
  sourceHealth: LlmWikiSourceHealth[]
): LlmWikiRegistry {
  const topics = registry.topics.map((topic) => topic.id === topicId
    ? {
      ...topic,
      sourceHealth,
      status: hasSourceHealthIssue(sourceHealth) ? "stale" as const : "fresh" as const
    }
    : topic);
  return { ...registry, topics };
}

/**
 * Aligns the Error Book with the health recorded on each topic.
 *
 * Health is refreshed by re-reading the sources, so an entry has to be closed
 * again once the topic is back in sync — otherwise the Error Book keeps nagging
 * about drift that was already fixed by the last incremental compilation.
 */
export function syncWikiSourceErrors(
  registry: LlmWikiRegistry,
  observedAt = new Date().toISOString()
): LlmWikiRegistry {
  const driftingPaths = new Set(registry.topics
    .filter((topic) => hasSourceHealthIssue(topic.sourceHealth))
    .map((topic) => topic.indexPath));
  const errorBook = registry.errorBook.map((error) => (
    error.type === "source-stale" && error.status === "open" && !driftingPaths.has(error.path)
      ? { ...error, status: "closed" as const }
      : error
  ));
  const alreadyReported = new Set(errorBook
    .filter((error) => error.type === "source-stale" && error.status === "open")
    .map((error) => error.path));
  for (const topic of registry.topics) {
    if (!driftingPaths.has(topic.indexPath) || alreadyReported.has(topic.indexPath)) {
      continue;
    }
    errorBook.push({
      id: `source-stale-${hashText(topic.indexPath)}`,
      type: "source-stale",
      path: topic.indexPath,
      detail: `主题“${topic.topic}”的${describeSourceDrift(topic.sourceHealth ?? [])}，需要增量编译。`,
      rule: "来源哈希变化时，重新编译引用该来源的 Wiki 页面。",
      status: "open",
      observedAt
    });
  }
  return { ...registry, errorBook: errorBook.slice(-120) };
}

function describeSourceDrift(sourceHealth: LlmWikiSourceHealth[]): string {
  const changed = sourceHealth.filter((source) => source.status === "changed").length;
  const missing = sourceHealth.filter((source) => source.status === "missing").length;
  const parts: string[] = [];
  if (changed) {
    parts.push(`${changed} 篇来源已修改`);
  }
  if (missing) {
    parts.push(`${missing} 篇来源已删除`);
  }
  return parts.length ? parts.join("、") : "来源已变化";
}

/** Root folder of the compiled Wiki inside the knowledge-system folder. */
export function llmWikiFolderPath(knowledgeSystemFolder: string): string {
  return `${normalizePath(knowledgeSystemFolder)}/${LLM_WIKI_FOLDER}`;
}

export function getLlmWikiTopicId(topic: string): string {
  return sanitizePathSegment(topic);
}

export function isLlmWikiPath(path: string, knowledgeSystemFolder: string): boolean {
  return normalizePath(path).startsWith(`${normalizePath(knowledgeSystemFolder)}/${LLM_WIKI_FOLDER}/`);
}

function createConceptPages(
  session: KnowledgeIntegrationSession,
  topicRelativeFolder: string,
  topicIndexPath: string,
  wikiRootPath: string,
  nodeDrafts?: ReadonlyMap<string, KnowledgeNodeDraft>
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
    const draft = nodeDrafts?.get(node.id);
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
        `> [!info] 概念页 · ${session.topic}`,
        `> 返回主题：[[${topicIndexPath}|${session.topic}]]`,
        "",
        "## 核心说明",
        "",
        // A composed draft brings its own conflict and gap sections; without
        // one the page is the knowledge-map summary, which is an outline entry
        // rather than written prose.
        draft ? renderKnowledgeNodeContent(draft) : node.summary,
        "",
        "## 关联概念",
        "",
        ...(related.length ? related.map((relatedPath) => `- [[${relatedPath}]]`) : ["- 当前资料未识别出直接关联的概念页。"]),
        "",
        "## 原始证据",
        "",
        ...renderSources(nodeSources),
        "",
        // Machine state goes last, not right under the title: nobody opens a
        // page to read a JSON ledger, and several readers show it verbatim.
        renderPageMetadata("concept", session.topic, links, sources, session.createdAt)
      ].join("\n")
    };
  });
  return pages;
}

function createTopicPage(
  session: KnowledgeIntegrationSession,
  topicRelativeFolder: string,
  topicIndexPath: string,
  concepts: LlmWikiPageDraft[],
  retainedConcepts: LlmWikiPageRecord[] = []
): LlmWikiPageDraft {
  const sources = uniqueSources(session.sources.map((source) => source.source));
  const allConcepts = [...concepts, ...retainedConcepts];
  const links = allConcepts.map((concept) => concept.path);
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
      `> [!abstract] ${session.topic}`,
      `> 由 ${session.sources.length} 条原始资料编译；细节请回查来源。`,
      "",
      "## 主题概览",
      "",
      session.map.overview,
      "",
      "## 概念导航",
      "",
      ...allConcepts.map((concept) => `- [[${concept.path}|${concept.title}]]：${concept.summary}`),
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
      "",
      renderPageMetadata("topic", session.topic, links, sources, session.createdAt)
    ].join("\n")
  };
}

function retainExistingConceptPages(
  previousTopic: LlmWikiTopicRecord | undefined,
  topicIndexPath: string,
  replacementPages: LlmWikiPageDraft[]
): LlmWikiPageRecord[] {
  if (!previousTopic) {
    return [];
  }
  const replacementPaths = new Set(replacementPages.map((page) => page.path));
  return previousTopic.pages.filter((page) => page.path !== topicIndexPath && !replacementPaths.has(page.path));
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
      "> [!info] LLM Wiki 入口",
      "> 主题页由原始资料增量编译；标记为“需更新”的主题有来源变化。",
      "",
      "## 已编译主题",
      "",
      ...(topics.length
        ? topics.map((topic) => `- [[${topic.indexPath}|${topic.topic}]]${topic.status === "stale" ? " · 需更新" : ""}`)
        : ["- 尚未编译主题。"]),
      `- [[${wikiRootPath}/_system/Error Book|Error Book]]`,
      "",
      renderPageMetadata("global-index", "LLM Wiki", links, sources, new Date().toISOString())
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
      "> [!info] Error Book",
      "> 记录可复用的 Wiki 结构与来源修复规则。",
      "",
      "## 未关闭问题",
      "",
      ...(openErrors.length
        ? openErrors.map((error) => `- **${error.type}** · [[${error.path}]]：${error.detail}\n  - 规则：${error.rule}`)
        : ["- 当前没有未关闭的问题。"]),
      "",
      renderPageMetadata("error-book", "LLM Wiki", [], sources, new Date().toISOString())
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
  return sources.map((source) => `- [[${source.source.pathOrUrl}|${source.title}]]${source.source.locator ? ` · ${humanizeLocator(source.source.locator)}` : ""}`);
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

function getTopicSourceHashes(topic: LlmWikiTopicRecord): Array<Pick<SourceRef, "pathOrUrl" | "contentHash">> {
  return topic.sourceHashes;
}

function hasSourceHealthIssue(sourceHealth: LlmWikiSourceHealth[] | undefined): boolean {
  return Boolean(sourceHealth?.some((source) => source.status !== "active"));
}

/**
 * Merge source records across compiles, keeping the newest hash per path.
 *
 * Keyed by path alone. Keying on path *and* hash let the same note appear twice
 * — once per compile, each with the hash it had then — which is how a recompile
 * left a second set of pages behind describing the same material: the registry
 * counted two sources where there was one note, and nothing in the data said they
 * were the same note.
 */
function mergeSourceHashes(
  ...groups: Array<Array<LlmWikiSourceRecord>>
): LlmWikiSourceRecord[] {
  const byPath = new Map<string, LlmWikiSourceRecord>();
  for (const group of groups) {
    for (const source of group) {
      const key = normalizePath(source.pathOrUrl);
      if (!key) {
        continue;
      }
      // Later groups are the newer compile, so they win.
      byPath.set(key, { ...source, pathOrUrl: key });
    }
  }
  return [...byPath.values()];
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

export interface WikiMissingSourcePatch {
  content: string;
  removedPaths: string[];
}

/**
 * Patches one compiled Wiki page whose source notes were deleted.
 *
 * Deletion breaks the evidence chain, not the conclusions, so the body stays
 * untouched: the dead entries leave the metadata block and the evidence list,
 * a warning callout records what was lost, and 待补充 gains a re-evidence
 * item. Deliberately no model call — the source is gone, nothing can be
 * retrieved for it; the fix is bookkeeping, not another compile round.
 * Returns the input untouched when the page does not cite a missing path.
 */
export function patchWikiPageForMissingSources(
  content: string,
  missingPaths: readonly string[],
  observedAt = new Date().toISOString()
): WikiMissingSourcePatch {
  const missing = new Set(missingPaths.map(normalizePath));
  if (!missing.size) {
    return { content, removedPaths: [] };
  }
  const removed = new Set<string>();
  let lines = content.split("\n");

  const metadataStart = lines.findIndex((line) => line.includes("knowledge-loop-agent:llm-wiki"));
  if (metadataStart >= 0) {
    const metadataEnd = lines.findIndex((line, index) => index > metadataStart && line.trim() === "-->");
    if (metadataEnd > metadataStart) {
      try {
        const parsed = JSON.parse(lines.slice(metadataStart + 1, metadataEnd).join("\n")) as {
          sources?: Array<{ path?: string; hash?: string }>;
          updatedAt?: string;
        };
        const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
        const kept = sources.filter((source) => {
          const dead = typeof source.path === "string" && missing.has(normalizePath(source.path));
          if (dead) {
            removed.add(normalizePath(source.path!));
          }
          return !dead;
        });
        if (kept.length < sources.length) {
          parsed.sources = kept;
          parsed.updatedAt = observedAt;
          lines = [
            ...lines.slice(0, metadataStart),
            `<!-- knowledge-loop-agent:llm-wiki`,
            JSON.stringify(parsed),
            `-->`,
            ...lines.slice(metadataEnd + 1)
          ];
        }
      } catch {
        // 元数据块结构损坏时不改写它；下面的证据列表与标注仍然生效。
      }
    }
  }

  const evidenceIndex = lines.findIndex((line) => line.trim() === "## 原始证据");
  if (evidenceIndex >= 0) {
    let evidenceEnd = lines.length;
    for (let index = evidenceIndex + 1; index < lines.length; index += 1) {
      if (/^## /u.test(lines[index]!)) {
        evidenceEnd = index;
        break;
      }
    }
    lines = lines.filter((line, index) => {
      const cited = index > evidenceIndex && index < evidenceEnd &&
        [...missing].some((path) => line.includes(`[[${path}|`) || line.includes(`[[${path}]]`));
      if (cited) {
        for (const path of missing) {
          if (line.includes(`[[${path}|`) || line.includes(`[[${path}]]`)) {
            removed.add(path);
          }
        }
      }
      return !cited;
    });
  }

  if (!removed.size) {
    return { content, removedPaths: [] };
  }

  const removedList = [...removed].join("、");
  const day = observedAt.slice(0, 10);
  const callout = [
    `> [!warning] 证据失效`,
    `> 原始来源已删除：${removedList}（${day} 校对）。相关结论暂无本地证据支持，待重新取证后移除本提示。`
  ];
  const infoIndex = lines.findIndex((line) => line.startsWith("> [!info]"));
  if (infoIndex >= 0) {
    let insertAt = infoIndex;
    while (insertAt + 1 < lines.length && lines[insertAt + 1]!.startsWith(">")) {
      insertAt += 1;
    }
    lines.splice(insertAt + 1, 0, "", ...callout);
  } else {
    const closeIndex = lines.findIndex((line) => line.trim() === "-->");
    lines.splice(closeIndex >= 0 ? closeIndex + 1 : 0, 0, "", ...callout);
  }

  const gapIndex = lines.findIndex((line) => line.trim() === "## 待补充");
  if (gapIndex >= 0) {
    let insertAt = gapIndex + 1;
    while (insertAt < lines.length && !lines[insertAt]!.trim()) {
      insertAt += 1;
    }
    lines.splice(insertAt, 0, `- 来源 ${removedList} 已删除，本页对应结论需要重新取证。`);
  }

  return { content: lines.join("\n"), removedPaths: [...removed] };
}

/**
 * Drops deleted sources from a topic's records once the affected pages have
 * been patched: health stops reporting them, the topic returns to fresh (or
 * stays stale for its remaining changed sources), and the matching Error Book
 * entry closes on the next sync. Restoring the note later makes it look "new"
 * again to the next incremental compile, which is the correct outcome.
 */
export function pruneMissingWikiSources(
  registry: LlmWikiRegistry,
  topicId: string,
  missingPaths: readonly string[]
): LlmWikiRegistry {
  const missing = new Set(missingPaths.map(normalizePath));
  if (!missing.size) {
    return registry;
  }
  const topics = registry.topics.map((topic) => {
    if (topic.id !== topicId) {
      return topic;
    }
    const sourceHealth = (topic.sourceHealth ?? []).filter((health) => !missing.has(normalizePath(health.pathOrUrl)));
    return {
      ...topic,
      sourceHashes: topic.sourceHashes.filter((source) => !missing.has(normalizePath(source.pathOrUrl))),
      pages: topic.pages.map((page) => ({
        ...page,
        sourcePaths: page.sourcePaths.filter((path) => !missing.has(normalizePath(path)))
      })),
      sourceHealth,
      status: hasSourceHealthIssue(sourceHealth) ? "stale" as const : "fresh" as const
    };
  });
  return syncWikiSourceErrors({ ...registry, topics });
}
