import type { MarkdownChunk } from "./markdown-parser";

export interface MarkdownSearchResult {
  chunk: MarkdownChunk;
  score: number;
  excerpt: string;
}

export function searchMarkdownChunks(
  chunks: MarkdownChunk[],
  query: string,
  limit = 8
): MarkdownSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const terms = extractSearchTerms(normalizedQuery);
  return chunks
    .map((chunk) => {
      const haystack = chunk.content.toLocaleLowerCase();
      const heading = (chunk.heading ?? "").toLocaleLowerCase();
      let score = 0;

      if (haystack.includes(normalizedQuery)) {
        score += 12;
      }
      if (heading.includes(normalizedQuery)) {
        score += 20;
      }

      for (const term of terms) {
        score += countOccurrences(haystack, term) * 2;
        score += countOccurrences(heading, term) * 5;
      }

      return {
        chunk,
        score,
        excerpt: createExcerpt(chunk.content, normalizedQuery, terms)
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.source.pathOrUrl.localeCompare(right.chunk.source.pathOrUrl))
    .slice(0, limit);
}

function extractSearchTerms(query: string): string[] {
  const terms = new Set(query.match(/[\p{L}\p{N}]+/gu) ?? []);
  for (const run of query.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return [...terms];
}

function countOccurrences(text: string, term: string): number {
  if (!term) {
    return 0;
  }

  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function createExcerpt(content: string, query: string, terms: string[]): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  const matchTerm = [query, ...terms].find((term) => flattened.toLocaleLowerCase().includes(term));
  const index = matchTerm ? flattened.toLocaleLowerCase().indexOf(matchTerm) : 0;
  const start = Math.max(0, index - 72);
  const end = Math.min(flattened.length, index + 180);
  return `${start > 0 ? "…" : ""}${flattened.slice(start, end)}${end < flattened.length ? "…" : ""}`;
}
