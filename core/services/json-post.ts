export interface JsonPostRequest {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  slowResponseMs?: number;
  providerName: string;
  onSlowResponse?: () => void;
}

export type JsonPost = <T>(request: JsonPostRequest) => Promise<T>;

/** Metadata collected while a streaming completion runs. */
export interface JsonPostStreamResult {
  requestId?: string;
  model?: string;
}

/**
 * Streams a provider completion, invoking `onDelta` with each newly arrived text
 * fragment. `signal` lets the caller cancel an in-flight generation.
 */
export type JsonPostStream = (
  request: JsonPostRequest,
  onDelta: (text: string) => void,
  signal?: AbortSignal
) => Promise<JsonPostStreamResult>;
