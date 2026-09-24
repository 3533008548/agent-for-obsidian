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
  const requiredTerms = extractRequiredTerms(normalizedQuery);
  const ranked = chunks
    .map((chunk) => {
      const haystack = chunk.content.toLocaleLowerCase();
      const heading = (chunk.heading ?? "").toLocaleLowerCase();
      const fileName = getFileName(chunk.source.pathOrUrl).toLocaleLowerCase();
      let score = 0;

      if (haystack.includes(normalizedQuery)) {
        score += 12;
      }
      if (heading.includes(normalizedQuery)) {
        score += 20;
      }
      if (fileName.includes(normalizedQuery)) {
        score += 16;
      }

      for (const term of terms) {
        score += countOccurrences(haystack, term) * 2;
        score += countOccurrences(heading, term) * 5;
        score += countOccurrences(fileName, term) * (term.length >= 3 ? 18 : 6);
      }

      return {
        chunk,
        score,
        excerpt: createExcerpt(chunk.content, normalizedQuery, terms),
        matchesRequiredTerms: requiredTerms.every((term) => `${haystack}\n${heading}\n${fileName}`.includes(term))
      };
    })
    .filter((result) => result.score > 0 && result.matchesRequiredTerms)
    .map(({ matchesRequiredTerms: _matchesRequiredTerms, ...result }) => result)
    .sort((left, right) => right.score - left.score || left.chunk.source.pathOrUrl.localeCompare(right.chunk.source.pathOrUrl));
  return selectDiverseSearchResults(ranked, limit);
}

export function selectDiverseSearchResults(
  results: MarkdownSearchResult[],
  limit = 8
): MarkdownSearchResult[] {
  const distinctPaths: MarkdownSearchResult[] = [];
  const remaining: MarkdownSearchResult[] = [];
  const seenPaths = new Set<string>();

  for (const result of results) {
    const path = result.chunk.source.pathOrUrl;
    if (seenPaths.has(path)) {
      remaining.push(result);
      continue;
    }
    seenPaths.add(path);
    distinctPaths.push(result);
  }
  return [...distinctPaths, ...remaining].slice(0, limit);
}

function extractSearchTerms(query: string): string[] {
  const terms = new Set(query.match(/[a-z0-9][a-z0-9._-]*/gu) ?? []);
  for (const run of query.match(/[\u3400-\u9fff]{2,}/gu) ?? []) {
    terms.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return [...terms];
}

function extractRequiredTerms(query: string): string[] {
  const stopWords = new Set(["a", "an", "are", "do", "does", "how", "is", "of", "the", "to", "what", "why"]);
  return [...new Set(query.match(/[a-z][a-z0-9._-]{2,}/gu) ?? [])]
    .filter((term) => !stopWords.has(term));
}

function getFileName(path: string): string {
  const segments = path.replace(/\\/gu, "/").split("/");
  const name = segments[segments.length - 1] ?? path;
  return name.replace(/\.md$/iu, "");
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
