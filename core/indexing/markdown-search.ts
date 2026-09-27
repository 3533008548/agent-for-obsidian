import { MarkdownBm25Corpus, fileNameOf, tokenizeForSearch } from "./bm25";
import type { MarkdownChunk } from "./markdown-parser";

export interface MarkdownSearchResult {
  chunk: MarkdownChunk;
  score: number;
  excerpt: string;
}

/**
 * Bonus for chunks that contain the whole query verbatim. BM25 scores terms
 * independently, so an exact phrase still needs a small nudge to outrank a
 * chunk that merely shares more bigrams with the question.
 */
const PHRASE_BONUS = {
  content: 1.5,
  heading: 1,
  fileName: 0.8
} as const;

/**
 * Rank chunks against a query.
 *
 * Scoring is BM25 over a pseudo-document per chunk (body + heading + file
 * name), which replaces the previous fixed per-hit weights: repeated terms
 * saturate, long chunks are normalised, and terms that appear everywhere are
 * discounted by IDF.
 *
 * `corpus` carries the IDF statistics. Callers that keep a long-lived index
 * should build it once and pass it in; when omitted it is derived from
 * `chunks`, which is correct but re-tokenises everything on every query.
 */
export function searchMarkdownChunks(
  chunks: MarkdownChunk[],
  query: string,
  limit = 8,
  corpus: MarkdownBm25Corpus = new MarkdownBm25Corpus(chunks)
): MarkdownSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const terms = extractSearchTerms(normalizedQuery);
  const requiredTerms = extractRequiredTerms(normalizedQuery);
  const ranked: MarkdownSearchResult[] = [];

  for (const chunk of chunks) {
    const haystack = chunk.content.toLocaleLowerCase();
    const heading = (chunk.heading ?? "").toLocaleLowerCase();
    const fileName = fileNameOf(chunk.source.pathOrUrl).toLocaleLowerCase();
    const searchableText = `${haystack}\n${heading}\n${fileName}`;

    if (!requiredTerms.every((term) => searchableText.includes(term))) {
      continue;
    }

    const score = corpus.score(chunk, terms) + phraseBonus(normalizedQuery, haystack, heading, fileName);
    if (score <= 0) {
      continue;
    }

    ranked.push({
      chunk,
      score,
      excerpt: createExcerpt(chunk.content, normalizedQuery, terms)
    });
  }

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.chunk.source.pathOrUrl.localeCompare(right.chunk.source.pathOrUrl)
  );
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
  const terms = new Set(tokenizeForSearch(query));
  for (const run of query.match(/[\u3400-\u9fff]{2,}/gu) ?? []) {
    terms.add(run);
  }
  return [...terms];
}

function extractRequiredTerms(query: string): string[] {
  const stopWords = new Set(["a", "an", "are", "do", "does", "how", "is", "of", "the", "to", "what", "why"]);
  return [...new Set(query.match(/[a-z][a-z0-9._-]{2,}/gu) ?? [])]
    .filter((term) => !stopWords.has(term));
}

function phraseBonus(
  query: string,
  haystack: string,
  heading: string,
  fileName: string
): number {
  let bonus = 0;
  if (haystack.includes(query)) {
    bonus += PHRASE_BONUS.content;
  }
  if (heading.includes(query)) {
    bonus += PHRASE_BONUS.heading;
  }
  if (fileName.includes(query)) {
    bonus += PHRASE_BONUS.fileName;
  }
  return bonus;
}

function createExcerpt(content: string, query: string, terms: string[]): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  const matchTerm = [query, ...terms].find((term) => flattened.toLocaleLowerCase().includes(term));
  const index = matchTerm ? flattened.toLocaleLowerCase().indexOf(matchTerm) : 0;
  const start = Math.max(0, index - 72);
  const end = Math.min(flattened.length, index + 180);
  return `${start > 0 ? "…" : ""}${flattened.slice(start, end)}${end < flattened.length ? "…" : ""}`;
}
