import { describe, expect, it } from "vitest";
import { parseMarkdownIntoChunks } from "../src/indexing/markdown-parser";
import { searchMarkdownChunks } from "../src/indexing/markdown-search";

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
});
