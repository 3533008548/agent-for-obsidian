import type { AgentRun, AgentRunStep, AgentToolCall, AgentToolDefinition } from "./agent-runtime";
import { AGENT_TOOL_DEFINITIONS, getAgentToolDefinition, toolKey } from "./agent-runtime";

export interface AgentToolExecutionContext {
  goal: string;
  run: AgentRun;
  step: AgentRunStep;
}

export interface AgentToolExecutionResult {
  summary: string;
  artifact?: "answer" | "knowledge-map" | "write-preview";
  /** A bounded, runtime-generated observation that warrants one alternative plan. */
  replanFeedback?: string;
  /** Tool calls that an automatically generated replacement plan must not repeat. */
  replanExclusions?: AgentToolCall[];
}

export interface AgentToolHandler {
  definition: AgentToolDefinition;
  execute(context: AgentToolExecutionContext): Promise<AgentToolExecutionResult>;
}

export type AgentToolExecutor = (context: AgentToolExecutionContext) => Promise<AgentToolExecutionResult>;
export type AgentToolExecutors = Record<string, AgentToolExecutor>;

/** One registry is shared by runtime orchestration and future manual-button adapters. */
export class AgentToolRegistry {
  private readonly handlers: Map<string, AgentToolHandler>;

  constructor(handlers: AgentToolHandler[]) {
    this.handlers = new Map(handlers.map((handler) => [toolKey(handler.definition), handler]));
    for (const definition of AGENT_TOOL_DEFINITIONS) {
      if (!this.handlers.has(toolKey(definition))) {
        throw new Error(`Agent 工具注册缺失：${toolKey(definition)}。`);
      }
    }
  }

  getDefinition(call: AgentToolCall): AgentToolDefinition {
    return getAgentToolDefinition(call);
  }

  async execute(context: AgentToolExecutionContext): Promise<AgentToolExecutionResult> {
    const handler = this.handlers.get(toolKey(context.step));
    if (!handler) {
      throw new Error("未注册的 Agent 工具动作。");
    }
    return handler.execute(context);
  }
}

export function createAgentToolRegistry(executors: AgentToolExecutors): AgentToolRegistry {
  return new AgentToolRegistry(AGENT_TOOL_DEFINITIONS.map((definition) => {
    const execute = executors[toolKey(definition)];
    if (!execute) {
      throw new Error(`Agent 工具执行器缺失：${toolKey(definition)}。`);
    }
    return { definition, execute };
  }));
}
