import { describe, expect, it } from "vitest";
import { parseMarkdownIntoChunks } from "../core/indexing/markdown-parser";
import { batchNoteDigests, buildNoteDigests, renderNoteDigest } from "../core/indexing/note-survey";
import {
  buildAssignmentMessages,
  buildOverviewMessages,
  buildTopicProposalMessages,
  parseNoteAssignments,
  parseOverview,
  parseTopicProposals,
  renderTopicMapMarkdown,
  type TopicMapTopic
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
  it("parses proposals and drops paths the model invented", () => {
    const proposals = parseTopicProposals(
      JSON.stringify({
        topics: [
          {
            name: "LangGraph",
            definition: "LangGraph 的状态图与持久化机制",
            parent: "Agent 工程",
            paths: ["AI/LangGraph/StateGraph.md", "AI/不存在的笔记.md"]
          },
          { name: "Agent 工程", definition: "Agent 框架与工程实践", paths: ["AI/LangGraph/持久化.md"] }
        ]
      }),
      new Set(["AI/LangGraph/StateGraph.md", "AI/LangGraph/持久化.md"])
    );

    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.paths).toEqual(["AI/LangGraph/StateGraph.md"]);
    // parent 按名称解析成 id，跨批次才能折叠小主题
    expect(proposals[0]?.parentId).toBe(proposals[1]?.id);
  });

  it("rejects a response with no topics", () => {
    expect(() => parseTopicProposals('{"topics":[]}', new Set())).toThrow();
    expect(() => parseTopicProposals("不是 JSON", new Set())).toThrow();
  });

  it("assigns notes only to topics that exist", () => {
    const votes = parseNoteAssignments(
      JSON.stringify({
        assignments: [
          { path: "AI/LangGraph/StateGraph.md", topicId: "langgraph", confidence: 0.9 },
          { path: "AI/LangGraph/持久化.md", topicId: "编造的主题", confidence: 0.9 },
          { path: "AI/不存在的笔记.md", topicId: "langgraph", confidence: 0.9 },
          { path: "读书/卡片笔记.md", topicId: "unclassified", confidence: 0.2 }
        ]
      }),
      new Set(["AI/LangGraph/StateGraph.md", "AI/LangGraph/持久化.md", "读书/卡片笔记.md"]),
      new Set(["langgraph"])
    );

    expect(votes.map((vote) => vote.path)).toEqual(["AI/LangGraph/StateGraph.md", "读书/卡片笔记.md"]);
    expect(votes[1]?.topicId).toBe("unclassified");
  });

  it("parses the overview", () => {
    expect(parseOverview('{"overview":"这个库集中在 Agent 工程。"}')).toContain("Agent 工程");
    expect(() => parseOverview("不是 JSON")).toThrow();
  });

  it("renders a map that links to every note it groups", () => {
    const topics: TopicMapTopic[] = [{
      id: "langgraph",
      name: "LangGraph",
      definition: "状态图与持久化。",
      paths: ["AI/LangGraph/StateGraph.md", "AI/LangGraph/持久化.md"],
      secondary: [{ path: "AI/LangGraph/持久化.md", topicName: "Agent 工程" }]
    }];
    const markdown = renderTopicMapMarkdown(
      { overview: "整体观察。", topics, unclassified: ["读书/索引.md"], sparse: [] },
      "2026-09-29T10:00:00.000Z"
    );

    expect(markdown).toContain("# 知识库地图");
    expect(markdown).toContain("| LangGraph | 2 | [[AI/LangGraph/StateGraph.md]] |");
    expect(markdown).toContain("- [[AI/LangGraph/持久化.md]]（另见：Agent 工程）");
    // 覆盖全量，不再只列代表笔记
    expect(markdown).toContain("- [[AI/LangGraph/StateGraph.md]]");
    expect(markdown).toContain("### 未归类");
    expect(markdown).toContain("generatedAt: 2026-09-29T10:00:00.000Z");
  });

  it("tells the model to group by judgement, not by keyword", () => {
    const digests = buildNoteDigests(LIBRARY);
    const proposal = buildTopicProposalMessages(digests, ["LangGraph"]).map((message) => message.content).join("\n");
    expect(proposal).toContain("AI/LangGraph/StateGraph.md");
    expect(proposal).toContain("不要按专有名词分组");
    expect(proposal).toContain("已有主题");

    const assignment = buildAssignmentMessages(
      [{ id: "langgraph", name: "LangGraph", definition: "状态图与持久化。" }],
      digests
    ).map((message) => message.content).join("\n");
    expect(assignment).toContain("id: langgraph");
    expect(assignment).toContain("Redis 事件流 TTL");

    const overview = buildOverviewMessages([{ name: "LangGraph", count: 2, samples: ["StateGraph"] }], 4)
      .map((message: { content: string }) => message.content).join("\n");
    expect(overview).toContain("LangGraph：2 篇");
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
