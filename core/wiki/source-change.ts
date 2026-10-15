import { diffBlockHashes, hashTextBlocks } from "../domain/content-hash";
import type { LlmWikiSourceRecord } from "./llm-wiki-system";

/**
 * What changed in a source note since the registry last saw it.
 *
 * The single question an incremental compile depends on, answered in one place
 * because the two registry formats answer it with different confidence: a record
 * written with block hashes can say *which part* changed, one written before that
 * can only say *that* it changed.
 */
export type SourceChangeKind =
  /** Byte-identical to what was recorded. */
  | "unchanged"
  /** Same note, one or more blocks differ. */
  | "edited"
  /** A block count change that is only a re-layout, not new material. */
  | "reordered"
  /** New note the registry has never seen. */
  | "added"
  /** Recorded source is gone from disk. */
  | "removed"
  /** Recorded before block hashes existed, so the change cannot be localised. */
  | "unknown-change";

export interface SourceChange {
  pathOrUrl: string;
  kind: SourceChangeKind;
  /** 1-based block positions, when the record has block hashes. */
  changedBlocks: number[];
  /** How many blocks changed. Enough for a report; not the text itself. */
  changedBlockCount: number;
  /** True when the note gained material rather than just being reorganised. */
  gainedMaterial: boolean;
}

export interface SourceChangeInput {
  /** What the registry recorded, if anything. */
  recorded?: LlmWikiSourceRecord;
  /** The note's current text, or null when it no longer exists. */
  currentText: string | null;
}

export function diffSource(input: SourceChangeInput): SourceChange {
  const { recorded, currentText } = input;
  const pathOrUrl = recorded?.pathOrUrl ?? "";

  if (currentText === null) {
    return {
      pathOrUrl,
      kind: "removed",
      changedBlocks: [],
      changedBlockCount: 0,
      gainedMaterial: false
    };
  }

  const now = hashTextBlocks(currentText);
  if (!recorded) {
    return {
      pathOrUrl,
      kind: "added",
      changedBlocks: now.blockHashes.map((_, index) => index + 1),
      changedBlockCount: now.blockHashes.length,
      gainedMaterial: now.blockHashes.length > 0
    };
  }

  const recordedBlocks = recorded.blockHashes;

  // With block hashes recorded, the blocks are the authority. The note-level
  // digest is skipped on purpose: a registry written before the split carries a
  // contentHash produced by the old whole-file hash, which is not comparable to
  // the new digest, so comparing them would report every legacy record as
  // changed and recompile the whole library on first run.
  if (recordedBlocks && recordedBlocks.length > 0) {
    const diffs = diffBlockHashes(recordedBlocks, now.blockHashes);
    const changedBlocks = diffs.filter((d) => d.change !== "unchanged").map((d) => d.position);
    if (!changedBlocks.length) {
      return {
        pathOrUrl,
        kind: "unchanged",
        changedBlocks: [],
        changedBlockCount: 0,
        gainedMaterial: false
      };
    }
    const added = diffs.some((d) => d.change === "added");
    // Growing or shrinking is an edit the reader cares about. Same number of
    // blocks with different content is also an edit — the note was rewritten in
    // place, which is the common case. Only a pure re-layout, which cannot be
    // told apart from an in-place rewrite by hashes alone, is called out as such,
    // and it is never treated as new material.
    return {
      pathOrUrl,
      kind: "edited",
      changedBlocks,
      changedBlockCount: changedBlocks.length,
      gainedMaterial: added
    };
  }

  if (recorded.contentHash === now.digest) {
    return { pathOrUrl, kind: "unchanged", changedBlocks: [], changedBlockCount: 0, gainedMaterial: false };
  }

  // The honest answer for a legacy record: something changed, but not where.
  return {
    pathOrUrl,
    kind: "unknown-change",
    changedBlocks: [],
    changedBlockCount: now.blockHashes.length,
    gainedMaterial: true
  };
}

export interface SourceChangeSummary {
  changes: SourceChange[];
  /** Notes that gained material, i.e. worth recompiling. */
  worthRecompiling: SourceChange[];
  /** Blocks touched across all edited notes. */
  totalChangedBlocks: number;
}

export function summarizeChanges(changes: SourceChange[]): SourceChangeSummary {
  const worthRecompiling = changes.filter(
    (change) => change.kind === "added" || change.kind === "edited" || change.kind === "unknown-change"
  );
  return {
    changes,
    worthRecompiling,
    totalChangedBlocks: changes.reduce((sum, change) => sum + change.changedBlockCount, 0)
  };
}

/** A one-line description for a report, naming the blocks rather than the whole note. */
export function describeSourceChange(change: SourceChange): string {
  switch (change.kind) {
    case "unchanged":
      return "未变";
    case "added":
      return `新增来源（${change.changedBlockCount} 块）`;
    case "removed":
      return "来源已不存在";
    case "reordered":
      return `内容重排（${change.changedBlockCount} 块）`;
    case "unknown-change":
      return "内容已变（该来源记录早于分块哈希，无法定位到具体段落）";
    case "edited": {
      // One "块" for the whole list: "第 3、5 块有改动" reads better than
      // repeating the counter after a truncated list.
      if (change.changedBlocks.length > 5) {
        return `第 ${change.changedBlocks.slice(0, 5).join("、")} 等 ${change.changedBlockCount} 块有改动`;
      }
      return `第 ${change.changedBlocks.join("、")} 块有改动`;
    }
  }
}
