import {
  createRunStep,
  getAgentToolDefinition,
  isAgentToolCall,
  type AgentRun,
  type AgentRunPlan,
  type AgentRunStatus,
  type AgentRunStep,
  type AgentRunStepStatus,
  type AgentToolCall
} from "./agent-runtime";

const MAX_AGENT_RUNS = 20;
const TERMINAL_STEP_STATUSES = new Set<AgentRunStepStatus>(["completed", "skipped"]);
const LEGACY_TOOL_CALLS: Record<string, AgentToolCall> = {
  "rebuild-markdown-index": { tool: "index", action: "rebuild-markdown" },
  "create-maintenance-plan": { tool: "organize", action: "maintenance-plan" },
  "process-attachment-batch": { tool: "index", action: "process-attachments" }
};

/** Durable run state only: secrets, source bodies, and model responses do not belong here. */
export class AgentRunStore {
  private readonly runs = new Map<string, AgentRun>();

  constructor(runs: AgentRun[] = []) {
    for (const run of runs.map(normalizePersistedRun).filter(isValidRun).slice(-MAX_AGENT_RUNS)) {
      recoverInterruptedRun(run);
      this.runs.set(run.id, run);
    }
  }

  add(run: AgentRun): AgentRun {
    this.runs.set(run.id, run);
    this.trim();
    return run;
  }

  get(id: string): AgentRun | null {
    return this.runs.get(id) ?? null;
  }

  getLatestForSession(sessionId: string): AgentRun | null {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  startStep(runId: string, stepId: string): { run: AgentRun; step: AgentRunStep } | null {
    const run = this.runs.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!run || !step || run.status === "cancelled" || step.status !== "pending") {
      return null;
    }
    step.status = "running";
    step.startedAt = new Date().toISOString();
    step.completedAt = undefined;
    step.resultSummary = undefined;
    run.status = "running";
    run.updatedAt = new Date().toISOString();
    return { run, step };
  }

  finishStep(runId: string, stepId: string, status: Extract<AgentRunStepStatus, "completed" | "failed" | "blocked">, resultSummary: string): AgentRun | null {
    const run = this.runs.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!run || !step || step.status !== "running") {
      return null;
    }
    step.status = status;
    step.completedAt = new Date().toISOString();
    step.resultSummary = resultSummary.slice(0, 800);
    run.updatedAt = new Date().toISOString();
    run.status = deriveRunStatus(run);
    return run;
  }

  retryStep(runId: string, stepId: string): AgentRun | null {
    const run = this.runs.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!run || !step || run.status === "cancelled" || (step.status !== "failed" && step.status !== "blocked")) {
      return null;
    }
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.resultSummary = undefined;
    run.status = "planned";
    run.updatedAt = new Date().toISOString();
    return run;
  }

  skipStep(runId: string, stepId: string): AgentRun | null {
    const run = this.runs.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!run || !step || run.status === "cancelled" || (step.status !== "pending" && step.status !== "failed" && step.status !== "blocked")) {
      return null;
    }
    step.status = "skipped";
    step.completedAt = new Date().toISOString();
    step.resultSummary = "用户跳过此步骤。";
    run.updatedAt = new Date().toISOString();
    run.status = deriveRunStatus(run);
    return run;
  }

  cancel(runId: string): AgentRun | null {
    const run = this.runs.get(runId);
    if (!run || run.status === "completed" || run.steps.some((step) => step.status === "running")) {
      return null;
    }
    run.status = "cancelled";
    run.updatedAt = new Date().toISOString();
    return run;
  }

  replaceIncompleteSteps(runId: string, plan: AgentRunPlan): AgentRun | null {
    const run = this.runs.get(runId);
    if (
      !run ||
      run.status === "cancelled" ||
      run.replanCount >= 1 ||
      run.steps.some((step) => step.status === "running")
    ) {
      return null;
    }
    for (const step of run.steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) {
        step.status = "skipped";
        step.completedAt = new Date().toISOString();
        step.resultSummary = "已由重新规划替换。";
      }
    }
    const nextSequence = run.steps.length + 1;
    run.steps.push(...plan.steps.map((step, index) => createRunStep(step, nextSequence + index)));
    run.planSummary = plan.summary;
    run.replanCount += 1;
    run.status = "planned";
    run.updatedAt = new Date().toISOString();
    return run;
  }

  toJSON(): AgentRun[] {
    return [...this.runs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private trim(): void {
    const oldest = [...this.runs.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    while (oldest.length > MAX_AGENT_RUNS) {
      const removed = oldest.shift();
      if (removed) {
        this.runs.delete(removed.id);
      }
    }
  }
}

function normalizePersistedRun(run: AgentRun): AgentRun {
  if (!Array.isArray(run?.steps)) {
    return run;
  }
  const wasPaused = (run as { status?: unknown }).status === "paused";
  let migrated = wasPaused;
  const steps = run.steps.flatMap((step) => {
    if (isRemovedReviewStep(step)) {
      migrated = true;
      return [];
    }
    const legacyTool = LEGACY_TOOL_CALLS[String((step as { tool?: unknown }).tool)];
    const call = isAgentToolCall(step) ? step : legacyTool;
    if (!call) {
      return [step];
    }
    migrated = true;
    const definition = getAgentToolDefinition(call);
    return [{
      ...step,
      ...call,
      confirmation: definition.confirmation,
      requiresConfirmation: definition.confirmation !== "none"
    }];
  });
  if (!migrated) {
    return run;
  }
  return {
    ...run,
    steps,
    ...(run.steps.length && !steps.length
      ? { status: "completed" as const }
      : wasPaused ? { status: "planned" as const } : {})
  };
}

function isRemovedReviewStep(step: { tool?: unknown }): boolean {
  return step.tool === "review" || step.tool === "open-next-review";
}

function recoverInterruptedRun(run: AgentRun): void {
  let recovered = false;
  for (const step of run.steps) {
    if (step.status === "running") {
      step.status = "pending";
      step.startedAt = undefined;
      step.completedAt = undefined;
      step.resultSummary = "插件关闭前中断；已恢复为待执行。";
      recovered = true;
    }
  }
  if (recovered && run.status !== "cancelled" && run.status !== "completed") {
    run.status = "planned";
    run.updatedAt = new Date().toISOString();
  }
}

function deriveRunStatus(run: AgentRun): AgentRunStatus {
  if (run.status === "cancelled") {
    return run.status;
  }
  return run.steps.every((step) => TERMINAL_STEP_STATUSES.has(step.status)) ? "completed" : "planned";
}

function isValidRun(run: AgentRun): boolean {
  return Boolean(
    run?.id && run.goal && run.createdAt && run.updatedAt &&
    (run.status === "planned" || run.status === "running" || run.status === "completed" || run.status === "cancelled") &&
    typeof run.planSummary === "string" && Number.isInteger(run.replanCount) && run.replanCount >= 0 &&
    Array.isArray(run.steps) && run.steps.every(isValidStep)
  );
}

function isValidStep(step: AgentRunStep): boolean {
  return Boolean(
    step?.id && step.title && step.reason && typeof step.requiresConfirmation === "boolean" &&
    isAgentToolCall(step) &&
    (step.status === "pending" || step.status === "running" || step.status === "completed" || step.status === "skipped" || step.status === "failed" || step.status === "blocked")
  );
}
