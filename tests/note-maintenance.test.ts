import { describe, expect, it } from "vitest";
import {
  buildRenameProposals,
  renderRenamePlanMarkdown,
  rewriteNoteLinks,
  titleFromNotePath
} from "../core/notes/note-maintenance";
import type { NoteDigest } from "../core/indexing/note-survey";

function digest(path: string, links: string[] = []): NoteDigest {
  return { path, title: titleFromNotePath(path), tags: [], links, excerpt: "" };
}

const LIBRARY = [
  digest("daily/后端中redis是什么,起什么作用.md"),
  digest("daily/什么是BM25.md", ["后端中redis是什么,起什么作用"]),
  digest("daily/Redis 的 TTL.md", ["什么是BM25#定义", "backend/后端中redis是什么,起什么作用"]),
  digest("daily/检索与排序.md")
];

const EXISTING = new Set(LIBRARY.map((entry) => entry.path));

describe("rename proposals", () => {
  it("names question-titled notes after their subject", () => {
    const plan = buildRenameProposals(LIBRARY, { existingPaths: EXISTING });

    expect(plan.proposals.map((proposal) => proposal.toTitle)).toEqual(["后端中redis", "BM25"]);
    expect(plan.proposals[0]?.to).toBe("daily/后端中redis.md");
    expect(plan.scanned).toBe(LIBRARY.length);
  });

  it("reports the notes whose links would have to be rewritten", () => {
    const plan = buildRenameProposals(LIBRARY, { existingPaths: EXISTING });

    expect(plan.proposals[0]?.linkSites).toEqual([
      "daily/什么是BM25.md",
      "daily/Redis 的 TTL.md"
    ]);
  });

  it("refuses a target name that is already taken", () => {
    const library = [...LIBRARY, digest("daily/BM25.md")];
    const plan = buildRenameProposals(library, { existingPaths: new Set(library.map((entry) => entry.path)) });

    expect(plan.proposals.map((proposal) => proposal.toTitle)).toEqual(["后端中redis"]);
    expect(plan.blocked).toEqual([{ path: "daily/什么是BM25.md", toTitle: "BM25" }]);
  });

  it("holds back names the rule cannot produce cleanly", () => {
    const library = [digest("daily/编程中hook是干嘛的.md"), digest("daily/线程、协程、进程分别是什么.md")];
    const plan = buildRenameProposals(library, { existingPaths: new Set(library.map((entry) => entry.path)) });

    expect(plan.proposals).toHaveLength(0);
    expect(plan.needsDecision.map((entry) => entry.path)).toEqual(library.map((entry) => entry.path));
    expect(plan.needsDecision[0]?.reason).toContain("收尾不完整");
  });

  it("leaves subject-named notes alone", () => {
    const plan = buildRenameProposals([digest("daily/Redis 的 TTL.md")], { existingPaths: EXISTING });
    expect(plan.proposals).toHaveLength(0);
  });
});

describe("rename plan report", () => {
  it("states that nothing has been renamed yet", () => {
    const plan = buildRenameProposals(LIBRARY, { existingPaths: EXISTING });
    const markdown = renderRenamePlanMarkdown({ plan, generatedAt: "2026-10-01T10:00:00.000Z" });

    expect(markdown).toContain("# 笔记命名整理建议");
    expect(markdown).toContain("尚未执行");
    expect(markdown).toContain("| [[daily/什么是BM25.md]] | BM25 |");
    expect(markdown).toContain("[[daily/Redis 的 TTL.md]]");
    expect(markdown).toContain("generatedAt: 2026-10-01T10:00:00.000Z");
  });

  it("lists the notes the rule could not name", () => {
    const library = [digest("daily/编程中hook是干嘛的.md")];
    const plan = buildRenameProposals(library, { existingPaths: EXISTING });
    const markdown = renderRenamePlanMarkdown({ plan, generatedAt: "now" });

    expect(markdown).toContain("需要模型或人工取名");
    expect(markdown).toContain("[[daily/编程中hook是干嘛的.md]]");
  });

  it("says so when there is nothing to tidy", () => {
    const plan = buildRenameProposals([digest("daily/Redis 的 TTL.md")], { existingPaths: EXISTING });
    expect(renderRenamePlanMarkdown({ plan, generatedAt: "now" })).toContain("没有需要改名的笔记");
  });
});

describe("link rewriting", () => {
  it("rewrites the target and keeps display text and anchors", () => {
    const mapping = new Map([["什么是BM25", "BM25"], ["后端中redis是什么,起什么作用", "后端中redis"]]);
    const content = [
      "见 [[什么是BM25]] 与 [[什么是BM25|打分函数]] 和 [[什么是BM25#定义]]。",
      "还有 [[daily/别的笔记]] 与 [[后端中redis是什么,起什么作用]]。"
    ].join("\n");
    const rewritten = rewriteNoteLinks(content, mapping);

    expect(rewritten).toContain("[[BM25]]");
    expect(rewritten).toContain("[[BM25|打分函数]]");
    expect(rewritten).toContain("[[BM25#定义]]");
    expect(rewritten).toContain("[[daily/别的笔记]]");
    expect(rewritten).toContain("[[后端中redis]]");
  });

  it("leaves content untouched when nothing is renamed", () => {
    const content = "见 [[什么是BM25]]。";
    expect(rewriteNoteLinks(content, new Map())).toBe(content);
  });
});
