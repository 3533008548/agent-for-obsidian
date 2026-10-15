import { describe, expect, it } from "vitest";
import { hashTextBlocks } from "../core/domain/content-hash";
import { detectDesktopAgentIntent } from "../core/desktop/desktop-intent-router";
import { planIngest, renderIngestPlan } from "../core/wiki/ingest-plan";
import { decidePlacement } from "../core/wiki/topic-placement";
import type { LlmWikiRegistry } from "../core/wiki/llm-wiki-system";

const TOPIC_INDEX = "知识体系/Agent/LLM Wiki/LangGraph/概览.md";

function registry(): LlmWikiRegistry {
  return {
    version: 1,
    topics: [
      {
        id: "LangGraph",
        topic: "LangGraph",
        indexPath: TOPIC_INDEX,
        status: "fresh",
        updatedAt: "2026-10-02T00:00:00.000Z",
        sourceHashes: [
          { pathOrUrl: "daily/langgraph中的checkpoint.md", contentHash: "aaa", blockHashes: ["b1", "b2"] }
        ],
        pages: [
          {
            path: TOPIC_INDEX,
            title: "LangGraph 概览",
            summary: "状态流转与 checkpoint",
            aliases: [],
            links: [],
            sourcePaths: []
          },
          {
            path: "知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md",
            title: "N5-LangGraph 中的 checkpoint",
            summary: "checkpoint 持久化状态",
            aliases: [],
            links: [TOPIC_INDEX],
            sourcePaths: ["daily/langgraph中的checkpoint.md"]
          }
        ]
      }
    ],
    errorBook: []
  } as unknown as LlmWikiRegistry;
}

function registryWithHashes(blockHashes: string[]): LlmWikiRegistry {
  const base = registry();
  base.topics[0]!.sourceHashes[0] = {
    pathOrUrl: "daily/langgraph中的checkpoint.md",
    contentHash: "aaa",
    blockHashes
  };
  return base;
}

describe("intent routing for ingest", () => {
  it("routes a request to take in a note without naming a topic", () => {
    // The whole point: no topic required, so nothing has to be looked up first.
    for (const question of ["收录这篇笔记", "把它纳入 LLM Wiki", "并入知识库"]) {
      expect(detectDesktopAgentIntent({ question }).intent).toBe("ingest-note");
    }
  });

  it("routes the confirmation to the same place as the request", () => {
    // "确认收录" and "收录这篇" are two steps of one decision, so they share an
    // intent: a separate confirm intent would need its own state to look at, and
    // the plan is what that state would be.
    for (const question of ["确认收录", "执行纳入", "并入吧"]) {
      expect(detectDesktopAgentIntent({ question }).intent).toBe("ingest-note");
    }
  });

  it("routes a question about what is left", () => {
    expect(detectDesktopAgentIntent({ question: "还有哪些没收录" }).intent).toBe("list-uncompiled");
    expect(detectDesktopAgentIntent({ question: "列出未编译的笔记" }).intent).toBe("list-uncompiled");
  });

  it("still allows naming a topic when someone wants a full recompile", () => {
    const result = detectDesktopAgentIntent({ question: "编译 LangGraph LLM Wiki" });

    expect(result.intent).toBe("compile-wiki");
    expect(result.subject).toContain("LangGraph");
  });
});

describe("ingest plan", () => {
  it("says a new note will be added to the agreed topic", () => {
    const decision = decidePlacement({
      notePath: "daily/langgraph中的checkpoint.md",
      noteTitle: "langgraph中的checkpoint",
      noteText: "checkpoint 在 LangGraph 里持久化状态。",
      registry: registry(),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.9 }]
    });
    const plan = planIngest({
      notePath: decision.notePath,
      noteTitle: "langgraph中的checkpoint",
      decision,
      registry: registry(),
      sourceTexts: new Map()
    });

    expect(plan.action).toBe("update-topics");
    expect(plan.topics.map((topic) => topic.topicId)).toEqual(["LangGraph"]);
    expect(plan.compilesRequired).toBe(1);
  });

  it("stops and names both sides when the evidence disagrees", () => {
    const decision = decidePlacement({
      notePath: "daily/B树.md",
      noteTitle: "B树",
      noteText: "B 树是多路平衡查找树。",
      registry: registry(),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.9 }]
    });
    const plan = planIngest({
      notePath: decision.notePath,
      noteTitle: "B树",
      decision,
      registry: registry(),
      sourceTexts: new Map()
    });

    expect(plan.action).toBe("needs-decision");
    expect(plan.compilesRequired).toBe(0);
    expect(plan.disagreement?.modelSaid).toEqual(["LangGraph"]);
    // The plan never compiles on disagreement, however confident the model was.
    expect(renderIngestPlan(plan)).toContain("需要你决定");
  });

  it("reports an already-covered note as needing no compile", () => {
    // The registry recorded this note with the exact blocks it still has, so
    // there is nothing to recompile even though the note is on the agreed topic.
    const decision = decidePlacement({
      notePath: "daily/langgraph中的checkpoint.md",
      noteTitle: "langgraph中的checkpoint",
      noteText: "checkpoint 在 LangGraph 里持久化状态。",
      registry: registry(),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.9 }]
    });
    const unchanged = hashTextBlocks("checkpoint 在 LangGraph 里持久化状态。").blockHashes;
    const plan = planIngest({
      notePath: decision.notePath,
      noteTitle: "langgraph中的checkpoint",
      decision,
      registry: registryWithHashes(unchanged),
      sourceTexts: new Map([["daily/langgraph中的checkpoint.md", "checkpoint 在 LangGraph 里持久化状态。"]])
    });

    expect(plan.action).toBe("already-covered");
    expect(plan.compilesRequired).toBe(0);
    expect(plan.topics[0]!.firstTime).toBe(false);
  });

  it("recompiles when the note was edited after it was compiled", () => {
    // Same note, same topic, different content. Reporting "already covered" here
    // would leave the Wiki quietly describing an older version of the note.
    const decision = decidePlacement({
      notePath: "daily/langgraph中的checkpoint.md",
      noteTitle: "langgraph中的checkpoint",
      noteText: "checkpoint 在 LangGraph 里持久化状态。",
      registry: registry(),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.9 }]
    });
    const old = hashTextBlocks("## 早期版本\n\n旧内容。").blockHashes;
    const plan = planIngest({
      notePath: decision.notePath,
      noteTitle: "langgraph中的checkpoint",
      decision,
      registry: registryWithHashes(old),
      sourceTexts: new Map([
        ["daily/langgraph中的checkpoint.md", "checkpoint 在 LangGraph 里持久化状态。\n\n新增了一段。"]
      ])
    });

    expect(plan.action).toBe("update-topics");
    expect(plan.compilesRequired).toBe(1);
  });

  it("passes a proposed new topic through instead of creating it silently", () => {
    const decision = decidePlacement({
      notePath: "daily/PostgreSQL 索引.md",
      noteTitle: "PostgreSQL 的索引结构",
      noteText: "B-tree、GIN 与 BRIN 三种索引的选择。",
      registry: registry(),
      modelProposals: []
    });
    const plan = planIngest({
      notePath: decision.notePath,
      noteTitle: "PostgreSQL 的索引结构",
      decision,
      registry: registry(),
      sourceTexts: new Map(),
      proposedTopic: { name: "数据库索引", definition: "索引结构与选择", why: "笔记全部在讲索引" }
    });

    expect(plan.action).toBe("propose-topic");
    expect(plan.proposedTopic?.name).toBe("数据库索引");
    // Even a proposed topic is a proposal: the compile count stays at one and
    // the report is what the user reads before agreeing.
    expect(plan.compilesRequired).toBe(1);
    expect(renderIngestPlan(plan)).toContain("数据库索引");
  });

  it("tells the reader how many model calls the plan costs", () => {
    const decision = decidePlacement({
      notePath: "daily/langgraph中的checkpoint.md",
      noteTitle: "langgraph中的checkpoint",
      noteText: "checkpoint 持久化状态。",
      registry: registry(),
      modelProposals: [{ topicId: "LangGraph", confidence: 0.9 }]
    });
    const plan = planIngest({
      notePath: decision.notePath,
      noteTitle: "langgraph中的checkpoint",
      decision,
      registry: registry(),
      sourceTexts: new Map()
    });

    expect(renderIngestPlan(plan)).toContain("1 次模型编译");
  });
});
