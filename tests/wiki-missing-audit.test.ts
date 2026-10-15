import { describe, expect, it } from "vitest";

import {
  patchWikiPageForMissingSources,
  pruneMissingWikiSources,
  type LlmWikiRegistry
} from "../core/wiki/llm-wiki-system";

function buildPage(): string {
  return [
    "---",
    "agent-created: true",
    "---",
    "",
    "# LangGraph 的状态流转机制",
    "",
    `<!-- knowledge-loop-agent:llm-wiki`,
    `{"version":2,"kind":"concept","topic":"LangGraph","links":["知识体系/Agent/LLM Wiki/LangGraph/概览.md"],"sources":[{"path":"daily/alive.md","hash":"aaaa1111"},{"path":"daily/deleted.md","hash":"bbbb2222"}],"updatedAt":"2026-10-02T08:28:52.152Z"}`,
    `-->`,
    "> [!info] 概念页 · LangGraph",
    "> 返回主题：[[知识体系/Agent/LLM Wiki/LangGraph/概览.md|LangGraph]]",
    "",
    "## 核心说明",
    "",
    "状态在图中按边流转。[S1]",
    "",
    "## 待补充",
    "",
    "- 缺少 reduce/聚合函数的说明",
    "",
    "## 关联概念",
    "",
    "- [[知识体系/Agent/LLM Wiki/LangGraph/概念/N4.md]]",
    "",
    "## 原始证据",
    "",
    "- [[daily/alive.md|alive]] · chunk=1",
    "- [[daily/deleted.md|deleted]] · chunk=1",
    ""
  ].join("\n");
}

describe("patchWikiPageForMissingSources", () => {
  it("removes dead citations, adds a warning callout and a 待补充 item, keeps the body", () => {
    const result = patchWikiPageForMissingSources(buildPage(), ["daily/deleted.md"], "2026-10-05T15:00:00.000Z");

    expect(result.removedPaths).toEqual(["daily/deleted.md"]);
    expect(result.content.match(/\[\[daily\/deleted\.md/gu) ?? []).toHaveLength(0);
    expect(result.content).toContain("daily/alive.md");
    expect(result.content).toContain("状态在图中按边流转。");
    expect(result.content).toContain("> [!warning] 证据失效");
    expect(result.content).toContain("> 原始来源已删除：daily/deleted.md（2026-10-05 校对）");
    expect(result.content).toContain("- 来源 daily/deleted.md 已删除，本页对应结论需要重新取证。");

    const warningIndex = result.content.indexOf("> [!warning]");
    const infoEnd = result.content.indexOf("> 返回主题：");
    expect(warningIndex).toBeGreaterThan(infoEnd);

    const metadata = result.content.match(/"sources":(\[[^\]]*\])/u)?.[1] ?? "";
    expect(metadata).toContain("alive.md");
    expect(metadata).not.toContain("deleted.md");
    const evidenceSection = result.content.slice(result.content.indexOf("## 原始证据"));
    expect(evidenceSection).not.toContain("deleted.md");
  });

  it("leaves a page untouched when it cites none of the missing paths", () => {
    const page = buildPage();
    const result = patchWikiPageForMissingSources(page, ["daily/other.md"]);

    expect(result.content).toBe(page);
    expect(result.removedPaths).toEqual([]);
  });

  it("inserts the callout right after the metadata block when there is no info callout", () => {
    const page = buildPage().replace(/> \[!info\][^\n]*\n>[^\n]*\n/u, "");
    const result = patchWikiPageForMissingSources(page, ["daily/deleted.md"], "2026-10-05T15:00:00.000Z");

    const metadataEnd = result.content.indexOf("-->");
    const warningIndex = result.content.indexOf("> [!warning] 证据失效");
    expect(warningIndex).toBeGreaterThan(metadataEnd);
    expect(warningIndex - metadataEnd).toBeLessThan(10);
  });
});

function buildRegistry(): LlmWikiRegistry {
  return {
    version: 1,
    topics: [
      {
        id: "langgraph",
        topic: "LangGraph",
        indexPath: "知识体系/Agent/LLM Wiki/LangGraph/概览.md",
        status: "stale",
        updatedAt: "2026-10-02T08:28:52.152Z",
        sourceHashes: [
          { pathOrUrl: "daily/alive.md", contentHash: "aaaa1111" },
          { pathOrUrl: "daily/deleted.md", contentHash: "bbbb2222" }
        ],
        sourceHealth: [
          { pathOrUrl: "daily/alive.md", status: "active", checkedAt: "2026-10-05T09:00:00.000Z" },
          { pathOrUrl: "daily/deleted.md", status: "missing", checkedAt: "2026-10-05T09:00:00.000Z" }
        ],
        pages: [
          {
            path: "知识体系/Agent/LLM Wiki/LangGraph/概念/N3.md",
            title: "LangGraph 的状态流转机制",
            summary: "状态流转",
            aliases: [],
            links: [],
            sourcePaths: ["daily/alive.md", "daily/deleted.md"]
          }
        ]
      },
      {
        id: "other",
        topic: "其他主题",
        indexPath: "知识体系/Agent/LLM Wiki/其他主题/概览.md",
        status: "fresh",
        updatedAt: "2026-10-02T08:28:52.152Z",
        sourceHashes: [{ pathOrUrl: "daily/other.md", contentHash: "cccc3333" }],
        pages: []
      }
    ],
    errorBook: [
      {
        id: "source-stale-x",
        type: "source-stale",
        path: "知识体系/Agent/LLM Wiki/LangGraph/概览.md",
        detail: "主题“LangGraph”的1 篇来源已删除，需要增量编译。",
        rule: "来源哈希变化时，重新编译引用该来源的 Wiki 页面。",
        status: "open",
        observedAt: "2026-10-05T09:00:00.000Z"
      }
    ]
  };
}

describe("pruneMissingWikiSources", () => {
  it("drops the deleted source from the topic records and closes the stale error", () => {
    const next = pruneMissingWikiSources(buildRegistry(), "langgraph", ["daily/deleted.md"]);
    const topic = next.topics.find((candidate) => candidate.id === "langgraph")!;

    expect(topic.sourceHashes.map((source) => source.pathOrUrl)).toEqual(["daily/alive.md"]);
    expect(topic.pages[0]?.sourcePaths).toEqual(["daily/alive.md"]);
    expect(topic.sourceHealth?.map((health) => health.pathOrUrl)).toEqual(["daily/alive.md"]);
    expect(topic.status).toBe("fresh");
    expect(next.errorBook[0]?.status).toBe("closed");

    const untouched = next.topics.find((candidate) => candidate.id === "other")!;
    expect(untouched.sourceHashes).toHaveLength(1);
  });

  it("keeps the topic stale when remaining sources are still changed", () => {
    const registry = buildRegistry();
    registry.topics[0]!.sourceHealth = [
      { pathOrUrl: "daily/alive.md", status: "changed", checkedAt: "2026-10-05T09:00:00.000Z" },
      { pathOrUrl: "daily/deleted.md", status: "missing", checkedAt: "2026-10-05T09:00:00.000Z" }
    ];

    const next = pruneMissingWikiSources(registry, "langgraph", ["daily/deleted.md"]);
    const topic = next.topics.find((candidate) => candidate.id === "langgraph")!;

    expect(topic.status).toBe("stale");
    expect(next.errorBook[0]?.status).toBe("open");
  });
});
