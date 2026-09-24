import { describe, expect, it } from "vitest";
import {
  appendAssistantStateAction,
  buildAssistantStateSkeleton,
  getAssistantStatePath,
  setAssistantFocus
} from "../core/memory/assistant-state";

describe("Assistant state", () => {
  it("keeps a readable current focus and action trace with session provenance", () => {
    const focused = setAssistantFocus(
      buildAssistantStateSkeleton(new Date("2026-09-13T08:00:00.000Z")),
      "完善个人助手记忆系统",
      "00 Inbox/Agent/Sessions/memory.md",
      new Date("2026-09-13T09:00:00.000Z")
    );
    const updated = appendAssistantStateAction(focused, {
      name: "更新用户画像",
      summary: "已记住用户偏好简洁回答。",
      sessionPath: "00 Inbox/Agent/Sessions/memory.md"
    }, new Date("2026-09-13T09:05:00.000Z"));

    expect(getAssistantStatePath("00 Inbox/Agent")).toBe("00 Inbox/Agent/Assistant State.md");
    expect(updated).toContain("完善个人助手记忆系统");
    expect(updated).toContain("更新用户画像");
    expect(updated).toContain("[[00 Inbox/Agent/Sessions/memory.md]]");
  });

  it("bounds the managed action history", () => {
    let state = buildAssistantStateSkeleton();
    for (let index = 0; index < 24; index += 1) {
      state = appendAssistantStateAction(state, { name: "测试", summary: `操作 ${index}` }, new Date(2026, 0, 1, 0, index));
    }
    expect((state.match(/^- 2026-01-01 /gmu) ?? [])).toHaveLength(20);
    expect(state).toContain("操作 23");
    expect(state).not.toContain("操作 0");
  });
});
