import { describe, expect, it } from "vitest";
import {
  buildRewriteMessages,
  parseRewrite,
  shouldRewriteFollowUp
} from "../core/desktop/question-rewrite";

describe("shouldRewriteFollowUp", () => {
  it("rewrites a bare follow-up whose subject is missing", () => {
    // The real case: asked right after the TLS handshake answer, so the
    // subject ("Client/Server Random") only exists in the conversation.
    expect(shouldRewriteFollowUp("为什么要有随机数")).toBe(true);
  });

  it("rewrites a short question that points back at the conversation", () => {
    expect(shouldRewriteFollowUp("那它为什么这么设计")).toBe(true);
    expect(shouldRewriteFollowUp("这个还有别的做法吗")).toBe(true);
  });

  it("leaves a question that already names its subject alone", () => {
    // This one retrieves correctly as written — verified against a real vault —
    // so spending a model call on it would be waste.
    expect(shouldRewriteFollowUp("客户端和服务器为什么要互发随机数")).toBe(false);
    expect(shouldRewriteFollowUp("为什么索引可以提高查询效率")).toBe(false);
  });

  it("never rewrites meta questions or long prompts", () => {
    expect(shouldRewriteFollowUp("你刚才为什么没联网")).toBe(false);
    expect(shouldRewriteFollowUp("为什么要有随机数，为什么要有随机数，为什么要有随机数，为什么要有随机数")).toBe(false);
  });

  it("ignores empty input", () => {
    expect(shouldRewriteFollowUp("   ")).toBe(false);
  });
});

describe("buildRewriteMessages", () => {
  it("passes the recent conversation and forbids answering the question", () => {
    const messages = buildRewriteMessages("为什么要有随机数", "最近讨论了 TLS 握手");
    const system = messages[0]!.content;
    expect(system).toContain("不要回答问题本身");
    expect(system).toContain("不可信文本");
    expect(messages[1]!.content).toContain("TLS 握手");
    expect(messages[1]!.content).toContain("为什么要有随机数");
  });

  it("says so when there is no conversation to use", () => {
    expect(buildRewriteMessages("为什么要有随机数", "")[1]!.content).toContain("没有可用的最近对话");
  });
});

describe("parseRewrite", () => {
  it("takes a rewritten question and reports the change", () => {
    const result = parseRewrite(
      '{"rewritten":"为什么 TLS 握手中客户端和服务器要各自生成随机数"}',
      "为什么要有随机数"
    );
    expect(result.changed).toBe(true);
    expect(result.rewritten).toContain("TLS");
  });

  it("reports no change when the model returns the question unchanged", () => {
    const result = parseRewrite('{"rewritten":"为什么要有随机数"}', "为什么要有随机数");
    expect(result.changed).toBe(false);
    expect(result.rewritten).toBe("为什么要有随机数");
  });

  it("falls back to the original on unparsable output", () => {
    // A failed rewrite must never cost the user their answer.
    expect(parseRewrite("抱歉，我不能回答", "为什么要有随机数")).toEqual({
      rewritten: "为什么要有随机数",
      changed: false
    });
    expect(parseRewrite('{"rewritten":""}', "为什么要有随机数").changed).toBe(false);
  });

  it("tolerates a fenced JSON block", () => {
    const result = parseRewrite('```json\n{"rewritten":"客户端随机数的作用是什么"}\n```', "它有什么作用");
    expect(result.rewritten).toBe("客户端随机数的作用是什么");
  });
});
