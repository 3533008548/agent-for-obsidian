import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";

const MAX_RESULTS = 10;
const MAX_SUMMARY_LENGTH = 1_500;

export interface RawWebSearchResult {
  title?: unknown;
  link?: unknown;
  content?: unknown;
  media?: unknown;
  publish_date?: unknown;
  refer?: unknown;
}

export interface WebSearchResult {
  title: string;
  url: string;
  summary: string;
  siteName?: string;
  publishedAt?: string;
  reference?: string;
  source: SourceRef;
}

export function normalizeWebSearchLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(value)));
}

export function parseWebSearchResults(
  rawResults: RawWebSearchResult[] | undefined,
  limit: number,
  retrievedAt = new Date().toISOString()
): WebSearchResult[] {
  if (!rawResults?.length) {
    return [];
  }

  const seenUrls = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const raw of rawResults) {
    const url = toHttpUrl(raw.link);
    if (!url || seenUrls.has(url)) {
      continue;
    }

    const title = toCleanText(raw.title) || url;
    const summary = toCleanText(raw.content).slice(0, MAX_SUMMARY_LENGTH);
    const siteName = toCleanText(raw.media) || undefined;
    const publishedAt = toCleanText(raw.publish_date) || undefined;
    const reference = toCleanText(raw.refer) || undefined;
    const locator = reference ? `search-result:${reference}` : "search-result";

    seenUrls.add(url);
    results.push({
      title,
      url,
      summary,
      siteName,
      publishedAt,
      reference,
      source: {
        type: "web",
        pathOrUrl: url,
        locator,
        contentHash: hashText([title, summary, siteName ?? "", publishedAt ?? ""].join("\n")),
        parserVersion: "tavily-search-v1",
        retrievedAt
      }
    });

    if (results.length >= normalizeWebSearchLimit(limit)) {
      break;
    }
  }
  return results;
}

export function sanitizeWebAnswer(answer: string): string {
  return answer
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/gu, "$1")
    .replace(/https?:\/\/[^\s<>()]+/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderWebAnswerCaptureContent(query: string, answer: string): string {
  const cleanQuery = query.trim();
  const cleanAnswer = sanitizeWebAnswer(answer);
  if (!cleanQuery || !cleanAnswer) {
    throw new Error("联网回答为空，不能生成笔记内容。");
  }

  return [
    `> 联网问答：${cleanQuery}`,
    "",
    cleanAnswer,
    ""
  ].join("\n");
}

function toHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function toCleanText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\u0000/g, "") : "";
}
