import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeMarkdownIndexStore } from "../core/desktop/node-markdown-index-store";
import { createEmptySnapshot } from "../core/indexing/markdown-index-snapshot";
import { MARKDOWN_PARSER_VERSION } from "../core/indexing/markdown-parser";

const createdDirectories: string[] = [];

async function makeStore(): Promise<{ store: ReturnType<typeof createNodeMarkdownIndexStore>; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-index-"));
  createdDirectories.push(directory);
  const path = join(directory, "nested", "index-snapshot.json");
  return { store: createNodeMarkdownIndexStore(path), path };
}

afterEach(async () => {
  while (createdDirectories.length) {
    const directory = createdDirectories.pop();
    if (directory) {
      await readdir(directory).catch(() => undefined);
    }
  }
});

describe("createNodeMarkdownIndexStore", () => {
  it("reports a missing snapshot as a cache miss rather than throwing", async () => {
    const { store } = await makeStore();

    await expect(store.read()).resolves.toBeNull();
  });

  it("reports a corrupt snapshot as a cache miss", async () => {
    const { store, path } = await makeStore();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ 截断的快照", "utf8");

    await expect(store.read()).resolves.toBeNull();
  });

  it("round-trips a snapshot and leaves no temporary file behind", async () => {
    const { store, path } = await makeStore();
    const snapshot = createEmptySnapshot(MARKDOWN_PARSER_VERSION, "root");

    await store.write(snapshot);
    const read = await store.read();

    expect(read?.rootPath).toBe("root");
    const directory = join(path, "..");
    await expect(readdir(directory)).resolves.not.toContain("index-snapshot.json.tmp");
  });

  it("creates missing parent directories on write", async () => {
    const { store, path } = await makeStore();

    await store.write(createEmptySnapshot(MARKDOWN_PARSER_VERSION, "root"));

    await expect(readFile(path, "utf8")).resolves.toContain("root");
  });
});
