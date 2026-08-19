import { describe, expect, it } from "vitest";
import { hashText } from "../src/domain/content-hash";
import {
  createGardenerSources,
  parseGardenerPlan,
  type GardenerSource
} from "../src/gardener/knowledge-gardener";

const sources: GardenerSource[] = [
  {
    id: "S1",
    title: "RAG 检索",
    excerpt: "关键词检索是基础检索方式。",
    source: { type: "note", pathOrUrl: "Notes/RAG.md", locator: "heading=检索", contentHash: hashText("RAG"), parserVersion: "markdown-v1" }
  },
  {
    id: "S2",
    title: "RAG 评估",
    excerpt: "评估应覆盖召回与答案质量。",
    source: { type: "note", pathOrUrl: "Notes/RAG-评估.md", locator: "heading=指标", contentHash: hashText("评估"), parserVersion: "markdown-v1" }
  }
];

describe("knowledge gardener plan", () => {
  it("parses grounded maintenance findings", () => {
    const plan = parseGardenerPlan(JSON.stringify({
      summary: "建议先统一 RAG 资料。",
      findings: [{ id: "f1", kind: "gap", title: "缺少边界", detail: "资料没有覆盖失败场景。", sourceIds: ["S1"] }]
    }), new Set(["S1", "S2"]));

    expect(plan.findings).toEqual([
      { id: "f1", kind: "gap", title: "缺少边界", detail: "资料没有覆盖失败场景。", sourceIds: ["S1"] }
    ]);
  });

  it("rejects fabricated source IDs and duplicate finding IDs", () => {
    expect(() => parseGardenerPlan(JSON.stringify({
      summary: "分析",
      findings: [{ id: "f1", kind: "gap", title: "缺口", detail: "说明", sourceIds: ["S9"] }]
    }), new Set(["S1"]))).toThrow("未知或重复");

    expect(() => parseGardenerPlan(JSON.stringify({
      summary: "分析",
      findings: [
        { id: "f1", kind: "gap", title: "缺口", detail: "说明", sourceIds: ["S1"] },
        { id: "f1", kind: "stale", title: "过时", detail: "说明", sourceIds: ["S1"] }
      ]
    }), new Set(["S1"]))).toThrow("不能重复");
  });

  it("creates compact unique sources from indexed chunks", () => {
    const records = createGardenerSources([
      { chunk: { source: sources[0].source, heading: "检索", content: "A".repeat(500) } },
      { chunk: { source: sources[0].source, heading: "检索", content: "重复" } },
      { chunk: { source: sources[1].source, heading: null, content: "评估正文" } }
    ]);
    expect(records).toHaveLength(2);
    expect(records[0].excerpt.length).toBeLessThanOrEqual(361);
  });

  it("allows a grounded report with no findings", () => {
    const plan = parseGardenerPlan(JSON.stringify({
      summary: "没有发现明确的维护问题。",
      findings: []
    }), new Set(["S1"]));
    expect(plan.findings).toEqual([]);
  });
});
