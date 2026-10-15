import { describe, expect, it } from "vitest";
import type { LlmWikiRegistry } from "../core/wiki/llm-wiki-system";
import { candidateTerms, decidePlacement } from "../core/wiki/topic-placement";

const TOPIC_INDEX = "知识体系/Agent/LLM Wiki/LangGraph/概览.md";

function registry(pages: Array<{ title: string; summary: string }>): LlmWikiRegistry {
  return {
    version: 1,
    topics: [
      {
        id: "LangGraph",
        topic: "LangGraph",
        indexPath: TOPIC_INDEX,
        status: "fresh",
        updatedAt: "2026-10-02T00:00:00.000Z",
        sourceHashes: [],
        pages: pages.map((page) => ({
          path: `知识体系/Agent/LLM Wiki/LangGraph/概念/${page.title}.md`,
          title: page.title,
          summary: page.summary,
          aliases: [],
          links: [TOPIC_INDEX],
          sourcePaths: []
        }))
      }
    ],
    errorBook: []
  } as unknown as LlmWikiRegistry;
}

const LANGGRAPH_PAGES = [
  { title: "N5-LangGraph 中的 checkpoint", summary: "checkpoint 把状态持久化，支持时间旅行与恢复" },
  { title: "N3-LangGraph 的状态流转机制", summary: "状态如何在节点之间流转" }
];

describe("candidate terms", () => {
  it("drops words that cannot place a note", () => {
    // Every page in a technical library says "agent" and "llm". Left in, they
    // put any note into any topic.
    const terms = candidateTerms("Agent 开发岗位面试题库", "面试要点：agent 如何调用 llm 工具");

    expect(terms).not.toContain("agent");
    expect(terms).not.toContain("llm");
  });

  it("keeps the words that actually name a subject", () => {
    expect(candidateTerms("langgraph中的checkpoint", "…")).toContain("langgraph");
  });

  it("reads the title before the body", () => {
    // A term that only appears deep in the body would let a passing mention
    // carry a note into a topic it has nothing to do with. The single character
    // of "B 树" is not a fragment to be discarded — it is the subject, and the
    // body term that follows it can only break a tie.
    const terms = candidateTerms("B 树", "开头无关内容。" + "redis ".repeat(80) + "结尾");

    expect(terms[0]).toBe("树");
    expect(terms.indexOf("redis")).toBeGreaterThan(0);
  });

  it("leaves a question's own words out of its terms", () => {
    // "什么是 B 树" must be placed by 树, not by the interrogative.
    expect(candidateTerms("什么是B树", "B 树是一种多路平衡查找树。")).toEqual(["树"]);
  });
});

describe("decide placement", () => {
  it("acts when the model and the corpus agree", () => {
    const decision = decidePlacement({
      notePath: "daily/langgraph中的checkpoint.md",
      noteTitle: "langgraph中的checkpoint",
      noteText: "checkpoint 在 LangGraph 里持久化状态。",
      registry: registry(LANGGRAPH_PAGES),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.9 }]
    });

    expect(decision.verdict).toBe("existing");
    expect(decision.agreed.map((o) => o.topicId)).toEqual(["LangGraph"]);
  });

  it("stops when the model names a topic the corpus knows nothing about", () => {
    // The case the whole rule exists for: a fluent model answer with nothing
    // behind it. Acting on it would file a B-tree note under LangGraph.
    const decision = decidePlacement({
      notePath: "daily/B树.md",
      noteTitle: "B树",
      noteText: "B 树是多路平衡查找树，节点分裂与合并。",
      registry: registry(LANGGRAPH_PAGES),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.85 }]
    });

    expect(decision.verdict).toBe("undecided");
    expect(decision.unsupported).toEqual(["LangGraph"]);
    expect(decision.reason).toContain("证据不足");
  });

  it("stops when the corpus sees a fit the model did not name", () => {
    const decision = decidePlacement({
      notePath: "daily/langgraph的状态流转机制.md",
      noteTitle: "langgraph的状态流转机制",
      noteText: "状态在节点之间流转。",
      registry: registry(LANGGRAPH_PAGES),
      modelProposals: []
    });

    expect(decision.verdict).toBe("undecided");
    expect(decision.missed.map((o) => o.topicId)).toEqual(["LangGraph"]);
  });

  it("says a new topic is needed when nothing matches at all", () => {
    const decision = decidePlacement({
      notePath: "daily/PostgreSQL 索引.md",
      noteTitle: "PostgreSQL 的索引结构",
      noteText: "B-tree、GIN 与 BRIN 三种索引的选择。",
      registry: registry(LANGGRAPH_PAGES),
      modelProposals: []
    });

    expect(decision.verdict).toBe("needs-new-topic");
  });

  it("ignores a proposal for a topic that does not exist", () => {
    // A hallucinated topic id must not reach the registry as if it were real.
    const decision = decidePlacement({
      notePath: "daily/langgraph中的checkpoint.md",
      noteTitle: "langgraph中的checkpoint",
      noteText: "checkpoint 持久化状态。",
      registry: registry(LANGGRAPH_PAGES),
      modelProposals: [{ topicId: "不存在的���题", confidence: 0.99 }]
    });

    expect(decision.modelProposes).toEqual([]);
  });

  it("ranks a term appearing in page titles above one buried in a summary", () => {
    const decision = decidePlacement({
      notePath: "daily/checkpoint.md",
      noteTitle: "checkpoint",
      noteText: "…",
      registry: registry([
        { title: "N5-LangGraph 中的 checkpoint", summary: "关于状态" },
        { title: "概念 A", summary: "这里提到 checkpoint 与状态流转" },
        { title: "概念 B", summary: "checkpoint 的作用" },
        { title: "概念 C", summary: "checkpoint 的实现" }
      ]),
      modelProposals: []
    });

    const option = decision.corpusSupports.find((o) => o.topicId === "LangGraph");
    const titleHit = option!.evidence.find((e) => e.term === "checkpoint");
    expect(titleHit!.pageHits).toBeGreaterThan(1);
    expect(titleHit!.matchedInTitle).toEqual(["checkpoint"]);
  });
});
