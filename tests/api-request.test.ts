import { afterEach, describe, expect, it, vi } from "vitest";
import { InFlightRequestGate } from "../src/services/in-flight-request-gate";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));

vi.mock("obsidian", () => ({ requestUrl }));

import { postJson } from "../src/services/api-request";

describe("postJson", () => {
  afterEach(() => {
    vi.useRealTimers();
    requestUrl.mockReset();
  });

  it("only warns when a request is slow and keeps the in-flight gate locked", async () => {
    vi.useFakeTimers();
    const gate = new InFlightRequestGate();
    const onSlowResponse = vi.fn();
    let release: ((value: { status: number; json: { ok: boolean } }) => void) | undefined;
    requestUrl.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));

    const operation = () => postJson<{ ok: boolean }>({
      url: "https://example.test/slow",
      apiKey: "test-key",
      providerName: "DeepSeek",
      slowResponseMs: 60_000,
      onSlowResponse,
      payload: { ping: true }
    });
    const first = gate.run("same-request", operation);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSlowResponse).toHaveBeenCalledTimes(1);

    const retry = gate.run("same-request", operation);
    expect(requestUrl).toHaveBeenCalledTimes(1);

    release?.({ status: 200, json: { ok: true } });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(retry).resolves.toEqual({ ok: true });
  });
});
