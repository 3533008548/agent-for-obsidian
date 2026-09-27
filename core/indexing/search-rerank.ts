import { MarkdownBm25Corpus, tokenizeForSearch } from "./bm25";
import type { MarkdownChunk } from "./markdown-parser";
import type { MarkdownSearchResult } from "./markdown-search";

/**
 * Structured signals a note carries beyond its prose. BM25 only sees words, so
 * the curator's own classifications — tags, outgoing links, which folder the
 * note lives in, which section it sits under — are invisible to it. These are
 * the cheapest relevance signals available: they are already in the files,
 * they cost no model call, and unlike an embedding they can be explained.
 */
const SIGNAL_WEIGHTS = {
  /** Explicitly assigned by the user, so the most reliable signal. */
  tag: 1.2,
  /** The note points at this concept by name. */
  link: 0.8,
  /** Folders are manual topic classification. */
  folder: 0.5,
  /** Ancestor headings describe what the chunk is part of. */
  ancestorHeading: 0.4
} as const;

/**
 * Proximity to the open note is a prior, not evidence: it says "look here
 * first", not "this matches better". Applying it as a multiplier instead of an
 * additive bonus keeps a barely-matching neighbour from jumping over a note
 * that actually answers the question.
 */
const ACTIVE_UPLIFT = {
  /** The open note links to this note, or this note links back to it. */
  link: 0.5,
  /** Same folder as the open note. */
  folder: 0.25
} as const;

/**
 * Substitute IDF for a term that appears in no chunk body at all. That happens
 * when the match only exists in a folder name or a tag, where an IDF of 0
 * would discard the strongest evidence. Terms that genuinely are common keep
 * their near-zero IDF — the floor is not a minimum, it is an "unknown" value.
 */
const UNKNOWN_IDF = 0.35;

interface ChunkSignals {
  tagTokens: Set<string>;
  linkTokens: Set<string>;
  folderTokens: Set<string>;
  ancestorTokens: Set<string>;
  /** Normalised link targets, used to match against another note's path. */
  linkTargets: Set<string>;
  folder: string;
}

interface ActiveNoteContext {
  path: string;
  folders: Set<string>;
  linkedTargets: Set<string>;
}

export interface RerankContext {
  corpus: MarkdownBm25Corpus;
  /** Chunks of the note open in the editor, when there is one. */
  activeChunks?: MarkdownChunk[];
}

const signalCache = new WeakMap<MarkdownChunk, ChunkSignals>();

/**
 * Re-score BM25 candidates with structured signals.
 *
 * Boosts are multiplied by IDF for the same reason BM25 scores are: a tag or a
 * folder named after a filler word must not buy relevance. Boosting happens
 * after recall, not instead of it — a note still has to match the query to be
 * in `results` at all.
 */
export function rerankSearchResults(
  results: MarkdownSearchResult[],
  terms: readonly string[],
  context: RerankContext
): MarkdownSearchResult[] {
  const active = context.activeChunks?.length
    ? buildActiveNoteContext(context.activeChunks)
    : null;

  return results
    .map((result) => {
      const score = result.score + signalBoost(result.chunk, terms, context.corpus);
      return { ...result, score: score * (1 + activeUplift(result.chunk, active)) };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.chunk.source.pathOrUrl.localeCompare(right.chunk.source.pathOrUrl)
    );
}

function signalBoost(
  chunk: MarkdownChunk,
  terms: readonly string[],
  corpus: MarkdownBm25Corpus
): number {
  const signals = chunkSignals(chunk);
  let boost = 0;

  for (const term of terms) {
    const idf = corpus.idfOf(term);
    const weight = idf > 0 ? idf : UNKNOWN_IDF;
    if (signals.tagTokens.has(term)) {
      boost += SIGNAL_WEIGHTS.tag * weight;
    }
    if (signals.linkTokens.has(term)) {
      boost += SIGNAL_WEIGHTS.link * weight;
    }
    if (signals.folderTokens.has(term)) {
      boost += SIGNAL_WEIGHTS.folder * weight;
    }
    if (signals.ancestorTokens.has(term)) {
      boost += SIGNAL_WEIGHTS.ancestorHeading * weight;
    }
  }

  return boost;
}

function activeUplift(chunk: MarkdownChunk, active: ActiveNoteContext | null): number {
  if (!active || active.path === chunk.source.pathOrUrl) {
    return 0;
  }

  const signals = chunkSignals(chunk);
  let uplift = 0;
  // Either direction counts: "what does this note link to" and "what links to
  // this note" are both the user's own statements that the two are related.
  if (active.linkedTargets.has(noteKey(chunk.source.pathOrUrl)) ||
      signals.linkTargets.has(noteKey(active.path))) {
    uplift += ACTIVE_UPLIFT.link;
  }
  if (signals.folder && active.folders.has(signals.folder)) {
    uplift += ACTIVE_UPLIFT.folder;
  }
  return uplift;
}

function buildActiveNoteContext(chunks: MarkdownChunk[]): ActiveNoteContext {
  const folders = new Set<string>();
  const linkedTargets = new Set<string>();

  for (const chunk of chunks) {
    const signals = chunkSignals(chunk);
    if (signals.folder) {
      folders.add(signals.folder);
    }
    for (const target of signals.linkTargets) {
      linkedTargets.add(target);
    }
  }

  return { path: chunks[0].source.pathOrUrl, folders, linkedTargets };
}

export function chunkSignals(chunk: MarkdownChunk): ChunkSignals {
  const cached = signalCache.get(chunk);
  if (cached) {
    return cached;
  }

  const folder = folderOf(chunk.source.pathOrUrl);
  const signals: ChunkSignals = {
    tagTokens: toTokens(extractTags(chunk.content)),
    linkTokens: toTokens(extractLinkTitles(chunk.content)),
    folderTokens: toTokens(folder.split("/")),
    ancestorTokens: toTokens(chunk.headingPath.slice(0, -1)),
    linkTargets: new Set(extractLinkTitles(chunk.content).map(noteKey)),
    folder
  };
  signalCache.set(chunk, signals);
  return signals;
}

/** Tags from frontmatter plus inline `#tag`, ignoring headings and code. */
export function extractTags(content: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const tags: string[] = [];

  if (frontmatter) {
    let collecting = false;
    for (const line of frontmatter[1].split("\n")) {
      const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
      if (item && collecting) {
        tags.push(cleanTag(item[1]));
        continue;
      }
      const field = /^\s*(tag|tags|alias|aliases)\s*:\s*(.*)$/u.exec(line);
      collecting = field !== null && !field[2].trim();
      if (field?.[2]) {
        tags.push(...field[2].replace(/[[\]]/gu, " ").split(",").map(cleanTag));
      }
    }
  }

  let insideCodeFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      insideCodeFence = !insideCodeFence;
      continue;
    }
    if (insideCodeFence || /^\s*#{1,6}\s/u.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/(?:^|[^\w#\\])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu)) {
      tags.push(cleanTag(match[1]));
    }
  }

  return tags.filter(Boolean);
}

/** Titles inside `[[wikilink]]`, with `|alias` and `#heading` stripped. */
export function extractLinkTitles(content: string): string[] {
  const titles: string[] = [];
  for (const match of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)) {
    titles.push(match[1].trim());
  }
  return titles;
}

function folderOf(pathOrUrl: string): string {
  const segments = pathOrUrl.replace(/\\/gu, "/").split("/");
  return segments.slice(0, -1).join("/");
}

function noteKey(pathOrUrl: string): string {
  const normalized = pathOrUrl.replace(/\\/gu, "/").replace(/\.md$/iu, "");
  const segments = normalized.split("/");
  return (segments[segments.length - 1] ?? normalized).toLocaleLowerCase();
}

function cleanTag(tag: string): string {
  return tag.trim().replace(/^#/u, "").replace(/^["']|["']$/gu, "");
}

function toTokens(values: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const token of tokenizeForSearch(value)) {
      tokens.add(token);
    }
  }
  return tokens;
}
