import { describe, expect, it } from "vitest";
import { isAgentMemoryPath, isInternalLibraryPath } from "../core/memory/agent-memory";

describe("agent memory paths", () => {
  it("claims the files the agent keeps about itself", () => {
    expect(isAgentMemoryPath("00 Inbox/Agent/Sessions/2026-10-03-分布式系统-abc.md", "00 Inbox/Agent")).toBe(true);
    expect(isAgentMemoryPath("00 Inbox/Agent/Agent Profile.md", "00 Inbox/Agent")).toBe(true);
    expect(isAgentMemoryPath("00 Inbox/Agent/Assistant State.md", "00 Inbox/Agent")).toBe(true);
  });

  it("leaves real notes alone, including ones captured into Inbox", () => {
    expect(isAgentMemoryPath("00 Inbox/Agent/python语言.md", "00 Inbox/Agent")).toBe(false);
    expect(isAgentMemoryPath("daily/分布式系统.md", "00 Inbox/Agent")).toBe(false);
    expect(isAgentMemoryPath("00 Inbox/Agent/_logs/session-1.jsonl", "00 Inbox/Agent")).toBe(false);
  });

  it("refuses to claim anything when the memory folder is unusable", () => {
    expect(isAgentMemoryPath("Agent Profile.md", "")).toBe(false);
  });
});

describe("internal library paths", () => {
  const folder = "00 Inbox/Agent";

  it("keeps deleted notes out of the corpus, not just out of the tree", () => {
    // The two exclusions were once written separately and the trash was only
    // in one of them, so a deleted note stayed searchable and kept answering
    // questions after it was gone from the sidebar.
    expect(isInternalLibraryPath(".trash/2026-10-04T08-00-00-000Z__daily-B树.md", folder)).toBe(true);
    expect(isInternalLibraryPath(".trash/2026-10-04T08-00-00-000Z__daily-B树.md.trash.md", folder)).toBe(true);
  });

  it("also claims the agent's own files and its scratch folders", () => {
    expect(isInternalLibraryPath("00 Inbox/Agent/Agent Profile.md", folder)).toBe(true);
    expect(isInternalLibraryPath("00 Inbox/Agent/Sessions/x.md", folder)).toBe(true);
    expect(isInternalLibraryPath(".obsidian/workspace.json", folder)).toBe(true);
    expect(isInternalLibraryPath(".knowledge-loop-agent/index.json", folder)).toBe(true);
  });

  it("leaves every real note alone", () => {
    expect(isInternalLibraryPath("daily/分布式系统.md", folder)).toBe(false);
    expect(isInternalLibraryPath("00 Inbox/Agent/python语言.md", folder)).toBe(false);
    // A note that merely starts with the same characters is not in the trash.
    expect(isInternalLibraryPath(".trash-notes/daily/笔记.md", folder)).toBe(false);
    expect(isInternalLibraryPath("daily/.trash/笔记.md", folder)).toBe(false);
  });

  it("normalizes Windows separators before matching", () => {
    expect(isInternalLibraryPath(".trash\\2026-10-04__daily-B树.md", folder)).toBe(true);
    expect(isInternalLibraryPath("00 Inbox\\Agent\\Agent Profile.md", folder)).toBe(true);
  });
});
