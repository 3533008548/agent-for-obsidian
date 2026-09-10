import { TFile, type Vault } from "obsidian";
import { ObsidianKnowledgeRepository } from "../adapters/obsidian-knowledge-repository";
import type { PolicyEngine } from "../policy/policy-engine";
import {
  PortableMarkdownKnowledgeIndex,
  type MarkdownIndexSummary
} from "./portable-markdown-knowledge-index";
import type { MarkdownSearchResult } from "./markdown-search";

export type { MarkdownIndexSummary } from "./portable-markdown-knowledge-index";

export class MarkdownKnowledgeIndex {
  private readonly index: PortableMarkdownKnowledgeIndex;

  constructor(
    private readonly vault: Vault,
    private readonly isExcludedPath: (path: string) => boolean = () => false
  ) {
    this.index = new PortableMarkdownKnowledgeIndex(
      new ObsidianKnowledgeRepository(vault),
      this.isExcludedPath
    );
  }

  async rebuild(policy: PolicyEngine): Promise<MarkdownIndexSummary> {
    return this.index.rebuild(policy);
  }

  async refreshFile(file: TFile, policy: PolicyEngine): Promise<boolean> {
    return this.index.refreshContent(
      {
        path: file.path,
        extension: file.extension,
        mtime: file.stat?.mtime ?? 0,
        size: file.stat?.size ?? 0
      },
      await this.vault.read(file),
      policy
    );
  }

  remove(path: string): void {
    this.index.remove(path);
  }

  clear(): void {
    this.index.clear();
  }

  has(path: string): boolean {
    return this.index.has(path);
  }

  search(query: string, limit = 8): MarkdownSearchResult[] {
    return this.index.search(query, limit);
  }

  getForPath(path: string) {
    return this.index.getForPath(path);
  }

  getInFolder(folder: string) {
    return this.index.getInFolder(folder);
  }

  get size(): number {
    return this.index.size;
  }
}
