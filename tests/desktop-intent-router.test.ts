import { describe, expect, it } from "vitest";
import { detectDesktopAgentIntent } from "../src/desktop/desktop-intent-router";

describe("desktop intent router", () => {
  it("routes explicit operational requests without a model classification request", () => {
    expect(detectDesktopAgentIntent({ question: "请编译 LangGraph LLM Wiki" })).toMatchObject({
      intent: "compile-wiki",
      subject: "LangGraph"
    });
    expect(detectDesktopAgentIntent({ question: "补全 LangGraph LLM Wiki" })).toMatchObject({
      intent: "expand-wiki",
      subject: "LangGraph"
    });
    expect(detectDesktopAgentIntent({ question: "检查 LangGraph LLM Wiki 来源" })).toMatchObject({
      intent: "inspect-wiki-sources",
      subject: "LangGraph"
    });
    expect(detectDesktopAgentIntent({ question: "联网核验 LangGraph LLM Wiki" })).toMatchObject({
      intent: "verify-wiki",
      subject: "LangGraph"
    });
    expect(detectDesktopAgentIntent({ question: "解析资料夹里的图片" })).toMatchObject({ intent: "process-images" });
  });

  it("uses the active note for an explicit relation request", () => {
    expect(detectDesktopAgentIntent({
      question: "补全当前笔记关联",
      activeNotePath: "后端/LangGraph.md"
    })).toEqual({ intent: "complete-relations", notePath: "后端/LangGraph.md" });
  });

  it("only changes profile or assistant state after explicit memory commands", () => {
    expect(detectDesktopAgentIntent({ question: "记住我偏好简洁的中文回答" })).toEqual({
      intent: "remember-profile",
      subject: "我偏好简洁的中文回答"
    });
    expect(detectDesktopAgentIntent({ question: "忘记我偏好详细回答" })).toEqual({
      intent: "forget-profile",
      subject: "我偏好详细回答"
    });
    expect(detectDesktopAgentIntent({ question: "设为当前重点：完善记忆系统" })).toEqual({
      intent: "set-current-focus",
      subject: "完善记忆系统"
    });
    expect(detectDesktopAgentIntent({ question: "查看助手状态" })).toEqual({ intent: "open-assistant-state" });
  });

  it("keeps ambiguous or explanatory questions on the answer route", () => {
    expect(detectDesktopAgentIntent({ question: "如何编译 LLM Wiki？" })).toEqual({ intent: "answer" });
    expect(detectDesktopAgentIntent({ question: "Pydantic 是什么" })).toEqual({ intent: "answer" });
  });
});
