import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "../src/renderer/App";

const VAULT = "D:/develop/agent for obsidian/knowledge/agentlearning-知识环迁移";

function render(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownPreview, { content, onOpenLink: () => undefined }));
}

function count(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}`, "g")) ?? []).length;
}

describe("MarkdownPreview", () => {
  it("renders a real LLM Wiki page without its machine state", () => {
    const html = render(readFileSync(`${VAULT}/知识体系/Agent/LLM Wiki/LangGraph/概览.md`, "utf8"));

    expect(html).toContain("<h1>");
    expect(html).toContain("LangGraph · LLM Wiki");
    expect(html).toContain("markdown-callout");
    expect(html).toContain("摘要");
    // The source ledger must not leak into what the reader sees.
    expect(html).not.toContain("knowledge-loop-agent");
    expect(html).not.toContain("contentHash");
    expect(html).not.toContain("agent-created");
    expect(html).not.toContain("&lt;!--");
  });

  it("renders percent-encoded locators as readable Chinese", () => {
    const html = render(
      "- [[daily/x.md|x]] · heading=%E7%8A%B6%E6%80%81%E6%B5%81%E8%BD%AC&amp;chunk=1\n"
    );
    expect(html).toContain("状态流转");
    expect(html).not.toContain("%E7%8A%B6");
  });

  it("turns a markdown table into a real table", () => {
    const html = render(["| 主题 | 笔记数 |", "| --- | --- |", "| LangGraph | 9 |"].join("\n"));

    expect(html).toContain("<table");
    expect(html).toContain("<th>");
    expect(html).toContain("主题");
    expect(html).toContain("<td>");
    expect(html).toContain("LangGraph");
    expect(html).not.toContain("| --- |");
  });

  it("merges consecutive quote lines into one blockquote", () => {
    const html = render(["> 第一行", "> 第二行"].join("\n"));

    expect(html.match(/<blockquote/g)?.length).toBe(1);
    expect(html).toContain("第一行 第二行");
  });

  it("renders a callout with its label instead of literal brackets", () => {
    const html = render(["> [!warning] 注意", "> 这一句很重要"].join("\n"));

    expect(html).toContain("callout-warning");
    expect(html).toContain("警告");
    expect(html).not.toContain("[!warning]");
  });

  it("renders lists as lists and keeps indentation", () => {
    const html = render(["- 一级", "  - 二级", "1. 第一步"].join("\n"));

    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("margin-left:18px");
    expect(html).toContain("第一步");
  });

  it("emphasises bold and inline code instead of showing markers", () => {
    const html = render("这是 **加粗** 与 `代码`。");

    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("markdown-inline-code");
    expect(html).not.toContain("**");
  });

  it("renders wikilinks as buttons with their alias", () => {
    const html = render("- [[daily/BM25.md|BM25 打分]]");

    expect(html).toContain("markdown-link");
    expect(html).toContain("BM25 打分");
    expect(html).not.toContain("[[");
  });

  it("keeps fenced code intact and does not parse inside it", () => {
    const html = render(["```ts", "const a = '# 不是标题';", "```"].join("\n"));

    expect(html).toContain("markdown-code");
    expect(html).toContain("const a =");
    expect(html).not.toContain("<h1>");
  });

  it("shows diagram source with a way to take it elsewhere", () => {
    const html = render(["```mermaid", "flowchart TD", "  A[根节点] --> B[叶子]", "```"].join("\n"));

    expect(html).toContain("markdown-diagram");
    expect(html).toContain("diagram-copy");
    expect(html).toContain("A[根节点]");
    // Escaped, because it goes out as HTML: "-->" is not an opportunity.
    expect(html).toContain("--&gt;");
    // The figure is drawn in place now; the source stays available so it can
    // still be copied into a note. There is no Obsidian hand-off any more.
    expect(html).toContain("diagram-source");
  });

  it("leaves ordinary code alone", () => {
    const html = render(["```ts", "const a = 1;", "```"].join("\n"));

    expect(html).toContain("markdown-code");
    expect(html).not.toContain("markdown-diagram");
  });

  it("never renders a raw URL as an anchor that could leave the app", () => {
    const html = render("参见 [标题](https://example.com/a)。");

    expect(html).not.toContain("<a href");
    expect(html).toContain("标题");
  });

  it("numbers a spaced ordered list as one list, not a series of 1s", () => {
    const html = render(
      [
        "1. **没有拥塞控制**：UDP 不像 TCP 那样调整发送速率。",
        "",
        "2. **服务质量保障**：运营商要区分优先级。",
        "",
        "3. **成本控制**：对非关键 UDP 流量限速。"
      ].join("\n")
    );

    // One list, so the browser can number it 1/2/3. Splitting it gave every
    // item its own <ol>, and each of those restarts at 1 — a five item list
    // displayed as 1. 1. 1. 1. 1.
    expect(count(html, "ol")).toBe(1);
    expect(count(html, "li")).toBe(3);
  });

  it("keeps a real note's spaced list intact", () => {
    const html = render(
      readFileSync(`${VAULT}/daily/UDP不能很好的满足服务商的QoS.md`, "utf8")
    );

    expect(count(html, "ol")).toBe(1);
    expect(count(html, "li")).toBeGreaterThan(1);
  });

  it("folds an indented explanation into the item it belongs to", () => {
    const html = render(
      [
        "1. **没有拥塞控制**",
        "   抢占式调度才能让用户公平使用链路资源，UDP 不做限速。",
        "",
        "2. **服务质量保障**",
        "   运营商要优先保证 VoIP 的 QoS。"
      ].join("\n")
    );

    // The explanation is the item's own text, not a sibling paragraph — and
    // the item that follows it must not restart the numbering.
    expect(count(html, "ol")).toBe(1);
    expect(count(html, "li")).toBe(2);
    expect(count(html, "p")).toBe(0);
  });

  it("still separates an ordered list from a bullet list that follows it", () => {
    const html = render("1. 第一项\n\n2. 第二项\n\n- 换个列表\n- 第二项\n");

    expect(count(html, "ol")).toBe(1);
    expect(count(html, "ul")).toBe(1);
  });
});
