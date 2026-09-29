import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import {
  compileLlmWikiTopic,
  createLlmWikiRegistry,
  getLinkedWikiPages,
  getLlmWikiTopicId,
  llmWikiFolderPath,
  searchLlmWiki,
  syncWikiSourceErrors,
  updateLlmWikiTopicSourceHealth,
  type LlmWikiCompilationMode,
  type LlmWikiCoverageReport,
  type LlmWikiError,
  type LlmWikiPageRecord,
  type LlmWikiRegistry,
  type LlmWikiSourceHealth,
  type LlmWikiTopicRecord
} from "../wiki/llm-wiki-system";
import type {
  KnowledgeIntegrationSession,
  KnowledgeIntegrationSource,
  KnowledgeMapNode,
  KnowledgeNodeDraft
} from "../integration/knowledge-system";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import { batchNoteDigests, buildNoteDigests } from "../indexing/note-survey";
import { renderTopicMapMarkdown, type TopicCluster } from "../wiki/topic-discovery";
import { parseMarkdownIntoChunks } from "../indexing/markdown-parser";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { PolicyEngine } from "../policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export interface DesktopWikiConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
  knowledgeSystemFolder?: string;
}

export interface DesktopWikiResult {
  topic: string;
  pageCount: number;
  sourceCount: number;
  updatedCount: number;
  paths: string[];
  coverage: LlmWikiCoverageReport;
  sourceHealth: DesktopWikiSourceHealthSummary;
  /** Concept pages written by the model rather than left as outline entries. */
  composedNodes: number;
  /** Concept pages that kept the knowledge-map summary because writing failed. */
  fallbackNodes: string[];
}

export type DesktopWikiCompileMode = LlmWikiCompilationMode;

interface WikiSourceSelection {
  sources: KnowledgeIntegrationSource[];
  coverage: LlmWikiCoverageReport;
}

export interface DesktopWikiSourceHealthSummary {
  active: number;
  changed: number;
  missing: number;
  unverified: number;
}

export interface DesktopWikiSourceHealthResult {
  topic: string;
  sourceHealth: DesktopWikiSourceHealthSummary;
  sources: LlmWikiSourceHealth[];
}

/** One compiled topic whose sources no longer match what was compiled. */
export interface DesktopWikiTopicHealth {
  id: string;
  topic: string;
  indexPath: string;
  updatedAt: string;
  changedSources: string[];
  missingSources: string[];
}

/**
 * Result of re-checking every compiled topic against the files on disk.
 *
 * `topics` only contains topics that actually drifted; `openErrors` is the
 * unresolved part of the Error Book, which also holds link and validation
 * problems unrelated to source drift.
 */
export interface DesktopWikiHealthReview {
  checkedAt: string;
  topics: DesktopWikiTopicHealth[];
  openErrors: LlmWikiError[];
}

/**
 * A drafted library map, not yet written.
 *
 * `skippedCount` and `failedBatches` exist because a survey that silently
 * covered only part of the library would look complete while not being one.
 */
export interface DesktopTopicSurveyDraft {
  relativePath: string;
  content: string;
  topicNames: string[];
  overview: string;
  noteCount: number;
  /** Notes the send policy refused to let out. */
  skippedCount: number;
  /** Batches whose clustering call failed. */
  failedBatches: number;
}

export interface DesktopWikiPageContent {
  path: string;
  title: string;
  content: string;
}

export interface DesktopWikiPageDraft {
  targetPath: string;
  content: string;
}

/** An unwritten compilation: pages plus the registry they will produce. */
export interface DesktopWikiCompileDraft {
  topic: string;
  pages: DesktopWikiPageDraft[];
  sourceCount: number;
  coverage: LlmWikiCoverageReport;
  sourceHealth: DesktopWikiSourceHealthSummary;
  composedNodes: number;
  fallbackNodes: string[];
  registry: LlmWikiRegistry;
}

type WikiCandidateKind = "new" | "changed" | "anchor";

interface WikiCandidate {
  source: KnowledgeIntegrationSource;
  kind: WikiCandidateKind;
}

interface WikiCompilationInput {
  registry: LlmWikiRegistry;
  session: KnowledgeIntegrationSession;
  coverage: LlmWikiCoverageReport;
  sourceHealth: LlmWikiSourceHealth[];
  sourceCount: number;
  nodeDrafts: Map<string, KnowledgeNodeDraft>;
  fallbackNodes: string[];
}

export interface WikiNodeDraftsResult {
  drafts: Map<string, KnowledgeNodeDraft>;
  /** Node titles that kept the knowledge-map summary because writing failed. */
  fallbackNodes: string[];
}

const MAX_WIKI_SOURCES = 80;
const MAX_CHUNKS_PER_SOURCE_PATH = 2;
/** Bodies are written one model call at a time, so the fan-out is capped. */
const MAX_WIKI_NODE_DRAFTS = 12;
const NODE_DRAFT_CONCURRENCY = 3;

/** Builds and persists the deterministic LLM Wiki pages used by the plugin. */
export class DesktopWikiService {
  private readonly knowledgeSystemFolder: string;

  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopWikiConfiguration
  ) {
    this.knowledgeSystemFolder = configuration.knowledgeSystemFolder ?? "知识体系/Agent";
  }

  private get wikiFolder(): string {
    return llmWikiFolderPath(this.knowledgeSystemFolder);
  }

  private get registryPath(): string {
    return `${this.wikiFolder}/_system/registry.json`;
  }

  /**
   * Where the registry landed while the folder join dropped its separator.
   *
   * Still read as a fallback so a Wiki compiled before the fix keeps its
   * coverage instead of silently starting over; writes always go to the
   * correct path.
   */
  private get legacyRegistryPath(): string {
    return `${this.knowledgeSystemFolder.replace(/\\/g, "/").replace(/\/+$/u, "/")}LLM Wiki/_system/registry.json`;
  }

  async compile(topic: string, mode: DesktopWikiCompileMode = "compile"): Promise<DesktopWikiResult> {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      throw new Error("LLM Wiki 主题不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const prepared = await this.prepare(normalizedTopic, mode);
    const compilation = compileLlmWikiTopic(prepared.session, prepared.registry, this.knowledgeSystemFolder, {
      mode,
      coverageReport: prepared.coverage,
      sourceHealth: prepared.sourceHealth,
      nodeDrafts: prepared.nodeDrafts
    });
    let updatedCount = 0;
    for (const page of compilation.pages) {
      const targetPath = `${this.knowledgeSystemFolder}/${page.relativePath}`;
      const decision = this.policy.decide({ action: "createKnowledgeSystemNote", targetPath });
      if (!decision.allowed) {
        throw new Error(`Wiki 写入被权限策略拒绝：${decision.reason}`);
      }
      if (await this.repository.getMarkdownFile(targetPath)) {
        await this.repository.writeText(targetPath, page.content);
      } else {
        await this.repository.createText(targetPath, page.content);
      }
      updatedCount += 1;
    }
    await this.persistRegistry(compilation.nextRegistry);
    return {
      topic: normalizedTopic,
      pageCount: compilation.pages.length,
      sourceCount: prepared.sourceCount,
      updatedCount,
      paths: compilation.pages.map((page) => `${this.knowledgeSystemFolder}/${page.relativePath}`),
      coverage: prepared.coverage,
      sourceHealth: summarizeSourceHealth(prepared.sourceHealth),
      composedNodes: prepared.nodeDrafts.size,
      fallbackNodes: prepared.fallbackNodes
    };
  }

  /**
   * Compile without touching the disk.
   *
   * The agent runtime turns each draft page into a write preview so the user
   * confirms the whole batch before anything is written.
   */
  async compileDraft(topic: string, mode: DesktopWikiCompileMode = "compile"): Promise<DesktopWikiCompileDraft> {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      throw new Error("LLM Wiki 主题不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const prepared = await this.prepare(normalizedTopic, mode);
    const compilation = compileLlmWikiTopic(prepared.session, prepared.registry, this.knowledgeSystemFolder, {
      mode,
      coverageReport: prepared.coverage,
      sourceHealth: prepared.sourceHealth,
      nodeDrafts: prepared.nodeDrafts
    });
    return {
      topic: normalizedTopic,
      pages: compilation.pages.map((page) => ({
        targetPath: `${this.knowledgeSystemFolder}/${page.relativePath}`,
        content: page.content
      })),
      sourceCount: prepared.sourceCount,
      coverage: prepared.coverage,
      sourceHealth: summarizeSourceHealth(prepared.sourceHealth),
      composedNodes: prepared.nodeDrafts.size,
      fallbackNodes: prepared.fallbackNodes,
      registry: compilation.nextRegistry
    };
  }

  /**
   * Everything a compilation needs before the pages can be laid out: the
   * knowledge map plus a written body for each concept node.
   *
   * Shared by the writing path and the preview path so the two cannot drift.
   */
  private async prepare(topic: string, mode: DesktopWikiCompileMode): Promise<WikiCompilationInput> {
    const wikiPrefix = `${this.wikiFolder}/`;
    const registry = await this.readRegistry();
    const previousTopic = registry.topics.find((record) => record.id === getLlmWikiTopicId(topic));
    const sourceHealth = mode === "expand" && previousTopic ? await this.inspectTopicSources(previousTopic) : [];
    const selection = this.collectSources(topic, wikiPrefix, previousTopic, mode);
    if (!selection.sources.length) {
      throw new Error("本地没有命中可用于编译 Wiki 的资料。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    const map = await client.createKnowledgeMap(topic, selection.sources);
    const session: KnowledgeIntegrationSession = {
      id: `desktop-wiki-${Date.now()}`,
      topic,
      scopeLabel: `本地检索：${topic}`,
      createdAt: new Date().toISOString(),
      sources: selection.sources,
      map
    };
    const { drafts, fallbackNodes } = await composeWikiNodeDrafts(
      (node, sources) => client.composeKnowledgeNode(topic, node, sources),
      session
    );
    return {
      registry,
      session,
      coverage: selection.coverage,
      sourceHealth,
      sourceCount: selection.sources.length,
      nodeDrafts: drafts,
      fallbackNodes
    };
  }

  /** Persist the registry after a confirmed compilation. */
  async persistRegistry(registry: LlmWikiRegistry): Promise<void> {
    await this.repository.writeRaw(this.registryPath, JSON.stringify(registry, null, 2));
  }

  async inspectSources(topic: string): Promise<DesktopWikiSourceHealthResult> {
    const normalizedTopic = topic.trim();
    const registry = await this.readRegistry();
    const record = registry.topics.find((candidate) => candidate.id === getLlmWikiTopicId(normalizedTopic));
    if (!record) {
      throw new Error(`没有找到主题“${normalizedTopic}”的 LLM Wiki；请先编译该主题。`);
    }
    const sources = await this.inspectTopicSources(record);
    const nextRegistry = updateLlmWikiTopicSourceHealth(registry, record.id, sources);
    await this.repository.writeRaw(this.registryPath, JSON.stringify(nextRegistry, null, 2));
    return {
      topic: record.topic,
      sourceHealth: summarizeSourceHealth(sources),
      sources
    };
  }

  /**
   * Re-reads every recorded source and reports which topics drifted.
   *
   * `sourceHealth` and the `stale` status were written but never read back, so
   * a compiled Wiki could silently fall behind the notes it came from. This is
   * the consumer: it refreshes the health, opens an Error Book entry for topics
   * that drifted, and closes the entry again once they are back in sync.
   *
   * Topic status is updated as a side effect — it is the same information the
   * next compilation reads to decide what counts as new or changed evidence.
   */
  async reviewHealth(): Promise<DesktopWikiHealthReview> {
    const registry = await this.readRegistry();
    const checkedAt = new Date().toISOString();
    if (!registry.topics.length) {
      return { checkedAt, topics: [], openErrors: openErrorsOf(registry) };
    }
    let next = registry;
    const topics: DesktopWikiTopicHealth[] = [];
    for (const topic of registry.topics) {
      const health = await this.inspectTopicSources(topic);
      next = updateLlmWikiTopicSourceHealth(next, topic.id, health);
      const changedSources = health.filter((source) => source.status === "changed").map((source) => source.pathOrUrl);
      const missingSources = health.filter((source) => source.status === "missing").map((source) => source.pathOrUrl);
      if (changedSources.length || missingSources.length) {
        topics.push({
          id: topic.id,
          topic: topic.topic,
          indexPath: topic.indexPath,
          updatedAt: topic.updatedAt,
          changedSources,
          missingSources
        });
      }
    }
    next = syncWikiSourceErrors(next, checkedAt);
    if (JSON.stringify(next) !== JSON.stringify(registry)) {
      await this.persistRegistry(next);
    }
    return { checkedAt, topics, openErrors: openErrorsOf(next) };
  }

  /**
   * Groups the whole library into topics and drafts a map note.
   *
   * Returns a draft rather than writing: the map is a normal note the user
   * should be able to read before it lands in the vault.
   */
  async surveyTopics(): Promise<DesktopTopicSurveyDraft> {
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const digests = buildNoteDigests(this.index.getAllChunks());
    // Whole-library enumeration means every title is about to leave the device,
    // so the send policy has to be applied here — not only on the write side.
    const permitted = digests.filter((digest) =>
      this.policy.decide({ action: "sendToGlm", targetPath: digest.path }).allowed
    );
    if (permitted.length < 2) {
      throw new Error("可外发的笔记不足两条，无法划分主题（检查权限策略是否阻断了整个知识库）。");
    }

    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });

    let failedBatches = 0;
    const clusters: TopicCluster[] = [];
    for (const batch of batchNoteDigests(permitted)) {
      try {
        clusters.push(...(await client.discoverNoteTopics(batch)));
      } catch (error) {
        // One bad batch costs a slice of the library's topics, not the whole
        // survey — the other batches' calls are already paid for.
        failedBatches += 1;
        console.error("[wiki-survey]", error);
      }
    }
    if (!clusters.length) {
      throw new Error("模型没有返回任何可用的主题分组。");
    }

    const plan = await client.mergeNoteTopics(clusters);
    return {
      relativePath: `${this.wikiFolder}/知识库地图.md`,
      content: renderTopicMapMarkdown(plan, new Date().toISOString()),
      topicNames: plan.topics.map((topic) => topic.name),
      overview: plan.overview,
      noteCount: permitted.length,
      skippedCount: digests.length - permitted.length,
      failedBatches
    };
  }

  private collectSources(
    topic: string,
    wikiPrefix: string,
    previousTopic: LlmWikiTopicRecord | undefined,
    mode: DesktopWikiCompileMode
  ): WikiSourceSelection {
    const queries = [topic, ...topic.split(/[\s,，、；;]+/u).filter((term) => term.length >= 2)];
    const seen = new Set<string>();
    const results = queries.flatMap((query) => this.index.search(query, 80))
      .filter((result) => !result.chunk.source.pathOrUrl.startsWith(wikiPrefix))
      .filter((result) => {
        const key = `${result.chunk.source.pathOrUrl}:${result.chunk.heading ?? ""}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    const candidates = results.map((result, index): KnowledgeIntegrationSource => ({
        id: `S${index + 1}`,
        title: result.chunk.heading ?? result.chunk.source.pathOrUrl,
        content: result.chunk.content,
        source: toSourceRef(result.chunk.source.pathOrUrl, result.chunk.source.locator, result.chunk.content)
      }));
    return selectSourcesForWikiCompilation(candidates, previousTopic, mode);
  }

  /**
   * Traversal half of the Wiki tool set: search, read, follow, then answer.
   *
   * Reading a page still goes through the policy engine, so a page inside a
   * restricted folder never reaches the model.
   */
  async searchPages(query: string, limit = 4): Promise<LlmWikiPageRecord[]> {
    const registry = await this.readRegistry();
    return searchLlmWiki(registry, query, limit).map((result) => result.page);
  }

  async readPages(records: LlmWikiPageRecord[], limit = 2): Promise<DesktopWikiPageContent[]> {
    const pages: DesktopWikiPageContent[] = [];
    for (const record of records.slice(0, limit)) {
      const decision = this.policy.decide({ action: "readVault", targetPath: record.path });
      if (!decision.allowed) {
        continue;
      }
      if (!(await this.repository.getMarkdownFile(record.path))) {
        continue;
      }
      pages.push({
        path: record.path,
        title: record.title,
        content: await this.repository.readText(record.path)
      });
    }
    return pages;
  }

  async followPages(readPaths: string[], limit = 3): Promise<LlmWikiPageRecord[]> {
    const registry = await this.readRegistry();
    const visited = registry.topics
      .flatMap((topic) => topic.pages ?? [])
      .filter((page) => readPaths.includes(page.path));
    return getLinkedWikiPages(registry, visited, limit).filter((page) => !readPaths.includes(page.path));
  }

  async answerFromPages(
    question: string,
    pages: DesktopWikiPageContent[],
    memoryContext = ""
  ): Promise<{ content: string; paths: string[] }> {
    if (!pages.length) {
      throw new Error("本次 Wiki 遍历没有可回答的页面。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    const answer = await client.answerWithSources(
      question,
      pages.map((page, index) => ({
        id: index + 1,
        path: page.path,
        locator: page.title,
        content: page.content
      })),
      memoryContext
    );
    return { content: answer.content, paths: pages.map((page) => page.path) };
  }

  private async readRegistry(): Promise<LlmWikiRegistry> {
    const registry = await this.readRegistryAt(this.registryPath);
    return registry.topics.length || registry.errorBook.length
      ? registry
      : this.readRegistryAt(this.legacyRegistryPath);
  }

  private async readRegistryAt(path: string): Promise<LlmWikiRegistry> {
    try {
      const raw = await this.repository.readRaw(path);
      const value = JSON.parse(raw) as Partial<LlmWikiRegistry>;
      return createLlmWikiRegistry(value);
    } catch {
      return createLlmWikiRegistry();
    }
  }

  private async inspectTopicSources(topic: LlmWikiTopicRecord): Promise<LlmWikiSourceHealth[]> {
    const sourceHashes = topic.sourceHashes;
    const expectedHashesByPath = new Map<string, Set<string>>();
    for (const source of sourceHashes) {
      const path = normalizePath(source.pathOrUrl);
      const hashes = expectedHashesByPath.get(path) ?? new Set<string>();
      hashes.add(source.contentHash);
      expectedHashesByPath.set(path, hashes);
    }
    const checkedAt = new Date().toISOString();
    const health: LlmWikiSourceHealth[] = [];
    for (const [path, expectedHashes] of expectedHashesByPath) {
      const file = await this.repository.getMarkdownFile(path);
      if (!file) {
        health.push({ pathOrUrl: path, status: "missing", checkedAt });
        continue;
      }
      if (!this.policy.decide({ action: "readVault", targetPath: path }).allowed) {
        health.push({ pathOrUrl: path, status: "unverified", checkedAt });
        continue;
      }
      const content = await this.repository.readText(path);
      const currentHashes = new Set(parseMarkdownIntoChunks(path, content).map((chunk) => hashText(chunk.content)));
      health.push({
        pathOrUrl: path,
        status: [...expectedHashes].every((hash) => currentHashes.has(hash)) ? "active" : "changed",
        checkedAt
      });
    }
    return health;
  }
}

/**
 * Writes a body for each concept node: a second model pass that reads the
 * node's own evidence instead of reusing the knowledge-map summary.
 *
 * A node that fails keeps its summary rather than failing the compilation —
 * by then the map and the earlier nodes are already paid for, and an outline
 * entry is better than no page. Nothing here inspects the error, so a
 * systematic failure (bad key, quota) still shows up as every node falling
 * back, which the caller reports instead of hiding.
 */
export async function composeWikiNodeDrafts(
  composer: (node: KnowledgeMapNode, sources: KnowledgeIntegrationSource[]) => Promise<KnowledgeNodeDraft>,
  session: KnowledgeIntegrationSession,
  limit = MAX_WIKI_NODE_DRAFTS
): Promise<WikiNodeDraftsResult> {
  const sourceById = new Map(session.sources.map((source) => [source.id, source]));
  const targets = session.map.nodes.slice(0, limit).flatMap((node) => {
    const sources = node.sourceIds
      .map((id) => sourceById.get(id))
      .filter((source): source is KnowledgeIntegrationSource => Boolean(source));
    return sources.length ? [{ node, sources }] : [];
  });
  const drafts = new Map<string, KnowledgeNodeDraft>();
  const fallbackNodes: string[] = [];
  for (let index = 0; index < targets.length; index += NODE_DRAFT_CONCURRENCY) {
    const results = await Promise.all(targets.slice(index, index + NODE_DRAFT_CONCURRENCY).map(async (target) => {
      try {
        return { node: target.node, draft: await composer(target.node, target.sources) };
      } catch {
        return { node: target.node, draft: null };
      }
    }));
    for (const result of results) {
      if (result.draft) {
        drafts.set(result.node.id, result.draft);
      } else {
        fallbackNodes.push(result.node.title);
      }
    }
  }
  return { drafts, fallbackNodes };
}

function toSourceRef(pathOrUrl: string, locator: string, content: string): SourceRef {
  return {
    type: "note",
    pathOrUrl,
    locator,
    contentHash: hashText(content),
    parserVersion: "portable-markdown-v1",
    retrievedAt: new Date().toISOString()
  };
}

/**
 * Selects sources without another model call. In expansion mode, new evidence
 * gets the majority of the prompt budget so repeated searches make progress.
 */
export function selectSourcesForWikiCompilation(
  sources: KnowledgeIntegrationSource[],
  previousTopic: LlmWikiTopicRecord | undefined,
  mode: DesktopWikiCompileMode,
  limit = MAX_WIKI_SOURCES
): WikiSourceSelection {
  const candidates = classifyWikiCandidates(sources, previousTopic);
  const selected: WikiCandidate[] = [];
  const selectedKeys = new Set<string>();
  const selectedByPath = new Map<string, number>();
  const add = (candidate: WikiCandidate): boolean => {
    if (selected.length >= limit) {
      return false;
    }
    const key = sourceKey(candidate.source);
    if (selectedKeys.has(key)) {
      return false;
    }
    const path = candidate.source.source.pathOrUrl;
    const count = selectedByPath.get(path) ?? 0;
    if (count >= MAX_CHUNKS_PER_SOURCE_PATH) {
      return false;
    }
    selected.push(candidate);
    selectedKeys.add(key);
    selectedByPath.set(path, count + 1);
    return true;
  };
  const addCandidates = (kind: WikiCandidateKind, maximum = limit): void => {
    let added = 0;
    for (const candidate of candidates) {
      if (candidate.kind === kind && add(candidate)) {
        added += 1;
        if (added >= maximum || selected.length >= limit) {
          return;
        }
      }
    }
  };

  if (mode === "expand") {
    addCandidates("new", Math.ceil(limit * 0.6));
    addCandidates("changed", Math.ceil(limit * 0.25));
    addCandidates("anchor", Math.floor(limit * 0.15));
    addCandidates("new");
    addCandidates("changed");
    addCandidates("anchor");
  } else {
    for (const candidate of candidates) {
      add(candidate);
      if (selected.length >= limit) {
        break;
      }
    }
  }

  const selectedIds = new Set(selected.map((candidate) => sourceKey(candidate.source)));
  const unselectedProgressPaths = new Set(candidates
    .filter((candidate) => candidate.kind !== "anchor" && !selectedIds.has(sourceKey(candidate.source)))
    .map((candidate) => candidate.source.source.pathOrUrl));
  return {
    sources: selected.map((candidate, index) => ({ ...candidate.source, id: `S${index + 1}` })),
    coverage: {
      mode,
      added: selected.filter((candidate) => candidate.kind === "new").length,
      changed: selected.filter((candidate) => candidate.kind === "changed").length,
      reused: selected.filter((candidate) => candidate.kind === "anchor").length,
      remainingCandidates: unselectedProgressPaths.size
    }
  };
}

function classifyWikiCandidates(
  sources: KnowledgeIntegrationSource[],
  previousTopic: LlmWikiTopicRecord | undefined
): WikiCandidate[] {
  const seenSources = previousTopic?.coverage?.seenSourceHashes ?? previousTopic?.sourceHashes ?? [];
  const hashesByPath = new Map<string, Set<string>>();
  for (const source of seenSources) {
    const path = normalizePath(source.pathOrUrl);
    const hashes = hashesByPath.get(path) ?? new Set<string>();
    hashes.add(source.contentHash);
    hashesByPath.set(path, hashes);
  }
  return sources.map((source) => {
    const path = normalizePath(source.source.pathOrUrl);
    const previousHashes = hashesByPath.get(path);
    if (!previousHashes) {
      return { source, kind: "new" };
    }
    return previousHashes.has(source.source.contentHash)
      ? { source, kind: "anchor" }
      : { source, kind: "changed" };
  });
}

function sourceKey(source: KnowledgeIntegrationSource): string {
  return `${normalizePath(source.source.pathOrUrl)}:${source.source.locator}:${source.source.contentHash}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/u, "");
}

function openErrorsOf(registry: LlmWikiRegistry): LlmWikiError[] {
  return registry.errorBook.filter((error) => error.status === "open");
}

function summarizeSourceHealth(sources: LlmWikiSourceHealth[]): DesktopWikiSourceHealthSummary {
  return sources.reduce<DesktopWikiSourceHealthSummary>((summary, source) => {
    summary[source.status] += 1;
    return summary;
  }, { active: 0, changed: 0, missing: 0, unverified: 0 });
}
