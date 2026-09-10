import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystemKnowledgeRepository } from "../src/desktop/node-file-system-knowledge-repository";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NodeFileSystemKnowledgeRepository", () => {
  it("lists Markdown files recursively with Vault-compatible paths", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "daily"));
    await writeFile(join(root, "daily", "LangGraph.md"), "# LangGraph", "utf8");
    await writeFile(join(root, "README.MD"), "# Root", "utf8");
    await writeFile(join(root, "ignored.txt"), "ignore", "utf8");

    const repository = new NodeFileSystemKnowledgeRepository(root);

    await expect(repository.listMarkdownFiles()).resolves.toMatchObject([
      { path: "daily/LangGraph.md", extension: "md" },
      { path: "README.MD", extension: "MD" }
    ]);
    await expect(repository.readText("daily/LangGraph.md")).resolves.toBe("# LangGraph");
  });

  it("returns null for a missing or non-Markdown file", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "image.png"), "not really an image", "utf8");
    const repository = new NodeFileSystemKnowledgeRepository(root);

    await expect(repository.getMarkdownFile("missing.md")).resolves.toBeNull();
    await expect(repository.getMarkdownFile("image.png")).resolves.toBeNull();
  });

  it("does not resolve a path outside the selected workspace", async () => {
    const repository = new NodeFileSystemKnowledgeRepository(await createWorkspace());

    await expect(repository.readText("../outside.md")).rejects.toThrow("超出已选目录");
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-loop-agent-"));
  temporaryRoots.push(root);
  return root;
}
