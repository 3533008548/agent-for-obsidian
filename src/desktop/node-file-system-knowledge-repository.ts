import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { KnowledgeFile, KnowledgeRepository } from "../core/knowledge-repository";

/**
 * Desktop adapter for a user-selected Markdown directory.
 * Paths exposed to the agent are always normalized relative paths, matching
 * the paths currently used inside an Obsidian Vault.
 */
export class NodeFileSystemKnowledgeRepository implements KnowledgeRepository {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async listMarkdownFiles(): Promise<KnowledgeFile[]> {
    const files: KnowledgeFile[] = [];
    await this.visitDirectory(this.rootDirectory, files);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async listFiles(): Promise<KnowledgeFile[]> {
    const files: KnowledgeFile[] = [];
    await this.visitAllFiles(this.rootDirectory, files);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async getMarkdownFile(path: string): Promise<KnowledgeFile | null> {
    const absolutePath = this.resolvePath(path);
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return null;
      }
      const file = this.toKnowledgeFile(absolutePath, fileStat.mtimeMs, fileStat.size);
      return file.extension.toLocaleLowerCase() === "md" ? file : null;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(this.resolvePath(path), "utf8");
  }

  async readBinary(path: string): Promise<Buffer> {
    return readFile(this.resolvePath(path));
  }

  async createText(path: string, content: string): Promise<void> {
    const targetPath = this.resolvePath(path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
  }

  async writeText(path: string, content: string): Promise<void> {
    const targetPath = this.resolvePath(path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }

  async appendText(path: string, content: string): Promise<void> {
    const targetPath = this.resolvePath(path);
    await mkdir(dirname(targetPath), { recursive: true });
    await appendFile(targetPath, content, "utf8");
  }

  async readRaw(path: string): Promise<string> {
    return readFile(this.resolvePath(path), "utf8");
  }

  async writeRaw(path: string, content: string): Promise<void> {
    const targetPath = this.resolvePath(path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }

  async createRaw(path: string, content: string): Promise<void> {
    const targetPath = this.resolvePath(path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
  }

  private async visitDirectory(directory: string, files: KnowledgeFile[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await this.visitDirectory(entryPath, files);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith(".md")) {
        continue;
      }
      const fileStat = await stat(entryPath);
      files.push(this.toKnowledgeFile(entryPath, fileStat.mtimeMs, fileStat.size));
    }
  }

  private async visitAllFiles(directory: string, files: KnowledgeFile[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await this.visitAllFiles(entryPath, files);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fileStat = await stat(entryPath);
      files.push(this.toKnowledgeFile(entryPath, fileStat.mtimeMs, fileStat.size));
    }
  }

  private toKnowledgeFile(absolutePath: string, mtime: number, size: number): KnowledgeFile {
    const path = relative(this.rootDirectory, absolutePath).split(sep).join("/");
    const extensionIndex = path.lastIndexOf(".");
    return {
      path,
      extension: extensionIndex >= 0 ? path.slice(extensionIndex + 1) : "",
      mtime,
      size
    };
  }

  private resolvePath(path: string): string {
    if (!path || isAbsolute(path)) {
      throw new Error("知识库路径必须是非空相对路径。");
    }
    const resolvedPath = resolve(this.rootDirectory, path);
    const rootWithSeparator = `${this.rootDirectory}${sep}`;
    if (resolvedPath !== this.rootDirectory && !resolvedPath.startsWith(rootWithSeparator)) {
      throw new Error(`知识库路径超出已选目录：${path}`);
    }
    return resolvedPath;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
