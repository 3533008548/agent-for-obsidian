import { describe, expect, it } from "vitest";
import { hashText } from "../src/domain/content-hash";
import {
  buildNoteRelationMessages,
  mergeManagedNoteRelations,
  parseNoteRelationPlan,
  renderNoteRelationItems
} from "../src/integration/note-relations";
import type { KnowledgeIntegrationSource } from "../src/integration/knowledge-system";

const sources: KnowledgeIntegrationSource[] = [
  {
    id: "S0",
    title: "RAG 总览",
    content: "RAG 通过检索外部资料增强生成结果。",
    source: { type: "note", pathOrUrl: "RAG/总览.md", locator: "heading=概览", contentHash: hashText("总览"), parserVersion: "markdown-v1" }
  },
  {
    id: "S1",
    title: "向量检索",
    content: "向量检索负责按语义召回候选片段。",
    source: { type: "note", pathOrUrl: "RAG/向量检索.md", locator: "heading=召回", contentHash: hashText("向量"), parserVersion: "markdown-v1" }
  },
  {
    id: "S2",
    title: "关键词检索",
    content: "关键词检索依赖词面匹配。",
    source: { type: "note", pathOrUrl: "RAG/关键词检索.md", locator: "heading=匹配", contentHash: hashText("关键词"), parserVersion: "markdown-v1" }
  }
];

describe("note relation protocol", () => {
  it("accepts only grounded candidate relations", () => {
    const plan = parseNoteRelationPlan(JSON.stringify({
      summary: "向量检索是 RAG 的前置检索能力。",
      relations: [{
        targetId: "S1",
        type: "prerequisite",
        reason: "总览将检索作为生成前的必要阶段。",
        sourceIds: ["S0", "S1"],
        confidence: "high"
      }]
    }), new Set(sources.map((source) => source.id)));

    expect(plan.relations).toHaveLength(1);
    expect(renderNoteRelationItems(plan.relations, sources)).toContain("[[RAG/向量检索.md]]");
    expect(buildNoteRelationMessages(sources)[0].content).toContain("targetId 必须是候选笔记 ID");
  });

  it("rejects a current-note target, weak evidence, and duplicate targets", () => {
    const allowed = new Set(sources.map((source) => source.id));
    expect(() => parseNoteRelationPlan(JSON.stringify({
      summary: "分析",
      relations: [{ targetId: "S0", type: "extension", reason: "说明", sourceIds: ["S0", "S1"], confidence: "medium" }]
    }), allowed)).toThrow("当前笔记作为目标");

    expect(() => parseNoteRelationPlan(JSON.stringify({
      summary: "分析",
      relations: [{ targetId: "S1", type: "extension", reason: "说明", sourceIds: ["S0", "S2"], confidence: "medium" }]
    }), allowed)).toThrow("同时引用当前笔记和目标笔记");

    expect(() => parseNoteRelationPlan(JSON.stringify({
      summary: "分析",
      relations: [
        { targetId: "S1", type: "extension", reason: "说明一", sourceIds: ["S0", "S1"], confidence: "medium" },
        { targetId: "S1", type: "comparison", reason: "说明二", sourceIds: ["S0", "S1"], confidence: "high" }
      ]
    }), allowed)).toThrow("重复提议");
  });

  it("replaces only the managed relation block and preserves manual content", () => {
    const first = mergeManagedNoteRelations("# RAG\n\n## 关联笔记\n\n- 手写关联：[[手写笔记]]", "- 前置概念：[[RAG/向量检索.md]] — 负责召回。");
    const second = mergeManagedNoteRelations(first, "- 对比阅读：[[RAG/关键词检索.md]] — 依赖词面匹配。");

    expect(second).toContain("- 手写关联：[[手写笔记]]");
    expect(second).toContain("[[RAG/关键词检索.md]]");
    expect(second).not.toContain("[[RAG/向量检索.md]]");
    expect(second.match(/knowledge-loop-agent:relations:start/gu)).toHaveLength(1);
  });
});
