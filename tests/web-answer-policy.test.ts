import { describe, expect, it } from "vitest";
import {
  getNoWebResultMessage,
  requiresFreshWebSources,
  shouldUseGeneralKnowledgeFallback
} from "../src/services/web-answer-policy";

describe("web answer fallback policy", () => {
  it("recognizes questions that require fresh sources", () => {
    expect(requiresFreshWebSources("今天北京天气怎么样？")).toBe(true);
    expect(requiresFreshWebSources("What is the latest Node.js version?")).toBe(true);
    expect(requiresFreshWebSources("解释监督学习中的损失函数")).toBe(false);
  });

  it("uses general knowledge only when the configured policy permits it", () => {
    expect(shouldUseGeneralKnowledgeFallback("stable-only", "解释监督学习中的损失函数")).toBe(true);
    expect(shouldUseGeneralKnowledgeFallback("stable-only", "今天黄金价格是多少？")).toBe(false);
    expect(shouldUseGeneralKnowledgeFallback("always-with-warning", "今天黄金价格是多少？")).toBe(true);
    expect(shouldUseGeneralKnowledgeFallback("disabled", "解释监督学习中的损失函数")).toBe(false);
  });

  it("explains why a no-result request did not fall back", () => {
    expect(getNoWebResultMessage("disabled", "解释强化学习")).toContain("关闭");
    expect(getNoWebResultMessage("stable-only", "最新政策是什么？")).toContain("实时信息");
  });
});
