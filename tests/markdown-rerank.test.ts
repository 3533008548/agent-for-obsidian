import { describe, expect, it } from "vitest";
import { MarkdownBm25Corpus } from "../core/indexing/bm25";
import { parseMarkdownIntoChunks, type MarkdownChunk } from "../core/indexing/markdown-parser";
import { searchMarkdownChunks } from "../core/indexing/markdown-search";
import { extractLinkTitles, extractTags, rerankSearchResults } from "../core/indexing/search-rerank";

function chunk(path: string, markdown: string, index = 0): MarkdownChunk {
  return parseMarkdownIntoChunks(path, markdown)[index];
}

/** Filler notes so IDF has a corpus to work with. */
function filler(count: number): MarkdownChunk[] {
  return Array.from({ length: count }, (_value, index) =>
    chunk(`notes/杂记${index}.md`, "# 杂记\n\n随便写点内容，提到检索这个词。")
  );
}

describe("structured signal extraction", () => {
  it("reads frontmatter tags in both list forms", () => {
    expect(extractTags("---\ntags: [RAG, 检索]\n---\n\n正文。")).toEqual(["RAG", "检索"]);
    expect(extractTags("---\ntags:\n  - RAG\n  - 检索\n---\n\n正文。")).toEqual(["RAG", "检索"]);
  });

  it("reads inline tags but not headings or code comments", () => {
    const content = "# 标题不是标签\n\n正文 #检索 结束。\n\n```py\n# 这是代码注释\n```\n";
    expect(extractTags(content)).toEqual(["检索"]);
  });

  it("reads wikilink titles without alias or heading suffix", () => {
    expect(extractLinkTitles("见 [[RAG/向量检索#召回|召回章节]] 与 [[LangGraph]]。")).toEqual([
      "RAG/向量检索",
      "LangGraph"
    ]);
  });
});

describe("reranking with structured signals", () => {
  it("promotes a note whose tag matches the query over one that only mentions it", () => {
    const tagged = chunk("notes/工程/RAG.md", "---\ntags: [RAG]\n---\n\n# 笔记\n\n这里只提了一次 rag。");
    const untagged = chunk("notes/杂谈.md", "# 杂谈\n\nrag 出现了两次，rag 但没有标签。");

    const results = searchMarkdownChunks([tagged, untagged, ...filler(8)], "rag", 2);

    expect(results[0]?.chunk.source.pathOrUrl).toBe("notes/工程/RAG.md");
  });

  it("promotes a note that links to the queried concept", () => {
    const linked = chunk("notes/A.md", "# A\n\n参见 [[LangGraph]] 的实现。");
    const plain = chunk("notes/B.md", "# B\n\n正文提到 langgraph 两次，langgraph 但没有链接。");

    const results = searchMarkdownChunks([linked, plain, ...filler(8)], "langgraph", 2);

    expect(results[0]?.chunk.source.pathOrUrl).toBe("notes/A.md");
  });

  it("promotes notes filed under a folder named after the query", () => {
    // One mention inside the matching folder beats two mentions outside it.
    const inFolder = chunk("notes/LangGraph/状态.md", "# 状态\n\nlanggraph 只提一次。");
    const elsewhere = chunk("notes/其他.md", "# 其他\n\nlanggraph 提了两次，langgraph 但没有归类。");

    const results = searchMarkdownChunks([inFolder, elsewhere, ...filler(8)], "langgraph", 2);

    expect(results[0]?.chunk.source.pathOrUrl).toBe("notes/LangGraph/状态.md");
  });

  it("promotes chunks under an ancestor heading that matches the query", () => {
    const nested = parseMarkdownIntoChunks(
      "notes/架构.md",
      "# 架构\n\n## 缓存\n\n### 淘汰策略\n\n这里只说了一次 缓存。"
    );
    const flat = chunk("notes/杂谈.md", "# 杂谈\n\n缓存 缓存 缓存。");

    const results = searchMarkdownChunks([...nested, flat, ...filler(8)], "缓存", 2);

    expect(results[0]?.chunk.source.pathOrUrl).toBe("notes/架构.md");
  });

  it("boosts notes linked with the note the user is looking at", () => {
    const active = chunk("notes/当前.md", "# 当前\n\n继续 [[笔记/状态]] 这条线。");
    const linked = chunk("notes/笔记/状态.md", "# 状态\n\nlanggraph 只提一次。");
    const unrelated = chunk("notes/其他.md", "# 其他\n\nlanggraph 提了两次，langgraph 但没被链接。");
    const chunks = [active, linked, unrelated, ...filler(8)];

    const query = "langgraph";
    const corpus = new MarkdownBm25Corpus(chunks);
    const scoreOf = (results: ReturnType<typeof searchMarkdownChunks>, path: string): number =>
      results.find((result) => result.chunk.source.pathOrUrl === path)?.score ?? 0;
    const withoutContext = searchMarkdownChunks(chunks, query, 2, { corpus });
    const withContext = searchMarkdownChunks(chunks, query, 2, {
      corpus,
      activePath: "notes/当前.md"
    });

    expect(withContext[0]?.chunk.source.pathOrUrl).toBe("notes/笔记/状态.md");
    expect(scoreOf(withContext, "notes/笔记/状态.md")).toBeGreaterThan(
      scoreOf(withoutContext, "notes/笔记/状态.md")
    );
    // The note being viewed is not itself boosted: it is the question's context,
    // not an answer.
    expect(scoreOf(withContext, "notes/当前.md")).toBe(
      scoreOf(withoutContext, "notes/当前.md")
    );
  });

  it("scales signal boosts by how rare the matched term is", () => {
    // "rag" is in one note, "检索" is in all of them, so the same tag buys far
    // less relevance in the second case.
    const chunks = [
      chunk("notes/稀罕.md", "# 稀罕\n\nrag 只在这里出现。"),
      chunk("notes/常见.md", "# 常见\n\n检索 到处都是。"),
      ...filler(10)
    ];
    const corpus = new MarkdownBm25Corpus(chunks);
    const boostFor = (path: string, tag: string, term: string): number =>
      rerankSearchResults(
        [{ chunk: chunk(path, `# 正文\n\n${term} 一次。\n\n#${tag}`), score: 0, excerpt: "" }],
        [term],
        { corpus }
      )[0].score;

    const rareTag = boostFor("notes/甲.md", "rag", "rag");
    const commonTag = boostFor("notes/乙.md", "检索", "检索");

    expect(rareTag).toBeGreaterThan(0);
    expect(commonTag).toBeGreaterThan(0);
    expect(rareTag).toBeGreaterThan(commonTag * 3);
  });
});
