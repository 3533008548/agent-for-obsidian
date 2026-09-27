import type {
  JsonPost,
  JsonPostRequest,
  JsonPostStream,
  JsonPostStreamResult
} from "./json-post";

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

/** Raised when the caller aborts a streaming completion. */
export class StreamCancelledError extends Error {
  constructor() {
    super("已停止生成。");
    this.name = "StreamCancelledError";
  }
}

/** Node/Electron request adapter for providers previously called through Obsidian requestUrl. */
export const postJsonWithFetch: JsonPost = async <T>(request: JsonPostRequest): Promise<T> => {
  if (!request.apiKey.trim()) {
    throw new Error("请先在本地 .env 中填写 " + request.providerName + " 的 API Key。");
  }

  const controller = new AbortController();
  const requestTimeout = Math.max(DEFAULT_REQUEST_TIMEOUT_MS, request.slowResponseMs ?? 0);
  const timeout = globalThis.setTimeout(() => controller.abort(), requestTimeout);
  let slowNoticeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  if (request.onSlowResponse && request.slowResponseMs && request.slowResponseMs > 0) {
    slowNoticeTimer = globalThis.setTimeout(() => request.onSlowResponse?.(), request.slowResponseMs);
  }

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + request.apiKey.trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.payload),
      signal: controller.signal
    });
    const rawBody = await response.text();
    const body = parseJsonResponse(rawBody, request.providerName);
    if (!response.ok) {
      throw new Error(getErrorMessage(body) ?? request.providerName + " 请求失败（HTTP " + response.status + "）。");
    }
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(request.providerName + " 请求超时。");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    if (slowNoticeTimer !== undefined) {
      globalThis.clearTimeout(slowNoticeTimer);
    }
  }
};

/**
 * Streaming counterpart of {@link postJsonWithFetch}. Reads a Server-Sent Events
 * body and forwards each text fragment to `onDelta` as it arrives, so the UI can
 * render progressively instead of waiting for the full completion.
 */
export const postJsonStreamWithFetch: JsonPostStream = async (request, onDelta, signal) => {
  if (!request.apiKey.trim()) {
    throw new Error("请先在本地 .env 中填写 " + request.providerName + " 的 API Key。");
  }
  if (signal?.aborted) {
    throw new StreamCancelledError();
  }

  const controller = new AbortController();
  const requestTimeout = Math.max(DEFAULT_REQUEST_TIMEOUT_MS, request.slowResponseMs ?? 0);
  const timeout = globalThis.setTimeout(() => controller.abort(), requestTimeout);
  let slowNoticeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  if (request.onSlowResponse && request.slowResponseMs && request.slowResponseMs > 0) {
    slowNoticeTimer = globalThis.setTimeout(() => request.onSlowResponse?.(), request.slowResponseMs);
  }
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + request.apiKey.trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.payload),
      signal: controller.signal
    });
    if (!response.ok) {
      const rawBody = await response.text();
      const body = parseJsonResponse(rawBody, request.providerName);
      throw new Error(getErrorMessage(body) ?? request.providerName + " 请求失败（HTTP " + response.status + "）。");
    }
    return await readSseStream(response, request.providerName, onDelta);
  } catch (error) {
    if (error instanceof StreamCancelledError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted) {
        throw new StreamCancelledError();
      }
      throw new Error(request.providerName + " 请求超时。");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    if (slowNoticeTimer !== undefined) {
      globalThis.clearTimeout(slowNoticeTimer);
    }
    signal?.removeEventListener("abort", abortFromCaller);
  }
};

async function readSseStream(
  response: Response,
  providerName: string,
  onDelta: (text: string) => void
): Promise<JsonPostStreamResult> {
  if (!response.body) {
    const body = parseJsonResponse(await response.text(), providerName);
    const content = readMessageContent(body);
    if (content) {
      onDelta(content);
    }
    return {
      requestId: isRecord(body) && typeof body.id === "string" ? body.id : undefined,
      model: isRecord(body) && typeof body.model === "string" ? body.model : undefined
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let requestId: string | undefined;
  let model: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, "\n");
    // The final segment is either an incomplete event or an empty tail; keep it buffered.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isRecord(parsed)) {
          continue;
        }
        if (typeof parsed.id === "string") {
          requestId = parsed.id;
        }
        if (typeof parsed.model === "string") {
          model = parsed.model;
        }
        const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
        if (!isRecord(choice)) {
          continue;
        }
        const delta = isRecord(choice.delta) ? choice.delta.content : choice.text;
        if (typeof delta === "string" && delta) {
          onDelta(delta);
        }
      }
    }
  }

  return { requestId, model };
}

function readMessageContent(body: unknown): string {
  if (!isRecord(body)) {
    return "";
  }
  if (!Array.isArray(body.choices)) {
    return "";
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return "";
  }
  return typeof choice.message.content === "string" ? choice.message.content : "";
}

function parseJsonResponse(rawBody: string, providerName: string): unknown {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error(providerName + " 返回了无法解析的响应。");
  }
}

function getErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = isRecord(value.error) && typeof value.error.message === "string"
    ? value.error.message.trim()
    : "";
  if (nested) {
    return nested;
  }
  for (const key of ["message", "detail"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
