import { describe, expect, it } from "vitest";
import {
  buildActionTargetPath,
  createManualCaptureSource,
  createKnowledgeSystemProposal,
  renderAgentSessionAppend,
  renderDailyAppend,
  sanitizeFileStem,
  validateActionProposal
} from "../src/actions/action-proposal";

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
});
