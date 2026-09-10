import type { TAbstractFile, TFile, Vault } from "obsidian";
import type { KnowledgeFile, KnowledgeRepository } from "../core/knowledge-repository";

/** Bridges the portable index contract to the existing Obsidian Vault API. */
export class ObsidianKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly vault: Vault) {}

  async listMarkdownFiles(): Promise<KnowledgeFile[]> {
    return this.vault.getMarkdownFiles().map(toKnowledgeFile);
  }

  async getMarkdownFile(path: string): Promise<KnowledgeFile | null> {
    const file = this.vault.getAbstractFileByPath(path);
    return isReadableFile(file) && file.extension.toLocaleLowerCase() === "md"
      ? toKnowledgeFile(file)
      : null;
  }

  async readText(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!isReadableFile(file)) {
      throw new Error(`知识库文件不存在：${path}`);
    }
    return this.vault.read(file);
  }
}

function toKnowledgeFile(file: TFile): KnowledgeFile {
  return {
    path: file.path,
    extension: file.extension,
    mtime: file.stat.mtime,
    size: file.stat.size
  };
}

function isReadableFile(file: TAbstractFile | null): file is TFile {
  return Boolean(
    file &&
      "extension" in file &&
      "stat" in file &&
      typeof file.path === "string"
  );
}
