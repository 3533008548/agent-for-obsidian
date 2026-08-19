import { describe, expect, it } from "vitest";
import {
  normalizeWebSearchLimit,
  parseWebSearchResults,
  renderWebAnswerCaptureContent,
  sanitizeWebAnswer
} from "../src/services/web-search";

describe("web search result processing", () => {
  it("keeps only unique HTTP sources and creates traceable web SourceRefs", () => {
    const results = parseWebSearchResults([
      {
        title: "GLM 文档",
        link: "https://docs.bigmodel.cn/guide",
        content: "官方接口说明。",
        media: "智谱开放文档",
        publish_date: "2026-08-01",
        refer: "1"
      },
      {
        title: "重复链接",
        link: "https://docs.bigmodel.cn/guide",
        content: "不会重复保存。"
      },
      {
        title: "不安全协议",
        link: "javascript:alert(1)",
        content: "应被过滤。"
      }
    ], 5, "2026-08-10T00:00:00.000Z");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "GLM 文档",
      url: "https://docs.bigmodel.cn/guide",
      source: {
        type: "web",
        pathOrUrl: "https://docs.bigmodel.cn/guide",
        locator: "search-result:1",
        parserVersion: "tavily-search-v1",
        retrievedAt: "2026-08-10T00:00:00.000Z"
      }
    });
  });

  it("clamps the provider result count and removes links from the displayed answer and capture", () => {
    expect(normalizeWebSearchLimit(100)).toBe(10);
    expect(normalizeWebSearchLimit(0)).toBe(1);

    const answer = sanitizeWebAnswer("[官方说明](https://example.com/article)\n结论是可行的。https://example.com/more");
    const content = renderWebAnswerCaptureContent("联网检索", answer);

    expect(answer).toBe("官方说明\n结论是可行的。");
    expect(content).toContain("> 联网问答：联网检索");
    expect(content).not.toContain("https://");
  });
});
