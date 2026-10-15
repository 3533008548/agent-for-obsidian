import { describe, expect, it } from "vitest";
import { buildWikiIndex, describeWikiPlan, isNavigationalPage, planAnswerSources } from "../core/wiki/wiki-retrieval";
import type { LlmWikiRegistry } from "../core/wiki/llm-wiki-system";
import type { MarkdownSearchResult } from "../core/indexing/markdown-search";
import type { MarkdownChunk } from "../core/indexing/markdown-parser";

const TOPIC_INDEX = "知识体系/Agent/LLM Wiki/LangGraph/概览.md";
const SOURCE = "daily/langgraph中的checkpoint.md";

function page(path: string, title: string, sourcePaths: string[] = []): {
  path: string;
  title: string;
  summary: string;
  aliases: string[];
  links: string[];
  sourcePaths: string[];
} {
  return { path, title, summary: `${title} 的说明`, aliases: [], links: [TOPIC_INDEX], sourcePaths };
}

function registry(pageTitles: string[] = ["N5-LangGraph 中的 checkpoint"]): LlmWikiRegistry {
  return {
    version: 1,
    topics: [
      {
        id: "LangGraph",
        topic: "LangGraph",
        indexPath: TOPIC_INDEX,
        status: "fresh",
        updatedAt: "2026-10-02T00:00:00.000Z",
        sourceHashes: [{ pathOrUrl: SOURCE, contentHash: "h1" }],
        pages: [
          page(TOPIC_INDEX, "LangGraph · LLM Wiki", [SOURCE]),
          ...pageTitles.map((title) =>
            page(`知识体系/Agent/LLM Wiki/LangGraph/概念/${title}.md`, title, [SOURCE])
          )
        ]
      }
    ],
    errorBook: []
  } as unknown as LlmWikiRegistry;
}

function result(path: string, score: number, heading = "小节"): MarkdownSearchResult {
  const chunk = {
    source: { pathOrUrl: path, locator: `${path}::heading=小节&chunk=1` },
    content: `${path} 的正文`,
    heading,
    startLine: 1,
    endLine: 2
  } as unknown as MarkdownChunk;
  return { chunk, score, excerpt: chunk.content };
}

const PLAN = {
  maxSources: 6,
  expansionPerSource: 2,
  maxSeeds: 3
};

describe("wiki index", () => {
  it("maps a source note to the topics that took it in", () => {
    const index = buildWikiIndex(registry());

    expect(index.topicsBySource.get(SOURCE)).toEqual(new Set(["LangGraph"]));
    expect(index.topicByPage.get(TOPIC_INDEX)).toBe("LangGraph");
  });

  it("knows a page that lists sources cannot answer on its own", () => {
    // Measured: "Agent 工具调用为什么会死循环" was served a page listing which
    // files the topic was compiled from, three times over.
    expect(
      isNavigationalPage("知识体系/Agent/LLM Wiki/LangGraph/概念/N8-相关资料索引与出处.md")
    ).toBe(true);
  });

  it("treats the system folder and the map as navigation too", () => {
    // Neither is registered as a page, so a registry-only rule let them through
    // as if they were notes — and they score well because they name every topic.
    expect(isNavigationalPage("知识体系/Agent/LLM Wiki/_system/主题表.md")).toBe(true);
    expect(isNavigationalPage("知识体系/Agent/LLM Wiki/知识库地图.md")).toBe(true);
  });

  it("leaves a concept page alone", () => {
    expect(isNavigationalPage("知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md")).toBe(false);
    expect(isNavigationalPage("daily/B树.md")).toBe(false);
  });
});

describe("plan answer sources", () => {
  it("lets a compiled page lead the notes it was written from", () => {
    // The case this whole layer exists for: both were in the result list, so the
    // model was handed one piece of material twice inside a six-source budget.
    const wikiPage = "知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md";
    const plan = planAnswerSources({
      ...PLAN,
      registry: registry(),
      results: [result(wikiPage, 20), result(SOURCE, 19), result("daily/其他.md", 5)]
    });

    expect(plan.sources[0]!.kind).toBe("wiki-page");
    expect(plan.sources.map((source) => source.path)).not.toContain(SOURCE);
    expect(plan.displacedByWiki.map((item) => item.path)).toContain(SOURCE);
    expect(plan.wikiLed).toBe(true);
  });

  it("keeps a note when the only page for its topic is a list", () => {
    // A topic whose page here is its own index has not been covered, so the
    // note is the better answer and keeps its slot.
    const indexPage = "知识体系/Agent/LLM Wiki/LangGraph/概念/N8-相关资料索引与出处.md";
    const plan = planAnswerSources({
      ...PLAN,
      registry: registry(["N8-相关资料索引与出处"]),
      results: [result(indexPage, 20), result(SOURCE, 19)]
    });

    expect(plan.promotedPages).toEqual([]);
    expect(plan.sources.map((source) => source.path)).toContain(SOURCE);
  });

  it("never lets a navigation page reach the model", () => {
    const plan = planAnswerSources({
      ...PLAN,
      registry: registry(),
      results: [
        result("知识体系/Agent/LLM Wiki/_system/主题表.md", 20),
        result("知识体系/Agent/LLM Wiki/知识库地图.md", 19),
        result(SOURCE, 18)
      ]
    });

    expect(plan.sources.map((source) => source.path)).toEqual([SOURCE]);
  });

  it("gives a page one slot however many of its sections matched", () => {
    // Measured: a single note filled three of six slots with its own sections.
    const wikiPage = "知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md";
    const plan = planAnswerSources({
      ...PLAN,
      registry: registry(),
      results: [
        result(wikiPage, 20, "第一节"),
        result(wikiPage, 19, "第二节"),
        result(wikiPage, 18, "第三节")
      ]
    });

    expect(plan.sources).toHaveLength(1);
  });

  it("fills the slots it frees with material about the question", () => {
    const wikiPage = "知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md";
    const plan = planAnswerSources({
      ...PLAN,
      registry: registry(),
      results: [
        result(wikiPage, 25.7),
        result(SOURCE, 25.5),
        result("daily/langgraph的状态流转机制.md", 24.9),
        result("daily/对话历史.md", 24.4)
      ]
    });

    // The note that gave up its slot is replaced, not lost, and the budget is
    // still spent on this subject. Scores are close together on purpose: a
    // break in the list would (correctly) stop the fill, which is the rule the
    // next test covers.
    expect(plan.sources).toHaveLength(3);
    expect(plan.sources.map((source) => source.path)).toContain("daily/对话历史.md");
    expect(plan.sources.map((source) => source.path)).not.toContain(SOURCE);
  });

  it("stops at the break instead of filling with another subject", () => {
    // Measured: 25.7, 25.6, then a shelf at 13.9 where a note about HTTP status
    // codes sat next to ones about chunking. Below the break is off-topic.
    const wikiPage = "知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md";
    const plan = planAnswerSources({
      ...PLAN,
      registry: registry(),
      results: [
        result(wikiPage, 25.7),
        result(SOURCE, 25.5),
        result("daily/描述RAG全流程.md", 13.9),
        result("daily/HTTP 状态码.md", 13.0),
        result("daily/http 与 https.md", 12.7)
      ]
    });

    const paths = plan.sources.map((source) => source.path);
    expect(paths).not.toContain("daily/HTTP 状态码.md");
    expect(paths).not.toContain("daily/http 与 https.md");
  });

  it("does nothing at all when no topic has been compiled", () => {
    const plan = planAnswerSources({
      ...PLAN,
      registry: { version: 1, topics: [], errorBook: [] } as unknown as LlmWikiRegistry,
      results: [result("daily/B树.md", 20), result("daily/什么是B树.md", 18)]
    });

    expect(plan.wikiLed).toBe(false);
    expect(plan.sources.every((source) => source.kind === "note")).toBe(true);
  });

  it("says what it did, and nothing when it did nothing", () => {
    const wikiPage = "知识体系/Agent/LLM Wiki/LangGraph/概念/N5-LangGraph 中的 checkpoint.md";
    const led = planAnswerSources({ ...PLAN, registry: registry(), results: [result(wikiPage, 20), result(SOURCE, 19)] });
    const idle = planAnswerSources({ ...PLAN, registry: registry(), results: [result("daily/B树.md", 20)] });

    expect(describeWikiPlan(led)).toContain("LLM Wiki");
    expect(describeWikiPlan(idle)).toBe("");
  });
});
