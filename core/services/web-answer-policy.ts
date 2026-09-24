export const WEB_FALLBACK_POLICIES = [
  "disabled",
  "stable-only",
  "always-with-warning"
] as const;

export type WebFallbackPolicy = (typeof WEB_FALLBACK_POLICIES)[number];

const FRESHNESS_PATTERN = /最新|近期|今天|昨日|昨天|明天|本周|本月|今年|目前|当前|实时|价格|股价|汇率|天气|新闻|政策|法规|比赛|赛程|比分|上线|发布|版本/iu;
const ENGLISH_FRESHNESS_PATTERN = /\b(latest|current|today|price|stock|exchange rate|weather|news|policy|regulation|score|schedule|release|version)\b/iu;

/** Returns true when a general-knowledge answer is likely to be stale or misleading. */
export function requiresFreshWebSources(query: string): boolean {
  return FRESHNESS_PATTERN.test(query) || ENGLISH_FRESHNESS_PATTERN.test(query);
}

export function shouldUseGeneralKnowledgeFallback(
  policy: WebFallbackPolicy,
  query: string
): boolean {
  switch (policy) {
    case "always-with-warning":
      return true;
    case "stable-only":
      return !requiresFreshWebSources(query);
    case "disabled":
      return false;
  }
}

export function getNoWebResultMessage(policy: WebFallbackPolicy, query: string): string {
  if (policy === "disabled") {
    return "Tavily 未返回可用网页结果，且当前已关闭 DeepSeek 通用回答兜底。";
  }
  if (policy === "stable-only" && requiresFreshWebSources(query)) {
    return "Tavily 未返回可用网页结果。该问题可能依赖实时信息，已避免自动生成可能过期的通用回答。";
  }
  return "Tavily 未返回可用网页结果。";
}
