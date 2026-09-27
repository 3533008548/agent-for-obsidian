import { describe, expect, it } from "vitest";
import type { KnowledgeFile, KnowledgeRepository } from "../core/core/knowledge-repository";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import {
  MARKDOWN_INDEX_SNAPSHOT_VERSION,
  parseSnapshot,
  type MarkdownIndexSnapshot,
  type MarkdownIndexSnapshotStore
} from "../core/indexing/markdown-index-snapshot";
import { MARKDOWN_PARSER_VERSION } from "../core/indexing/markdown-parser";
import { createDefaultPermissionPolicy, PolicyEngine } from "../core/policy/policy-engine";

interface FakeFile {
  content: string;
  mtime: number;
}

class FakeRepository implements KnowledgeRepository {
  readCount = 0;

  constructor(private readonly files: Map<string, FakeFile>) {}

  async listMarkdownFiles(): Promise<KnowledgeFile[]> {
    return [...this.files.entries()].map(([path, file]) => ({
      path,
      extension: "md",
      mtime: file.mtime,
      size: file.content.length
    }));
  }

  async getMarkdownFile(path: string): Promise<KnowledgeFile | null> {
    const file = this.files.get(path);
    if (!file) {
      return null;
    }
    return { path, extension: "md", mtime: file.mtime, size: file.content.length };
  }

  async readText(path: string): Promise<string> {
    this.readCount += 1;
    return this.files.get(path)?.content ?? "";
  }
}

class MemorySnapshotStore implements MarkdownIndexSnapshotStore {
  raw: string | null = null;
  writes = 0;

  async read(): Promise<MarkdownIndexSnapshot | null> {
    return this.raw ? parseSnapshot(this.raw) : null;
  }

  async write(snapshot: MarkdownIndexSnapshot): Promise<void> {
    this.writes += 1;
    this.raw = JSON.stringify(snapshot);
  }
}

function createIndex(
  files: Map<string, FakeFile>,
  store: MemorySnapshotStore | null,
  rootPath = "root"
): { index: PortableMarkdownKnowledgeIndex; repository: FakeRepository } {
  const repository = new FakeRepository(files);
  const index = new PortableMarkdownKnowledgeIndex(
    repository,
    () => false,
    store ? { store, rootPath } : {}
  );
  return { index, repository };
}

const policy = new PolicyEngine(createDefaultPermissionPolicy());

describe("PortableMarkdownKnowledgeIndex.sync", () => {
  it("reuses cached chunks and skips reading when nothing changed", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n原始内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    const { index, repository } = createIndex(files, store);

    const first = await index.sync(policy);
    expect(first.indexedFiles).toBe(1);
    expect(first.reusedFiles).toBe(0);
    expect(repository.readCount).toBe(1);
    expect(store.writes).toBe(1);

    const second = await index.sync(policy);
    expect(second.reusedFiles).toBe(1);
    expect(repository.readCount).toBe(1);
    expect(store.writes).toBe(1);
    expect(index.search("原始内容")).toHaveLength(1);
  });

  it("re-reads and re-chunks a file whose fingerprint changed", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n原始内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    const { index, repository } = createIndex(files, store);

    await index.sync(policy);
    files.set("daily/甲.md", { content: "# 甲\n\n完全不同的东西。", mtime: 2 });

    const summary = await index.sync(policy);

    expect(summary.reusedFiles).toBe(0);
    expect(repository.readCount).toBe(2);
    expect(index.search("完全不同的东西")).toHaveLength(1);
    expect(index.search("原始内容")).toHaveLength(0);
  });

  it("removes files that disappeared from the workspace", async () => {
    const files = new Map([
      ["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }],
      ["daily/乙.md", { content: "# 乙\n\n内容。", mtime: 1 }]
    ]);
    const store = new MemorySnapshotStore();
    const { index } = createIndex(files, store);

    await index.sync(policy);
    expect(index.has("daily/乙.md")).toBe(true);

    files.delete("daily/乙.md");
    const summary = await index.sync(policy);

    expect(index.has("daily/乙.md")).toBe(false);
    expect(summary.indexedFiles).toBe(1);
    expect(store.writes).toBe(2);
  });

  it("discards a snapshot that belongs to another workspace", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    const firstPass = createIndex(files, store, "workspace-a");
    await firstPass.index.sync(policy);
    expect(firstPass.repository.readCount).toBe(1);

    const secondPass = createIndex(files, store, "workspace-b");
    const summary = await secondPass.index.sync(policy);

    expect(summary.reusedFiles).toBe(0);
    expect(secondPass.repository.readCount).toBe(1);
  });

  it("falls back to a full index when the snapshot is corrupt", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    store.raw = "{ 写到一半就崩了";
    const { index, repository } = createIndex(files, store);

    const summary = await index.sync(policy);

    expect(summary.reusedFiles).toBe(0);
    expect(summary.indexedFiles).toBe(1);
    expect(repository.readCount).toBe(1);
  });

  it("ignores a snapshot written by a different parser version", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    store.raw = JSON.stringify({
      version: MARKDOWN_INDEX_SNAPSHOT_VERSION,
      parserVersion: "markdown-v0",
      rootPath: "root",
      files: {
        "daily/甲.md": { mtime: 1, size: 20, chunks: [{ content: "旧解析器的块" }] }
      }
    });
    const { index } = createIndex(files, store);

    const summary = await index.sync(policy);

    expect(summary.reusedFiles).toBe(0);
    expect(index.search("内容")).toHaveLength(1);
  });

  it("rebuild re-reads everything even when a usable snapshot exists", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    const { index, repository } = createIndex(files, store);

    await index.sync(policy);
    const summary = await index.rebuild(policy);

    expect(summary.reusedFiles).toBe(0);
    expect(repository.readCount).toBe(2);
  });

  it("works without a snapshot store", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }]]);
    const { index } = createIndex(files, null);

    const summary = await index.sync(policy);

    expect(summary.indexedFiles).toBe(1);
    expect(summary.reusedFiles).toBe(0);
  });

  it("keeps the index populated while syncing instead of clearing it first", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\n内容。", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    const { index } = createIndex(files, store);

    await index.sync(policy);
    files.set("daily/甲.md", { content: "# 甲\n\n内容。", mtime: 9 });

    const pending = index.sync(policy);
    expect(index.search("内容")).toHaveLength(1);
    await pending;
  });

  it("does not notice a rewrite that keeps both size and mtime", async () => {
    const files = new Map([["daily/甲.md", { content: "# 甲\n\nAAAA", mtime: 1 }]]);
    const store = new MemorySnapshotStore();
    const { index } = createIndex(files, store);

    await index.sync(policy);
    files.set("daily/甲.md", { content: "# 甲\n\nBBBB", mtime: 1 });

    const summary = await index.sync(policy);

    expect(summary.reusedFiles).toBe(1);
    expect(index.search("AAAA")).toHaveLength(1);
  });
});
