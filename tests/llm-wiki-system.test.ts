import { describe, expect, it } from "vitest";
import {
  compileLlmWikiTopic,
  createLlmWikiRegistry,
  getLinkedWikiPages,
  markLlmWikiSourceStale,
  searchLlmWiki
} from "../src/wiki/llm-wiki-system";
import type { KnowledgeIntegrationSession } from "../src/integration/knowledge-system";

const session: KnowledgeIntegrationSession = {
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
    nodes: [
      { id: "state", title: "StateGraph", summary: "StateGraph 是状态图入口。", sourceIds: ["S1"], priority: "high" },
      { id: "checkpoint", title: "Checkpoint", summary: "Checkpoint 用于持久化状态。", sourceIds: ["S1", "S2"], priority: "medium" }
    ],
    conflicts: [],
    gaps: []
  }
};

describe("LLM Wiki system", () => {
  it("compiles a topic index, concept pages, global index and Error Book", () => {
    const compilation = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent");
    expect(compilation.pages.map((page) => page.relativePath)).toEqual(expect.arrayContaining([
      "LLM Wiki/index.md",
      "LLM Wiki/LangGraph/概览.md",
      "LLM Wiki/LangGraph/概念/state-StateGraph.md",
      "LLM Wiki/_system/Error Book.md"
    ]));
    const statePage = compilation.pages.find((page) => page.title === "StateGraph")!;
    expect(statePage.content).toContain("[[知识体系/Agent/LLM Wiki/LangGraph/概览.md|LangGraph]]");
    expect(statePage.content).toContain("[[AI/LangGraph/StateGraph.md|StateGraph]]");
    expect(compilation.nextRegistry.topics[0].status).toBe("fresh");
    expect(compilation.nextRegistry.errorBook).toEqual([]);
  });

  it("searches compiled pages, follows explicit links, and marks only dependent topics stale", () => {
    const compilation = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent");
    const found = searchLlmWiki(compilation.nextRegistry, "Checkpoint");
    expect(found[0].page.title).toBe("Checkpoint");
    const linked = getLinkedWikiPages(compilation.nextRegistry, found.map((result) => result.page));
    expect(linked.map((page) => page.title)).toContain("LangGraph · LLM Wiki");

    const stale = markLlmWikiSourceStale(compilation.nextRegistry, "AI/LangGraph/StateGraph.md", "2026-09-03T02:00:00.000Z");
    expect(stale.topics[0].status).toBe("stale");
    expect(stale.errorBook.some((error) => error.type === "source-stale" && error.status === "open")).toBe(true);
  });
});
