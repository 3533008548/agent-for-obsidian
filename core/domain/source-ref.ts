export type SourceType = "note" | "pdf" | "image" | "web" | "conversation";

export interface SourceRef {
  type: SourceType;
  pathOrUrl: string;
  locator: string;
  contentHash: string;
  parserVersion: string;
  retrievedAt?: string;
}
