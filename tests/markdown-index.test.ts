import { describe, expect, it } from "vitest";
import type { KnowledgeFile, KnowledgeRepository } from "../core/core/knowledge-repository";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import { parseMarkdownIntoChunks } from "../core/indexing/markdown-parser";
import { searchMarkdownChunks } from "../core/indexing/markdown-search";
import { createDefaultPermissionPolicy, PolicyEngine } from "../core/policy/policy-engine";

class MemoryKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly contents: Map<string, string>) {}

  async listMarkdownFiles(): Promise<KnowledgeFile[]> {
    return [...this.contents.keys()].map((path) => this.toFile(path));
  }

  async getMarkdownFile(path: string): Promise<KnowledgeFile | null> {
    return this.contents.has(path) ? this.toFile(path) : null;
  }

  async readText(path: string): Promise<string> {
    return this.contents.get(path) ?? "";
  }

  private toFile(path: string): KnowledgeFile {
    return { path, extension: "md", mtime: 1, size: (this.contents.get(path) ?? "").length };
  }
}

describe("Markdown parsing and search", () => {
  const chunks = parseMarkdownIntoChunks(
    "Notes/机器学习.md",
    "# 机器学习\n\n机器学习通过数据学习规律。\n\n## 监督学习\n\n监督学习依赖带标签的数据。\n\n## 损失函数\n\n损失函数衡量预测与真实值的差异。"
  );

  it("preserves heading source locations", () => {
    expect(chunks).toHaveLength(3);
    expect(chunks[1].headingPath).toEqual(["机器学习", "监督学习"]);
    expect(chunks[1].source.locator).toContain("heading=");
  });

  it("returns source-aware results for Chinese queries", () => {
    const results = searchMarkdownChunks(chunks, "监督学习是什么");

    expect(results).not.toHaveLength(0);
    expect(results[0].chunk.heading).toBe("监督学习");
    expect(results[0].chunk.source.pathOrUrl).toBe("Notes/机器学习.md");
  });

  it("does not return results for an empty query", () => {
    expect(searchMarkdownChunks(chunks, "  ")).toEqual([]);
  });

  it("does not treat generic Chinese question words as a match for a missing technical term", () => {
    const unrelated = parseMarkdownIntoChunks(
      "daily/编程概念.md",
      "# 编程概念\n\nRedis 是什么？HTTP 429 是什么？"
    );

    expect(searchMarkdownChunks(unrelated, "Pydantic 是什么")).toEqual([]);
  });

  it("finds mixed Chinese-English queries and prioritizes matching filenames", () => {
    const fileNameMatch = parseMarkdownIntoChunks(
      "daily/LangGraph-checkpoint.md",
      "# Checkpoint\n\n状态恢复与持久化。"
    );
    const contentOnlyMatch = parseMarkdownIntoChunks(
      "daily/其他 Agent 笔记.md",
      "# Agent\n\n本文提到 langgraph。"
    );
    // IDF needs a corpus to be meaningful: "笔记" only stops dominating the
    // query once it appears in several other file names.
    const filler = [0, 1, 2, 3, 4, 5].flatMap((index) =>
      parseMarkdownIntoChunks(`daily/读书笔记${index}.md`, "# 摘要\n\n随便写点内容。")
    );

    const results = searchMarkdownChunks(
      [...fileNameMatch, ...contentOnlyMatch, ...filler],
      "整理LangGraph相关笔记"
    );

    expect(results[0]?.chunk.source.pathOrUrl).toBe("daily/LangGraph-checkpoint.md");
  });

  it("prioritizes different notes before returning extra chunks from one note", () => {
    const repeatedNote = parseMarkdownIntoChunks(
      "daily/LangGraph-状态.md",
      "# LangGraph\n\nLangGraph 基础。\n\n## 状态\n\nLangGraph 状态流转。\n\n## 节点\n\nLangGraph 节点执行。"
    );
    const secondNote = parseMarkdownIntoChunks(
      "daily/LangGraph-checkpoint.md",
      "# Checkpoint\n\nLangGraph 使用 checkpoint 保存执行状态。"
    );

    const results = searchMarkdownChunks([...repeatedNote, ...secondNote], "langgraph", 3);

    expect(new Set(results.slice(0, 2).map((result) => result.chunk.source.pathOrUrl))).toEqual(new Set([
      "daily/LangGraph-状态.md",
      "daily/LangGraph-checkpoint.md"
    ]));
  });

  it("indexes a Markdown file through refreshFile", async () => {
    const contents = new Map<string, string>([
      ["daily/LangGraph-checkpoint.md", "# Checkpoint\n\nLangGraph 状态恢复。"]
    ]);
    const index = new PortableMarkdownKnowledgeIndex(new MemoryKnowledgeRepository(contents));
    const policy = new PolicyEngine(createDefaultPermissionPolicy());

    await expect(index.refreshFile({
      path: "daily/LangGraph-checkpoint.md",
      extension: "md",
      mtime: 1,
      size: 0
    }, policy)).resolves.toBe(true);
    expect(index.search("langgraph")).toHaveLength(1);
  });

  it("ranks new content after re-indexing a note without a full rebuild", async () => {
    const contents = new Map<string, string>([["daily/甲.md", "# 甲\n\n内容一。"]]);
    const index = new PortableMarkdownKnowledgeIndex(new MemoryKnowledgeRepository(contents));
    const policy = new PolicyEngine(createDefaultPermissionPolicy());

    await index.rebuild(policy);
    index.refreshContent(
      { path: "daily/甲.md", extension: "md", mtime: 2, size: 0 },
      "# 甲\n\n新术语 zettelkasten。",
      policy
    );

    expect(index.search("zettelkasten")[0]?.chunk.source.pathOrUrl).toBe("daily/甲.md");
  });

  it("rebuilds from the repository and reports a summary", async () => {
    const contents = new Map<string, string>([
      ["daily/甲.md", "# 甲\n\n内容一。"],
      ["daily/乙.md", "# 乙\n\n内容二。"]
    ]);
    const index = new PortableMarkdownKnowledgeIndex(new MemoryKnowledgeRepository(contents));
    const policy = new PolicyEngine(createDefaultPermissionPolicy());

    const summary = await index.rebuild(policy);

    expect(summary.indexedFiles).toBe(2);
    expect(index.search("内容一")[0]?.chunk.source.pathOrUrl).toBe("daily/甲.md");
  });
});
