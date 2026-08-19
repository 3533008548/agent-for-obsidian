import { postJson } from "./api-request";
import {
  normalizeWebSearchLimit,
  parseWebSearchResults,
  type WebSearchResult
} from "./web-search";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MINIMUM_SUMMARY_LENGTH = 40;

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
}

interface TavilySearchResponse {
  request_id?: string;
  results?: TavilyResult[];
}

export interface TavilyClientOptions {
  apiKey: string;
  timeoutMs: number;
}

export interface TavilySearchResult {
  requestId?: string;
  sources: WebSearchResult[];
}

/** A successful Tavily request did not contain enough safe content to answer from. */
export class NoUsableWebResultsError extends Error {
  constructor() {
    super("Tavily 未返回可用的网页结果。");
    this.name = "NoUsableWebResultsError";
  }
}

export class TavilyClient {
  constructor(private readonly options: TavilyClientOptions) {}

  async search(query: string, resultLimit: number): Promise<TavilySearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("联网搜索关键词不能为空。");
    }

    const limit = normalizeWebSearchLimit(resultLimit);
    const body = await postJson<TavilySearchResponse>({
      url: TAVILY_SEARCH_URL,
      apiKey: this.options.apiKey,
      timeoutMs: this.options.timeoutMs,
      providerName: "Tavily",
      payload: {
        query: normalizedQuery,
        topic: "general",
        search_depth: "basic",
        max_results: limit,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      }
    });
    const sources = parseWebSearchResults(
      body.results?.map((result) => ({
        title: result.title,
        link: result.url,
        content: result.content,
        publish_date: result.published_date
      })),
      limit
    ).filter((source) => source.summary.length >= MINIMUM_SUMMARY_LENGTH);
    if (!sources.length) {
      throw new NoUsableWebResultsError();
    }
    return { requestId: body.request_id, sources };
  }
}
