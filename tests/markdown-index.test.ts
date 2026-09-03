import { describe, expect, it } from "vitest";
import type { TFile, Vault } from "obsidian";
import { MarkdownKnowledgeIndex } from "../src/indexing/markdown-knowledge-index";
import { parseMarkdownIntoChunks } from "../src/indexing/markdown-parser";
import { searchMarkdownChunks } from "../src/indexing/markdown-search";
import { createDefaultPermissionPolicy, PolicyEngine } from "../src/policy/policy-engine";

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

    const results = searchMarkdownChunks(
      [...fileNameMatch, ...contentOnlyMatch],
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

  it("indexes a newly created Markdown file through refreshFile", async () => {
    const contents = new Map<string, string>([
      ["daily/LangGraph-checkpoint.md", "# Checkpoint\n\nLangGraph 状态恢复。"]
    ]);
    const vault = {
      getMarkdownFiles: () => [],
      read: async (file: TFile) => contents.get(file.path) ?? ""
    } as unknown as Vault;
    const index = new MarkdownKnowledgeIndex(vault);
    const policy = new PolicyEngine(createDefaultPermissionPolicy());
    const file = {
      path: "daily/LangGraph-checkpoint.md",
      extension: "md"
    } as TFile;

    await expect(index.refreshFile(file, policy)).resolves.toBe(true);
    expect(index.search("langgraph")).toHaveLength(1);
  });
});
