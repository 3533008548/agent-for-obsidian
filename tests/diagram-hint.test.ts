import { describe, expect, it } from "vitest";
import { DIAGRAM_INSTRUCTION, wantsDiagram } from "../core/domain/diagram-hint";

describe("wantsDiagram", () => {
  it("asks for a diagram when the question is about what something is", () => {
    expect(wantsDiagram("什么是红黑树")).toBe(true);
    expect(wantsDiagram("什么是 B 树，它和二叉搜索树有什么区别")).toBe(true);
    expect(wantsDiagram("讲讲 RAG 的检索流程")).toBe(true);
    expect(wantsDiagram("解释一下 CAP 定理")).toBe(true);
  });

  it("asks when two things are being compared or laid out", () => {
    expect(wantsDiagram("http 和 https 有什么区别")).toBe(true);
    expect(wantsDiagram("LangChain 与 LangGraph 的架构差异")).toBe(true);
    expect(wantsDiagram("描述 RAG 的完整流程")).toBe(true);
  });

  it("leaves lookups and instructions alone", () => {
    expect(wantsDiagram("今天天气怎么样")).toBe(false);
    expect(wantsDiagram("帮我看看这段报错")).toBe(false);
    expect(wantsDiagram("编译 LangGraph Wiki")).toBe(false);
    expect(wantsDiagram("记住我喜欢简洁的回答")).toBe(false);
  });

  it("treats very short questions as lookups rather than topics", () => {
    expect(wantsDiagram("401")).toBe(false);
    expect(wantsDiagram("搞定没")).toBe(false);
  });

  it("never costs anything when the rule says no", () => {
    expect(wantsDiagram("整理一下今天的笔记")).toBe(false);
  });
});

describe("diagram instruction", () => {
  it("names mermaid explicitly so the model does not invent a syntax", () => {
    expect(DIAGRAM_INSTRUCTION).toContain("mermaid");
    expect(DIAGRAM_INSTRUCTION).toContain("Mermaid");
  });

  it("bounds how many diagrams one answer may carry", () => {
    expect(DIAGRAM_INSTRUCTION).toContain("恰好一个");
  });
});
