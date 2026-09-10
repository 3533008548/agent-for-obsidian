import type { KnowledgeFile, KnowledgeRepository } from "../core/knowledge-repository";
import type { PolicyEngine } from "../policy/policy-engine";
import { parseMarkdownIntoChunks, type MarkdownChunk } from "./markdown-parser";
import { searchMarkdownChunks, type MarkdownSearchResult } from "./markdown-search";

export interface MarkdownIndexSummary {
  indexedFiles: number;
  skippedFiles: number;
  chunkCount: number;
}

/**
 * Obsidian-independent Markdown index.
 *
 * The index intentionally retains the existing policy check at the storage
 * boundary, so moving the UI does not broaden which notes can be indexed.
 */
export class PortableMarkdownKnowledgeIndex {
  private readonly chunksByPath = new Map<string, MarkdownChunk[]>();

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly isExcludedPath: (path: string) => boolean = () => false
  ) {}

  async rebuild(policy: PolicyEngine): Promise<MarkdownIndexSummary> {
    this.chunksByPath.clear();
    let indexedFiles = 0;
    let skippedFiles = 0;

    for (const file of await this.repository.listMarkdownFiles()) {
      const didIndex = await this.refreshFile(file, policy);
      if (didIndex) {
        indexedFiles += 1;
      } else {
        skippedFiles += 1;
      }
    }

    return {
      indexedFiles,
      skippedFiles,
      chunkCount: this.getAllChunks().length
    };
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
      return false;
    }
    const content = await this.repository.readText(file.path);
    return this.refreshContent(file, content, policy);
  }

  refreshContent(file: KnowledgeFile, content: string, policy: PolicyEngine): boolean {
    if (!this.canIndex(file, policy)) {
      return false;
    }
    this.chunksByPath.set(file.path, parseMarkdownIntoChunks(file.path, content));
    return true;
  }

  remove(path: string): void {
    this.chunksByPath.delete(path);
  }

  clear(): void {
    this.chunksByPath.clear();
  }

  has(path: string): boolean {
    return this.chunksByPath.has(path);
  }

  search(query: string, limit = 8): MarkdownSearchResult[] {
    return searchMarkdownChunks(this.getAllChunks(), query, limit);
  }

  getForPath(path: string): MarkdownChunk[] {
    return [...(this.chunksByPath.get(path) ?? [])];
  }

  getInFolder(folder: string): MarkdownChunk[] {
    const normalizedFolder = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalizedFolder) {
      return [];
    }
    return [...this.chunksByPath.entries()]
      .filter(([path]) => path.startsWith(`${normalizedFolder}/`))
      .flatMap(([, chunks]) => chunks);
  }

  get size(): number {
    return this.getAllChunks().length;
  }

  private getAllChunks(): MarkdownChunk[] {
    return [...this.chunksByPath.values()].flat();
  }

  private canIndex(file: KnowledgeFile, policy: PolicyEngine): boolean {
    if (file.extension.toLocaleLowerCase() !== "md" || this.isExcludedPath(file.path)) {
      this.remove(file.path);
      return false;
    }
    const decision = policy.decide({ action: "readVault", targetPath: file.path });
    if (!decision.allowed) {
      this.remove(file.path);
      return false;
    }
    return true;
  }
}
