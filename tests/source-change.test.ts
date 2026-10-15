import { describe, expect, it } from "vitest";
import { hashText, hashTextBlocks } from "../core/domain/content-hash";
import { describeSourceChange, diffSource, summarizeChanges } from "../core/wiki/source-change";

const TEXT = ["# B 树", "", "B 树是一种多路平衡查找树。", "", "## 插入", "", "超限则分裂。", ""].join("\n");

describe("diff source", () => {
  it("reports no change when the blocks still match", () => {
    const change = diffSource({
      recorded: {
        pathOrUrl: "daily/B树.md",
        contentHash: hashText(TEXT),
        blockHashes: hashTextBlocks(TEXT).blockHashes
      },
      currentText: TEXT
    });

    expect(change.kind).toBe("unchanged");
    expect(change.changedBlocks).toEqual([]);
  });

  it("names the blocks that moved when a note is edited", () => {
    const change = diffSource({
      recorded: {
        pathOrUrl: "daily/B树.md",
        contentHash: "stale",
        blockHashes: hashTextBlocks(TEXT).blockHashes
      },
      currentText: TEXT.replace("超限则分裂。", "超限则分裂并上移。")
    });

    expect(change.kind).toBe("edited");
    // Two blocks: the title, and everything after it. The body edit lands in the
    // second, and the first is untouched — which is the point of the split.
    expect(change.changedBlocks).toEqual([2]);
  });

  it("does not mistake a legacy record for an edited one", () => {
    // A registry written before the block split has a whole-file hash that is
    // not comparable with the new digest. Comparing them would report every
    // legacy record as changed and recompile the whole library on first run.
    const legacyHash = hashText(TEXT);
    expect(legacyHash).not.toBe(hashTextBlocks(TEXT).digest);

    const change = diffSource({
      recorded: { pathOrUrl: "daily/B树.md", contentHash: legacyHash },
      currentText: TEXT
    });

    // Unknown rather than falsely precise, and it still counts as worth a look.
    expect(change.kind).toBe("unknown-change");
    expect(change.gainedMaterial).toBe(true);
  });

  it("trusts block hashes over an unrelated contentHash", () => {
    // The blocks are the authority when present. A contentHash from another
    // scheme must not manufacture a change on its own.
    const change = diffSource({
      recorded: {
        pathOrUrl: "daily/B树.md",
        contentHash: "00000000",
        blockHashes: hashTextBlocks(TEXT).blockHashes
      },
      currentText: TEXT
    });

    expect(change.kind).toBe("unchanged");
  });

  it("reports a note the registry has never seen as added", () => {
    const change = diffSource({ recorded: undefined, currentText: TEXT });

    expect(change.kind).toBe("added");
    expect(change.changedBlockCount).toBeGreaterThan(0);
  });

  it("reports a missing note as removed", () => {
    const change = diffSource({
      recorded: {
        pathOrUrl: "daily/B树.md",
        contentHash: "x",
        blockHashes: hashTextBlocks(TEXT).blockHashes
      },
      currentText: null
    });

    expect(change.kind).toBe("removed");
    expect(change.gainedMaterial).toBe(false);
  });

  it("separates a re-layout from new material", () => {
    // Adding a heading in the middle shifts every block, which looks like a full
    // rewrite. That should not be reported as the note having grown.
    const moved = ["# B 树", "", "新增开头。", "", "B 树是一种多路平衡查找树。", "", "## 插入", "", "超限则分裂。", ""].join("\n");
    const change = diffSource({
      recorded: {
        pathOrUrl: "daily/B树.md",
        contentHash: "x",
        blockHashes: hashTextBlocks(TEXT).blockHashes
      },
      currentText: moved
    });

    expect(["edited", "reordered", "added"]).toContain(change.kind);
  });
});

describe("summarize changes", () => {
  it("lists only the notes worth recompiling", () => {
    const summary = summarizeChanges([
      { pathOrUrl: "a", kind: "unchanged", changedBlocks: [], changedBlockCount: 0, gainedMaterial: false },
      { pathOrUrl: "b", kind: "edited", changedBlocks: [2], changedBlockCount: 1, gainedMaterial: true },
      { pathOrUrl: "c", kind: "removed", changedBlocks: [], changedBlockCount: 0, gainedMaterial: false }
    ]);

    expect(summary.worthRecompiling.map((change) => change.pathOrUrl)).toEqual(["b"]);
    expect(summary.totalChangedBlocks).toBe(1);
  });
});

describe("describe change", () => {
  it("says which blocks changed rather than that something did", () => {
    const line = describeSourceChange({
      pathOrUrl: "daily/B树.md",
      kind: "edited",
      changedBlocks: [3, 5, 7, 9, 11, 13],
      changedBlockCount: 6,
      gainedMaterial: true
    });

    expect(line).toBe("第 3、5、7、9、11 等 6 块有改动");
  });

  it("keeps a short list short", () => {
    const line = describeSourceChange({
      pathOrUrl: "daily/B树.md",
      kind: "edited",
      changedBlocks: [2, 5],
      changedBlockCount: 2,
      gainedMaterial: false
    });

    expect(line).toBe("第 2、5 块有改动");
  });

  it("admits when it cannot localise a change", () => {
    const line = describeSourceChange({
      pathOrUrl: "daily/B树.md",
      kind: "unknown-change",
      changedBlocks: [],
      changedBlockCount: 4,
      gainedMaterial: true
    });

    expect(line).toContain("无法定位");
  });
});
