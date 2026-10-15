export function hashText(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashArrayBuffer(input: ArrayBuffer): string {
  let hash = 0x811c9dc5;
  const bytes = new Uint8Array(input);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A note split into stable, individually-hashed blocks.
 *
 * A single hash over the whole text cannot answer the question an incremental
 * compile actually needs: *what changed*. Any edit, down to a typo, produces an
 * unrelated value, so every small correction reads as a full rewrite and triggers
 * recompiling the note from scratch. Per block, an unchanged paragraph keeps its
 * value, so the difference is a position rather than a guess.
 *
 * Blocks follow Markdown structure rather than a fixed width, because where a
 * note is edited is where it is edited: inside a section. Splitting on headings
 * and blank lines also keeps a block from being one enormous paragraph whose
 * hash is as fragile as the whole-file version.
 */
export const MAX_BLOCK_HASHES = 512;

export interface BlockHashResult {
  /** One hash per block, in document order. */
  blockHashes: string[];
  /**
   * Hash of the ordered block hashes, so a block count change is also a change.
   * This is what older code paths compare; it is not meant to be compared
   * against {@link hashText} output.
   */
  digest: string;
}

/** Long paragraphs are split further so one dense block cannot dominate. */
const MAX_BLOCK_CHARS = 1200;

export function hashTextBlocks(input: string): BlockHashResult {
  const normalized = input.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return { blockHashes: [], digest: hashText("") };
  }

  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join("\n").trim();
    if (text) {
      blocks.push(text);
    }
    current = [];
  };

  let inFence = false;
  for (const line of normalized.split("\n")) {
    // Fenced code is kept whole: a snippet is one unit, and splitting it would
    // make every re-indent look like an edit to the note that quotes it.
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
    }
    if (!inFence && (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### "))) {
      flush();
    }
    current.push(line);
    // Never break a fence open: a snippet longer than the limit stays one block,
    // because half a diagram is worth less than a stable hash.
    if (!inFence && current.join("\n").length >= MAX_BLOCK_CHARS) {
      flush();
    }
  }
  flush();

  const limited = blocks.slice(0, MAX_BLOCK_HASHES);
  const blockHashes = limited.map((block) => hashText(block));
  return { blockHashes, digest: hashText(blockHashes.join("|")) };
}

export type BlockChange = "unchanged" | "edited" | "added" | "removed";

export interface BlockDiff {
  change: BlockChange;
  /** 1-based block number, matching the order in {@link hashTextBlocks}. */
  position: number;
  hash: string;
}

/**
 * Compare two block-hash sets position by position.
 *
 * Positional because that is the granularity the block split bought us. The
 * caller can now say "block 4 changed" instead of "something changed", which is
 * the difference between recompiling a section and recompiling a note.
 */
export function diffBlockHashes(
  previous: readonly string[],
  next: readonly string[]
): BlockDiff[] {
  const diffs: BlockDiff[] = [];
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    diffs.push({
      change: before === after ? "unchanged" : "edited",
      position: index + 1,
      hash: after
    });
  }
  for (let index = shared; index < next.length; index += 1) {
    diffs.push({ change: "added", position: index + 1, hash: next[index]! });
  }
  for (let index = shared; index < previous.length; index += 1) {
    diffs.push({ change: "removed", position: index + 1, hash: previous[index]! });
  }
  return diffs;
}
