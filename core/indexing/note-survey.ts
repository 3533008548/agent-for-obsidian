import { extractLinkTitles, extractTags } from "./search-rerank";
import type { MarkdownChunk } from "./markdown-parser";

/**
 * The smallest description of a note that still lets a model tell what it is
 * about. Full bodies are deliberately not included: a whole library does not
 * fit in one request, and titles plus tags carry most of the grouping signal.
 */
export interface NoteDigest {
  path: string;
  title: string;
  tags: string[];
  links: string[];
  excerpt: string;
}

/** Default notes per clustering request. */
export const DIGEST_BATCH_SIZE = 40;

const MAX_TAGS = 8;
const MAX_LINKS = 8;
const MAX_EXCERPT_LENGTH = 160;

/**
 * Collapses indexed chunks into one digest per note.
 *
 * Frontmatter-only chunks are skipped for the excerpt — a chunk whose body is
 * just `tags: [...]` would otherwise become the note's entire description.
 */
export function buildNoteDigests(chunks: readonly MarkdownChunk[]): NoteDigest[] {
  const byPath = new Map<string, MarkdownChunk[]>();
  for (const chunk of chunks) {
    const list = byPath.get(chunk.source.pathOrUrl);
    if (list) {
      list.push(chunk);
    } else {
      byPath.set(chunk.source.pathOrUrl, [chunk]);
    }
  }

  const digests: NoteDigest[] = [];
  for (const [path, noteChunks] of byPath) {
    const tags = new Set<string>();
    const links = new Set<string>();
    let title = "";
    let excerpt = "";

    for (const chunk of noteChunks) {
      for (const tag of extractTags(chunk.content)) {
        if (tags.size < MAX_TAGS) {
          tags.add(tag);
        }
      }
      for (const link of extractLinkTitles(chunk.content)) {
        if (links.size < MAX_LINKS) {
          links.add(link);
        }
      }
      if (!title && chunk.heading) {
        title = chunk.heading;
      }
      if (isFrontmatterChunk(chunk.content)) {
        continue;
      }
      const candidate = compact(chunk.content);
      if (candidate.length > excerpt.length) {
        excerpt = candidate;
      }
    }

    digests.push({
      path,
      title: title || titleFromPath(path),
      tags: [...tags],
      links: [...links],
      excerpt: excerpt.slice(0, MAX_EXCERPT_LENGTH)
    });
  }

  return digests.sort((left, right) => left.path.localeCompare(right.path));
}

/** Splits digests into request-sized batches. */
export function batchNoteDigests(
  digests: readonly NoteDigest[],
  size = DIGEST_BATCH_SIZE
): NoteDigest[][] {
  const batches: NoteDigest[][] = [];
  for (let index = 0; index < digests.length; index += size) {
    batches.push(digests.slice(index, index + size));
  }
  return batches;
}

/** One line per note, compact enough that 40 of them fit in a request. */
export function renderNoteDigest(digest: NoteDigest): string {
  const parts = [`路径：${digest.path}`, `标题：${digest.title}`];
  if (digest.tags.length) {
    parts.push(`标签：${digest.tags.join("、")}`);
  }
  if (digest.links.length) {
    parts.push(`链接：${digest.links.join("、")}`);
  }
  if (digest.excerpt) {
    parts.push(`摘要：${digest.excerpt}`);
  }
  return `- ${parts.join(" ｜ ")}`;
}

function titleFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/iu, "").trim() || path;
}

function isFrontmatterChunk(content: string): boolean {
  return content.trimStart().startsWith("---");
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
