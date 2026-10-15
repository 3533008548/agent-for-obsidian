import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopNoteRenameService } from "../core/desktop/desktop-note-rename-service";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import { createDefaultPermissionPolicy, PolicyEngine } from "../core/policy/policy-engine";

let root: string;
let repository: NodeFileSystemKnowledgeRepository;
let service: DesktopNoteRenameService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "note-rename-"));
  repository = new NodeFileSystemKnowledgeRepository(root);
  const policy = new PolicyEngine(createDefaultPermissionPolicy());
  const index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
  service = new DesktopNoteRenameService(repository, index, policy, root);
});

afterEach(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(root, { recursive: true, force: true });
  const parent = join(root, "..");
  const prefix = root.split(/[\\/]/u).pop() ?? "";
  for (const entry of await fs.readdir(parent)) {
    if (entry.startsWith(`${prefix}-backup-`)) {
      await fs.rm(join(parent, entry), { recursive: true, force: true });
    }
  }
});

async function writeNote(path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function readNote(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("rename plan", () => {
  it("counts only notes the rule can name cleanly", async () => {
    await writeNote("daily/什么是BM25.md", "# 什么是BM25\n\n打分函数。\n");
    await writeNote("daily/编程中hook是干嘛的.md", "# 编程中hook是干嘛的\n\n回调。\n");
    await writeNote("daily/检索与排序.md", "# 检索与排序\n\n已经是主题式命名。\n");
    const index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
    await index.sync(new PolicyEngine(createDefaultPermissionPolicy()));
    const plan = await new DesktopNoteRenameService(
      repository,
      index,
      new PolicyEngine(createDefaultPermissionPolicy()),
      root
    ).plan("知识体系/Agent/笔记命名整理建议.md");

    expect(plan.count).toBe(1);
    expect(plan.needsDecision).toBe(1);
    expect(plan.scanned).toBe(3);
    expect(plan.content).toContain("BM25");
  });
});

describe("rename apply", () => {
  it("renames the note, keeps the old question as an alias, and rewrites links", async () => {
    await writeNote("daily/什么是BM25.md", "# 什么是BM25\n\n打分函数。\n");
    await writeNote("daily/检索与排序.md", "见 [[什么是BM25]] 与 [[daily/什么是BM25|打分]]。\n");

    const index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
    const policy = new PolicyEngine(createDefaultPermissionPolicy());
    await index.sync(policy);
    const renameService = new DesktopNoteRenameService(repository, index, policy, root);

    const result = await renameService.apply();

    expect(result.renamed).toEqual(["daily/BM25.md"]);
    expect(result.linksRewritten).toEqual(["daily/检索与排序.md"]);
    expect(result.failures).toEqual([]);
    expect(result.backupFileCount).toBeGreaterThan(0);

    const renamed = await readNote("daily/BM25.md");
    expect(renamed).toContain("# BM25");
    expect(renamed).toContain('- "什么是BM25"');
    expect(renamed).toContain("打分函数。");

    const linker = await readNote("daily/检索与排序.md");
    expect(linker).toContain("[[BM25]]");
    // A path-style link keeps its path: only the name changes.
    expect(linker).toContain("[[daily/BM25|打分]]");
  });

  it("rewrites references stored in frontmatter, not only body links", async () => {
    await writeNote("daily/什么是BM25.md", "# 什么是BM25\n\n打分函数。\n");
    await writeNote(
      "daily/检索与排序.md",
      "---\nagent-created: true\nsources:\n  - \"[[daily/什么是BM25.md]] · 2026-08-21 17:32\"\n---\n\n# 检索与排序\n"
    );

    const index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
    const policy = new PolicyEngine(createDefaultPermissionPolicy());
    await index.sync(policy);

    const result = await new DesktopNoteRenameService(repository, index, policy, root).apply();

    expect(result.linksRewritten).toEqual(["daily/检索与排序.md"]);
    expect(await readNote("daily/检索与排序.md")).toContain("[[daily/BM25.md]]");
  });

  it("deletes the old file and leaves a backup beside the vault", async () => {
    await writeNote("daily/什么是BM25.md", "# 什么是BM25\n\n打分函数。\n");
    const index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
    const policy = new PolicyEngine(createDefaultPermissionPolicy());
    await index.sync(policy);

    const result = await new DesktopNoteRenameService(repository, index, policy, root).apply();

    expect(await repository.getMarkdownFile("daily/什么是BM25.md")).toBeNull();
    expect(result.backupPath).not.toBe(root);
    const backup = await readdir(result.backupPath, { recursive: true });
    expect(backup.some((entry) => String(entry).includes("BM25"))).toBe(true);
  });

  it("refuses to run when there is nothing clean to rename", async () => {
    await writeNote("daily/检索与排序.md", "# 检索与排序\n\n已经是主题式命名。\n");
    const index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
    const policy = new PolicyEngine(createDefaultPermissionPolicy());
    await index.sync(policy);

    await expect(new DesktopNoteRenameService(repository, index, policy, root).apply()).rejects.toThrow(
      "没有可执行的改名建议"
    );
  });
});
