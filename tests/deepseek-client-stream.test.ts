import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, type TextSourceSnippet } from "../core/services/deepseek-client";
import type { JsonPost } from "../core/services/json-post";

const sources: TextSourceSnippet[] = [
  { id: 1, path: "notes/optimistic-lock.md", locator: "第 1 段", content: "乐观锁通过版本号避免覆盖。" }
];

function client(postJsonStream: NonNullable<ConstructorParameters<typeof DeepSeekClient>[0]["postJsonStream"]>): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    slowResponseMs: 60_000,
    postJson: vi.fn() as unknown as JsonPost,
    postJsonStream
  });
}

/** Emits a JSON knowledge answer as small fragments, as a real provider would. */
function jsonStream(answer: string, evidenceComplete: boolean): NonNullable<ConstructorParameters<typeof DeepSeekClient>[0]["postJsonStream"]> {
  return async (_request, onDelta) => {
    const pieces = [
      '{"answer":"',
      ...answer.match(/.{1,5}/gu) ?? [],
      `","evidenceComplete":${evidenceComplete},"missingEvidence":[]}`
    ];
    for (const piece of pieces) {
      onDelta(piece);
    }
    return { requestId: "req-1", model: "deepseek-v4-flash" };
  };
}

describe("DeepSeekClient streaming", () => {
  it("streams only the answer text, never the surrounding JSON", async () => {
    const received: string[] = [];
    const result = await client(jsonStream("已证实的回答内容", true))
      .answerWithSources("问题", sources, "", { onDelta: (text) => received.push(text) });

    expect(received.join("")).toBe("已证实的回答内容");
    expect(received.join("")).not.toContain("{");
    expect(received.join("")).not.toContain("evidenceComplete");
    expect(result.content).toBe("已证实的回答内容");
    expect(result.evidenceComplete).toBe(true);
  });

  it("still parses evidence metadata from the reassembled document", async () => {
    const received: string[] = [];
    const result = await client(jsonStream("局部回答", false))
      .answerWithSources("问题", sources, "", { onDelta: (text) => received.push(text) });

    expect(result.evidenceComplete).toBe(false);
    expect(result.missingEvidence).toEqual([]);
    expect(result.sourceCount).toBe(1);
  });

  it("decodes escaped newlines inside the streamed answer", async () => {
    const received: string[] = [];
    await client(jsonStream("第一行\\n第二行", true))
      .answerWithSources("问题", sources, "", { onDelta: (text) => received.push(text) });
    expect(received.join("")).toBe("第一行\n第二行");
  });

  it("requests stream mode and forwards the abort signal", async () => {
    const controller = new AbortController();
    let seenStream: unknown;
    let seenSignal: AbortSignal | undefined;
    const streaming = vi.fn(async (_request, onDelta, signal) => {
      seenStream = _request.payload.stream;
      seenSignal = signal;
      onDelta('{"answer":"x","evidenceComplete":true,"missingEvidence":[]}');
      return { requestId: "req-2" };
    }) as unknown as NonNullable<ConstructorParameters<typeof DeepSeekClient>[0]["postJsonStream"]>;

    await client(streaming).answerWithSources("问题", sources, "", {
      onDelta: () => undefined,
      signal: controller.signal
    });
    expect(seenStream).toBe(true);
    expect(seenSignal).toBe(controller.signal);
  });

  it("streams plain text answers verbatim", async () => {
    const received: string[] = [];
    const streaming = vi.fn(async (_request, onDelta) => {
      onDelta("通用回答");
      onDelta("的第二段");
      return { requestId: "req-3" };
    }) as unknown as NonNullable<ConstructorParameters<typeof DeepSeekClient>[0]["postJsonStream"]>;

    const result = await client(streaming).answerFromGeneralKnowledge("问题", "", {
      onDelta: (text) => received.push(text)
    });
    expect(received.join("")).toBe("通用回答的第二段");
    expect(result.content).toBe("通用回答的第二段");
  });

  it("keeps the non-streaming path unchanged", async () => {
    const postJson = vi.fn(async () => ({
      id: "req-4",
      model: "deepseek-v4-flash",
      choices: [{ message: { content: '{"answer":"非流式","evidenceComplete":true,"missingEvidence":[]}' } }]
    })) as unknown as JsonPost;

    const nonStreaming = new DeepSeekClient({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      slowResponseMs: 60_000,
      postJson
    });
    const result = await nonStreaming.answerWithSources("问题", sources);
    expect(result.content).toBe("非流式");
    const calls = (postJson as unknown as {
      mock: { calls: Array<[{ payload: { stream: boolean } }]> };
    }).mock.calls;
    expect(calls[0][0].payload.stream).toBe(false);
  });
});
