import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopWriteService } from "../core/desktop/desktop-write-service";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";
import { createDefaultPermissionPolicy, PolicyEngine } from "../core/policy/policy-engine";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopWriteService", () => {
  it("creates a collision-free note in Daily and preserves answer sources", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "daily"), { recursive: true });
    await writeFile(join(root, "daily", "Agent.md"), "existing", "utf8");
    const service = createService(root);
    const preview = await service.previewAnswer("createInboxNote", "Agent", "回答正文", [
      { path: "daily/LangGraph.md", heading: "定义", excerpt: "有状态图" }
    ]);
    const result = await service.apply(preview);

    expect(result.targetPath).toBe("daily/Agent-2.md");
    await expect(readFile(join(root, ...result.targetPath.split("/")), "utf8")).resolves.toContain("[[daily/LangGraph.md]]");
  });

  it("never writes a captured note into the agent's own memory folder", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const preview = await service.previewAnswer("createInboxNote", "GIL 是什么", "正文", []);

    // The Inbox destination used to be "00 Inbox/Agent", the same path as the
    // agent's memory, which made captured notes invisible to search and to the
    // note list. Everything captured now lands in Daily.
    expect(preview.targetPath.startsWith("00 Inbox/")).toBe(false);
    expect(preview.targetPath.startsWith("daily/")).toBe(true);
  });

  it("appends an answer to a topic Daily note", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const preview = await service.previewAnswer("appendDailyNote", "LangGraph", "第一段", []);
    await service.apply(preview);
    const second = await service.previewAnswer("appendDailyNote", "LangGraph", "第二段", []);
    await service.apply(second);

    await expect(readFile(join(root, "daily", "LangGraph.md"), "utf8")).resolves.toMatch(/第一段[\s\S]*第二段/);
  });

  it("keeps a new subject out of an existing note that already owns the name", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const first = await service.previewAnswer("appendDailyNote", "BM25", "打分公式", []);
    await service.apply(first);

    const preview = await service.previewAnswer(
      "appendDailyNote",
      "BM25",
      "k1 与 b 的调参",
      [],
      "检索调参",
      undefined,
      { disambiguateOnCollision: true }
    );

    expect(preview.targetPath).toBe("daily/BM25（检索调参）.md");
    expect(preview.afterContent).not.toContain("打分公式");
    expect(preview.afterContent).toContain("# BM25");
  });

  it("falls back to a numeric suffix when the qualified name is taken too", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const first = await service.previewAnswer("appendDailyNote", "Redis", "缓存", []);
    await service.apply(first);
    const topic = "后端";
    const second = await service.previewAnswer(
      "appendDailyNote",
      "Redis",
      "持久化",
      [],
      topic,
      undefined,
      { disambiguateOnCollision: true }
    );
    await service.apply(second);
    const third = await service.previewAnswer(
      "appendDailyNote",
      "Redis",
      "哨兵",
      [],
      topic,
      undefined,
      { disambiguateOnCollision: true }
    );

    expect(second.targetPath).toBe("daily/Redis（后端）.md");
    expect(third.targetPath).toBe("daily/Redis（后端）-2.md");
  });

  it("names a manually captured answer after its subject, not its question", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const preview = await service.previewAnswer("appendDailyNote", "什么是分布式系统", "一组机器对外提供服务", []);
    await service.apply(preview);

    expect(preview.targetPath).toBe("daily/分布式系统.md");
    expect(preview.afterContent).toContain("# 分布式系统");
  });

  it("appends the manual capture into the note the routed path already created", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const first = await service.previewAnswer("appendDailyNote", "分布式系统", "九月的回答", []);
    await service.apply(first);

    const preview = await service.previewAnswer("appendDailyNote", "什么是分布式系统", "十月的回答", []);
    await service.apply(preview);

    const written = await readFile(join(root, "daily", "分布式系统.md"), "utf8");
    expect(preview.existedBefore).toBe(true);
    expect(written).toContain("九月的回答");
    expect(written).toContain("十月的回答");
    expect(written).not.toContain("# 什么是分布式系统");
  });

  it("keeps the original question as an alias on a captured note", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const preview = await service.previewAnswer("createInboxNote", "什么是分布式系统", "正文", []);

    expect(preview.targetPath).toBe("daily/分布式系统.md");
    expect(preview.afterContent).toContain("- \"什么是分布式系统\"");
  });

  it("leaves a title alone that is already a subject", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const preview = await service.previewAnswer("appendDailyNote", "BM25", "打分公式", []);

    expect(preview.targetPath).toBe("daily/BM25.md");
  });

  it("keeps the question when the rules cannot name it cleanly", async () => {
    const root = await createWorkspace();
    const service = createService(root);
    const preview = await service.previewAnswer(
      "appendDailyNote",
      "怎么理解agent harness,没有他大模型会有什么瓶颈",
      "正文",
      []
    );

    expect(preview.targetPath).toBe("daily/怎么理解agent harness,没有他大模型会有什么瓶颈.md");
  });
});

function createService(root: string): DesktopWriteService {
  return new DesktopWriteService(
    new NodeFileSystemKnowledgeRepository(root),
    new PolicyEngine(createDefaultPermissionPolicy())
  );
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-loop-write-"));
  roots.push(root);
  return root;
}
