import { describe, expect, it } from "vitest";
import { MarkdownBm25Corpus, tokenizeForSearch } from "../core/indexing/bm25";
import { parseMarkdownIntoChunks, type MarkdownChunk } from "../core/indexing/markdown-parser";
import { searchMarkdownChunks } from "../core/indexing/markdown-search";

function chunk(path: string, markdown: string, index = 0): MarkdownChunk {
  return parseMarkdownIntoChunks(path, markdown)[index];
}

describe("BM25 search scoring", () => {
  it("splits punctuation-separated words so hyphenated file names stay findable", () => {
    expect(tokenizeForSearch("LangGraph-checkpoint 状态")).toEqual([
      "langgraph",
      "checkpoint",
      "状态"
    ]);
  });

  it("discounts terms that appear in most chunks (IDF)", () => {
    // "笔记" is in many file names and therefore carries no information;
    // "langgraph" is in two chunks and should decide the ranking.
    const chunks = [
      chunk("daily/LangGraph-checkpoint.md", "# Checkpoint\n\n状态恢复与持久化。"),
      chunk("daily/其他 Agent 笔记.md", "# Agent\n\n本文提到 langgraph。"),
      ...[0, 1, 2, 3, 4, 5].map((index) =>
        chunk(`daily/读书笔记${index}.md`, "# 摘要\n\n随便写点内容。")
      )
    ];

    const results = searchMarkdownChunks(chunks, "整理LangGraph相关笔记");

    expect(results[0]?.chunk.source.pathOrUrl).toBe("daily/LangGraph-checkpoint.md");
  });

  it("stops a chatty note from outranking the note that answers the question", () => {
    // "是什么" repeats eight times per paragraph here and used to drown out the
    // actual answer under fixed per-hit weights. IDF discounts it once the
    // phrase is common across the workspace.
    const chunks = [
      chunk("notes/监督学习.md", "# 监督学习\n\n监督学习依赖带标签的数据。"),
      chunk("notes/杂谈.md", `# 杂谈\n\n${"知识是什么？记忆是什么？学习是什么？".repeat(8)}`),
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((index) =>
        chunk(`notes/杂记${index}.md`, "# 杂记\n\n今天在想效率是什么。")
      )
    ];

    const results = searchMarkdownChunks(chunks, "监督学习是什么", 2);

    expect(results[0]?.chunk.source.pathOrUrl).toBe("notes/监督学习.md");
  });

  it("saturates repeated terms instead of rewarding keyword stuffing", () => {
    const chunks = [
      chunk("notes/甲.md", "# 甲\n\nRedis 用于缓存。"),
      chunk("notes/乙.md", `# 乙\n\n${"Redis ".repeat(40)}`)
    ];
    const corpus = new MarkdownBm25Corpus(chunks);

    const once = corpus.score(chunks[0], ["redis"]);
    const repeated = corpus.score(chunks[1], ["redis"]);

    expect(repeated).toBeGreaterThan(once);
    expect(repeated).toBeLessThan(once * 3);
  });

  it("normalises chunk length so a single hit in a short chunk outranks one in a long chunk", () => {
    const chunks = [
      chunk("notes/短.md", "# 短\n\nRedis 用于缓存。"),
      chunk("notes/长.md", `# 长\n\n${"无关内容。".repeat(120)}\nRedis 也出现了。`)
    ];
    const corpus = new MarkdownBm25Corpus(chunks);

    expect(corpus.score(chunks[0], ["redis"]) ?? 0).toBeGreaterThan(
      corpus.score(chunks[1], ["redis"]) ?? 0
    );
  });

  it("weights file names above body text for the same single hit", () => {
    const chunks = [
      chunk("notes/Redis-缓存.md", "# 缓存\n\n过期策略与淘汰。"),
      chunk("notes/后端笔记.md", "# 后端\n\n用了 Redis 做缓存。")
    ];
    const corpus = new MarkdownBm25Corpus(chunks);

    expect(corpus.score(chunks[0], ["redis"])).toBeGreaterThan(
      corpus.score(chunks[1], ["redis"])
    );
  });

  it("gives a term found nowhere a zero IDF", () => {
    const corpus = new MarkdownBm25Corpus([chunk("notes/甲.md", "# 甲\n\n内容。")]);

    expect(corpus.idfOf("redis")).toBe(0);
    expect(corpus.documentCount).toBe(1);
  });
});
