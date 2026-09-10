import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getStandaloneWorkspaceName,
  migrateObsidianVault,
  previewObsidianVaultMigration
} from "../src/desktop/obsidian-vault-migrator";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Obsidian Vault migration", () => {
  it("copies notes and attachments while excluding application configuration", async () => {
    const source = await createDirectory("source");
    const target = await createDirectory("target");
    await mkdir(join(source, "笔记", "图片"), { recursive: true });
    await mkdir(join(source, ".obsidian", "plugins"), { recursive: true });
    await mkdir(join(source, ".git"), { recursive: true });
    await writeFile(join(source, "笔记", "LangGraph.md"), "# LangGraph", "utf8");
    await writeFile(join(source, "笔记", "图片", "流程.png"), "image", "utf8");
    await writeFile(join(source, ".obsidian", "plugins", "data.json"), "secret", "utf8");
    await writeFile(join(source, ".git", "HEAD"), "ref", "utf8");

    const preview = await previewObsidianVaultMigration(source);
    const destination = join(target, getStandaloneWorkspaceName(source));
    const result = await migrateObsidianVault(source, destination);

    expect(preview).toMatchObject({ noteCount: 1, attachmentCount: 1, totalFiles: 2 });
    expect(result.destinationPath).toBe(destination);
    await expect(readFile(join(destination, "笔记", "LangGraph.md"), "utf8")).resolves.toBe("# LangGraph");
    await expect(readFile(join(destination, "笔记", "图片", "流程.png"), "utf8")).resolves.toBe("image");
    await expect(readFile(join(destination, ".obsidian", "plugins", "data.json"), "utf8")).rejects.toThrow();
  });

  it("does not allow copying into the original Vault or an existing destination", async () => {
    const source = await createDirectory("source");
    const target = await createDirectory("target");

    await expect(migrateObsidianVault(source, source)).rejects.toThrow("不能是原始知识库");
    await expect(migrateObsidianVault(source, target)).rejects.toThrow("迁移目标已存在");
  });
});

async function createDirectory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-loop-migration-"));
  temporaryRoots.push(root);
  const directory = join(root, name);
  await mkdir(directory);
  return directory;
}
