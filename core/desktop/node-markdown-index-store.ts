import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseSnapshot,
  type MarkdownIndexSnapshot,
  type MarkdownIndexSnapshotStore
} from "../indexing/markdown-index-snapshot";

/**
 * Filesystem-backed snapshot store.
 *
 * Writes go to a temporary file and are then renamed, so a crash part-way
 * through can never leave a half-written snapshot behind for the next start.
 *
 * Every read failure is reported as "no snapshot" rather than thrown. The
 * snapshot is a cache: a miss costs one full re-index, which is recoverable,
 * whereas failing to start would not be.
 */
export function createNodeMarkdownIndexStore(filePath: string): MarkdownIndexSnapshotStore {
  return {
    async read(): Promise<MarkdownIndexSnapshot | null> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      return parseSnapshot(raw);
    },

    async write(snapshot: MarkdownIndexSnapshot): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
      await rename(temporaryPath, filePath);
    }
  };
}
