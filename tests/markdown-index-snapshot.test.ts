import { describe, expect, it } from "vitest";
import {
  MARKDOWN_INDEX_SNAPSHOT_VERSION,
  createEmptySnapshot,
  fingerprintOf,
  isUsableSnapshot,
  parseSnapshot,
  type MarkdownIndexSnapshot
} from "../core/indexing/markdown-index-snapshot";
import { MARKDOWN_PARSER_VERSION, parseMarkdownIntoChunks } from "../core/indexing/markdown-parser";

function snapshotWithChunk(): MarkdownIndexSnapshot {
  return {
    version: MARKDOWN_INDEX_SNAPSHOT_VERSION,
    parserVersion: MARKDOWN_PARSER_VERSION,
    rootPath: "root",
    files: {
      "daily/甲.md": {
        mtime: 1,
        size: 10,
        chunks: parseMarkdownIntoChunks("daily/甲.md", "# 甲\n\n内容。")
      }
    }
  };
}

describe("fingerprintOf", () => {
  it("changes when either mtime or size changes", () => {
    expect(fingerprintOf({ mtime: 1, size: 2 })).not.toBe(fingerprintOf({ mtime: 2, size: 2 }));
    expect(fingerprintOf({ mtime: 1, size: 2 })).not.toBe(fingerprintOf({ mtime: 1, size: 3 }));
    expect(fingerprintOf({ mtime: 1, size: 2 })).toBe(fingerprintOf({ mtime: 1, size: 2 }));
  });
});

describe("parseSnapshot", () => {
  it("round-trips a snapshot with chunks", () => {
    const parsed = parseSnapshot(JSON.stringify(snapshotWithChunk()));

    expect(parsed?.rootPath).toBe("root");
    expect(parsed?.files["daily/甲.md"].chunks).toHaveLength(1);
    expect(parsed?.files["daily/甲.md"].chunks[0].content).toContain("内容");
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseSnapshot("{ not json")).toBeNull();
  });

  it("returns null when required top-level fields are missing", () => {
    expect(parseSnapshot(JSON.stringify({ version: 1, parserVersion: "x" }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ files: {} }))).toBeNull();
  });

  it("drops individual entries whose chunks are malformed", () => {
    const raw = JSON.stringify({
      ...snapshotWithChunk(),
      files: {
        "daily/甲.md": { mtime: 1, size: 10, chunks: [{ content: "缺少 source 字段" }] },
        "daily/乙.md": { mtime: 1, size: 10, chunks: [] }
      }
    });

    const parsed = parseSnapshot(raw);

    expect(parsed?.files["daily/甲.md"]).toBeUndefined();
    expect(parsed?.files["daily/乙.md"]).toEqual({ mtime: 1, size: 10, chunks: [] });
  });
});

describe("isUsableSnapshot", () => {
  const snapshot = snapshotWithChunk();

  it("accepts a snapshot from this schema, parser and workspace", () => {
    expect(isUsableSnapshot(snapshot, MARKDOWN_PARSER_VERSION, "root")).toBe(true);
  });

  it("rejects a snapshot written by another parser version", () => {
    expect(isUsableSnapshot(snapshot, "markdown-v0", "root")).toBe(false);
  });

  it("rejects a snapshot from another workspace", () => {
    expect(isUsableSnapshot(snapshot, MARKDOWN_PARSER_VERSION, "other-root")).toBe(false);
  });

  it("rejects a missing snapshot", () => {
    expect(isUsableSnapshot(null, MARKDOWN_PARSER_VERSION, "root")).toBe(false);
  });

  it("accepts an empty snapshot so a first run can still persist one", () => {
    const empty = createEmptySnapshot(MARKDOWN_PARSER_VERSION, "root");
    expect(isUsableSnapshot(empty, MARKDOWN_PARSER_VERSION, "root")).toBe(true);
  });
});
