import { describe, expect, it } from "vitest";
import { AGENT_TOOL_DEFINITIONS, type AgentRun, type AgentRunStep } from "../core/runtime/agent-runtime";
import { RuntimeToolBlockedError } from "../core/runtime/agent-runtime-errors";
import {
  createDesktopRuntimeToolRegistry,
  type DesktopRuntimeState,
  type DesktopRuntimeToolDependencies
} from "../core/desktop/desktop-runtime-tools";

function createDependencies(overrides: Partial<DesktopRuntimeToolDependencies> = {}) {
  const state: DesktopRuntimeState = {};
  return {
    state,
    deps: {
      state,
      index: { rebuild: async () => ({ indexedFiles: 3, chunkCount: 12, skippedFiles: 0 }) },
      policy: {},
      agent: {
        answer: async () => {
          throw new Error("本地检索没有找到直接证据。");
        },
        answerFromWeb: async () => ({
          content: "联网回答",
          mode: "web",
          evidenceComplete: true,
          sources: []
        })
      },
      wiki: {
        searchPages: async () => [],
        readPages: async () => [],
        followPages: async () => [],
        answerFromPages: async () => ({ content: "", paths: [] }),
        compileDraft: async () => ({ topic: "", pages: [], sourceCount: 0 })
      },
      knowledge: {
        createMap: async () => ({
          id: "map-1",
          topic: "主题",
          scopeLabel: "本地",
          createdAt: "2026-01-01T00:00:00.000Z",
          sources: [],
          map: { overview: "", nodes: [], conflicts: [], gaps: [] }
        }),
        previewMap: async () => createPreview(),
        previewNode: async () => createPreview()
      },
      maintenance: { analyze: async () => ({ summary: "无问题", findings: [] }) },
      attachments: {
        scan: async () => ({ queued: 1, unchanged: 2, blocked: 0, removed: 0, unsupportedPdfCount: 1 }),
        processAll: async () => ({ indexed: 2, failed: 0, pending: 0 })
      },
      relation: {
        preview: async () => ({ path: "a.md", summary: "无关联", relationCount: 0, afterContent: null }),
        apply: async (preview: { path: string }) => preview
      },
      write: {
        previewAnswer: async () => createPreview(),
        previewPath: async () => createPreview(),
        previewExistingNote: async () => createPreview()
      },
      knowledgeSystemFolder: "知识体系/Agent",
      deepSeekApiKey: () => "key",
      deepSeekModel: () => "deepseek-chat",
      requestTimeoutMs: () => 30_000,
      activeNotePath: () => "note.md",
      formatClipboard: async () => ({ content: "| a |", changed: true }),
      describeStatus: () => "状态正常",
      ...overrides
    } as unknown as DesktopRuntimeToolDependencies
  };
}

function createPreview() {
  return {
    action: "createInboxNote",
    targetPath: "00 Inbox/Agent/x.md",
    existedBefore: false,
    beforeContent: "",
    afterContent: "内容"
  };
}

function createStep(tool: string, action: string): AgentRunStep {
  return {
    id: `step-1-${tool}-${action}`,
    tool,
    action,
    title: "标题",
    reason: "原因",
    confirmation: "none",
    requiresConfirmation: false,
    status: "pending"
  } as unknown as AgentRunStep;
}

function createRun(goal: string): AgentRun {
  return { id: "run-1", goal, createdAt: "", updatedAt: "", status: "planned", replanCount: 0, planSummary: "", steps: [] };
}

describe("desktop runtime tool registry", () => {
  it("registers every whitelisted agent action", () => {
    const { deps } = createDependencies();
    expect(() => createDesktopRuntimeToolRegistry(deps)).not.toThrow();
  });

  it("covers all 22 tool definitions", () => {
    expect(AGENT_TOOL_DEFINITIONS).toHaveLength(22);
  });

  it("reports an explicit block for capabilities the desktop shell lacks", async () => {
    const { deps } = createDependencies();
    const registry = createDesktopRuntimeToolRegistry(deps);
    await expect(registry.execute({
      goal: "目标",
      run: createRun("目标"),
      step: createStep("editor", "repair-selection")
    })).rejects.toBeInstanceOf(RuntimeToolBlockedError);
    await expect(registry.execute({
      goal: "目标",
      run: createRun("目标"),
      step: createStep("system", "test-glm")
    })).rejects.toBeInstanceOf(RuntimeToolBlockedError);
  });

  it("turns a missing local answer into replan feedback instead of failing", async () => {
    const { deps, state } = createDependencies({
      agent: {
        answer: async () => {
          const { LocalKnowledgeUnavailableError } = await import("../core/runtime/agent-runtime-errors");
          throw new LocalKnowledgeUnavailableError("本地没有证据", "不要重复 answer-vault");
        },
        answerFromWeb: async () => ({ content: "", mode: "web", evidenceComplete: true, sources: [] })
      } as never
    });
    const registry = createDesktopRuntimeToolRegistry(deps);
    const result = await registry.execute({
      goal: "目标",
      run: createRun("目标"),
      step: createStep("research", "answer-vault")
    });
    expect(result.replanFeedback).toContain("answer-vault");
    expect(result.autoContinue).toBe(true);
    expect(state.answer).toBeUndefined();
  });

  it("never writes when previewing a knowledge map", async () => {
    const { deps, state } = createDependencies();
    const registry = createDesktopRuntimeToolRegistry(deps);
    const result = await registry.execute({
      goal: "整理笔记",
      run: createRun("整理笔记"),
      step: createStep("organize", "knowledge-map")
    });
    expect(result.artifact).toBe("write-preview");
    expect(state.knowledgeMap).toBeDefined();
    expect(state.writePreviews).toHaveLength(1);
  });

  it("blocks a note preview when the run produced no answer", async () => {
    const { deps } = createDependencies();
    const registry = createDesktopRuntimeToolRegistry(deps);
    await expect(registry.execute({
      goal: "目标",
      run: createRun("目标"),
      step: createStep("note", "preview-inbox")
    })).rejects.toBeInstanceOf(RuntimeToolBlockedError);
  });
});
