import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSessionService } from "../src/desktop/desktop-session-service";
import { NodeFileSystemKnowledgeRepository } from "../src/desktop/node-file-system-knowledge-repository";

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

    const content = await readFile(join(root, ...session.path.split("/")), "utf8");
    const context = await service.getMemoryContext();

    expect(content).toContain("LangGraph 是什么？");
    expect(content).toContain("有状态的 LLM 应用");
    expect(context.includedSession).toBe(true);
    expect(context.content).toContain("当前会话最近记录");
    await expect(service.ensureProfile()).resolves.toBe("00 Inbox/Agent/Agent Profile.md");
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-loop-session-"));
  temporaryRoots.push(root);
  return root;
}
