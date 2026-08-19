import { requestUrl } from "obsidian";

export interface JsonPostRequest {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  providerName: string;
}

/**
 * Shared, non-streaming JSON request path for external providers.
 * It centralizes headers, HTTP error extraction and the user-visible timeout.
 */
export async function postJson<T>(request: JsonPostRequest): Promise<T> {
  if (!request.apiKey.trim()) {
    throw new Error(`请先在本地 .env 中填写 ${request.providerName} 的 API Key。`);
  }

  const response = await withTimeout(
    requestUrl({
      url: request.url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.payload),
      throw: false
    }),
    request.timeoutMs,
    request.providerName
  );

  const body = response.json as T;
  if (response.status >= 400) {
    throw new Error(getErrorMessage(body) ?? `${request.providerName} 请求失败（HTTP ${response.status}）。`);
  }
  return body;
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

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, providerName: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${providerName} 请求超过 ${timeoutMs} 毫秒。`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}
