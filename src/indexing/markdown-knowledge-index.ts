import { TFile, type Vault } from "obsidian";
import type { PolicyEngine } from "../policy/policy-engine";
import { parseMarkdownIntoChunks, type MarkdownChunk } from "./markdown-parser";
import { searchMarkdownChunks, type MarkdownSearchResult } from "./markdown-search";

export interface MarkdownIndexSummary {
  indexedFiles: number;
  skippedFiles: number;
  chunkCount: number;
}

export class MarkdownKnowledgeIndex {
  private readonly chunksByPath = new Map<string, MarkdownChunk[]>();

  constructor(
    private readonly vault: Vault,
    private readonly isExcludedPath: (path: string) => boolean = () => false
  ) {}

  async rebuild(policy: PolicyEngine): Promise<MarkdownIndexSummary> {
    this.chunksByPath.clear();
    let indexedFiles = 0;
    let skippedFiles = 0;

    for (const file of this.vault.getMarkdownFiles()) {
      const didIndex = await this.indexFile(file, policy);
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

  async refreshFile(file: TFile, policy: PolicyEngine, force = false): Promise<boolean> {
    if (!force && !this.chunksByPath.has(file.path)) {
      return false;
    }
    return this.indexFile(file, policy);
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

  private async indexFile(file: TFile, policy: PolicyEngine): Promise<boolean> {
    if (this.isExcludedPath(file.path)) {
      this.chunksByPath.delete(file.path);
      return false;
    }
    const decision = policy.decide({ action: "readVault", targetPath: file.path });
    if (!decision.allowed) {
      this.chunksByPath.delete(file.path);
      return false;
    }

    const content = await this.vault.read(file);
    this.chunksByPath.set(file.path, parseMarkdownIntoChunks(file.path, content));
    return true;
  }

  private getAllChunks(): MarkdownChunk[] {
    return [...this.chunksByPath.values()].flat();
  }
}
