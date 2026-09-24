import type { JsonPost, JsonPostRequest } from "./json-post";

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

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
