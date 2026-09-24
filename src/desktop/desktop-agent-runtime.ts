import {
  createAgentRun,
  createLocalKnowledgeFallbackPlan,
  ensureKnowledgeOrganizationPlan,
  ensureLlmWikiTraversalPlan,
  type AgentRun,
  type AgentRunPlan,
  type AgentToolCall
} from "../runtime/agent-runtime";
import { AgentRunStore } from "../runtime/agent-run-store";
import { isRuntimeBlockedError } from "../runtime/agent-runtime-errors";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import {
  createDesktopRuntimeToolRegistry,
  type DesktopRuntimeState,
  type DesktopRuntimeToolDependencies
} from "./desktop-runtime-tools";

export interface DesktopAgentRuntimeConfiguration {
  deepSeekApiKey: () => string;
  deepSeekModel: () => string;
  requestTimeoutMs: () => number;
  memoryContext?: () => string;
  hasTavilyApiKey: () => boolean;
  /** True when a compiled Wiki already covers the goal. */
  hasRelevantWiki: (goal: string) => Promise<boolean>;
  /** Injectable for offline tests; defaults to the real DeepSeek client. */
  planAgentRun?: (goal: string, memoryContext: string, replanFeedback: string) => Promise<AgentRunPlan>;
}

/**
 * The desktop counterpart of the plugin's agent orchestration.
 *
 * The model only proposes a plan; this class decides what actually runs, and
 * every step still goes through the same permissions, budgets and write
 * previews as the plugin.
 */
export class DesktopAgentRuntime {
  private readonly runStore = new AgentRunStore();
  private readonly registry: ReturnType<typeof createDesktopRuntimeToolRegistry>;
  private state: DesktopRuntimeState = {};

  constructor(
    toolDeps: Omit<DesktopRuntimeToolDependencies, "state">,
    private readonly configuration: DesktopAgentRuntimeConfiguration
  ) {
    this.registry = createDesktopRuntimeToolRegistry({ ...toolDeps, state: this.state });
  }

  getState(): DesktopRuntimeState {
    return this.state;
  }

  getRun(runId: string): AgentRun | null {
    return this.runStore.get(runId);
  }

  listRuns(): AgentRun[] {
    return this.runStore.toJSON();
  }

  async plan(goal: string): Promise<AgentRun> {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      throw new Error("请输入 Agent 运行目标。");
    }
    if (!this.configuration.deepSeekApiKey().trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const modelPlan = await this.requestPlan(normalizedGoal, this.configuration.memoryContext?.() ?? "");
    const plan = ensureLlmWikiTraversalPlan(
      normalizedGoal,
      ensureKnowledgeOrganizationPlan(normalizedGoal, modelPlan),
      await this.hasRelevantWiki(normalizedGoal)
    );
    this.state = {};
    return this.runStore.add(createAgentRun(normalizedGoal, plan, new Date()));
  }

  async executeStep(runId: string, stepId: string, confirmed = false): Promise<AgentRun> {
    const run = this.runStore.get(runId);
    const step = run?.steps.find((candidate) => candidate.id === stepId);
    if (!run || !step) {
      throw new Error("Agent 运行或步骤不存在。");
    }
    if (step.requiresConfirmation && !confirmed) {
      throw new Error("该步骤会调用模型、处理附件或写入笔记，需要用户确认。");
    }
    const started = this.runStore.startStep(runId, stepId);
    if (!started) {
      throw new Error("该步骤当前不可执行。");
    }
    try {
      const result = await this.registry.execute({
        goal: started.run.goal,
        run: started.run,
        step: started.step
      });
      const updated = this.runStore.finishStep(runId, stepId, "completed", result.summary);
      if (!updated) {
        throw new Error("无法更新 Agent 步骤状态。");
      }
      if (result.replanFeedback && updated.replanCount < 1) {
        try {
          const replanned = await this.replan(runId, result.replanFeedback, result.replanExclusions ?? []);
          return result.autoContinue ? this.continueEvidenceCompletion(replanned) : replanned;
        } catch {
          return updated;
        }
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知 Agent 工具错误。";
      const status = isRuntimeBlockedError(error) ? "blocked" : "failed";
      const updated = this.runStore.finishStep(runId, stepId, status, message);
      if (!updated) {
        throw new Error("无法更新 Agent 步骤状态。");
      }
      return updated;
    }
  }

  async replan(runId: string, replanFeedback = "", excludedCalls: AgentToolCall[] = []): Promise<AgentRun> {
    const run = this.runStore.get(runId);
    if (!run || run.status === "cancelled") {
      throw new Error("该 Agent 运行不存在或已取消。");
    }
    if (run.replanCount >= 1) {
      throw new Error("每次 Agent 运行最多重新规划一次；请新建运行继续。");
    }
    const shouldUseWebFallback = this.configuration.hasTavilyApiKey() && excludedCalls.some(isEvidenceCollectionCall);
    const plan: AgentRunPlan = shouldUseWebFallback
      ? createLocalKnowledgeFallbackPlan(run.goal)
      : ensureLlmWikiTraversalPlan(
        run.goal,
        ensureKnowledgeOrganizationPlan(
          run.goal,
          await this.requestPlan(run.goal, this.configuration.memoryContext?.() ?? "", replanFeedback)
        ),
        await this.hasRelevantWiki(run.goal)
      );
    if (excludedCalls.some((excluded) => plan.steps.some((step) => step.tool === excluded.tool && step.action === excluded.action))) {
      throw new Error("替代计划仍重复安排了已知无结果的工具动作；已拒绝该计划。");
    }
    const updated = this.runStore.replaceIncompleteSteps(runId, plan);
    if (!updated) {
      throw new Error("该 Agent 运行正在执行，暂时不能重新规划。");
    }
    return updated;
  }

  async retryStep(runId: string, stepId: string): Promise<AgentRun> {
    const updated = this.runStore.retryStep(runId, stepId);
    if (!updated) {
      throw new Error("该步骤当前不能重试。");
    }
    return updated;
  }

  async skipStep(runId: string, stepId: string): Promise<AgentRun> {
    const updated = this.runStore.skipStep(runId, stepId);
    if (!updated) {
      throw new Error("该步骤当前不能跳过。");
    }
    return updated;
  }

  async cancel(runId: string): Promise<AgentRun> {
    const updated = this.runStore.cancel(runId);
    if (!updated) {
      throw new Error("该 Agent 运行正在执行，暂时不能取消。");
    }
    return updated;
  }

  /** Run the automatically appended web-evidence step without another prompt. */
  private async continueEvidenceCompletion(run: AgentRun): Promise<AgentRun> {
    const next = run.steps.find((step) => step.status === "pending");
    if (!next || next.tool !== "research" || next.action !== "answer-web" || !this.configuration.hasTavilyApiKey()) {
      return run;
    }
    return this.executeStep(run.id, next.id, true);
  }

  private async hasRelevantWiki(goal: string): Promise<boolean> {
    try {
      return await this.configuration.hasRelevantWiki(goal);
    } catch {
      return false;
    }
  }

  private requestPlan(goal: string, memoryContext: string, replanFeedback = ""): Promise<AgentRunPlan> {
    if (this.configuration.planAgentRun) {
      return this.configuration.planAgentRun(goal, memoryContext, replanFeedback);
    }
    return this.createClient().planAgentRun(goal, memoryContext, replanFeedback);
  }

  private createClient(): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey(),
      model: this.configuration.deepSeekModel(),
      slowResponseMs: this.configuration.requestTimeoutMs(),
      postJson: postJsonWithFetch
    });
  }
}

function isEvidenceCollectionCall(call: AgentToolCall): boolean {
  return call.tool === "research" && (
    call.action === "answer-vault" || isLlmWikiEvidenceCall(call)
  );
}

function isLlmWikiEvidenceCall(call: AgentToolCall): boolean {
  return call.tool === "research" && (
    call.action === "wiki-search" ||
    call.action === "wiki-read" ||
    call.action === "wiki-follow" ||
    call.action === "answer-wiki"
  );
}
