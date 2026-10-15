import { describe, expect, it } from "vitest";
import {
  normalizeQuestionToStem,
  parseNoteTopicResolution,
  resolveFallbackNoteTopic
} from "../core/notes/note-naming";
import {
  buildNoteCaptureMessages,
  fallbackNoteCapturePlan,
  parseNoteCapturePlan,
  renderRouteCandidates
} from "../core/notes/note-routing";
import { renderNoteSection } from "../core/actions/action-proposal";

const CANDIDATES = [
  { path: "daily/后端中的 Redis.md", title: "后端中的 Redis", excerpt: "Redis 用作缓存。", origin: "session" as const },
  { path: "daily/后端中SSE是什么.md", title: "后端中SSE是什么", excerpt: "SSE 是服务端推送。", origin: "search" as const }
];

const ALLOWED = new Set(CANDIDATES.map((candidate) => candidate.path));

describe("question to subject", () => {
  it("strips question wording from the title", () => {
    expect(normalizeQuestionToStem("后端中redis是什么，起什么作用")).toBe("后端中redis");
    expect(normalizeQuestionToStem("什么是BM25")).toBe("BM25");
    expect(normalizeQuestionToStem("Python 语言有什么特点？")).toBe("Python 语言");
  });

  it("turns a comparison into a difference phrase", () => {
    expect(normalizeQuestionToStem("langchain和langgragh有什么区别，应用场景上有什么不同")).toBe("langchain 与 langgragh 的区别");
  });

  it("keeps the original question as an alias", () => {
    expect(resolveFallbackNoteTopic("什么是BM25").aliases).toEqual(["什么是BM25"]);
  });
});

describe("note capture plan", () => {
  it("merges into a candidate the model chose", () => {
    const plan = parseNoteCapturePlan(JSON.stringify({
      title: "Redis 的 TTL",
      topic: "后端缓存",
      aliases: ["Redis 事件流设置了 TTL,TTL是什么"],
      keywords: ["Redis", "TTL"],
      action: "append",
      targetPath: "daily/后端中的 Redis.md",
      sectionHeading: "TTL 过期机制",
      confidence: 0.9,
      reason: "同一对象的另一个属性"
    }), ALLOWED, "Redis 事件流设置了 TTL,TTL是什么");

    expect(plan.decision.action).toBe("append");
    expect(plan.decision.targetPath).toBe("daily/后端中的 Redis.md");
    expect(plan.decision.sectionHeading).toBe("TTL 过期机制");
    expect(plan.resolution.title).toBe("Redis 的 TTL");
    expect(plan.resolution.aliases).toContain("Redis 事件流设置了 TTL,TTL是什么");
  });

  it("refuses a path the model invented", () => {
    const plan = parseNoteCapturePlan(JSON.stringify({
      title: "Redis 的 TTL",
      action: "append",
      targetPath: "daily/不存在.md",
      confidence: 1
    }), ALLOWED, "Redis TTL");

    expect(plan.decision.action).toBe("create");
    expect(plan.decision.targetPath).toBeUndefined();
  });

  it("refuses a merge the model is not confident about", () => {
    const plan = parseNoteCapturePlan(JSON.stringify({
      title: "Redis 的 TTL",
      action: "append",
      targetPath: "daily/后端中的 Redis.md",
      confidence: 0.4
    }), ALLOWED, "Redis TTL");

    expect(plan.decision.action).toBe("create");
  });

  it("falls back to a rule-based subject instead of throwing", () => {
    const plan = fallbackNoteCapturePlan("什么是BM25");
    expect(plan.decision.action).toBe("create");
    expect(plan.resolution.title).toBe("BM25");
  });

  it("rejects a title that is still a question", () => {
    expect(parseNoteTopicResolution({ title: "BM25 是什么？" }, "什么是BM25").title).toBe("BM25");
  });

  it("offers only candidate paths and marks where each came from", () => {
    const messages = buildNoteCaptureMessages("Redis TTL 是什么", "TTL 是过期时间。", CANDIDATES);
    const user = messages[1]?.content ?? "";

    expect(renderRouteCandidates(CANDIDATES)).toContain("来源：session");
    expect(user).toContain("daily/后端中的 Redis.md");
    expect(user).toContain("回答摘要");
  });

  it("carries each candidate's topic into the routing prompt", () => {
    const candidates = [{ ...CANDIDATES[0]!, topic: "后端与缓存" }];
    const system = buildNoteCaptureMessages("Redis TTL 是什么", "TTL 是过期时间。", candidates)[0]?.content ?? "";

    expect(renderRouteCandidates(candidates)).toContain("主题：后端与缓存");
    expect(system).toContain("来自知识库主题表");
  });

  it("numbers the merge rules without gaps", () => {
    const system = buildNoteCaptureMessages("Redis TTL 是什么", "TTL 是过期时间。", CANDIDATES)[0]?.content ?? "";
    expect(system).toMatch(/1\. .*2\. .*3\. .*4\. .*5\. /su);
  });
});

describe("appended section", () => {
  it("keeps the original question and sources inside the existing note", () => {
    const rendered = renderNoteSection({
      heading: "TTL",
      question: "Redis 事件流设置了 TTL,TTL是什么",
      content: "TTL 是键的存活时间。",
      sources: [{ type: "web", pathOrUrl: "https://example.com", locator: "", contentHash: "h", parserVersion: "v1", retrievedAt: "" }],
      createdAt: new Date(2026, 8, 29, 12, 0)
    }, "# 后端中的 Redis\n\nRedis 用作缓存。");

    expect(rendered.startsWith("# 后端中的 Redis"));
    expect(rendered).toContain("## 2026-09-29 12:00 · TTL");
    expect(rendered).toContain("> 原问题：Redis 事件流设置了 TTL,TTL是什么");
    expect(rendered).toContain("https://example.com");
  });
});
