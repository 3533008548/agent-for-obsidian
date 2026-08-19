import { describe, expect, it } from "vitest";
import {
  formatPastedContent,
  parsePasteRepairSuggestion
} from "../src/paste/paste-formatter";

describe("paste formatter", () => {
  it("converts TSV tables locally, pads short rows, and escapes Markdown pipes", () => {
    const result = formatPastedContent({
      text: "项目\t状态\t备注\n索引\t完成\n修复\t进行中\t包含 | 符号"
    });

    expect(result.recommendedOutput).toBe("markdown");
    expect(result.markdown).toContain("| 项目 | 状态 | 备注 |");
    expect(result.markdown).toContain("| 索引 | 完成 |  |");
    expect(result.markdown).toContain("包含 \\| 符号");
    expect(result.report.repairedCellCount).toBe(1);
  });

  it("keeps a sanitized HTML alternative when a table has merged cells", () => {
    const result = formatPastedContent({
      text: "标题\t值",
      html: "<table onclick=\"alert(1)\"><tr><th colspan=\"2\">标题</th></tr><tr><td>A</td><td>B</td></tr></table>"
    });

    expect(result.recommendedOutput).toBe("preserved-html");
    expect(result.preservedHtml).toContain("<table");
    expect(result.preservedHtml).not.toContain("onclick");
    expect(result.report.warnings.join(" ")).toContain("合并单元格");
  });

  it("normalizes an already pasted Markdown table", () => {
    const result = formatPastedContent({ text: "| A | B |\n| - | --- |\n| 1 | 2 |" });
    expect(result.report.kind).toBe("markdown-table");
    expect(result.markdown).toContain("| A | B |");
    expect(result.markdown).toContain("| --- | --- |");
  });

  it("rejects malformed or overreaching Agent repair JSON", () => {
    expect(() => parsePasteRepairSuggestion('{"markdown":"","warnings":[]}')).toThrow("markdown");
    expect(() => parsePasteRepairSuggestion('{"markdown":"| A |","warnings":[1]}')).toThrow("warnings");
    expect(parsePasteRepairSuggestion('{"markdown":"| A |\\n| --- |","warnings":["未确定表头"]}')).toMatchObject({
      markdown: "| A |\n| --- |",
      warnings: ["未确定表头"]
    });
  });
});
