import { describe, expect, it } from "vitest";
import { hashText } from "../src/domain/content-hash";
import {
  selectSourcesForWikiCompilation,
  type DesktopWikiCompileMode
} from "../src/desktop/desktop-wiki-service";
import type { KnowledgeIntegrationSource } from "../src/integration/knowledge-system";
import type { LlmWikiTopicRecord } from "../src/wiki/llm-wiki-system";

function source(path: string, content: string, heading = path): KnowledgeIntegrationSource {
  return {
    id: path,
    title: heading,
    content,
    source: {
      type: "note",
      pathOrUrl: path,
      locator: `heading=${heading}`,
      contentHash: hashText(content),
      parserVersion: "test"
    }
  };
}

function previousTopic(seen: KnowledgeIntegrationSource[]): LlmWikiTopicRecord {
  return {
    id: "测试主题",
    topic: "测试主题",
    indexPath: "知识体系/Agent/LLM Wiki/测试主题/概览.md",
    status: "fresh",
    updatedAt: "2026-09-13T00:00:00.000Z",
    sourceHashes: seen.map((item) => ({
      pathOrUrl: item.source.pathOrUrl,
      contentHash: item.source.contentHash
    })),
    pages: []
  };
}

describe("desktop wiki source selection", () => {
  it("prioritizes unseen and changed evidence over high-ranked reused notes during expansion", () => {
    const anchors = Array.from({ length: 8 }, (_, index) => source(`旧资料/${index}.md`, `旧资料 ${index}`));
    const changedBefore = Array.from({ length: 3 }, (_, index) => source(`变更资料/${index}.md`, `旧版本 ${index}`));
    const changedNow = changedBefore.map((item, index) => source(item.source.pathOrUrl, `新版本 ${index}`));
    const newSources = Array.from({ length: 7 }, (_, index) => source(`新资料/${index}.md`, `新资料 ${index}`));
    const result = selectSourcesForWikiCompilation(
      [...anchors, ...changedNow, ...newSources],
      previousTopic([...anchors, ...changedBefore]),
      "expand" satisfies DesktopWikiCompileMode,
      10
    );

    expect(result.coverage).toEqual({
      mode: "expand",
      added: 6,
      changed: 3,
      reused: 1,
      remainingCandidates: 1
    });
    expect(result.sources.map((item) => item.source.pathOrUrl)).toEqual(expect.arrayContaining([
      "新资料/0.md",
      "变更资料/0.md"
    ]));
    expect(result.sources.filter((item) => item.source.pathOrUrl.startsWith("旧资料/")).length).toBe(1);
  });

  it("keeps a long note from consuming the whole compilation budget", () => {
    const result = selectSourcesForWikiCompilation([
      source("长笔记.md", "第一段", "第一节"),
      source("长笔记.md", "第二段", "第二节"),
      source("长笔记.md", "第三段", "第三节"),
      source("另一篇.md", "独立资料")
    ], undefined, "compile", 4);

    expect(result.sources.filter((item) => item.source.pathOrUrl === "长笔记.md")).toHaveLength(2);
    expect(result.sources.map((item) => item.source.pathOrUrl)).toContain("另一篇.md");
  });
});
