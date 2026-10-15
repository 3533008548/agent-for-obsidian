import { describe, expect, it } from "vitest";
import {
  buildActionTargetPath,
  closeDanglingCodeFence,
  createManualCaptureSource,
  createKnowledgeSystemProposal,
  renderAgentSessionAppend,
  renderDailyAppend,
  sanitizeFileStem,
  validateActionProposal
} from "../core/actions/action-proposal";

describe("action proposals", () => {
  it("normalizes a topic into a safe file stem without losing Chinese text", () => {
    expect(sanitizeFileStem("  机器学习：损失函数?  ")).toBe("机器学习-损失函数");
    expect(sanitizeFileStem("../")).toBe("");
  });

  it("builds a target path only from configured Vault folders", () => {
    const proposal = {
      type: "appendDailyNote" as const,
      topic: "机器学习",
      content: "复习了监督学习。",
      sources: [createManualCaptureSource("复习了监督学习。")]
    };
    expect(buildActionTargetPath(proposal, "00 Inbox/Agent", "daily")).toBe("daily/机器学习.md");
  });

  it("builds knowledge-system notes only in their dedicated folder", () => {
    const proposal = createKnowledgeSystemProposal("机器学习知识地图", "节点关系。", [createManualCaptureSource("节点关系。")]);
    expect(buildActionTargetPath(proposal, "00 Inbox/Agent", "daily", "知识体系/Agent"))
      .toBe("知识体系/Agent/机器学习知识地图.md");
  });

  it("keeps a compiled Wiki page in a stable path below the knowledge-system folder", () => {
    const proposal = createKnowledgeSystemProposal(
      "LangGraph LLM Wiki",
      "主题概览。",
      [createManualCaptureSource("主题概览。")],
      "LLM Wiki/LangGraph/概览.md"
    );
    expect(buildActionTargetPath(proposal, "00 Inbox/Agent", "daily", "知识体系/Agent"))
      .toBe("知识体系/Agent/LLM Wiki/LangGraph/概览.md");
  });

  it("requires nonempty content and a source", () => {
    expect(validateActionProposal({
      type: "createInboxNote",
      title: "想法",
      content: "",
      sources: []
    })).toHaveLength(2);
  });

  it("renders a source-bearing topic journal entry", () => {
    const content = "复习了监督学习。";
    const output = renderDailyAppend({
      type: "appendDailyNote",
      topic: "机器学习",
      content,
      sources: [createManualCaptureSource(content)]
    }, "", new Date(2026, 7, 10, 9, 5));

    expect(output).toContain("# 机器学习");
    expect(output).toContain("## 2026-08-10 09:05");
    expect(output).toContain("### 来源");
  });

  it("keeps session append targets explicit instead of deriving them from model text", () => {
    const proposal = {
      type: "appendAgentSession" as const,
      sessionPath: "00 Inbox/Agent/Sessions/2026-08-17-demo.md",
      content: "## 新记录",
      sources: [createManualCaptureSource("新记录")]
    };
    expect(buildActionTargetPath(proposal, "00 Inbox/Agent", "daily", "知识体系/Agent", "00 Inbox/Agent"))
      .toBe("00 Inbox/Agent/Sessions/2026-08-17-demo.md");
    expect(renderAgentSessionAppend(proposal, "# 会话")).toContain("# 会话\n\n## 新记录");
  });

  it("keeps an existing-note update pinned to its explicit Vault path", () => {
    const proposal = {
      type: "modifyExistingNote" as const,
      notePath: "RAG/总览.md",
      content: "- 前置概念：[[RAG/向量检索.md]]",
      sources: [createManualCaptureSource("关联提案")]
    };
    expect(buildActionTargetPath(proposal, "00 Inbox/Agent", "daily")).toBe("RAG/总览.md");
  });

  it("closes a fence the model left open so the footer stays outside the block", () => {
    // A real answer, truncated mid-diagram: the closing ``` never arrived, and
    // appending "### 来源" after it swallowed the provenance into the diagram —
    // the note then failed to render and the source line was invisible.
    const content = [
      "第五步，生成会话密钥。",
      "",
      "```mermaid",
      "sequenceDiagram",
      "    C->>S: New Session Ticket",
      "    Note"
    ].join("\n");
    const output = renderDailyAppend({
      type: "appendDailyNote",
      topic: "HTTPS完整握手流程",
      content,
      sources: [createManualCaptureSource(content)]
    }, "# HTTPS完整握手流程\n\n已有正文。\n", new Date(2026, 9, 4, 16, 25));

    // Two fence lines: the ```mermaid that opened the block and the one we add.
    expect(output.split("\n").filter((line) => /^\s*(?:```|~~~)/u.test(line)).length % 2).toBe(0);
    // The footer has to come after the closing fence, not inside the block.
    expect(output.lastIndexOf("```")).toBeLessThan(output.indexOf("### 来源"));
    expect(output.trimEnd().endsWith("- 当前会话中的手动记录")).toBe(true);
  });

  it("leaves a balanced document exactly as the model wrote it", () => {
    const content = "```mermaid\nsequenceDiagram\n    A->>B: hi\n```\n";
    expect(closeDanglingCodeFence(content)).toBe(content);
    // An odd count means "inside a block"; a document may legitimately contain
    // a fence inside a fenced example, which is why this counts whole lines.
    expect(closeDanglingCodeFence("```\n示例：\n```\n```js\nconst a = 1;\n")).toContain("const a = 1;");
  });
});
