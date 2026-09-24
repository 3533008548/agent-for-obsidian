import { describe, expect, it } from "vitest";
import { extractLlmWikiTopic } from "../core/wiki/llm-wiki-system";

describe("LLM Wiki", () => {
  it("extracts a stable topic from a Wiki compilation request", () => {
    expect(extractLlmWikiTopic("将库里的 LangGraph 相关笔记整理成 LLM Wiki")).toBe("LangGraph");
  });
});
