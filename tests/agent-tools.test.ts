import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_DEFINITIONS,
  getAgentToolDefinition
} from "../src/runtime/agent-runtime";
import { createAgentToolRegistry } from "../src/runtime/agent-tools";

describe("AgentToolRegistry", () => {
  it("requires one executor for every registered semantic tool action", () => {
    expect(() => createAgentToolRegistry({})).toThrow("执行器缺失");
  });

  it("centralizes confirmation policy instead of trusting the model", () => {
    expect(getAgentToolDefinition({ tool: "index", action: "rebuild-markdown" }).confirmation).toBe("none");
    expect(getAgentToolDefinition({ tool: "research", action: "answer-vault" }).confirmation).toBe("external-request");
    expect(getAgentToolDefinition({ tool: "note", action: "preview-inbox" }).confirmation).toBe("write-preview");
    expect(getAgentToolDefinition({ tool: "editor", action: "normalize-paste" }).confirmation).toBe("editor-context");
  });

  it("has no duplicate semantic tool registrations", () => {
    const keys = AGENT_TOOL_DEFINITIONS.map((definition) => `${definition.tool}:${definition.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((key) => key.startsWith("review:"))).toBe(false);
  });
});
