import type { MarkdownChunk } from "./markdown-parser";

/** BM25 term-frequency saturation: how fast repeated terms stop adding score. */
const K1 = 1.2;
/** BM25 length normalisation: 1 punishes long chunks hard, 0 ignores length. */
const LENGTH_NORMALISATION = 0.75;

/**
 * A chunk is scored as one BM25 document whose term frequencies are the
 * weighted sum of its body, heading and file name. Weighting the fields keeps
 * the "title matters more than body" behaviour that used to be encoded in
 * ad-hoc score constants, but the weight now competes with IDF and saturation
 * instead of overriding them.
 */
const FIELD_WEIGHTS = {
  content: 1,
  heading: 2,
  fileName: 3
} as const;

export interface Bm25Stats {
  documentCount: number;
  averageLength: number;
  /** Number of chunks containing a term, keyed by term. */
  documentFrequency: Map<string, number>;
}

interface ChunkTermFrequencies {
  frequencies: Map<string, number>;
  /** Weighted token count, used for length normalisation. */
  length: number;
}

/**
 * Latin/digit words plus overlapping CJK bigrams. Chinese has no spaces, so
 * bigrams are the smallest unit that still carries meaning; overlapping keeps
 * multi-character words findable from any position.
 */
export function tokenizeForSearch(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  const tokens: string[] = [];

  // Punctuation separates words, so "LangGraph-checkpoint" yields both halves
  // and stays findable by either one.
  for (const word of normalized.match(/[a-z0-9]+/gu) ?? []) {
    tokens.push(word);
  }

  for (const run of normalized.match(/[\u3400-\u9fff]+/gu) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }

  return tokens;
}

export function fileNameOf(pathOrUrl: string): string {
  const segments = pathOrUrl.replace(/\\/gu, "/").split("/");
  const name = segments[segments.length - 1] ?? pathOrUrl;
  return name.replace(/\.md$/iu, "");
}

/**
 * Inverse document frequency of a chunk collection.
 *
 * Terms that occur in almost every chunk carry no information ("笔记", "内容"),
 * so they contribute almost nothing; terms in a couple of chunks carry the
 * query. This is the part the previous fixed-weight scorer could not express.
 */
export class MarkdownBm25Corpus {
  private readonly cache = new WeakMap<MarkdownChunk, ChunkTermFrequencies>();
  private readonly stats: Bm25Stats;

  constructor(chunks: readonly MarkdownChunk[]) {
    const documentFrequency = new Map<string, number>();
    let totalLength = 0;

    for (const chunk of chunks) {
      const { frequencies, length } = this.frequenciesOf(chunk);
      totalLength += length;
      for (const term of frequencies.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    this.stats = {
      documentCount: chunks.length,
      averageLength: chunks.length ? totalLength / chunks.length : 0,
      documentFrequency
    };
  }

  get documentCount(): number {
    return this.stats.documentCount;
  }

  idfOf(term: string): number {
    const documentFrequency = this.stats.documentFrequency.get(term) ?? 0;
    if (!documentFrequency) {
      return 0;
    }
    const { documentCount } = this.stats;
    return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
  }

  score(chunk: MarkdownChunk, terms: readonly string[]): number {
    const { frequencies, length } = this.frequenciesOf(chunk);
    if (!length) {
      return 0;
    }

    const normalisation =
      1 - LENGTH_NORMALISATION +
      LENGTH_NORMALISATION * (length / (this.stats.averageLength || 1));
    let score = 0;

    for (const term of terms) {
      const frequency = frequencies.get(term);
      if (!frequency) {
        continue;
      }
      score +=
        (this.idfOf(term) * (frequency * (K1 + 1))) /
        (frequency + K1 * normalisation);
    }

    return score;
  }

  private frequenciesOf(chunk: MarkdownChunk): ChunkTermFrequencies {
    const cached = this.cache.get(chunk);
    if (cached) {
      return cached;
    }

    const frequencies = new Map<string, number>();
    const add = (text: string, weight: number): void => {
      for (const token of tokenizeForSearch(text)) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + weight);
      }
    };

    add(chunk.content, FIELD_WEIGHTS.content);
    add(chunk.heading ?? "", FIELD_WEIGHTS.heading);
    add(fileNameOf(chunk.source.pathOrUrl), FIELD_WEIGHTS.fileName);

    let length = 0;
    for (const frequency of frequencies.values()) {
      length += frequency;
    }

    const entry: ChunkTermFrequencies = { frequencies, length };
    this.cache.set(chunk, entry);
    return entry;
  }
}
