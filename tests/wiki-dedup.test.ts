import { describe, expect, it } from "vitest";

import {
  createLlmWikiRegistry,
  findOverlappingWikiPages,
  stabilizeWikiNodeIds
} from "../core/wiki/llm-wiki-system";

import type { KnowledgeMapNode } from "../core/integration/knowledge-system";
import type { LlmWikiRegistry, LlmWikiTopicRecord } from "../core/wiki/llm-wiki-system";

function node(id: string, title: string): KnowledgeMapNode {
  return { id, title, summary: `${title} 的摘要`, sourceIds: ["S1"], priority: "high" };
}

function topicWithConceptPages(pages: Array<{ id: string; title: string }>): LlmWikiTopicRecord {
  return {
    id: "langgraph",
    topic: "LangGraph",
    indexPath: "知识体系/Agent/LLM Wiki/LangGraph/概览.md",
    status: "fresh",
    updatedAt: "2026-10-02T08:00:00.000Z",
    sourceHashes: [],
    pages: pages.map((page) => ({
      path: `知识体系/Agent/LLM Wiki/LangGraph/概念/${page.id}-${page.title}.md`,
      title: page.title,
      summary: `${page.title} 的摘要`,
      aliases: [],
      links: [],
      sourcePaths: ["daily/a.md"]
    }))
  };
}

describe("stabilizeWikiNodeIds", () => {
  it("re-adopts previous ids when the title differs only by spacing or punctuation", () => {
    const previous = topicWithConceptPages([
      { id: "N3", title: "LangGraph 的状态流转机制" },
      { id: "N4", title: "LangGraph 状态的数据类型" }
    ]);

    const stabilized = stabilizeWikiNodeIds([
      node("N1", "langgraph 的状态流转机制"),
      node("N2", "LangGraph 状态的数据类型。"),
      node("N5", "全新概念：多 Agent 编排")
    ], previous);

    expect(stabilized.map((item) => item.id)).toEqual(["N3", "N4", "N5"]);
    expect(stabilized[2]?.title).toBe("全新概念：多 Agent 编排");
  });

  it("keeps a re-worded title as a new node — wording is the prompt's job, not this matcher", () => {
    const previous = topicWithConceptPages([{ id: "N3", title: "LangGraph 的状态流转机制" }]);

    const stabilized = stabilizeWikiNodeIds([node("N1", "LangGraph 状态流转机制")], previous);

    expect(stabilized[0]?.id).toBe("N1");
  });

  it("keeps nodes untouched without a previous topic", () => {
    const nodes = [node("N1", "任意标题")];
    expect(stabilizeWikiNodeIds(nodes, undefined)).toBe(nodes);
  });

  it("does not let two nodes claim the same previous id", () => {
    const previous = topicWithConceptPages([{ id: "N2", title: "状态流转" }]);
    const stabilized = stabilizeWikiNodeIds([
      node("N1", "状态流转"),
      node("N9", "状态流转 机制")
    ], previous);

    expect(stabilized[0]?.id).toBe("N2");
    expect(stabilized[1]?.id).toBe("N9");
  });
});

function buildOverlapRegistry(): LlmWikiRegistry {
  const base = createLlmWikiRegistry();
  const makeTopic = (id: string, topic: string, pages: Array<{ title: string; summary: string }>): LlmWikiTopicRecord => ({
    id,
    topic,
    indexPath: `知识体系/Agent/LLM Wiki/${id}/概览.md`,
    status: "fresh",
    updatedAt: "2026-10-05T00:00:00.000Z",
    sourceHashes: [],
    pages: pages.map((page) => ({
      path: `知识体系/Agent/LLM Wiki/${id}/概念/N1-${page.title}.md`,
      title: page.title,
      summary: page.summary,
      aliases: [],
      links: [],
      sourcePaths: ["daily/a.md"]
    }))
  });
  return {
    ...base,
    topics: [
      makeTopic("langgraph", "LangGraph", [
        { title: "LangGraph 的状态流转机制", summary: "状态在节点与边之间流转，checkpoint 负责快照与恢复。" },
        { title: "LangGraph 状态流转机制", summary: "状态沿着图的边流转，checkpoint 做快照恢复。" },
        { title: "LangGraph 的绘图能力", summary: "用 Mermaid 输出图结构，支持可视化。" }
      ]),
      makeTopic("agentscope", "AgentScope", [
        { title: "AgentScope 消息中心", summary: "消息中心负责 Agent 间通信与流水线编排。" }
      ])
    ]
  };
}

describe("findOverlappingWikiPages", () => {
  it("pairs the re-worded duplicates and leaves distinct pages out", () => {
    const pairs = findOverlappingWikiPages(buildOverlapRegistry());

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const top = pairs[0]!;
    expect([top.aTitle, top.bTitle].sort()).toEqual(["LangGraph 的状态流转机制", "LangGraph 状态流转机制"].sort());
    expect(top.signals.length).toBeGreaterThan(0);
    expect(pairs.some((pair) => pair.aTitle === "LangGraph 的绘图能力")).toBe(false);
  });

  it("labels cross-topic pairs with both topic names", () => {
    const registry = buildOverlapRegistry();
    registry.topics[1]!.pages.push({
      path: "知识体系/Agent/LLM Wiki/agentscope/概念/N9-LangGraph 状态流转机制.md",
      title: "LangGraph 状态流转机制",
      summary: "状态沿着图的边流转，checkpoint 做快照恢复。",
      aliases: [],
      links: [],
      sourcePaths: []
    });

    const pairs = findOverlappingWikiPages(registry);
    expect(pairs.some((pair) => pair.topic === "LangGraph / AgentScope")).toBe(true);
  });
});
