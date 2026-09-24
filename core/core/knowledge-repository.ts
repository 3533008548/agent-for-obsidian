/**
 * The smallest storage boundary needed by the knowledge index.
 *
 * Implementations may read an Obsidian Vault, a local directory, or another
 * Markdown workspace.  Keeping this contract read-only makes it safe to
 * reuse from the desktop application before its write workflow is migrated.
 */
export interface KnowledgeFile {
  path: string;
  extension: string;
  mtime: number;
  size: number;
}

export interface KnowledgeRepository {
  listMarkdownFiles(): Promise<KnowledgeFile[]>;
  getMarkdownFile(path: string): Promise<KnowledgeFile | null>;
  readText(path: string): Promise<string>;
}

export function isMarkdownKnowledgeFile(file: KnowledgeFile): boolean {
  return file.extension.toLocaleLowerCase() === "md";
}
