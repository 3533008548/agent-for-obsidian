import type { KnowledgeFile, KnowledgeRepository } from "../core/knowledge-repository";
import type { PolicyEngine } from "../policy/policy-engine";
import { MARKDOWN_PARSER_VERSION, parseMarkdownIntoChunks, type MarkdownChunk } from "./markdown-parser";
import { MarkdownBm25Corpus } from "./bm25";
import { searchMarkdownChunks, type MarkdownSearchResult } from "./markdown-search";
import {
  MARKDOWN_INDEX_SNAPSHOT_VERSION,
  fingerprintOf,
  isUsableSnapshot,
  type MarkdownIndexSnapshot,
  type MarkdownIndexSnapshotFile,
  type MarkdownIndexSnapshotStore
} from "./markdown-index-snapshot";

export interface MarkdownIndexSummary {
  indexedFiles: number;
  skippedFiles: number;
  chunkCount: number;
  /** Files whose chunks came from the snapshot instead of a fresh read. */
  reusedFiles: number;
}

interface IndexEntry {
  mtime: number;
  size: number;
  chunks: MarkdownChunk[];
}

export interface PortableMarkdownKnowledgeIndexOptions {
  /** When provided, chunks survive across runs. */
  store?: MarkdownIndexSnapshotStore;
  /** Snapshots are keyed by workspace; a different root discards them. */
  rootPath?: string;
}

/**
 * Obsidian-independent Markdown index.
 *
 * The index intentionally retains the existing policy check at the storage
 * boundary, so moving the UI does not broaden which notes can be indexed.
 *
 * `sync()` is the normal entry point: it diffs file fingerprints against the
 * last snapshot and only re-reads what actually changed, which also keeps the
 * index populated instead of clearing and refilling it. `rebuild()` remains
 * for an explicit full re-index.
 */
export class PortableMarkdownKnowledgeIndex {
  private entries = new Map<string, IndexEntry>();
  /** IDF statistics for `search()`, rebuilt lazily whenever chunks change. */
  private corpus: MarkdownBm25Corpus | null = null;

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly isExcludedPath: (path: string) => boolean = () => false,
    private readonly options: PortableMarkdownKnowledgeIndexOptions = {}
  ) {}

  /** Re-read and re-parse everything, ignoring any snapshot. */
  async rebuild(policy: PolicyEngine): Promise<MarkdownIndexSummary> {
    const files = await this.repository.listMarkdownFiles();
    const entries = new Map<string, IndexEntry>();
    let indexedFiles = 0;
    let skippedFiles = 0;

    for (const file of files) {
      if (!this.canIndex(file, policy)) {
        skippedFiles += 1;
        continue;
      }
      entries.set(file.path, {
        mtime: file.mtime,
        size: file.size,
        chunks: parseMarkdownIntoChunks(file.path, await this.repository.readText(file.path))
      });
      indexedFiles += 1;
    }

    this.entries = entries;
    this.corpus = null;
    await this.persist();
    return this.toSummary(indexedFiles, skippedFiles, 0);
  }

  /**
   * Bring the index in line with the workspace, reusing cached chunks for
   * files whose `mtime:size` fingerprint is unchanged.
   */
  async sync(policy: PolicyEngine): Promise<MarkdownIndexSummary> {
    const previous = await this.loadSnapshot();
    const files = await this.repository.listMarkdownFiles();
    const entries = new Map<string, IndexEntry>();
    let indexedFiles = 0;
    let skippedFiles = 0;
    let reusedFiles = 0;

    for (const file of files) {
      if (!this.canIndex(file, policy)) {
        skippedFiles += 1;
        continue;
      }

      const cached = previous?.files[file.path];
      if (cached && fingerprintOf(cached) === fingerprintOf(file)) {
        entries.set(file.path, { mtime: file.mtime, size: file.size, chunks: cached.chunks });
        reusedFiles += 1;
        indexedFiles += 1;
        continue;
      }

      entries.set(file.path, {
        mtime: file.mtime,
        size: file.size,
        chunks: parseMarkdownIntoChunks(file.path, await this.repository.readText(file.path))
      });
      indexedFiles += 1;
    }

    this.entries = entries;
    this.corpus = null;
    if (hasSnapshotChanged(previous, entries)) {
      await this.persist();
    }
    return this.toSummary(indexedFiles, skippedFiles, reusedFiles);
  }

  async refreshPath(path: string, policy: PolicyEngine): Promise<boolean> {
    const file = await this.repository.getMarkdownFile(path);
    if (!file) {
      this.remove(path);
      return false;
    }
    return this.refreshFile(file, policy);
  }

  async refreshFile(file: KnowledgeFile, policy: PolicyEngine): Promise<boolean> {
    if (!this.canIndex(file, policy)) {
      this.remove(file.path);
      return false;
    }
    const content = await this.repository.readText(file.path);
    return this.refreshContent(file, content, policy);
  }

  refreshContent(file: KnowledgeFile, content: string, policy: PolicyEngine): boolean {
    if (!this.canIndex(file, policy)) {
      this.remove(file.path);
      return false;
    }
    this.entries.set(file.path, {
      mtime: file.mtime,
      size: file.size,
      chunks: parseMarkdownIntoChunks(file.path, content)
    });
    this.corpus = null;
    return true;
  }

  /** Write current state to the snapshot store, if one is configured. */
  async save(): Promise<void> {
    await this.persist();
  }

  remove(path: string): void {
    if (this.entries.delete(path)) {
      this.corpus = null;
    }
  }

  clear(): void {
    this.entries.clear();
    this.corpus = null;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  search(query: string, limit = 8, activePath: string | null = null): MarkdownSearchResult[] {
    return searchMarkdownChunks(this.getAllChunks(), query, limit, {
      corpus: this.currentCorpus(),
      activePath
    });
  }

  getForPath(path: string): MarkdownChunk[] {
    return [...(this.entries.get(path)?.chunks ?? [])];
  }

  getInFolder(folder: string): MarkdownChunk[] {
    const normalizedFolder = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalizedFolder) {
      return [];
    }
    return [...this.entries.entries()]
      .filter(([path]) => path.startsWith(`${normalizedFolder}/`))
      .flatMap(([, entry]) => entry.chunks);
  }

  get size(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.chunks.length;
    }
    return total;
  }

  private toSummary(
    indexedFiles: number,
    skippedFiles: number,
    reusedFiles: number
  ): MarkdownIndexSummary {
    return { indexedFiles, skippedFiles, chunkCount: this.size, reusedFiles };
  }

  private async loadSnapshot(): Promise<MarkdownIndexSnapshot | null> {
    const store = this.options.store;
    if (!store) {
      return null;
    }
    let snapshot: MarkdownIndexSnapshot | null = null;
    try {
      snapshot = await store.read();
    } catch {
      return null;
    }
    const rootPath = this.options.rootPath ?? "";
    return isUsableSnapshot(snapshot, MARKDOWN_PARSER_VERSION, rootPath) ? snapshot : null;
  }

  private async persist(): Promise<void> {
    const store = this.options.store;
    if (!store) {
      return;
    }
    const files: Record<string, MarkdownIndexSnapshotFile> = {};
    for (const [path, entry] of this.entries) {
      files[path] = { mtime: entry.mtime, size: entry.size, chunks: entry.chunks };
    }
    await store.write({
      version: MARKDOWN_INDEX_SNAPSHOT_VERSION,
      parserVersion: MARKDOWN_PARSER_VERSION,
      rootPath: this.options.rootPath ?? "",
      files
    });
  }

  private getAllChunks(): MarkdownChunk[] {
    return [...this.entries.values()].flatMap((entry) => entry.chunks);
  }

  private currentCorpus(): MarkdownBm25Corpus {
    if (!this.corpus) {
      this.corpus = new MarkdownBm25Corpus(this.getAllChunks());
    }
    return this.corpus;
  }

  private canIndex(file: KnowledgeFile, policy: PolicyEngine): boolean {
    if (file.extension.toLocaleLowerCase() !== "md" || this.isExcludedPath(file.path)) {
      return false;
    }
    return policy.decide({ action: "readVault", targetPath: file.path }).allowed;
  }
}

function hasSnapshotChanged(
  previous: MarkdownIndexSnapshot | null,
  entries: Map<string, IndexEntry>
): boolean {
  if (!previous) {
    return true;
  }
  if (Object.keys(previous.files).length !== entries.size) {
    return true;
  }
  for (const [path, entry] of entries) {
    const cached = previous.files[path];
    if (!cached || fingerprintOf(cached) !== fingerprintOf(entry)) {
      return true;
    }
  }
  return false;
}
