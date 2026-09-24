import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const EXCLUDED_DIRECTORY_NAMES = new Set([".obsidian", ".git", ".knowledge-loop-agent"]);

export interface ObsidianVaultMigrationPreview {
  sourcePath: string;
  noteCount: number;
  attachmentCount: number;
  totalFiles: number;
}

export interface ObsidianVaultMigrationResult extends ObsidianVaultMigrationPreview {
  destinationPath: string;
}

interface VaultFileEntry {
  relativePath: string;
  sourcePath: string;
  isMarkdown: boolean;
}

/**
 * Copies an Obsidian Vault into a standalone knowledge workspace.
 *
 * User content and attachment paths are retained verbatim. Obsidian's
 * application configuration, Git metadata and local standalone settings are
 * intentionally excluded, so no plugin configuration or API keys migrate.
 */
export async function previewObsidianVaultMigration(sourcePath: string): Promise<ObsidianVaultMigrationPreview> {
  const sourceRoot = await resolveExistingDirectory(sourcePath, "原始 Obsidian 知识库");
  const files = await collectVaultFiles(sourceRoot);
  return toPreview(sourceRoot, files);
}

export async function migrateObsidianVault(
  sourcePath: string,
  destinationPath: string
): Promise<ObsidianVaultMigrationResult> {
  const sourceRoot = await resolveExistingDirectory(sourcePath, "原始 Obsidian 知识库");
  const destinationRoot = resolve(destinationPath);
  ensureDestinationIsSeparate(sourceRoot, destinationRoot);
  await ensureDestinationDoesNotExist(destinationRoot);

  const files = await collectVaultFiles(sourceRoot);
  await mkdir(destinationRoot, { recursive: true });
  for (const file of files) {
    const targetPath = join(destinationRoot, ...file.relativePath.split("/"));
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(file.sourcePath, targetPath);
  }

  return {
    ...toPreview(sourceRoot, files),
    destinationPath: destinationRoot
  };
}

export function getStandaloneWorkspaceName(sourcePath: string): string {
  return `${basename(resolve(sourcePath))}-知识环迁移`;
}

async function collectVaultFiles(sourceRoot: string): Promise<VaultFileEntry[]> {
  const files: VaultFileEntry[] = [];
  await visitDirectory(sourceRoot, sourceRoot, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function visitDirectory(
  sourceRoot: string,
  currentDirectory: string,
  files: VaultFileEntry[]
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        await visitDirectory(sourceRoot, join(currentDirectory, entry.name), files);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = join(currentDirectory, entry.name);
    const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/");
    files.push({
      relativePath,
      sourcePath,
      isMarkdown: entry.name.toLocaleLowerCase().endsWith(".md")
    });
  }
}

function toPreview(sourcePath: string, files: VaultFileEntry[]): ObsidianVaultMigrationPreview {
  const noteCount = files.filter((file) => file.isMarkdown).length;
  return {
    sourcePath,
    noteCount,
    attachmentCount: files.length - noteCount,
    totalFiles: files.length
  };
}

async function resolveExistingDirectory(path: string, label: string): Promise<string> {
  if (!path || !isAbsolute(path)) {
    throw new Error(`${label}路径无效。`);
  }
  const root = resolve(path);
  const current = await stat(root).catch(() => null);
  if (!current?.isDirectory()) {
    throw new Error(`${label}不存在或不是目录。`);
  }
  return root;
}

function ensureDestinationIsSeparate(sourceRoot: string, destinationRoot: string): void {
  const relationship = relative(sourceRoot, destinationRoot);
  if (!relationship || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error("迁移目标不能是原始知识库或其子目录。");
  }
}

async function ensureDestinationDoesNotExist(destinationPath: string): Promise<void> {
  const current = await stat(destinationPath).catch(() => null);
  if (current) {
    throw new Error(`迁移目标已存在：${destinationPath}。请选择其他父目录。`);
  }
}
