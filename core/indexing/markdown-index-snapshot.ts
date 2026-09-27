import type { MarkdownChunk } from "./markdown-parser";

/**
 * Persisted state of the Markdown chunk index.
 *
 * The snapshot exists so that startup can skip re-reading and re-parsing files
 * that have not changed. It stores the finished chunks rather than only file
 * fingerprints: fingerprints alone would still force a read for every note,
 * which is the exact cost we are trying to avoid.
 *
 * Chunks are invalidated per file, never per chunk. A chunk locator encodes its
 * position (`heading=…&chunk=N`, `startLine`/`endLine`), so editing one heading
 * shifts every chunk after it. Re-deriving a whole file is cheap; keeping
 * individual chunks coherent across edits is not.
 */
export const MARKDOWN_INDEX_SNAPSHOT_VERSION = 1;

export interface MarkdownIndexSnapshotFile {
  mtime: number;
  size: number;
  chunks: MarkdownChunk[];
}

export interface MarkdownIndexSnapshot {
  version: number;
  parserVersion: string;
  /** Identifies the workspace so a snapshot never leaks across roots. */
  rootPath: string;
  files: Record<string, MarkdownIndexSnapshotFile>;
}

/**
 * Storage boundary for the snapshot. Injecting it keeps the index itself free
 * of any filesystem dependency, so tests can supply an in-memory store.
 */
export interface MarkdownIndexSnapshotStore {
  read(): Promise<MarkdownIndexSnapshot | null>;
  write(snapshot: MarkdownIndexSnapshot): Promise<void>;
}

/**
 * Cheap change detector: modified time plus size.
 *
 * Content hashing would be exact but requires reading the file, which is the
 * cost this fingerprint exists to avoid. The known gap is a rewrite that
 * preserves both size and mtime (same-second save); that is accepted as rare
 * for a personal knowledge base.
 */
export function fingerprintOf(file: { mtime: number; size: number }): string {
  return `${file.mtime}:${file.size}`;
}

export function createEmptySnapshot(parserVersion: string, rootPath: string): MarkdownIndexSnapshot {
  return {
    version: MARKDOWN_INDEX_SNAPSHOT_VERSION,
    parserVersion,
    rootPath,
    files: {}
  };
}

/** A snapshot only helps if it was produced by this schema, parser and workspace. */
export function isUsableSnapshot(
  snapshot: MarkdownIndexSnapshot | null,
  parserVersion: string,
  rootPath: string
): boolean {
  if (!snapshot) {
    return false;
  }
  return (
    snapshot.version === MARKDOWN_INDEX_SNAPSHOT_VERSION &&
    snapshot.parserVersion === parserVersion &&
    snapshot.rootPath === rootPath
  );
}

/**
 * Tolerant parse: returns null for anything unusable.
 *
 * A corrupt or outdated snapshot must degrade to a full rebuild, never throw —
 * it is a cache, and a cache miss is always recoverable.
 */
export function parseSnapshot(raw: string): MarkdownIndexSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.version !== "number" || typeof parsed.parserVersion !== "string") {
    return null;
  }
  if (typeof parsed.rootPath !== "string" || !isRecord(parsed.files)) {
    return null;
  }

  const files: Record<string, MarkdownIndexSnapshotFile> = {};
  for (const [path, value] of Object.entries(parsed.files)) {
    const entry = asSnapshotFile(value);
    if (entry) {
      files[path] = entry;
    }
  }

  return {
    version: parsed.version,
    parserVersion: parsed.parserVersion,
    rootPath: parsed.rootPath,
    files
  };
}

function asSnapshotFile(value: unknown): MarkdownIndexSnapshotFile | null {
  if (!isRecord(value) || typeof value.mtime !== "number" || typeof value.size !== "number") {
    return null;
  }
  if (!Array.isArray(value.chunks)) {
    return null;
  }

  const chunks: MarkdownChunk[] = [];
  for (const chunk of value.chunks) {
    const parsed = asChunk(chunk);
    if (!parsed) {
      return null;
    }
    chunks.push(parsed);
  }
  return { mtime: value.mtime, size: value.size, chunks };
}

function asChunk(value: unknown): MarkdownChunk | null {
  if (!isRecord(value) || typeof value.content !== "string") {
    return null;
  }
  if (!isRecord(value.source)) {
    return null;
  }
  const { source } = value;
  if (
    typeof source.pathOrUrl !== "string" ||
    typeof source.locator !== "string" ||
    typeof source.contentHash !== "string" ||
    typeof source.parserVersion !== "string" ||
    (source.type !== "note" && source.type !== "pdf" && source.type !== "image" &&
      source.type !== "web" && source.type !== "conversation")
  ) {
    return null;
  }
  if (value.heading !== null && typeof value.heading !== "string") {
    return null;
  }
  if (!Array.isArray(value.headingPath) || value.headingPath.some((entry) => typeof entry !== "string")) {
    return null;
  }
  if (typeof value.startLine !== "number" || typeof value.endLine !== "number") {
    return null;
  }

  return {
    source: {
      type: source.type,
      pathOrUrl: source.pathOrUrl,
      locator: source.locator,
      contentHash: source.contentHash,
      parserVersion: source.parserVersion,
      ...(typeof source.retrievedAt === "string" ? { retrievedAt: source.retrievedAt } : {})
    },
    content: value.content,
    heading: value.heading,
    headingPath: value.headingPath,
    startLine: value.startLine,
    endLine: value.endLine
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
