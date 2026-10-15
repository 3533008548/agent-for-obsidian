import { describe, expect, it } from "vitest";
import { diffBlockHashes, hashTextBlocks, MAX_BLOCK_HASHES } from "../core/domain/content-hash";

const NOTE = [
  "---",
  "topic: B 树",
  "---",
  "",
  "# B 树是什么",
  "",
  "B 树是一种自平衡的多路搜索树。",
  "",
  "## 插入",
  "",
  "插入时若关键字数超限则分裂。",
  "",
  "## 删除",
  "",
  "删除时若低于下限则向兄弟借一个键。",
  ""
].join("\n");

describe("block hashes", () => {
  it("gives the same answer for the same text", () => {
    expect(hashTextBlocks(NOTE).digest).toBe(hashTextBlocks(NOTE).digest);
  });

  it("ignores line endings and trailing whitespace", () => {
    // A note that came back from a Windows editor should not read as edited.
    expect(hashTextBlocks(NOTE.replace(/\n/g, "\r\n")).digest).toBe(hashTextBlocks(NOTE).digest);
    expect(hashTextBlocks(`${NOTE}\n\n  \n`).digest).toBe(hashTextBlocks(NOTE).digest);
  });

  it("localises an edit instead of marking the whole note changed", () => {
    // This is the reason for the block split. With one hash over the file, a
    // single typo and a full rewrite are indistinguishable.
    const before = hashTextBlocks(NOTE);
    const after = hashTextBlocks(NOTE.replace("向兄弟借一个键", "向兄弟借一个键。"));
    const changed = diffBlockHashes(before.blockHashes, after.blockHashes).filter(
      (d) => d.change !== "unchanged"
    );

    expect(before.digest).not.toBe(after.digest);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.change).toBe("edited");
  });

  it("reports an appended section as an addition, not a rewrite", () => {
    const before = hashTextBlocks(NOTE);
    const after = hashTextBlocks(`${NOTE}\n## 性能\n\n查找是 O(log n)。\n`);
    const changes = diffBlockHashes(before.blockHashes, after.blockHashes).filter(
      (d) => d.change !== "unchanged"
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]!.change).toBe("added");
    expect(changes[0]!.position).toBe(before.blockHashes.length + 1);
  });

  it("reports a deleted section as a removal", () => {
    const withExtra = hashTextBlocks(`${NOTE}\n## 性能\n\n查找是 O(log n)。\n`);
    const without = hashTextBlocks(NOTE);
    const changes = diffBlockHashes(withExtra.blockHashes, without.blockHashes).filter(
      (d) => d.change !== "unchanged"
    );

    expect(changes.some((c) => c.change === "removed")).toBe(true);
  });

  it("keeps an unmodified section unchanged when a later one is edited", () => {
    // The property that makes incremental compile possible at all: editing the
    // delete section must not invalidate the insert section's hash.
    const before = hashTextBlocks(NOTE);
    const after = hashTextBlocks(NOTE.replace("插入时若关键字数超限则分裂。", "插入时若关键字数超限则分裂并上移。"));
    const diffs = diffBlockHashes(before.blockHashes, after.blockHashes);
    const insert = diffs.find((d) => d.position === 2);

    expect(insert?.change).toBe("unchanged");
  });

  it("treats a fenced diagram as one block so a re-indent is a real edit", () => {
    // Not a convenience: a diagram quoted across several notes must hash the
    // same wherever it appears, so it is never broken by the length cutoff.
    const withFence = [
      "## 插入",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[插入] --> B{超过 m?}",
      "```"
    ].join("\n");
    const longFence = [
      "## 插入",
      "",
      "```mermaid",
      "flowchart TD",
      ...Array.from({ length: 80 }, (_, i) => `  N${i}[节点${i}] --> N${i + 1}[下一步]`),
      "```"
    ].join("\n");
    const result = hashTextBlocks(longFence);

    // One heading plus the whole diagram, however long the diagram is.
    expect(result.blockHashes).toHaveLength(1);
    expect(hashTextBlocks(withFence).blockHashes).toHaveLength(1);
  });

  it("bounds how many blocks one note can produce", () => {
    const huge = Array.from({ length: MAX_BLOCK_HASHES + 50 }, (_, i) => `## 小节 ${i}\n\n内容。`).join("\n");

    expect(hashTextBlocks(huge).blockHashes).toHaveLength(MAX_BLOCK_HASHES);
  });

  it("handles an empty note without inventing a block", () => {
    expect(hashTextBlocks("").blockHashes).toEqual([]);
    expect(hashTextBlocks("   \n\n ").blockHashes).toEqual([]);
  });

  it("numbers positions from one so they can be shown to a reader", () => {
    const diffs = diffBlockHashes(["a", "b"], ["a", "c"]);

    expect(diffs.map((d) => d.position)).toEqual([1, 2]);
  });
});
