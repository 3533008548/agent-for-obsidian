import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopWriteService } from "../core/desktop/desktop-write-service";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";
import {
  TRASH_FOLDER,
  PolicyEngine,
  createDefaultPermissionPolicy
} from "../core/policy/policy-engine";
import {
  buildDeletePreview,
  excerptForConfirmation,
  renderTrashManifest,
  resolveTrashPath
} from "../core/desktop/desktop-delete-service";

const NOTE = ["---", "topic: B 树", "---", "", "# B 树", "", "B 树是一种多路平衡查找树。"].join("\n");

describe("note deletion", () => {
  let root: string;
  let repository: NodeFileSystemKnowledgeRepository;
  let service: DesktopWriteService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "knowledge-loop-delete-"));
    await mkdir(join(root, "daily"), { recursive: true });
    await writeFile(join(root, "daily", "B树.md"), NOTE, "utf8");
    await writeFile(join(root, "daily", "引用者.md"), "参见 [[daily/B树.md]]。", "utf8");
    repository = new NodeFileSystemKnowledgeRepository(root);
    // The index is what makes backlink reporting possible; without it a delete
    // card would claim nothing references the note, which is the unsafe default.
    const index = new PortableMarkdownKnowledgeIndex(repository);
    await index.rebuild(new PolicyEngine(createDefaultPermissionPolicy()));
    service = new DesktopWriteService(
      repository,
      new PolicyEngine(createDefaultPermissionPolicy()),
      "daily",
      "daily",
      "知识体系/Agent",
      index
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("preview", () => {
    it("describes the target without removing anything", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });

      expect(preview.targetPath).toBe("daily/B树.md");
      expect(preview.excerpt).toContain("多路平衡查找树");
      expect(preview.trashPath.startsWith(`${TRASH_FOLDER}/`)).toBe(true);
      // The whole point: previewing is not doing.
      await expect(repository.getMarkdownFile("daily/B树.md")).resolves.not.toBeNull();
    });

    it("reports which notes reference the one being deleted", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });

      expect(preview.inboundLinks).toContain("daily/引用者.md");
    });

    it("refuses a note that does not exist", async () => {
      await expect(service.previewDelete({ targetPath: "daily/不存在.md" })).rejects.toThrow(/不存在/);
    });

    it("refuses a path outside the vault", async () => {
      await expect(service.previewDelete({ targetPath: "../escape.md" })).rejects.toThrow();
    });

    it("refuses to delete out of the trash, which would make recovery impossible", async () => {
      await expect(
        service.previewDelete({ targetPath: `${TRASH_FOLDER}/2026-01-01__daily/B树.md` })
      ).rejects.toThrow(/回收站/);
    });

    it("refuses when the policy disallows deletion", async () => {
      const policy = createDefaultPermissionPolicy();
      policy.enabled.deleteNote = false;
      const guarded = new DesktopWriteService(repository, new PolicyEngine(policy));

      await expect(guarded.previewDelete({ targetPath: "daily/B树.md" })).rejects.toThrow(/权限策略/);
    });
  });

  describe("apply", () => {
    it("moves the note to the trash instead of erasing it", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });
      const result = await service.applyDelete(preview);

      await expect(repository.getMarkdownFile("daily/B树.md")).resolves.toBeNull();
      // Recoverable: the content is still readable at its new path.
      await expect(repository.readText(result.trashPath)).resolves.toContain("多路平衡查找树");
      // And the reason it went is recorded.
      const manifest = await repository.readText(result.manifestPath);
      expect(manifest).toContain("original-path: \"daily/B树.md\"");
      expect(manifest).toContain("trashed: true");
    });

    it("refuses a confirmation for a note that changed after the preview", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });
      await writeFile(join(root, "daily", "B树.md"), `${NOTE}\n\n新增的一段。`, "utf8");

      await expect(service.applyDelete(preview)).rejects.toThrow(/被修改过/);
      await expect(repository.getMarkdownFile("daily/B树.md")).resolves.not.toBeNull();
    });

    it("refuses to delete a note that is already gone", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });
      await repository.deleteText("daily/B树.md");

      await expect(service.applyDelete(preview)).rejects.toThrow(/已不存在/);
    });
  });

  describe("restore", () => {
    it("puts a trashed note back where it came from", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });
      const deleted = await service.applyDelete(preview);
      await service.restoreFromTrash(deleted.manifestPath);

      await expect(repository.readText("daily/B树.md")).resolves.toContain("多路平衡查找树");
      await expect(repository.getMarkdownFile(deleted.trashPath)).resolves.toBeNull();
      await expect(repository.getMarkdownFile(deleted.manifestPath)).resolves.toBeNull();
    });

    it("will not overwrite a note that took the original name back", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });
      const deleted = await service.applyDelete(preview);
      await writeFile(join(root, "daily", "B树.md"), "新内容", "utf8");

      await expect(service.restoreFromTrash(deleted.manifestPath)).rejects.toThrow(/同名笔记/);
    });
  });

  describe("name resolution for a spoken request", () => {
    it("matches a note by its exact file name", async () => {
      await expect(service.findNotesByName("B树")).resolves.toEqual(["daily/B树.md"]);
      await expect(service.findNotesByName("B树.md")).resolves.toEqual(["daily/B树.md"]);
    });

    it("does not match loosely, because a wrong match deletes the wrong note", async () => {
      await expect(service.findNotesByName("B")).resolves.toEqual([]);
      await expect(service.findNotesByName("树")).resolves.toEqual([]);
    });

    it("never offers a note already sitting in the trash", async () => {
      const preview = await service.previewDelete({ targetPath: "daily/B树.md" });
      await service.applyDelete(preview);

      await expect(service.findNotesByName("2026-01-01__daily/B树")).resolves.toEqual([]);
    });
  });
});

describe("delete preview helpers", () => {
  it("keeps two same-named notes apart in the trash", () => {
    const taken = new Set<string>();
    const first = resolveTrashPath("daily/B树.md", taken);
    taken.add(first);
    const second = resolveTrashPath("daily/B树.md", taken);

    expect(first).not.toBe(second);
  });

  it("skips frontmatter and headings when summarising a note", () => {
    const excerpt = excerptForConfirmation(NOTE);

    expect(excerpt).toContain("多路平衡查找树");
    expect(excerpt).not.toContain("topic:");
    expect(excerpt).not.toContain("# B 树");
  });

  it("writes a manifest a human can read months later", () => {
    const preview = buildDeletePreview({
      targetPath: "daily/B树.md",
      content: NOTE,
      takenTrashPaths: new Set(),
      reason: "内容已过期",
      inboundLinks: ["daily/引用者.md"]
    });
    const manifest = renderTrashManifest(preview, new Date("2026-10-04T08:00:00.000Z"));

    expect(manifest).toContain("daily/B树.md");
    expect(manifest).toContain("内容已过期");
    expect(manifest).toContain("daily/引用者.md");
    expect(manifest).toContain("2026-10-04");
  });

  it("does not require a reason to be written", () => {
    const preview = buildDeletePreview({
      targetPath: "daily/B树.md",
      content: NOTE,
      takenTrashPaths: new Set(),
      reason: "",
      inboundLinks: []
    });

    expect(preview.reason).toBe("用户请求删除。");
  });
});
