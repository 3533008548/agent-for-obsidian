import { describe, expect, it } from "vitest";
import {
  compileLlmWikiTopic,
  createLlmWikiRegistry,
  getLinkedWikiPages,
  markLlmWikiSourceStale,
  searchLlmWiki,
  updateLlmWikiTopicSourceHealth
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

  it("keeps cumulative source coverage when an existing topic is expanded", () => {
    const first = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent");
    const expandedSession: KnowledgeIntegrationSession = {
      ...session,
      createdAt: "2026-09-04T01:00:00.000Z",
      sources: [
        {
          id: "S3",
          title: "中断恢复",
          content: "恢复机制保存执行状态。",
          source: { type: "note", pathOrUrl: "AI/LangGraph/恢复.md", locator: "heading=恢复", contentHash: "resume-hash", parserVersion: "markdown-v1" }
        }
      ],
      map: {
        overview: "LangGraph 可以保存并恢复执行状态。",
        nodes: [
          { id: "resume", title: "中断恢复", summary: "恢复机制保存执行状态。", sourceIds: ["S3"], priority: "medium" }
        ],
        conflicts: [],
        gaps: []
      }
    };
    const expanded = compileLlmWikiTopic(expandedSession, first.nextRegistry, "知识体系/Agent", {
      mode: "expand",
      coverageReport: { mode: "expand", added: 1, changed: 0, reused: 0, remainingCandidates: 2 }
    });
    const topic = expanded.nextRegistry.topics[0];

    expect(topic.sourceHashes).toEqual(expect.arrayContaining([
      { pathOrUrl: "AI/LangGraph/StateGraph.md", contentHash: "state-hash" },
      { pathOrUrl: "AI/LangGraph/恢复.md", contentHash: "resume-hash" }
    ]));
    expect(topic.coverage?.seenSourceHashes).toEqual(expect.arrayContaining([
      { pathOrUrl: "AI/LangGraph/StateGraph.md", contentHash: "state-hash" },
      { pathOrUrl: "AI/LangGraph/恢复.md", contentHash: "resume-hash" }
    ]));
    expect(topic.coverage?.lastReport?.remainingCandidates).toBe(2);
    expect(topic.pages.map((page) => page.title)).toEqual(expect.arrayContaining([
      "StateGraph",
      "Checkpoint",
      "中断恢复"
    ]));
  });

  it("marks a topic stale when a recorded local source is missing or changed", () => {
    const compilation = compileLlmWikiTopic(session, createLlmWikiRegistry(), "知识体系/Agent");
    const updated = updateLlmWikiTopicSourceHealth(compilation.nextRegistry, "LangGraph", [
      { pathOrUrl: "AI/LangGraph/StateGraph.md", status: "missing", checkedAt: "2026-09-04T02:00:00.000Z" },
      { pathOrUrl: "AI/LangGraph/持久化.md", status: "active", checkedAt: "2026-09-04T02:00:00.000Z" }
    ]);

    expect(updated.topics[0].status).toBe("stale");
    expect(updated.topics[0].sourceHealth?.[0].status).toBe("missing");
  });
});
