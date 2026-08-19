import { describe, expect, it } from "vitest";
import {
  AgentSessionStore,
  applyProfileMemorySuggestions,
  buildAgentMemoryContext,
  buildAgentProfileSkeleton,
  parseAgentSessionTranscript,
  parseProfileMemorySuggestions,
  renderNewAgentSession,
  renderSessionExchange,
  renderSessionToolResult
} from "../src/memory/agent-memory";

describe("Agent memory", () => {
  it("keeps a single active session and persists only session metadata", () => {
    const store = new AgentSessionStore();
    const first = store.create("机器学习资料整理", "00 Inbox/Agent", new Date("2026-08-17T09:00:00.000Z"));
    store.activate(first);
    expect(store.getActive()).toMatchObject({ id: first.id, status: "active" });
    expect(first.path).toMatch(/^00 Inbox\/Agent\/Sessions\/2026-08-17-机器学习资料整理-[a-z0-9]{6}\.md$/u);

    const second = store.create("面试准备", "00 Inbox/Agent", new Date("2026-08-17T10:00:00.000Z"));
    store.activate(second);
    expect(store.getActive()).toMatchObject({ id: second.id });
    expect(store.getAll().find((session) => session.id === first.id)?.status).toBe("closed");
    expect(new AgentSessionStore(store.toJSON()).getActive()).toMatchObject({ id: second.id });
  });

  it("renders session records as user-visible Markdown excluded from the knowledge index", () => {
    const store = new AgentSessionStore();
    const session = store.create("测试", "00 Inbox/Agent", new Date("2026-08-17T09:00:00.000Z"));
    const markdown = `${renderNewAgentSession(session)}\n${renderSessionExchange("问题", "回答", new Date("2026-08-17T09:01:00.000Z"))}`;
    expect(markdown).toContain("agent-memory: session");
    expect(markdown).toContain("index: false");
    expect(markdown).toContain("### 用户\n问题");
    expect(markdown).toContain("### Agent\n回答");
  });

  it("uses a bounded recent session window and a bounded profile window", () => {
    const context = buildAgentMemoryContext("P".repeat(3_000), "S".repeat(4_000));
    expect(context.includedProfile).toBe(true);
    expect(context.includedSession).toBe(true);
    expect(context.content).toContain("用户画像");
    expect(context.content).toContain("较早会话记录已省略");
    expect(context.content.length).toBeLessThan(6_300);
  });

  it("parses stored exchanges and tool summaries for the chat view", () => {
    const transcript = [
      "# 会话",
      "",
      "## 会话记录",
      "",
      renderSessionExchange("问题", "回答", new Date("2026-08-17T09:01:00.000Z")),
      renderSessionToolResult("重建索引", "已索引 12 个文件。", new Date("2026-08-17T09:02:00.000Z"))
    ].join("\n");
    expect(parseAgentSessionTranscript(transcript).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "问题" },
      { role: "agent", content: "回答" },
      { role: "tool", content: "- 重建索引：已索引 12 个文件。" }
    ]);
  });

  it("only accepts a compact allowlisted profile suggestion and preserves user-authored content", () => {
    const suggestions = parseProfileMemorySuggestions(JSON.stringify({
      items: [
        { category: "goal", content: "完成 Agent 项目的求职展示" },
        { category: "preference", content: "默认使用中文回答" }
      ]
    }));
    const profile = `${buildAgentProfileSkeleton(new Date("2026-08-17T09:00:00.000Z"))}\n\n## 用户手写备注\n\n- 不要删除这一行\n`;
    const updated = applyProfileMemorySuggestions(
      profile,
      suggestions,
      "00 Inbox/Agent/Sessions/demo.md",
      new Date("2026-08-17T10:00:00.000Z")
    );
    expect(updated).toContain("不要删除这一行");
    expect(updated).toContain("长期目标：完成 Agent 项目的求职展示");
    expect(updated).toContain("[[00 Inbox/Agent/Sessions/demo.md]]");
    expect(() => parseProfileMemorySuggestions(JSON.stringify({
      items: [{ category: "identity", content: "不允许的分类" }]
    }))).toThrow("无效条目");
  });
});
