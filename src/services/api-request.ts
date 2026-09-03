import { requestUrl } from "obsidian";

export interface JsonPostRequest {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  slowResponseMs?: number;
  providerName: string;
  onSlowResponse?: () => void;
}

/**
 * Shared, non-streaming JSON request path for external providers.
 * It centralizes headers and HTTP error extraction. A slow response only updates
 * the UI; it must not reject the caller while requestUrl is still in flight.
 */
export async function postJson<T>(request: JsonPostRequest): Promise<T> {
  if (!request.apiKey.trim()) {
    throw new Error(`请先在本地 .env 中填写 ${request.providerName} 的 API Key。`);
  }

  let slowNoticeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  if (request.onSlowResponse && request.slowResponseMs && request.slowResponseMs > 0) {
    slowNoticeTimer = globalThis.setTimeout(() => {
      try {
        request.onSlowResponse?.();
      } catch {
        // A notification failure must not affect the network request.
      }
    }, request.slowResponseMs);
  }

  try {
    const response = await requestUrl({
      url: request.url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.payload),
      throw: false
    });

    const body = response.json as T;
    if (response.status >= 400) {
      throw new Error(getErrorMessage(body) ?? `${request.providerName} 请求失败（HTTP ${response.status}）。`);
    }
    return body;
  } finally {
    if (slowNoticeTimer !== undefined) {
      globalThis.clearTimeout(slowNoticeTimer);
    }
  }
}

function getErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const errorMessage = isRecord(value.error) && typeof value.error.message === "string"
    ? value.error.message.trim()
    : "";
  if (errorMessage) {
    return errorMessage;
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
