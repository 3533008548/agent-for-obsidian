import { describe, expect, it } from "vitest";
import { composeWikiNodeDrafts } from "../core/desktop/desktop-wiki-service";
import type {
  KnowledgeIntegrationSession,
  KnowledgeNodeDraft
} from "../core/integration/knowledge-system";
import { compileLlmWikiTopic, createLlmWikiRegistry } from "../core/wiki/llm-wiki-system";

function sessionWith(nodes: KnowledgeIntegrationSession["map"]["nodes"]): KnowledgeIntegrationSession {
  return {
    id: "session-1",
    topic: "LangGraph",
    scopeLabel: "搜索结果：LangGraph",
    createdAt: "2026-09-03T01:00:00.000Z",
    sources: [
      {
        id: "S1",
        title: "StateGraph",
        content: "StateGraph 使用共享状态。",
        source: { type: "note", pathOrUrl: "AI/LangGraph/StateGraph.md", locator: "heading=StateGraph", contentHash: "state-hash", parserVersion: "markdown-v1" }
      },
      {
        id: "S2",
        title: "持久化",
        content: "Checkpoint 保存状态。",
        source: { type: "note", pathOrUrl: "AI/LangGraph/持久化.md", locator: "heading=Checkpoint", contentHash: "checkpoint-hash", parserVersion: "markdown-v1" }
      }
    ],
    map: {
      overview: "LangGraph 用状态图组织工作流。",
      nodes,
      conflicts: [],
      gaps: []
    }
  };
}

function draft(title: string): KnowledgeNodeDraft {
  return {
    title,
    content: `${title} 的正文：把两条资料揉成一节有论证的文字。`,
    sourceIds: ["S1"],
    conflicts: ["两篇资料对默认值的说法不一致。"],
    gaps: ["没有覆盖并发分支的取舍。"]
  };
}

describe("wiki concept page bodies", () => {
  it("uses a composed draft instead of the knowledge-map summary", () => {
    const session = sessionWith([
      { id: "state", title: "StateGraph", summary: "StateGraph 是状态图入口。", sourceIds: ["S1"], priority: "high" }
    ]);
    const compilation = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent", {
      nodeDrafts: new Map([["state", draft("StateGraph")]])
    });

    const page = compilation.pages.find((page) => page.title === "StateGraph")!;
    expect(page.content).toContain("把两条资料揉成一节有论证的文字。");
    expect(page.content).toContain("## 资料间差异或冲突");
    expect(page.content).toContain("两篇资料对默认值的说法不一致。");
    expect(page.content).toContain("## 待补充");
    // Navigation text stays the summary: a page body is not an index blurb.
    expect(page.summary).toBe("StateGraph 是状态图入口。");
  });

  it("falls back to the summary when the node has no draft", () => {
    const session = sessionWith([
      { id: "state", title: "StateGraph", summary: "StateGraph 是状态图入口。", sourceIds: ["S1"], priority: "high" },
      { id: "checkpoint", title: "Checkpoint", summary: "Checkpoint 用于持久化状态。", sourceIds: ["S2"], priority: "medium" }
    ]);
    const compilation = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent", {
      nodeDrafts: new Map([["state", draft("StateGraph")]])
    });

    const written = compilation.pages.find((page) => page.title === "StateGraph")!;
    const outlined = compilation.pages.find((page) => page.title === "Checkpoint")!;
    expect(written.content).toContain("## 资料间差异或冲突");
    expect(outlined.content).toContain("Checkpoint 用于持久化状态。");
    expect(outlined.content).not.toContain("## 资料间差异或冲突");
  });

  it("keeps the original evidence section regardless of the body", () => {
    const session = sessionWith([
      { id: "state", title: "StateGraph", summary: "摘要。", sourceIds: ["S1", "S2"], priority: "high" }
    ]);
    const compilation = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent", {
      nodeDrafts: new Map([["state", draft("StateGraph")]])
    });

    const page = compilation.pages.find((page) => page.title === "StateGraph")!;
    expect(page.content).toContain("## 原始证据");
    expect(page.content).toContain("AI/LangGraph/StateGraph.md");
    expect(page.content).toContain("AI/LangGraph/持久化.md");
  });
});

describe("composeWikiNodeDrafts", () => {
  const nodes = [
    { id: "a", title: "A", summary: "a", sourceIds: ["S1"], priority: "high" as const },
    { id: "b", title: "B", summary: "b", sourceIds: ["S2"], priority: "medium" as const },
    { id: "c", title: "C", summary: "c", sourceIds: [], priority: "low" as const }
  ];

  it("writes one draft per node that has evidence", async () => {
    const result = await composeWikiNodeDrafts(async (node) => draft(node.title), sessionWith(nodes));

    expect([...result.drafts.keys()].sort()).toEqual(["a", "b"]);
    expect(result.fallbackNodes).toEqual([]);
  });

  it("keeps the summary for a node whose writing failed instead of failing the batch", async () => {
    const result = await composeWikiNodeDrafts(async (node) => {
      if (node.id === "b") {
        throw new Error("模型返回了无法解析的内容。");
      }
      return draft(node.title);
    }, sessionWith(nodes));

    expect([...result.drafts.keys()]).toEqual(["a"]);
    expect(result.fallbackNodes).toEqual(["B"]);
  });

  it("caps how many nodes it is willing to write", async () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({
      id: `n${index}`,
      title: `N${index}`,
      summary: "s",
      sourceIds: ["S1"],
      priority: "medium" as const
    }));
    const result = await composeWikiNodeDrafts(async (node) => draft(node.title), sessionWith(many), 4);

    expect(result.drafts.size).toBe(4);
  });
});
