import { describe, expect, it } from "vitest";
import { parseMarkdownIntoChunks } from "../core/indexing/markdown-parser";
import { batchNoteDigests, buildNoteDigests, renderNoteDigest } from "../core/indexing/note-survey";
import {
  buildClusterMessages,
  buildMergeMessages,
  parseTopicClusters,
  parseTopicSurveyPlan,
  renderTopicMapMarkdown
} from "../core/wiki/topic-discovery";
import { detectDesktopAgentIntent } from "../core/desktop/desktop-intent-router";

const LIBRARY = [
  parseMarkdownIntoChunks("AI/LangGraph/StateGraph.md", "---\ntags: [LangGraph]\n---\n\n# StateGraph\n\nStateGraph 用共享状态串联节点。"),
  parseMarkdownIntoChunks("AI/LangGraph/持久化.md", "# Checkpoint\n\nCheckpoint 保存每一步状态 [[StateGraph]]。"),
  parseMarkdownIntoChunks("读书/卡片笔记.md", "# 卡片笔记\n\n卢曼的卡片盒方法 #笔记法。"),
  parseMarkdownIntoChunks("读书/索引.md", "# 索引\n\n索引是卡片盒的入口。")
].flat();

describe("note digests", () => {
  it("collapses chunks into one digest per note", () => {
    const digests = buildNoteDigests(LIBRARY);

    expect(new Set(digests.map((digest) => digest.path))).toEqual(new Set([
      "AI/LangGraph/StateGraph.md",
      "AI/LangGraph/持久化.md",
      "读书/卡片笔记.md",
      "读书/索引.md"
    ]));
    const stateGraph = digests.find((digest) => digest.path === "AI/LangGraph/StateGraph.md");
    const checkpoint = digests.find((digest) => digest.path === "AI/LangGraph/持久化.md");
    expect(stateGraph?.title).toBe("StateGraph");
    expect(stateGraph?.tags).toContain("LangGraph");
    expect(checkpoint?.links).toContain("StateGraph");
  });

  it("does not let a frontmatter-only chunk become the note description", () => {
    const digests = buildNoteDigests(LIBRARY);
    const tagged = digests.find((digest) => digest.path === "AI/LangGraph/StateGraph.md");

    expect(tagged?.excerpt).toContain("StateGraph 用共享状态串联节点。");
    expect(tagged?.excerpt).not.toContain("tags");
  });

  it("falls back to the file name when no heading exists", () => {
    const digests = buildNoteDigests(
      parseMarkdownIntoChunks("杂项/随手记.md", "没有标题的一段话。")
    );

    expect(digests[0]?.title).toBe("随手记");
  });

  it("renders one compact line per note", () => {
    const line = renderNoteDigest({
      path: "a/b.md",
      title: "标题",
      tags: ["标签"],
      links: [],
      excerpt: "摘要"
    });

    expect(line.startsWith("- 路径：a/b.md")).toBe(true);
    expect(line).toContain("标题：标题");
    expect(line).not.toContain("链接：");
  });

  it("batches digests request-sized", () => {
    const digests = buildNoteDigests(LIBRARY);
    expect(batchNoteDigests(digests, 3).map((batch) => batch.length)).toEqual([3, 1]);
  });
});

describe("topic discovery parsing", () => {
  it("parses clusters and drops paths the model invented", () => {
    const clusters = parseTopicClusters(
      JSON.stringify({
        clusters: [
          { label: "LangGraph", paths: ["AI/LangGraph/StateGraph.md", "AI/不存在的笔记.md"] }
        ]
      }),
      new Set(["AI/LangGraph/StateGraph.md"])
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.paths).toEqual(["AI/LangGraph/StateGraph.md"]);
  });

  it("rejects a response with no clusters", () => {
    expect(() => parseTopicClusters('{"clusters":[]}', new Set())).toThrow();
    expect(() => parseTopicClusters("不是 JSON", new Set())).toThrow();
  });

  it("parses the merged plan", () => {
    const plan = parseTopicSurveyPlan(
      JSON.stringify({
        overview: "这个库集中在 Agent 工程与笔记法。",
        topics: [
          { name: "LangGraph", summary: "状态图与持久化。", paths: ["AI/LangGraph/StateGraph.md"] },
          { name: "卡片笔记", summary: "卢曼的方法。", paths: ["读书/卡片笔记.md"] }
        ]
      }),
      new Set(["AI/LangGraph/StateGraph.md", "读书/卡片笔记.md"])
    );

    expect(plan.topics.map((topic) => topic.name)).toEqual(["LangGraph", "卡片笔记"]);
    expect(plan.overview).toContain("Agent 工程");
  });

  it("fails when every topic was filtered out", () => {
    expect(() =>
      parseTopicSurveyPlan(
        '{"overview":"x","topics":[{"name":"空","summary":"s","paths":["没有/这篇.md"]}]}',
        new Set()
      )
    ).toThrow();
  });

  it("renders a map that links to the notes it groups", () => {
    const markdown = renderTopicMapMarkdown(
      {
        overview: "整体观察。",
        topics: [{ name: "LangGraph", summary: "状态图与持久化。", paths: ["AI/LangGraph/StateGraph.md"] }]
      },
      "2026-09-29T10:00:00.000Z"
    );

    expect(markdown).toContain("# 知识库地图");
    expect(markdown).toContain("| LangGraph | 1 | [[AI/LangGraph/StateGraph.md]] |");
    expect(markdown).toContain("- [[AI/LangGraph/StateGraph.md]]");
    expect(markdown).toContain("generatedAt: 2026-09-29T10:00:00.000Z");
  });

  it("keeps note paths out of the instructions that reach the model", () => {
    const stateGraph = buildNoteDigests(LIBRARY).find(
      (digest) => digest.path === "AI/LangGraph/StateGraph.md"
    )!;
    const prompt = buildClusterMessages([stateGraph]).map((message) => message.content).join("\n");
    expect(prompt).toContain("AI/LangGraph/StateGraph.md");
    expect(prompt).toContain("不能虚构笔记");
    expect(buildMergeMessages([{ label: "LangGraph", paths: ["AI/LangGraph/StateGraph.md"] }])[0]?.content)
      .toContain("候选主题");
  });
});

describe("topic survey intent", () => {
  it("routes a library-wide survey", () => {
    for (const question of ["梳理知识库", "帮我划分一下知识库主题", "绘制知识地图", "盘点笔记库"]) {
      expect(detectDesktopAgentIntent({ question })).toEqual({ intent: "survey-wiki" });
    }
  });

  it("does not mistake clipboard formatting for a survey", () => {
    expect(detectDesktopAgentIntent({ question: "整理剪贴板里的表格格式" })).toMatchObject({
      intent: "format-clipboard"
    });
  });
});
