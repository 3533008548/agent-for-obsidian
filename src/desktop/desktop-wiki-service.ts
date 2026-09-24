import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import {
  createLlmWikiRegistry,
  compileLlmWikiTopic,
  getLlmWikiTopicId,
  updateLlmWikiTopicSourceHealth,
  type LlmWikiCompilationMode,
  type LlmWikiCoverageReport,
  type LlmWikiRegistry,
  type LlmWikiSourceHealth,
  type LlmWikiTopicRecord
} from "../wiki/llm-wiki-system";
import type { KnowledgeIntegrationSession, KnowledgeIntegrationSource } from "../integration/knowledge-system";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
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

type WikiCandidateKind = "new" | "changed" | "anchor";

interface WikiCandidate {
  source: KnowledgeIntegrationSource;
  kind: WikiCandidateKind;
}

const MAX_WIKI_SOURCES = 80;
const MAX_CHUNKS_PER_SOURCE_PATH = 2;

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

  private get registryPath(): string {
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
    const wikiPrefix = `${this.knowledgeSystemFolder.replace(/\\/g, "/").replace(/\/+$/u, "/")}LLM Wiki/`;
    const registry = await this.readRegistry();
    const previousTopic = registry.topics.find((record) => record.id === getLlmWikiTopicId(normalizedTopic));
    const sourceHealth = mode === "expand" && previousTopic ? await this.inspectTopicSources(previousTopic) : [];
    const selection = this.collectSources(normalizedTopic, wikiPrefix, previousTopic, mode);
    if (!selection.sources.length) {
      throw new Error("本地没有命中可用于编译 Wiki 的资料。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    const map = await client.createKnowledgeMap(normalizedTopic, selection.sources);
    const session: KnowledgeIntegrationSession = {
      id: `desktop-wiki-${Date.now()}`,
      topic: normalizedTopic,
      scopeLabel: `本地检索：${normalizedTopic}`,
      createdAt: new Date().toISOString(),
      sources: selection.sources,
      map
    };
    const compilation = compileLlmWikiTopic(session, registry, this.knowledgeSystemFolder, {
      mode,
      coverageReport: selection.coverage,
      sourceHealth
    });
    let updatedCount = 0;
    for (const page of compilation.pages) {
      const decision = this.policy.decide({
        action: "createKnowledgeSystemNote",
        targetPath: `${this.knowledgeSystemFolder}/${page.relativePath}`
      });
      if (!decision.allowed) {
        throw new Error(`Wiki 写入被权限策略拒绝：${decision.reason}`);
      }
      if (await this.repository.getMarkdownFile(`${this.knowledgeSystemFolder}/${page.relativePath}`)) {
        await this.repository.writeText(`${this.knowledgeSystemFolder}/${page.relativePath}`, page.content);
      } else {
        await this.repository.createText(`${this.knowledgeSystemFolder}/${page.relativePath}`, page.content);
      }
      updatedCount += 1;
    }
    await this.repository.writeRaw(this.registryPath, JSON.stringify(compilation.nextRegistry, null, 2));
    return {
      topic: normalizedTopic,
      pageCount: compilation.pages.length,
      sourceCount: selection.sources.length,
      updatedCount,
      paths: compilation.pages.map((page) => `${this.knowledgeSystemFolder}/${page.relativePath}`),
      coverage: selection.coverage,
      sourceHealth: summarizeSourceHealth(sourceHealth)
    };
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

  private async readRegistry(): Promise<LlmWikiRegistry> {
    try {
      const raw = await this.repository.readRaw(this.registryPath);
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

function summarizeSourceHealth(sources: LlmWikiSourceHealth[]): DesktopWikiSourceHealthSummary {
  return sources.reduce<DesktopWikiSourceHealthSummary>((summary, source) => {
    summary[source.status] += 1;
    return summary;
  }, { active: 0, changed: 0, missing: 0, unverified: 0 });
}
