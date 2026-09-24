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

  it("limits normal answers to four clipped sources and disables thinking", async () => {
    respondWith({ answer: "回答", evidenceComplete: true, missingEvidence: [] });
    const client = new DeepSeekClient({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      slowResponseMs: 60_000,
      postJson
    });
    const sources = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      path: `note-${index + 1}.md`,
      locator: "chunk",
      content: "x".repeat(1_800)
    }));

    const result = await client.answerWithSources("测试问题", sources);
    const payload = (fetchMock.mock.calls[0][0] as { payload: {
      max_tokens: number;
      thinking: { type: string };
      response_format: { type: string };
      messages: Array<{ content: string }>;
    } }).payload;
    const sourceMessage = payload.messages.at(-1)?.content ?? "";

    expect(result.sourceCount).toBe(4);
    expect(result.evidenceComplete).toBe(true);
    expect(result.missingEvidence).toEqual([]);
    expect(payload.max_tokens).toBe(800);
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.response_format).toEqual({ type: "json_object" });
    expect(sourceMessage).toContain("[S4]");
    expect(sourceMessage).not.toContain("[S5]");
    expect(sourceMessage).not.toContain("x".repeat(1_501));
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
});
