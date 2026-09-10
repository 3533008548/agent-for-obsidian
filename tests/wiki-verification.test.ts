import { describe, expect, it } from "vitest";
import {
  mergeWikiVerificationBlock,
  parseWikiUpdateBlocks,
  parseWikiVerificationReport
} from "../src/wiki/wiki-verification";

describe("Wiki verification", () => {
  it("only accepts findings that point to supplied Wiki pages", () => {
    const report = parseWikiVerificationReport(JSON.stringify({
      summary: "需要补充版本变化。",
      needsUpdate: true,
      findings: [{ kind: "outdated", pagePath: "知识体系/Agent/LLM Wiki/LangGraph/概览.md", detail: "资料未覆盖最新版本。" }]
    }), new Set(["知识体系/Agent/LLM Wiki/LangGraph/概览.md"]));

    expect(report.findings[0]?.kind).toBe("outdated");
    expect(() => parseWikiVerificationReport(JSON.stringify({
      summary: "错误路径。",
      needsUpdate: true,
      findings: [{ kind: "missing", pagePath: "其他.md", detail: "不应被接受。" }]
    }), new Set(["知识体系/Agent/LLM Wiki/LangGraph/概览.md"]))).toThrow("未提供的页面");
  });

  it("replaces only the managed external verification block", () => {
    const first = mergeWikiVerificationBlock("# LangGraph\n\n原始正文", "- 外部核验发现：版本信息待补充。");
    const second = mergeWikiVerificationBlock(first, "- 外部核验发现：已更新为待确认状态。");

    expect(second).toContain("已更新为待确认状态");
    expect(second).not.toContain("版本信息待补充");
    expect(second).toContain("原始正文");
  });

  it("rejects update previews outside the selected pages", () => {
    expect(() => parseWikiUpdateBlocks(JSON.stringify({
      updates: [{ path: "未知.md", summary: "x", content: "y" }]
    }), new Set(["已知.md"]))).toThrow("未知或重复页面");
  });
});
