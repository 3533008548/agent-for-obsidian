import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isBlockStart,
  isTableDivider,
  isTableRow,
  parseBullet,
  parseCalloutHead,
  splitTableRow,
  stripMachineNoise
} from "../src/renderer/markdown-model";

const WIKI_PAGE =
  "D:/develop/agent for obsidian/knowledge/agentlearning-知识环迁移/知识体系/Agent/LLM Wiki/LangGraph/概览.md";

describe("machine noise removal", () => {
  it("drops frontmatter and the JSON comment from a real Wiki page", () => {
    const cleaned = stripMachineNoise(readFileSync(WIKI_PAGE, "utf8"));

    expect(cleaned).not.toContain("---");
    expect(cleaned).not.toContain("knowledge-loop-agent");
    expect(cleaned).not.toContain("contentHash");
    expect(cleaned).not.toContain("<!--");
    expect(cleaned.startsWith("# LangGraph · LLM Wiki")).toBe(true);
  });

  it("leaves frontmatter alone when the file does not start with it", () => {
    expect(stripMachineNoise("# 标题\n\n正文\n")).toBe("# 标题\n\n正文\n");
  });

  it("keeps HTML comments inside fenced code", () => {
    const source = ["# 标题", "", "```html", "<!-- 这是示例 -->", "```", ""].join("\n");
    expect(stripMachineNoise(source)).toContain("<!-- 这是示例 -->");
  });

  it("removes a trailing comment block without eating the last line", () => {
    const cleaned = stripMachineNoise("# T\n\n正文\n\n<!-- x\n{}\n-->\n");
    expect(cleaned.trim()).toBe("# T\n\n正文");
  });
});

describe("table recognition", () => {
  it("recognises the divider row that makes a table", () => {
    expect(isTableRow("| a | b |")).toBe(true);
    expect(isTableDivider("| --- | --- |")).toBe(true);
    expect(isTableDivider("| a | b |")).toBe(false);
  });

  it("splits cells and drops the outer pipes", () => {
    expect(splitTableRow("| LangGraph | 9 | x |")).toEqual(["LangGraph", "9", "x"]);
    expect(splitTableRow("a | b")).toEqual(["a", "b"]);
  });
});

describe("callout heads", () => {
  it("reads the kind and title", () => {
    expect(parseCalloutHead("[!info] 概念页 · LangGraph")).toEqual({ kind: "info", title: "概念页 · LangGraph" });
    expect(parseCalloutHead("[!warning]")).toEqual({ kind: "warning", title: "" });
    expect(parseCalloutHead("[!abstract]- 可折叠")).toEqual({ kind: "abstract", title: "可折叠" });
  });

  it("does not mistake ordinary text for a callout", () => {
    expect(parseCalloutHead("这是一段普通文字")).toBeNull();
    expect(parseCalloutHead("返回主题：[[x]]")).toBeNull();
  });
});

describe("bullet parsing", () => {
  it("turns indentation into depth", () => {
    expect(parseBullet("- 一级")).toEqual({ depth: 0, ordered: false, text: "一级" });
    expect(parseBullet("  - 二级")).toEqual({ depth: 1, ordered: false, text: "二级" });
    expect(parseBullet("    - 三级")).toEqual({ depth: 2, ordered: false, text: "三级" });
    expect(parseBullet("1. 有序")).toEqual({ depth: 0, ordered: true, text: "有序" });
  });

  it("ignores lines that are not list items", () => {
    expect(parseBullet("正文一句话")).toBeNull();
    expect(parseBullet("-需要空格才成立")).toBeNull();
  });
});

describe("block boundaries", () => {
  it("ends a paragraph at every block-level construct", () => {
    for (const line of ["# 标题", "## 小节", "> 引用", "- 列表", "1. 列表", "```", "---", "| a | b |"]) {
      expect(isBlockStart(line)).toBe(true);
    }
  });

  it("keeps ordinary prose inside the paragraph", () => {
    expect(isBlockStart("这是一段普通的正文。")).toBe(false);
  });
});
