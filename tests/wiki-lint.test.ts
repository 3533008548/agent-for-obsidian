import { describe, expect, it } from "vitest";
import { MAX_PAGES_PER_TOPIC, lintWiki, renderWikiHealth } from "../core/wiki/wiki-lint";
import type { LlmWikiPageRecord, LlmWikiRegistry } from "../core/wiki/llm-wiki-system";

const WIKI = "知识体系/Agent/LLM Wiki";
const TOPIC_INDEX = `${WIKI}/LangGraph/概览.md`;

function page(overrides: Partial<LlmWikiPageRecord> & { path: string }): LlmWikiPageRecord {
  const name = overrides.path.slice(overrides.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return {
    title: name,
    // Distinct per page by default, so the summary fallback cannot fire by
    // accident; tests that want it to fire pass their own.
    summary: `${name} 主题的独立说明，涉及各自不同的切入点与展开顺序`,
    aliases: [],
    links: [`${TOPIC_INDEX}`],
    sourcePaths: [],
    ...overrides
  };
}

function registry(pages: LlmWikiPageRecord[], sources: string[] = ["daily/a.md"]): LlmWikiRegistry {
  return {
    version: 1,
    topics: [
      {
        id: "LangGraph",
        topic: "LangGraph",
        indexPath: TOPIC_INDEX,
        status: "fresh",
        updatedAt: "2026-10-02T00:00:00.000Z",
        // Taken from the caller's list rather than fixed, so a test can say which
        // notes the topic has taken in. A registry that claims a note the test
        // never declared would make the coverage count wrong in a way that looks
        // like a bug in the code under test.
        sourceHashes: sources.map((pathOrUrl) => ({ pathOrUrl, contentHash: "h1" })),
        pages: [page({ path: TOPIC_INDEX, links: [] }), ...pages]
      }
    ],
    errorBook: []
  } as unknown as LlmWikiRegistry;
}

describe("wiki lint", () => {
  it("finds nothing wrong with a registry that matches the disk", () => {
    const pages = [
      page({ path: `${WIKI}/LangGraph/概念/N1-状态流转.md`, sourcePaths: ["daily/a.md"] }),
      page({ path: `${WIKI}/LangGraph/概念/N2-数据��型.md`, sourcePaths: ["daily/b.md"] })
    ];
    const report = lintWiki({
      registry: registry(pages),
      diskPaths: [TOPIC_INDEX, ...pages.map((p) => p.path)],
      isCompilableNote: () => true
    });

    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("reports a page on disk that the registry never recorded", () => {
    // What a recompile under new names leaves behind: the files stay, the
    // registry moves on, and nothing links to them any more.
    const known = page({ path: `${WIKI}/LangGraph/概念/N1-状态流转.md`, sourcePaths: ["daily/a.md"] });
    const orphan = `${WIKI}/LangGraph/概念/state_flow_mechanism-状态流转.md`;
    const report = lintWiki({
      registry: registry([known]),
      diskPaths: [TOPIC_INDEX, known.path, orphan, `${WIKI}/index.md`, `${WIKI}/知识库地图.md`],
      isCompilableNote: () => true
    });

    const orphans = report.findings.filter((f) => f.kind === "orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.paths).toEqual([orphan]);
  });

  it("does not treat the two hand-written front doors as orphans", () => {
    const known = page({ path: `${WIKI}/LangGraph/概念/N1-状态流转.md`, sourcePaths: ["daily/a.md"] });
    const report = lintWiki({
      registry: registry([known]),
      diskPaths: [TOPIC_INDEX, known.path, `${WIKI}/index.md`, `${WIKI}/知识库地图.md`],
      isCompilableNote: () => true
    });

    expect(report.findings.filter((f) => f.kind === "orphan")).toEqual([]);
  });

  it("flags two pages that share sources and state the same subject", () => {
    // The real case: a recompile named the page "N5-LangGraph 中的 checkpoint"
    // while the previous compile had left "checkpoint_mechanism-...".
    const older = page({
      path: `${WIKI}/LangGraph/概念/checkpoint_mechanism-LangGraph 中的 checkpoint(检查点)机制.md`,
      sourcePaths: ["daily/langgraph中的checkpoint.md"]
    });
    const newer = page({
      path: `${WIKI}/LangGraph/概念/N5-LangGraph 中的 checkpoint.md`,
      sourcePaths: ["daily/langgraph中的checkpoint.md"]
    });
    const report = lintWiki({
      registry: registry([older, newer]),
      diskPaths: [TOPIC_INDEX, older.path, newer.path],
      isCompilableNote: () => true
    });

    const duplicates = report.findings.filter((f) => f.kind === "duplicate-source");
    expect(duplicates).toHaveLength(1);
    // The last recorded page is the current compile, so it is the one to keep.
    expect(duplicates[0]!.resolution).toEqual({ keep: newer.path, retire: [older.path] });
  });

  it("leaves two different pages that happen to share one source alone", () => {
    // Both draw on one long note, but they answer different questions. Calling
    // these duplicates would delete a page the reader came for.
    const flow = page({
      path: `${WIKI}/LangGraph/概念/state_flow_mechanism-LangGraph 的状态流转机制.md`,
      sourcePaths: ["daily/langgraph的状态流转机制,状态的数据类型.md"]
    });
    const types = page({
      path: `${WIKI}/LangGraph/概念/state_data_type-状态的数据类型.md`,
      sourcePaths: ["daily/langgraph的状态流转机制,状态的数据类型.md"]
    });
    const report = lintWiki({
      registry: registry([flow, types]),
      diskPaths: [TOPIC_INDEX, flow.path, types.path],
      isCompilableNote: () => true
    });

    expect(report.findings.filter((f) => f.kind === "duplicate-source")).toEqual([]);
  });

  it("catches a renamed duplicate the title alone would miss", () => {
    // The other real pair: the recompile named the page by its question, the
    // previous compile had named it by its contrast. Containment is only 0.44,
    // below the title bar — the summary is what gives them away.
    const older = page({
      path: `${WIKI}/LangGraph/概念/comparison_with_prompt-LangGraph vs 长 Prompt 的优势.md`,
      sourcePaths: ["daily/agent开发中为什么需要类型注解.md"],
      summary: "对比 LangGraph 与直接写长 Prompt 的取舍，说明什么时候多一层图式编排更划算"
    });
    const newer = page({
      path: `${WIKI}/LangGraph/概念/N2-为什么使用 LangGraph 而不是一个很长的 Prompt.md`,
      sourcePaths: ["daily/agent开发中为什么需要类型注解.md"],
      summary: "对比 LangGraph 与直接写长 Prompt 的取舍，说明什么时候多一层图式编排更划算"
    });
    const report = lintWiki({
      registry: registry([older, newer]),
      diskPaths: [TOPIC_INDEX, older.path, newer.path],
      isCompilableNote: () => true
    });

    const duplicates = report.findings.filter((f) => f.kind === "duplicate-source");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.resolution).toEqual({ keep: newer.path, retire: [older.path] });
  });

  it("flags a topic that has outgrown its page budget", () => {
    const pages = Array.from({ length: MAX_PAGES_PER_TOPIC + 3 }, (_, i) =>
      page({ path: `${WIKI}/LangGraph/概念/N${i + 1}-主题${i + 1}.md`, sourcePaths: [`daily/n${i}.md`] })
    );
    const report = lintWiki({
      registry: registry(pages),
      diskPaths: [TOPIC_INDEX, ...pages.map((p) => p.path)],
      isCompilableNote: () => true
    });

    const overflow = report.findings.filter((f) => f.kind === "topic-overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.detail).toContain(String(MAX_PAGES_PER_TOPIC));
  });

  it("reports a registered page that is no longer on disk", () => {
    const gone = page({ path: `${WIKI}/LangGraph/概念/N9-已删除.md`, sourcePaths: ["daily/a.md"] });
    const report = lintWiki({
      registry: registry([gone]),
      diskPaths: [TOPIC_INDEX],
      isCompilableNote: () => true
    });

    expect(report.findings.filter((f) => f.kind === "missing-page").map((f) => f.paths[0])).toEqual([gone.path]);
  });

  it("reports a page with no way onward", () => {
    const dead = page({ path: `${WIKI}/LangGraph/概念/N1-孤岛.md`, sourcePaths: ["daily/a.md"], links: [] });
    const report = lintWiki({
      registry: registry([dead]),
      diskPaths: [TOPIC_INDEX, dead.path],
      isCompilableNote: () => true
    });

    expect(report.findings.filter((f) => f.kind === "dead-end")).toHaveLength(1);
  });

  it("reports a topic whose source notes have gone", () => {
    const only = page({ path: `${WIKI}/LangGraph/概念/N1-主题.md`, sourcePaths: ["daily/a.md"] });
    const report = lintWiki({
      registry: registry([only]),
      diskPaths: [TOPIC_INDEX, only.path],
      isCompilableNote: (path) => path !== "daily/a.md"
    });

    const stale = report.findings.filter((f) => f.kind === "stale-source");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain("daily/a.md");
  });
});

describe("wiki health", () => {
  it("counts notes that no topic has taken in", () => {
    // The one number a reader wants without prose: how much of the library the
    // Wiki actually describes.
    const compiled = page({ path: `${WIKI}/LangGraph/概念/N1-主题.md`, sourcePaths: ["daily/covered.md"] });
    const report = lintWiki({
      registry: registry([compiled], ["daily/covered.md"]),
      diskPaths: [TOPIC_INDEX, compiled.path, "daily/covered.md", "daily/new-a.md", "daily/new-b.md"],
      isCompilableNote: (path) => !path.includes("LLM Wiki/")
    });

    expect(report.health.uncoveredNotes).toBe(2);
  });

  it("does not count the Wiki's own pages as notes waiting to be compiled", () => {
    // Wiki pages exist on disk; counting them would inflate the gap by however
    // many pages the Wiki has.
    const compiled = page({ path: `${WIKI}/LangGraph/概念/N1-主题.md`, sourcePaths: ["daily/covered.md"] });
    const report = lintWiki({
      registry: registry([compiled], ["daily/covered.md"]),
      diskPaths: [
        TOPIC_INDEX,
        compiled.path,
        `${WIKI}/index.md`,
        `${WIKI}/知识库地图.md`,
        `${WIKI}/_system/Error Book.md`,
        "daily/covered.md"
      ],
      isCompilableNote: (path) => !path.includes("LLM Wiki/")
    });

    expect(report.health.uncoveredNotes).toBe(0);
  });

  it("flags a topic whose pages restate a few sources", () => {
    // Fragmentation has no error message: each placement was reasonable, and the
    // topic just ends up with many pages per few notes.
    const pages = Array.from({ length: 8 }, (_, i) =>
      page({ path: `${WIKI}/LangGraph/概念/N${i + 1}-薄页${i + 1}.md`, sourcePaths: ["daily/one.md"] })
    );
    const report = lintWiki({
      registry: registry(pages, ["daily/one.md"]),
      diskPaths: [TOPIC_INDEX, ...pages.map((p) => p.path), "daily/one.md"],
      isCompilableNote: (path) => !path.includes("LLM Wiki/")
    });

    expect(report.health.possiblyFragmented).toContain("LangGraph");
  });

  it("leaves a well-proportioned topic unflagged", () => {
    const pages = Array.from({ length: 4 }, (_, i) =>
      page({ path: `${WIKI}/LangGraph/概念/N${i + 1}-页${i + 1}.md`, sourcePaths: [`daily/s${i}.md`] })
    );
    const report = lintWiki({
      registry: registry(pages, Array.from({ length: 4 }, (_, i) => `daily/s${i}.md`)),
      diskPaths: [TOPIC_INDEX, ...pages.map((p) => p.path), ...Array.from({ length: 4 }, (_, i) => `daily/s${i}.md`)],
      isCompilableNote: (path) => !path.includes("LLM Wiki/")
    });

    expect(report.health.possiblyFragmented).toEqual([]);
    expect(report.health.oversized).toEqual([]);
  });

  it("flags a topic that has outgrown a readable size", () => {
    const pages = Array.from({ length: MAX_PAGES_PER_TOPIC + 2 }, (_, i) =>
      page({ path: `${WIKI}/LangGraph/概念/N${i + 1}-页${i + 1}.md`, sourcePaths: [`daily/s${i}.md`] })
    );
    const report = lintWiki({
      registry: registry(pages, Array.from({ length: MAX_PAGES_PER_TOPIC + 2 }, (_, i) => `daily/s${i}.md`)),
      diskPaths: [TOPIC_INDEX, ...pages.map((p) => p.path), ...Array.from({ length: MAX_PAGES_PER_TOPIC + 2 }, (_, i) => `daily/s${i}.md`)],
      isCompilableNote: (path) => !path.includes("LLM Wiki/")
    });

    expect(report.health.oversized).toContain("LangGraph");
  });

  it("renders a table a person can act on", () => {
    const compiled = page({ path: `${WIKI}/LangGraph/概念/N1-主题.md`, sourcePaths: ["daily/a.md"] });
    const report = lintWiki({
      registry: registry([compiled], ["daily/a.md"]),
      diskPaths: [TOPIC_INDEX, compiled.path, "daily/a.md", "daily/unclaimed.md"],
      isCompilableNote: (path) => !path.includes("LLM Wiki/")
    });
    const text = renderWikiHealth(report.health);

    expect(text).toContain("| 主题 | 页面 | 来源 |");
    expect(text).toContain("LangGraph");
    expect(text).toContain("1 篇笔记尚未被任何主题收录");
  });
});
