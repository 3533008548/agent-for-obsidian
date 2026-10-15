import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Copies every Markdown note out of the vault before a bulk edit.
 *
 * Renaming touches files the user wrote, so the pass that does it takes a
 * backup first. The copy lands *beside* the vault, never inside it: a backup
 * directory under the root would be indexed as notes and would show up in the
 * next survey.
 */
export interface VaultBackupResult {
  path: string;
  fileCount: number;
}

export async function backupMarkdownNotes(
  rootDirectory: string,
  now = new Date()
): Promise<VaultBackupResult> {
  const root = resolve(rootDirectory);
  const target = resolve(dirname(root), `${folderName(root)}-backup-${formatStamp(now)}`);
  const files = await listMarkdownFiles(root);
  for (const file of files) {
    const destination = join(target, relative(root, file));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
  }
  return { path: target, fileCount: files.length };
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
      const entryStat = await stat(entryPath);
      if (entryStat.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function folderName(root: string): string {
  return root.split(/[\\/]/u).pop() || "vault";
}

function formatStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}
