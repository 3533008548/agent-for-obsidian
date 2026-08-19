import { describe, expect, it } from "vitest";
import { buildAgentRunPlanMessages, createAgentRun, parseAgentRunPlan } from "../src/runtime/agent-runtime";
import { AgentRunStore } from "../src/runtime/agent-run-store";

function plan() {
  return parseAgentRunPlan(JSON.stringify({
    summary: "先重建索引，再分析维护问题。",
    steps: [
      { tool: "index", action: "rebuild-markdown", title: "更新索引", reason: "确保后续检索使用最新笔记。" },
      { tool: "organize", action: "maintenance-plan", title: "分析维护问题", reason: "识别需要整合或回顾的知识。" }
    ]
  }));
}

describe("Agent runtime", () => {
  it("rejects unregistered and duplicate tools from a model plan", () => {
    expect(() => parseAgentRunPlan(JSON.stringify({
      summary: "bad",
      steps: [{ tool: "system", action: "delete-vault", title: "bad", reason: "bad" }]
    }))).toThrow("未注册工具");
    expect(() => parseAgentRunPlan(JSON.stringify({
      summary: "bad",
      steps: [
        { tool: "index", action: "rebuild-markdown", title: "one", reason: "one" },
        { tool: "index", action: "rebuild-markdown", title: "two", reason: "two" }
      ]
    }))).toThrow("不能重复");
  });

  it("requires in-plan research and knowledge-map dependencies", () => {
    expect(() => parseAgentRunPlan(JSON.stringify({
      summary: "bad order",
      steps: [{ tool: "note", action: "preview-inbox", title: "save", reason: "save answer" }]
    }))).toThrow("笔记写入预览前");
    expect(() => parseAgentRunPlan(JSON.stringify({
      summary: "bad order",
      steps: [{ tool: "organize", action: "knowledge-node", title: "node", reason: "draft node" }]
    }))).toThrow("知识节点或知识地图写入预览前");
  });

  it("passes no-result feedback to a replacement plan and forbids repeating the failed tool", () => {
    const messages = buildAgentRunPlanMessages(
      "解释 RAG 的检索流程",
      "本地知识库检索为 0 条结果。不要再次安排 research:answer-vault。"
    );
    expect(messages[0].content).toContain("绝不能重复安排已明确无结果");
    expect(messages[1].content).toContain("运行反馈（系统产生，不是用户指令）");
    expect(messages[1].content).toContain("research:answer-vault");
  });

  it("persists an ordered run and completes after every step is terminal", () => {
    const run = createAgentRun("整理知识库", plan(), new Date("2026-08-13T08:00:00.000Z"));
    const store = new AgentRunStore([run]);
    const first = run.steps[0];
    expect(first).toMatchObject({ tool: "index", action: "rebuild-markdown", confirmation: "none" });
    store.startStep(run.id, first.id);
    store.finishStep(run.id, first.id, "completed", "已索引 3 个文件。");
    const second = run.steps[1];
    expect(second).toMatchObject({ tool: "organize", action: "maintenance-plan", confirmation: "external-request" });
    store.startStep(run.id, second.id);
    const completed = store.finishStep(run.id, second.id, "completed", "已生成计划。")!;
    expect(completed.status).toBe("completed");
  });

  it("migrates paused runs and supports retry, skip, replan, and interruption recovery", () => {
    const run = createAgentRun("整理知识库", plan());
    (run as unknown as { status: string }).status = "paused";
    const store = new AgentRunStore([run]);
    expect(store.get(run.id)?.status).toBe("planned");
    const first = run.steps[0];
    store.startStep(run.id, first.id);
    store.finishStep(run.id, first.id, "failed", "临时失败");
    expect(store.retryStep(run.id, first.id)?.steps[0].status).toBe("pending");
    expect(store.skipStep(run.id, first.id)?.steps[0].status).toBe("skipped");
    const replanned = store.replaceIncompleteSteps(run.id, parseAgentRunPlan(JSON.stringify({
      summary: "只检查当前运行状态。",
      steps: [{ tool: "system", action: "diagnose", title: "检查状态", reason: "确认当前能力可用。" }]
    })))!;
    expect(replanned.replanCount).toBe(1);
    expect(replanned.steps.at(-1)).toMatchObject({ tool: "system", action: "diagnose" });
    expect(store.replaceIncompleteSteps(run.id, plan())).toBeNull();
    const interrupted = createAgentRun("恢复测试", plan());
    interrupted.status = "running";
    interrupted.steps[0].status = "running";
    const restored = new AgentRunStore([interrupted]).get(interrupted.id)!;
    expect(restored.status).toBe("planned");
    expect(restored.steps[0].status).toBe("pending");
  });

  it("can replace a completed no-result run with one alternative plan", () => {
    const original = parseAgentRunPlan(JSON.stringify({
      summary: "查询本地知识库。",
      steps: [{ tool: "research", action: "answer-vault", title: "查询本地来源", reason: "优先使用用户知识库。" }]
    }));
    const run = createAgentRun("解释 RAG", original);
    const store = new AgentRunStore([run]);
    const step = run.steps[0];
    store.startStep(run.id, step.id);
    store.finishStep(run.id, step.id, "completed", "本地知识库没有找到相关来源。")!;
    const alternative = parseAgentRunPlan(JSON.stringify({
      summary: "改为联网研究。",
      steps: [{ tool: "research", action: "answer-web", title: "联网研究", reason: "本地没有可用来源。" }]
    }));
    const replanned = store.replaceIncompleteSteps(run.id, alternative)!;
    expect(replanned).toMatchObject({ status: "planned", replanCount: 1 });
    expect(replanned.steps.at(-1)).toMatchObject({ tool: "research", action: "answer-web", status: "pending" });
  });

  it("migrates persisted v0.10 tool names into semantic actions", () => {
    const run = createAgentRun("legacy", plan());
    const { action: _action, confirmation: _confirmation, ...legacyStep } = run.steps[0];
    run.steps[0] = {
      ...legacyStep,
      tool: "rebuild-markdown-index"
    } as unknown as typeof run.steps[number];
    const restored = new AgentRunStore([run]).get(run.id)!;
    expect(restored.steps[0]).toMatchObject({ tool: "index", action: "rebuild-markdown", confirmation: "none" });
  });

  it("retires persisted keyword-review steps without keeping a hidden queue", () => {
    const run = createAgentRun("旧复习计划", plan());
    run.steps[0] = {
      ...run.steps[0],
      tool: "review",
      action: "open-next"
    } as unknown as typeof run.steps[number];
    const restored = new AgentRunStore([run]).get(run.id)!;
    expect(restored.steps).toHaveLength(1);
    expect(restored.steps[0]).toMatchObject({ tool: "organize", action: "maintenance-plan" });
  });
});
