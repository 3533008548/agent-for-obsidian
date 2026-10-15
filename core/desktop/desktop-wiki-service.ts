import { hashText } from "../domain/content-hash";
import { isInternalLibraryPath } from "../memory/agent-memory";
import {
  createKnowledgeSystemProposal,
  renderCreatedKnowledgeSystemNote
} from "../actions/action-proposal";
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
  patchWikiPageForMissingSources,
  pruneMissingWikiSources,
  stabilizeWikiNodeIds,
  type LlmWikiCompilationMode,
  type LlmWikiCoverageReport,
  type LlmWikiError,
  type LlmWikiPageRecord,
  type LlmWikiRegistry,
  type LlmWikiSourceHealth,
  type LlmWikiTopicRecord
} from "../wiki/llm-wiki-system";
import { decidePlacement, type PlacementDecision } from "../wiki/topic-placement";
import type {
  KnowledgeIntegrationSession,
  KnowledgeIntegrationSource,
  KnowledgeMapNode,
  KnowledgeNodeDraft
} from "../integration/knowledge-system";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import { batchNoteDigests, buildNoteDigests } from "../indexing/note-survey";
import {
  MAX_TOPICS,
  renderTopicMapMarkdown,
  type ProposedTopic,
  type TopicLibraryStat,
  type TopicMapPlan
} from "../wiki/topic-discovery";
import {
  assignNotes,
  convergeRegistry,
  createTopicRegistry,
  digestPaths,
  existingTopicNames,
  MIN_NOTES_PER_TOPIC,
  notesOfTopic,
  parseTopicRegistryMarkdown,
  resolveTopicReference,
  renderTopicRegistryMarkdown,
  topicStats,
  upsertTopics,
  UNCLASSIFIED_TOPIC_ID,
  type TopicDefinition,
  type TopicRegistry
} from "../wiki/topic-registry";
import { parseMarkdownIntoChunks } from "../indexing/markdown-parser";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { PolicyEngine } from "../policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export interface DesktopWikiConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
  knowledgeSystemFolder?: string;
  /**
   * Where the agent's own Markdown lives, so it can be left out of the notes
   * waiting to be compiled. Passed in rather than defaulted: the desktop shell
   * owns that path, and a service that guessed would quietly disagree with the
   * index it is reporting on.
   */
  agentMemoryFolder?: string;
}

export interface DesktopWikiResult {
  topic: string;
  /** The wording the user typed, when the topic table resolved it to a canonical name. */
  topicMatched?: string;
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

/** A Wiki page rewritten to drop citations to deleted source notes. */
export interface DesktopWikiMissingAuditPage {
  path: string;
  title: string;
  content: string;
}

export interface DesktopWikiMissingAudit {
  topic: string;
  pages: DesktopWikiMissingAuditPage[];
  removedSources: string[];
  /** Persist only after the page previews are confirmed. */
  registry: LlmWikiRegistry;
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
  /** Batches whose model call failed. */
  failedBatches: number;
  /** The topic table this survey produced; persisted once the map is confirmed. */
  registry: TopicRegistry;
  /** Sparse topics folded into their parent, for the receipt. */
  mergedTopics: string[];
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
  topicMatched?: string;
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
  /** Stable folder id, taken from the topic table when the phrase resolves. */
  topicId: string;
  /** The phrase the user typed, when it differed from the resolved topic name. */
  matchedFrom: string | null;
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
/** Assignment carries the whole topic table, so its batches are smaller. */
const ASSIGNMENT_BATCH_SIZE = 30;

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
      nodeDrafts: prepared.nodeDrafts,
      topicId: prepared.topicId
    });
    let updatedCount = 0;
    for (const page of compilation.pages) {
      const targetPath = `${this.knowledgeSystemFolder}/${page.relativePath}`;
      const decision = this.policy.decide({ action: "createKnowledgeSystemNote", targetPath });
      if (!decision.allowed) {
        throw new Error(`Wiki 写入被权限策略拒绝：${decision.reason}`);
      }
      if (await this.repository.getMarkdownFile(targetPath)) {
        await this.repository.writeText(targetPath, renderPageBody(page));
      } else {
        await this.repository.createText(targetPath, renderPageBody(page));
      }
      updatedCount += 1;
    }
    await this.persistRegistry(compilation.nextRegistry);
    return {
      topic: prepared.session.topic,
      ...(prepared.matchedFrom ? { topicMatched: prepared.matchedFrom } : {}),
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
      nodeDrafts: prepared.nodeDrafts,
      topicId: prepared.topicId
    });
    return {
      topic: prepared.session.topic,
      ...(prepared.matchedFrom ? { topicMatched: prepared.matchedFrom } : {}),
      pages: compilation.pages.map((page) => ({
        targetPath: `${this.knowledgeSystemFolder}/${page.relativePath}`,
        content: renderPageBody(page)
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
    const { displayTopic, topicId, matchedFrom } = await this.resolveTopic(topic, registry);
    const previousTopic = registry.topics.find((record) => record.id === topicId);
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
    // The map is regenerated from the sources each compile, so without this
    // hint the model re-words every concept title — and since page paths are
    // derived from titles, each expansion used to spawn a duplicate page set
    // next to the retained old one.
    const existingTitles = mode === "expand" && previousTopic
      ? previousTopic.pages
        .filter((page) => page.path.includes("/概念/"))
        .map((page) => page.title)
      : [];
    const map = await client.createKnowledgeMap(displayTopic, selection.sources, existingTitles.length
      ? [
        `该主题已有以下 Wiki 页面。同一概念必须沿用原标题与原有划分，不要换一种说法另起标题；只有真正的新概念才新增节点：\n${existingTitles.map((title) => `- ${title}`).join("\n")}`
      ]
      : []);
    const mapWithStableIds: typeof map = {
      ...map,
      nodes: mode === "expand" ? stabilizeWikiNodeIds(map.nodes, previousTopic) : map.nodes
    };
    const session: KnowledgeIntegrationSession = {
      id: `desktop-wiki-${Date.now()}`,
      topic: displayTopic,
      scopeLabel: `本地检索：${displayTopic}`,
      createdAt: new Date().toISOString(),
      sources: selection.sources,
      map: mapWithStableIds
    };
    const { drafts, fallbackNodes } = await composeWikiNodeDrafts(
      (node, sources) => client.composeKnowledgeNode(displayTopic, node, sources),
      session
    );
    return {
      registry,
      session,
      topicId,
      matchedFrom,
      coverage: selection.coverage,
      sourceHealth,
      sourceCount: selection.sources.length,
      nodeDrafts: drafts,
      fallbackNodes
    };
  }

  /**
   * Resolves what the user typed to one topic.
   *
   * Two wordings of one theme used to open two topic folders, so recompiling
   * "RAG 检索" after "RAG" produced a second wiki instead of updating the
   * first. The id now comes from the topic table, and an already compiled
   * topic keeps its folder even if the table's name changed later.
   */
  private async resolveTopic(
    phrase: string,
    wikiRegistry: LlmWikiRegistry
  ): Promise<{ displayTopic: string; topicId: string; matchedFrom: string | null }> {
    const reference = resolveTopicReference(await this.readTopicRegistry(), phrase);
    const displayTopic = reference?.name ?? phrase;
    const compiled = wikiRegistry.topics.find((record) => record.id === getLlmWikiTopicId(displayTopic))
      ?? (reference ? wikiRegistry.topics.find((record) => record.topic === reference.name) : undefined);
    return {
      displayTopic,
      topicId: compiled?.id ?? reference?.topicId ?? getLlmWikiTopicId(displayTopic),
      matchedFrom: displayTopic === phrase ? null : phrase
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
   * Three steps: propose the topic table, assign every note against that
   * table, then describe the result. Assigning against a fixed table is what
   * keeps a note's topic independent of which batch it happened to land in.
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

    const stored = await this.readTopicRegistry();
    const knownNames = existingTopicNames(stored);
    let failedBatches = 0;

    const proposals: ProposedTopic[] = [];
    for (const batch of batchNoteDigests(permitted)) {
      try {
        proposals.push(...(await client.proposeNoteTopics(batch, knownNames)));
      } catch (error) {
        // One bad batch costs a slice of the library's topics, not the whole
        // survey — the other batches' calls are already paid for.
        failedBatches += 1;
        console.error("[wiki-survey]", error);
      }
    }
    // Definitions the user corrected survive: a proposal is only a suggestion.
    const topics = upsertTopics(stored.topics, proposals.map(toTopicDefinition)).slice(0, MAX_TOPICS);
    if (!topics.length) {
      throw new Error("模型没有返回任何可用的主题。");
    }

    const allowedPaths = digestPaths(permitted);
    const votes: Array<{ path: string; topicId: string; confidence: number; secondaryTopicId?: string }> = [];
    for (const batch of batchNoteDigests(permitted, ASSIGNMENT_BATCH_SIZE)) {
      try {
        votes.push(...(await client.assignNoteTopics(batch, topics)));
      } catch (error) {
        failedBatches += 1;
        console.error("[wiki-survey]", error);
      }
    }

    const assigned = assignNotes({ ...stored, topics }, votes, allowedPaths);
    const { registry: converged, merged } = convergeRegistry(assigned);
    const generatedAt = new Date().toISOString();
    const registry: TopicRegistry = { ...converged, updatedAt: generatedAt };
    const overview = await this.describeLibrary(client, registry, permitted.length);
    const plan = buildTopicMapPlan(registry, overview);

    return {
      relativePath: `${this.wikiFolder}/知识库地图.md`,
      content: renderTopicMapMarkdown(plan, generatedAt),
      topicNames: plan.topics.map((topic) => topic.name),
      overview,
      noteCount: permitted.length,
      skippedCount: digests.length - permitted.length,
      failedBatches,
      registry,
      mergedTopics: merged.map((entry) => `${entry.from} → ${entry.to}`)
    };
  }

  /** Reads the persisted topic table, or an empty one on first run. */
  async readTopicRegistry(): Promise<TopicRegistry> {
    const file = await this.repository.getMarkdownFile(this.topicRegistryPath);
    if (!file) {
      return createTopicRegistry();
    }
    return parseTopicRegistryMarkdown(await this.repository.readText(this.topicRegistryPath)) ?? createTopicRegistry();
  }

  /** Persisted only after the map write is confirmed. */
  async persistTopicRegistry(registry: TopicRegistry): Promise<void> {
    await this.repository.writeRaw(
      this.topicRegistryPath,
      renderTopicRegistryMarkdown(registry, new Date().toISOString())
    );
  }

  private get topicRegistryPath(): string {
    return `${this.wikiFolder}/_system/主题表.md`;
  }

  /** A missing overview costs a paragraph, not the whole map. */
  private async describeLibrary(
    client: DeepSeekClient,
    registry: TopicRegistry,
    totalNotes: number
  ): Promise<string> {
    const stats: TopicLibraryStat[] = topicStats(registry).map((stat) => ({
      name: stat.topic.name,
      count: stat.count,
      samples: notesOfTopic(registry, stat.topic.id).slice(0, 3).map(titleFromPath)
    }));
    if (!stats.length) {
      return "";
    }
    try {
      return await client.summarizeTopicLibrary(stats, totalNotes);
    } catch (error) {
      console.error("[wiki-survey]", error);
      return "";
    }
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
   * The Wiki's current state, for callers that need to decide rather than act.
   *
   * Public because placement and health both read the registry without touching
   * it, and the caller of those is the desktop shell, not this service.
   */
  async currentRegistry(): Promise<LlmWikiRegistry> {
    return this.readRegistry();
  }

  /**
   * Which topics could take this note, and where the model disagrees.
   *
   * Two sources, deliberately not merged into one answer: the model's own
   * proposal and what the corpus already talks about. A note whose two sources
   * point the same way is placed; anything else is handed back as a question,
   * because a confident wrong placement is invisible afterwards while a
   * missing one is not.
   */
  async planNotePlacement(input: {
    notePath: string;
    noteTitle: string;
    noteText: string;
  }): Promise<PlacementDecision> {
    const registry = await this.readRegistry();
    return decidePlacement({
      notePath: input.notePath,
      noteTitle: input.noteTitle,
      noteText: input.noteText,
      registry,
      modelProposals: await this.proposeTopicsForNote(
        { path: input.notePath, title: input.noteTitle, text: input.noteText },
        registry
      )
    });
  }

  /**
   * Notes the Wiki has never been shown.
   *
   * The answer to "what is left to do", which the compile command used to
   * require a person to assemble by hand. Restricted notes stay out of the
   * count: they were never eligible for compiling, so listing them would
   * report work that can never be done.
   */
  async listUncompiledNotes(limit = 20): Promise<{
    notes: Array<{ path: string; title: string }>;
    compiledCount: number;
    total: number;
  }> {
    const registry = await this.readRegistry();
    const compiled = new Set(
      registry.topics.flatMap((topic) => topic.sourceHashes.map((source) => source.pathOrUrl))
    );

    const pending: Array<{ path: string; title: string }> = [];
    const memoryFolder = this.configuration.agentMemoryFolder ?? "";
    let total = 0;
    for (const file of await this.repository.listMarkdownFiles()) {
      const path = file.path;
      if (
        !path.toLowerCase().endsWith(".md") ||
        isInternalLibraryPath(path, memoryFolder)
      ) {
        continue;
      }
      if (!this.policy.decide({ action: "readVault", targetPath: path }).allowed) {
        continue;
      }
      total += 1;
      if (!compiled.has(path) && pending.length < limit) {
        pending.push({ path, title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "") });
      }
    }
    return { notes: pending, compiledCount: compiled.size, total };
  }

  /**
   * Ask the model which topics a note belongs to. Returns proposals only.
   *
   * The confidence it returns is deliberately not trusted: nothing here
   * verifies it, which is why the caller weighs it against what the corpus
   * already says and reports disagreement rather than acting on the higher
   * number.
   */
  private async proposeTopicsForNote(
    note: { path: string; title: string; text: string },
    registry: LlmWikiRegistry
  ): Promise<Array<{ topicId: string; confidence: number }>> {
    if (!this.configuration.deepSeekApiKey.trim() || !registry.topics.length) {
      return [];
    }
    if (!this.policy.decide({ action: "sendToGlm", targetPath: note.path }).allowed) {
      // Its title is enough to place it against the corpus, and its body never
      // left the device. Better a corpus-only answer than none.
      return [];
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    try {
      const assignments = await client.assignNoteTopics(
        [
          {
            path: note.path,
            title: note.title,
            excerpt: note.text.slice(0, 500),
            tags: [],
            // Links would let the model see how the note connects to the rest of
            // the library; the title and opening are what placement turns on, and
            // sending more than that is data leaving the device for no gain.
            links: []
          }
        ],
        registry.topics.map((topic) => ({
          id: topic.id,
          name: topic.topic,
          definition:
            topic.pages.find((page) => page.path === topic.indexPath)?.summary ?? topic.topic
        }))
      );
      return assignments
        .filter((assignment) => assignment.topicId)
        .map((assignment) => ({ topicId: assignment.topicId, confidence: assignment.confidence }));
    } catch (error) {
      // A proposal is advisory. Losing it leaves the corpus deciding alone,
      // which is the safe direction: fewer placements, more questions.
      console.error("[wiki-placement]", error);
      return [];
    }
  }

  /**
   * Traversal half of the Wiki tool set: search, read, follow, then answer.
   *
   * Reading a page still goes through the policy engine, so a page inside a
   * restricted folder never reaches the model.
   */  async searchPages(query: string, limit = 4): Promise<LlmWikiPageRecord[]> {
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

  /**
   * Proofs the pages that cite deleted sources, without a model call.
   *
   * A deleted source cannot be recovered by another retrieval round, yet the
   * expansion compile kept re-running the whole map+compose pipeline on mostly
   * unchanged material while the pages went on citing notes that no longer
   * exist. This pass rewrites only the affected pages — dead entries out of
   * the metadata block and evidence list, a warning callout in — and prunes
   * the topic's records, so the health review stops re-flagging the same
   * deletion. The registry only lands once the previews are confirmed.
   */
  async auditMissingSources(topic: string): Promise<DesktopWikiMissingAudit> {
    const normalizedTopic = topic.trim();
    const registry = await this.readRegistry();
    const record = registry.topics.find((candidate) => candidate.id === getLlmWikiTopicId(normalizedTopic));
    if (!record) {
      throw new Error(`没有找到主题“${normalizedTopic}”的 LLM Wiki；请先编译该主题。`);
    }
    const health = await this.inspectTopicSources(record);
    const missingPaths = health.filter((source) => source.status === "missing").map((source) => source.pathOrUrl);
    if (!missingPaths.length) {
      throw new Error("该主题没有已删除的来源，无需校对。");
    }
    const missingSet = new Set(missingPaths.map((path) => normalizePath(path)));
    const pages: DesktopWikiMissingAuditPage[] = [];
    const removedSources = new Set<string>();
    for (const page of record.pages) {
      const citesMissing = page.sourcePaths.some((path) => missingSet.has(normalizePath(path)));
      if (!citesMissing || !this.policy.decide({ action: "readVault", targetPath: page.path }).allowed) {
        continue;
      }
      let content: string;
      try {
        content = await this.repository.readText(page.path);
      } catch {
        continue;
      }
      const patched = patchWikiPageForMissingSources(content, missingPaths);
      if (!patched.removedPaths.length) {
        continue;
      }
      pages.push({ path: page.path, title: page.title, content: patched.content });
      for (const path of patched.removedPaths) {
        removedSources.add(path);
      }
    }
    if (!pages.length) {
      throw new Error("引用已删除来源的页面都不可读，本次没有可校对的内容。");
    }
    return {
      topic: record.topic,
      pages,
      removedSources: [...removedSources],
      registry: pruneMissingWikiSources(registry, record.id, missingPaths)
    };
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
 * A compiled page with its title and provenance attached.
 *
 * The page body alone has neither: it starts at a callout, so a page written
 * as-is loses its H1 and carries no agent-created marker, which is why a
 * freshly compiled Wiki looked untitled and untraceable.
 */
export function renderPageBody(page: { title: string; content: string; sources: SourceRef[] }): string {
  return renderCreatedKnowledgeSystemNote(
    createKnowledgeSystemProposal(page.title, page.content, page.sources),
    new Date()
  );
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

function toTopicDefinition(proposal: ProposedTopic): TopicDefinition {
  return {
    id: proposal.id,
    name: proposal.name,
    definition: proposal.definition,
    ...(proposal.parentId ? { parentId: proposal.parentId } : {})
  };
}

/**
 * Turns the registry into the map: one section per topic, every note listed,
 * cross-topic notes marked, and the sparse ones flagged for a human.
 */
function buildTopicMapPlan(registry: TopicRegistry, overview: string): TopicMapPlan {
  const nameById = new Map(registry.topics.map((topic) => [topic.id, topic.name]));
  const stats = topicStats(registry);
  const topics = stats.map(({ topic, count }) => ({
    id: topic.id,
    name: topic.name,
    definition: topic.definition,
    paths: notesOfTopic(registry, topic.id),
    secondary: Object.entries(registry.assignments)
      .filter(([, assignment]) => assignment.topicId !== topic.id && assignment.secondaryTopicIds?.includes(topic.id))
      .map(([path, assignment]) => ({ path, topicName: nameById.get(assignment.topicId) ?? UNCLASSIFIED_TOPIC_ID }))
  }));
  return {
    overview,
    topics,
    unclassified: notesOfTopic(registry, UNCLASSIFIED_TOPIC_ID),
    sparse: topics.filter((topic) => topic.paths.length < MIN_NOTES_PER_TOPIC).map((topic) => topic.name)
  };
}

function titleFromPath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/iu, "").trim() || path;
}

function summarizeSourceHealth(sources: LlmWikiSourceHealth[]): DesktopWikiSourceHealthSummary {
  return sources.reduce<DesktopWikiSourceHealthSummary>((summary, source) => {
    summary[source.status] += 1;
    return summary;
  }, { active: 0, changed: 0, missing: 0, unverified: 0 });
}
