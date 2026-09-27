import { afterEach, describe, expect, it, vi } from "vitest";
import { postJsonStreamWithFetch, StreamCancelledError } from "../core/services/fetch-api-request";
import type { JsonPostStream } from "../core/services/json-post";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, { status });
}

function dataEvent(content: string, id = "chatcmpl-1"): string {
  return `data: ${JSON.stringify({ id, model: "deepseek-v4-flash", choices: [{ delta: { content } }] })}\n\n`;
}

const request = {
  url: "https://api.deepseek.com/chat/completions",
  apiKey: "test-key",
  providerName: "DeepSeek",
  payload: { model: "deepseek-v4-flash", stream: true }
};

describe("postJsonStreamWithFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("concatenates every streamed fragment in arrival order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      dataEvent("第一段"),
      dataEvent("，第二段"),
      dataEvent("。"),
      "data: [DONE]\n\n"
    ])));

    const received: string[] = [];
    const result = await postJsonStreamWithFetch(request, (text) => received.push(text));
    expect(received.join("")).toBe("第一段，第二段。");
    expect(result.requestId).toBe("chatcmpl-1");
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("reassembles an event split across network chunks", async () => {
    const event = dataEvent("被切断的文本");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      event.slice(0, 40),
      event.slice(40)
    ])));

    const received: string[] = [];
    await postJsonStreamWithFetch(request, (text) => received.push(text));
    expect(received.join("")).toBe("被切断的文本");
  });

  it("normalizes CRLF line endings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      dataEvent("回车换行").replace(/\n\n$/, "\r\n\r\n")
    ])));

    const received: string[] = [];
    await postJsonStreamWithFetch(request, (text) => received.push(text));
    expect(received.join("")).toBe("回车换行");
  });

  it("ignores malformed events instead of failing the stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      "data: {not json}\n\n",
      dataEvent("正常片段"),
      ": keep-alive comment\n\n"
    ])));

    const received: string[] = [];
    await postJsonStreamWithFetch(request, (text) => received.push(text));
    expect(received.join("")).toBe("正常片段");
  });

  it("surfaces provider error details for failed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Invalid API key" } }),
      { status: 401 }
    )));

    await expect(postJsonStreamWithFetch(request, () => undefined)).rejects.toThrow("Invalid API key");
  });

  it("refuses to call the provider without an API key", async () => {
    await expect(postJsonStreamWithFetch({ ...request, apiKey: "  " }, () => undefined))
      .rejects.toThrow(/DEEPSEEK_API_KEY|API Key/);
  });

  it("reports cancellation distinctly from a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    ));
    const controller = new AbortController();
    const pending = postJsonStreamWithFetch(request, () => undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(StreamCancelledError);
  });

  it("is usable through the JsonPostStream contract", async () => {
    const stream: JsonPostStream = postJsonStreamWithFetch;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([dataEvent("契约可用")])));
    const received: string[] = [];
    await stream(request, (text) => received.push(text));
    expect(received.join("")).toBe("契约可用");
  });
});
