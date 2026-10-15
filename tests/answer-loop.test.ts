import { describe, expect, it } from "vitest";
import {
  buildDecisionMessages,
  isMetaQuestion,
  parseDecision,
  runAnswerLoop,
  type AnswerLoopDependencies,
  type AnswerLoopEntry
} from "../core/desktop/desktop-answer-loop";
import type { DesktopAgentAnswer, DesktopAgentService } from "../core/desktop/desktop-agent-service";

const COMPLETE: DesktopAgentAnswer = {
  content: "本地回答",
  mode: "local",
  evidenceComplete: true,
  sources: [{ path: "daily/x.md", heading: null, excerpt: "x" }]
};

const GAP: DesktopAgentAnswer = {
  content: "本地资料无法回答。",
  mode: "evidence-gap",
  evidenceComplete: false,
  sources: [],
  recoveryNote: "缺少直接证据"
};

function makeService(overrides: Record<string, unknown> = {}): DesktopAgentService {
  return {
    answer: async () => GAP,
    answerFromWeb: async () => ({ content: "联网回答", mode: "web", evidenceComplete: true, sources: [] }),
    answerFromGeneralKnowledge: async () => ({ content: "通用回答", mode: "general", evidenceComplete: true, sources: [] }),
    ...overrides
  } as unknown as DesktopAgentService;
}

function makeDeps(
  service: DesktopAgentService,
  decide?: AnswerLoopDependencies["decide"],
  capabilities = { hasTavily: true, webFallbackPolicy: "stable-only" }
): AnswerLoopDependencies {
  return { service, capabilities, decide };
}

describe("answer loop", () => {
  it("returns after local evidence suffices, without any decision call", async () => {
    let decideCalls = 0;
    const result = await runAnswerLoop("什么是 BM25", undefined, makeDeps(
      makeService({ answer: async () => COMPLETE }),
      async () => {
        decideCalls += 1;
        throw new Error("不应被调用");
      }
    ));

    expect(result.content).toBe("本地回答");
    expect(result.decisionTrail.join()).toContain("足以回答");
    expect(decideCalls).toBe(0);
  });

  it("asks the model what to try next when local evidence falls short", async () => {
    const actions: string[] = [];
    const result = await runAnswerLoop("B+ 树和二叉树的区别", undefined, makeDeps(
      makeService({
        answer: async () => GAP,
        answerFromWeb: async () => {
          actions.push("web");
          return { content: "联网回答", mode: "web", evidenceComplete: true, sources: [] };
        }
      }),
      async () => ({ action: "answer-web", reason: "本地没有这类资料" })
    ));

    expect(result.content).toBe("联网回答");
    expect(actions).toEqual(["web"]);
    expect(result.decisionTrail.join()).toContain("联网搜索");
    expect(result.decisionTrail.join()).toContain("缺少直接证据");
  });

  it("keeps the policy veto on general answers and can still stop honestly", async () => {
    const decisions: Array<"general" | "stop"> = ["general", "stop"];
    let calls = 0;
    // A null here is what the service returns when WEB_FALLBACK_POLICY vetoes
    // the general answer.
    const result = await runAnswerLoop("问题", undefined, makeDeps(
      makeService({ answerFromGeneralKnowledge: async () => null }),
      async () => {
        const decision = decisions[Math.min(calls, decisions.length - 1)];
        calls += 1;
        return { action: decision, reason: "理由" };
      },
      { hasTavily: false, webFallbackPolicy: "disabled" }
    ));

    expect(calls).toBe(2);
    expect(result.mode).toBe("evidence-gap");
    expect(result.decisionTrail.join()).toContain("WEB_FALLBACK_POLICY=disabled");
    expect(result.decisionTrail.join()).toContain("停止补证");
  });

  it("falls back to the old hardcoded chain when the decision call fails", async () => {
    const result = await runAnswerLoop("问题", undefined, makeDeps(
      makeService(),
      async () => {
        throw new Error("模型挂了");
      }
    ));

    expect(result.content).toBe("联网回答");
    expect(result.decisionTrail.join()).toContain("联网搜索");
  });

  it("answers questions about the agent itself from the run trace, not the vault", async () => {
    let searched = false;
    let generalQuestion = "";
    const deps: AnswerLoopDependencies = {
      ...makeDeps(
        makeService({
          answer: async () => {
            searched = true;
            return GAP;
          },
          answerFromGeneralKnowledge: async (question: string) => {
            generalQuestion = question;
            return { content: "基于记录的解释", mode: "general", evidenceComplete: true, sources: [] };
          }
        }),
        async () => ({ action: "stop", reason: "x" })
      ),
      lastRunTrace: () => "目标：B+ 树和二叉树的区别。步骤：联网研究：B+ 树和二叉树的区别（failed：没有可用结果）"
    };
    const result = await runAnswerLoop("为什么不联网搜索", undefined, deps);

    expect(searched).toBe(false);
    // The trace must reach the model, or the answer is fluent nonsense.
    expect(generalQuestion).toContain("上一轮执行记录");
    expect(generalQuestion).toContain("联网研究");
    expect(result.decisionTrail.join()).toContain("上一轮执行记录");
  });
});

describe("meta question detection", () => {
  it("catches questions about the agent's own behaviour", () => {
    for (const question of ["为什么不联网搜索", "你怎么不检索就回答", "你刚才做了什么", "agent 为什么不写笔记"]) {
      expect(isMetaQuestion(question)).toBe(true);
    }
  });

  it("leaves ordinary questions alone", () => {
    for (const question of ["B+ 树和二叉树的区别是什么？", "为什么 Redis 快", "为什么要有 overlap"]) {
      expect(isMetaQuestion(question)).toBe(false);
    }
  });
});

describe("decision parsing", () => {
  it("parses every action and requires a query for retry-local", () => {
    expect(parseDecision('{"action":"answer-web","query":"B+树","reason":"r"}')).toEqual({
      action: "answer-web",
      query: "B+树",
      reason: "r"
    });
    expect(parseDecision('{"action":"stop","reason":"没救了"}')).toEqual({ action: "stop", reason: "没救了" });
    expect(() => parseDecision('{"action":"retry-local","reason":"r"}')).toThrow();
    expect(() => parseDecision('{"action":"delete-everything","reason":"r"}')).toThrow();
  });

  it("builds messages that name the available capabilities", () => {
    const messages = buildDecisionMessages("问题", [{ action: "本地检索", outcome: "缺少直接证据" }] as AnswerLoopEntry[], {
      hasTavily: false,
      webFallbackPolicy: "stable-only"
    });
    const system = messages[0]?.content ?? "";
    expect(system).toContain("不可用（未配置 TAVILY_API_KEY）");
    expect(system).toContain("answer-web");
    expect(system).toContain("不要为了收尾而编造");
  });
});
