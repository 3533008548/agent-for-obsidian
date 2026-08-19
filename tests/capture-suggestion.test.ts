import { describe, expect, it } from "vitest";
import {
  buildCaptureSuggestionMessages,
  parseCaptureSuggestion
} from "../src/services/capture-suggestion";

describe("capture suggestion JSON", () => {
  it("parses a valid JSON proposal, including a fenced fallback", () => {
    const suggestion = parseCaptureSuggestion("```json\n{\"subject\":\"机器学习\",\"content\":\"监督学习使用带标签数据。\",\"rationale\":\"按主题沉淀。\"}\n```");

    expect(suggestion).toEqual({
      subject: "机器学习",
      content: "监督学习使用带标签数据。",
      rationale: "按主题沉淀。"
    });
  });

  it("rejects missing or oversized fields instead of producing a write proposal", () => {
    expect(() => parseCaptureSuggestion("{\"subject\":\"主题\",\"content\":\"\"}")).toThrow("content");
    expect(() => parseCaptureSuggestion("{not-json}")).toThrow("有效的笔记提案 JSON");
  });

  it("asks the model for JSON and fixes the write destination in advance", () => {
    const messages = buildCaptureSuggestionMessages("答案正文", "appendDailyNote");

    expect(messages[0].content).toContain("JSON");
    expect(messages[1].content).toContain("主题命名的 Daily 日志");
  });
});
