import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSessionService } from "../core/desktop/desktop-session-service";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopSessionService", () => {
  it("persists one conversation in one Markdown session and exposes it as memory context", async () => {
    const root = await createWorkspace();
    const service = new DesktopSessionService(new NodeFileSystemKnowledgeRepository(root));

    const session = await service.createSession("LangGraph 学习");
    await service.appendExchange("LangGraph 是什么？", "LangGraph 用于构建有状态的 LLM 应用。");
    await service.appendActionExchange("编译 LangGraph Wiki", "已编译 3 个页面。", "编译 LLM Wiki");
    const remembered = await service.rememberProfile("我偏好简洁的中文回答");
    const statePath = await service.setCurrentFocus("完善个人助手记忆系统");

    const content = await readFile(join(root, ...session.path.split("/")), "utf8");
    const context = await service.getMemoryContext();

    expect(content).toContain("LangGraph 是什么？");
    expect(content).toContain("有状态的 LLM 应用");
    expect(content).toContain("编译 LLM Wiki");
    expect(context.includedSession).toBe(true);
    expect(context.includedAssistantState).toBe(true);
    expect(context.content).toContain("当前会话最近记录");
    expect(context.content).toContain("助手状态");
    expect((await readFile(join(root, ...remembered.path.split("/")), "utf8"))).toContain("偏好：我偏好简洁的中文回答");
    expect((await readFile(join(root, ...statePath.split("/")), "utf8"))).toContain("完善个人助手记忆系统");
    await expect(service.ensureProfile()).resolves.toBe("00 Inbox/Agent/Agent Profile.md");
  });

  it("opens a session on demand instead of waiting to be asked", async () => {
    const root = await createWorkspace();
    const service = new DesktopSessionService(new NodeFileSystemKnowledgeRepository(root));

    expect(service.activeSession).toBeNull();

    const opened = await service.ensureSession("分布式系统");
    const again = await service.ensureSession("另一个标题");

    expect(opened.title).toBe("分布式系统");
    // A second call must not open a second session: the conversation is one
    // continuous thing until it is explicitly closed.
    expect(again.id).toBe(opened.id);
    expect(service.activeSession?.title).toBe("分布式系统");
  });

  it("keeps dropping exchanges when no session is open", async () => {
    const root = await createWorkspace();
    const service = new DesktopSessionService(new NodeFileSystemKnowledgeRepository(root));

    await service.appendExchange("这条会被丢掉", "因为没有打开的会话");

    expect(await service.readConversationLog()).toEqual([]);
  });

  it("records a turn in both the transcript and the replay log", async () => {
    const root = await createWorkspace();
    const repository = new NodeFileSystemKnowledgeRepository(root);
    const service = new DesktopSessionService(repository);
    const session = await service.createSession("分布式系统");

    const turnId = await service.appendTurn({
      question: "什么是分布式系统",
      content: "一组机器对外提供服务。",
      intent: "answer",
      mode: "local",
      evidenceComplete: true,
      sources: [{ path: "daily/分布式系统.md", heading: "定义", excerpt: "一组机器" }],
      decisionTrail: ["本地检索：命中 3 条来源，足以回答。"]
    });

    const transcript = await readFile(join(root, ...session.path.split("/")), "utf8");
    expect(transcript).toContain("什么是分布式系统");

    const turns = await service.readConversationLog();
    expect(turnId).toBeTruthy();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sources).toHaveLength(1);
    expect(turns[0]?.decisionTrail).toEqual(["本地检索：命中 3 条来源，足以回答。"]);
    // The transcript has no room for either; the log exists for exactly this.
    expect(transcript).not.toContain("decisionTrail");
  });

  it("remembers that an answer was already saved, so a replay offers it only once", async () => {
    const root = await createWorkspace();
    const service = new DesktopSessionService(new NodeFileSystemKnowledgeRepository(root));
    await service.createSession("分布式系统");
    const turnId = await service.appendTurn({ question: "什么是分布式系统", content: "正文。" });

    expect((await service.readConversationLog())[0]?.captured).toBeUndefined();

    await service.markCaptured(turnId ?? undefined, "appendDailyNote", "daily/分布式系统.md");

    const turns = await service.readConversationLog();
    expect(turns[0]?.captured).toEqual(
      expect.objectContaining({ action: "appendDailyNote", targetPath: "daily/分布式系统.md" })
    );
  });

  it("survives being reconstructed from persisted state", async () => {
    const root = await createWorkspace();
    const repository = new NodeFileSystemKnowledgeRepository(root);
    const first = new DesktopSessionService(repository);
    await first.createSession("分布式系统");
    await first.appendTurn({ question: "什么是分布式系统", content: "正文。", sources: [] });

    const restored = new DesktopSessionService(repository, first.state);

    expect(restored.activeSession?.title).toBe("分布式系统");
    expect(await restored.readConversationLog()).toHaveLength(1);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-loop-session-"));
  temporaryRoots.push(root);
  return root;
}
