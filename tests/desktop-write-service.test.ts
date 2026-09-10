import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopWriteService } from "../src/desktop/desktop-write-service";
import { NodeFileSystemKnowledgeRepository } from "../src/desktop/node-file-system-knowledge-repository";
import { createDefaultPermissionPolicy, PolicyEngine } from "../src/policy/policy-engine";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopWriteService", () => {
  it("creates a collision-free Inbox note and preserves answer sources", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "00 Inbox", "Agent"), { recursive: true });
    await writeFile(join(root, "00 Inbox", "Agent", "Agent.md"), "existing", "utf8");
    const service = createService(root);
    const preview = await service.previewAnswer("createInboxNote", "Agent", "回答正文", [
      { path: "daily/LangGraph.md", heading: "定义", excerpt: "有状态图" }
    ]);
    const result = await service.apply(preview);

    expect(result.targetPath).toBe("00 Inbox/Agent/Agent-2.md");
    await expect(readFile(join(root, ...result.targetPath.split("/")), "utf8")).resolves.toContain("[[daily/LangGraph.md]]");
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
