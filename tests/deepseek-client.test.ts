import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

/** Minimal stand-in for the fetch-based request adapter used by the desktop shell. */
const postJson = async <T>(request: {
  url: string;
  apiKey: string;
  payload: unknown;
}): Promise<T> => {
  fetchMock(request);
  return {
    id: "request-1",
    model: "deepseek-v4-flash",
    choices: [{ message: { content: (fetchMock as unknown as { content: string }).content } }]
  } as T;
};

import { DeepSeekClient } from "../core/services/deepseek-client";

describe("DeepSeekClient", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  function respondWith(payload: unknown): void {
    (fetchMock as unknown as { content: string }).content = JSON.stringify(payload);
  }

  it("limits normal answers to six clipped sources and disables thinking", async () => {
    respondWith({ answer: "回答", evidenceComplete: true, missingEvidence: [] });
    const client = new DeepSeekClient({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      slowResponseMs: 60_000,
      postJson
    });
    const sources = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      path: `note-${index + 1}.md`,
      locator: "chunk",
      content: "x".repeat(2_400)
    }));

    const result = await client.answerWithSources("测试问题", sources);
    const payload = (fetchMock.mock.calls[0][0] as { payload: {
      max_tokens: number;
      thinking: { type: string };
      response_format: { type: string };
      messages: Array<{ content: string }>;
    } }).payload;
    const sourceMessage = payload.messages.at(-1)?.content ?? "";

    expect(result.sourceCount).toBe(6);
    expect(result.evidenceComplete).toBe(true);
    expect(result.missingEvidence).toEqual([]);
    expect(payload.max_tokens).toBe(800);
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.response_format).toEqual({ type: "json_object" });
    expect(sourceMessage).toContain("[S6]");
    expect(sourceMessage).not.toContain("[S7]");
    // Sources are clipped at 2000 characters, not 1500: the budget went up
    // because a clipped fragment is where "how does it work" gets lost.
    expect(sourceMessage).not.toContain("x".repeat(2_001));
    expect(result.inputCharacters).toBe(payload.messages.reduce((total, message) => total + message.content.length, 0));
  });

  it("reports concepts that lack direct local evidence", async () => {
    respondWith({
      answer: "来源只说明了乐观锁。[S1]",
      evidenceComplete: false,
      missingEvidence: ["悲观锁"]
    });
    const client = new DeepSeekClient({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      slowResponseMs: 60_000,
      postJson
    });

    await expect(client.answerWithSources("乐观锁和悲观锁的区别", [{
      id: 1,
      path: "乐观锁.md",
      locator: "chunk",
      content: "乐观锁通过版本号检查冲突。"
    }])).resolves.toMatchObject({
      evidenceComplete: false,
      missingEvidence: ["悲观锁"]
    });
  });

  it("gives the knowledge map and node drafts a larger JSON budget than the default", async () => {
    // 资料多的主题下，地图 JSON 用默认 1400 会在字符串中间被截断
    // （实测 "Unterminated string at position 3642"），这两次调用的预算必须单独放大。
    respondWith({ overview: "总览", nodes: [{ id: "n1", title: "节点", summary: "摘要", sourceIds: ["s1"], priority: "high" }], conflicts: [], gaps: [] });
    const client = new DeepSeekClient({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      slowResponseMs: 60_000,
      postJson
    });
    const source = {
      id: "s1",
      title: "笔记 A",
      content: "内容",
      source: {
        type: "note" as const,
        pathOrUrl: "笔记A.md",
        locator: "chunk=1",
        contentHash: "hash",
        parserVersion: "markdown-v2"
      }
    };

    await client.createKnowledgeMap("主题", [source]);
    respondWith({ title: "节点", content: "正文", sourceIds: ["s1"], conflicts: [], gaps: [] });
    await client.composeKnowledgeNode(
      "主题",
      { id: "n1", title: "节点", summary: "摘要", sourceIds: ["s1"], priority: "high" },
      [source]
    );

    const budgets = fetchMock.mock.calls.map(
      (call) => (call[0] as { payload: { max_tokens: number } }).payload.max_tokens
    );
    expect(budgets[0]).toBe(6_000);
    expect(budgets[1]).toBe(4_000);
  });
});
