export interface JsonPostRequest {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  slowResponseMs?: number;
  providerName: string;
  onSlowResponse?: () => void;
}

export type JsonPost = <T>(request: JsonPostRequest) => Promise<T>;
