import { describe, expect, it } from "vitest";
import {
  conversationLogPath,
  parseConversationLog,
  renderCapturePatch,
  renderTurnLine,
  type ConversationLogTurn
} from "../core/memory/conversation-log";

function turn(turnId: string): ConversationLogTurn {
  return {
    turnId,
    at: "2026-10-03T07:12:00.000Z",
    question: "什么是分布式系统",
    content: "一组机器对外提供服务。",
    mode: "local",
    evidenceComplete: true,
    sources: [{ path: "daily/分布式系统.md", heading: null, excerpt: "一组机器" }],
    decisionTrail: []
  };
}

describe("conversation log", () => {
  it("round-trips a turn including its sources", () => {
    const turns = parseConversationLog(renderTurnLine(turn("t1")));

    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("什么是分布式系统");
    expect(turns[0]?.sources[0]?.path).toBe("daily/分布式系统.md");
    expect(turns[0]?.evidenceComplete).toBe(true);
  });

  it("keeps the log beside the transcript rather than in the library", () => {
    const path = conversationLogPath("00 Inbox/Agent/Sessions/2026-10-03-分布式系统-abc123.md", "session-1");

    expect(path).toBe("00 Inbox/Agent/Sessions/_logs/session-1.jsonl");
    expect(path.endsWith(".md")).toBe(false);
  });

  it("folds a later capture onto the turn it belongs to", () => {
    const raw = renderTurnLine(turn("t1")) + renderTurnLine(turn("t2"))
      + renderCapturePatch("t2", { action: "appendDailyNote", targetPath: "daily/分布式系统.md", at: "2026-10-03T07:20:00.000Z" });

    const turns = parseConversationLog(raw);

    expect(turns[0]?.captured).toBeUndefined();
    expect(turns[1]?.captured?.targetPath).toBe("daily/分布式系统.md");
  });

  it("loses one bad line instead of the whole session", () => {
    const raw = renderTurnLine(turn("t1")) + "{not json at all\n" + renderTurnLine(turn("t2"));

    const turns = parseConversationLog(raw);

    expect(turns.map((entry) => entry.turnId)).toEqual(["t1", "t2"]);
  });

  it("ignores lines that carry no question or answer", () => {
    expect(parseConversationLog('{"turnId":"t1"}\n')).toEqual([]);
    expect(parseConversationLog('{"turnId":"t1","question":"q"}\n')).toEqual([]);
  });

  it("treats an empty log as no history", () => {
    expect(parseConversationLog("")).toEqual([]);
    expect(parseConversationLog("\n\n")).toEqual([]);
  });
});
