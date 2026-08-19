import { describe, expect, it } from "vitest";
import { hashText } from "../src/domain/content-hash";
import {
  parseKnowledgeMap,
  parseKnowledgeNodeDraft,
  renderKnowledgeMapContent,
  renderKnowledgeNodeContent,
  type KnowledgeIntegrationSource
} from "../src/integration/knowledge-system";

const sources: KnowledgeIntegrationSource[] = [
  {
    id: "S1",
    title: "损失函数",
    content: "损失函数衡量预测值和真实值之间的差异。",
    source: {
      type: "note",
      pathOrUrl: "Notes/损失函数.md",
      locator: "heading=定义",
      contentHash: hashText("损失函数"),
      parserVersion: "markdown-v1"
    }
  },
  {
    id: "S2",
    title: "优化算法",
    content: "梯度下降通过迭代减小损失。",
    source: {
      type: "note",
      pathOrUrl: "Notes/优化算法.md",
      locator: "heading=梯度下降",
      contentHash: hashText("梯度下降"),
      parserVersion: "markdown-v1"
    }
  }
];

describe("knowledge system JSON validation", () => {
  it("accepts a map only when each node references known sources", () => {
    const map = parseKnowledgeMap(JSON.stringify({
      overview: "监督学习由目标、损失和优化组成。",
      nodes: [{
        id: "loss",
        title: "损失函数",
        summary: "衡量预测误差。",
        sourceIds: ["S1"],
        priority: "high"
      }],
      conflicts: [],
      gaps: ["缺少泛化误差资料。"]
    }), new Set(sources.map((source) => source.id)));

    expect(map.nodes[0].sourceIds).toEqual(["S1"]);
    expect(renderKnowledgeMapContent("监督学习", map, "当前笔记", "2026-08-12T00:00:00.000Z")).toContain("[[损失函数]]");
  });

  it("rejects invented source IDs in a map or node draft", () => {
    const invalidMap = JSON.stringify({
      overview: "概览",
      nodes: [{ id: "loss", title: "损失", summary: "说明", sourceIds: ["S9"], priority: "high" }],
      conflicts: [],
      gaps: []
    });
    expect(() => parseKnowledgeMap(invalidMap, new Set(["S1"]))).toThrow("未知或重复");

    const invalidDraft = JSON.stringify({
      title: "损失函数",
      content: "正文",
      sourceIds: ["S9"],
      conflicts: [],
      gaps: []
    });
    expect(() => parseKnowledgeNodeDraft(invalidDraft, new Set(["S1"]))).toThrow("未知或重复");
  });

  it("renders node content with visible conflicts and gaps", () => {
    const output = renderKnowledgeNodeContent({
      title: "损失函数",
      content: "损失函数用于定义训练目标。",
      sourceIds: ["S1"],
      conflicts: ["不同笔记的符号定义不同。"],
      gaps: ["缺少分类损失的资料。"]
    });
    expect(output).toContain("## 资料间差异或冲突");
    expect(output).toContain("## 待补充");
  });

  it("keeps a node draft title available while the map owns the final node filename", () => {
    const draft = parseKnowledgeNodeDraft(JSON.stringify({
      title: "模型自拟标题",
      content: "正文",
      sourceIds: ["S1"],
      conflicts: [],
      gaps: []
    }), new Set(["S1"]));
    expect(draft.title).toBe("模型自拟标题");
  });
});
