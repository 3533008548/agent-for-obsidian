import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopWikiService } from "../core/desktop/desktop-wiki-service";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";
import { hashText } from "../core/domain/content-hash";
import { parseMarkdownIntoChunks } from "../core/indexing/markdown-parser";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import { createDefaultPermissionPolicy, PolicyEngine } from "../core/policy/policy-engine";
import {
  createLlmWikiRegistry,
  type LlmWikiRegistry,
  type LlmWikiTopicRecord
} from "../core/wiki/llm-wiki-system";

const SYSTEM_FOLDER = "知识体系/Agent";
const REGISTRY_PATH = `${SYSTEM_FOLDER}/LLM Wiki/_system/registry.json`;

let root: string;
let service: DesktopWikiService;
let policy: PolicyEngine;
let index: PortableMarkdownKnowledgeIndex;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wiki-health-"));
  const repository = new NodeFileSystemKnowledgeRepository(root);
  policy = new PolicyEngine(createDefaultPermissionPolicy());
  index = new PortableMarkdownKnowledgeIndex(repository, () => false, { rootPath: root });
  service = new DesktopWikiService(repository, index, policy, {
    deepSeekApiKey: "",
    deepSeekModel: "deepseek-chat",
    requestTimeoutMs: 1000
  });
});

afterEach(async () => {
  await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
});

async function writeNote(path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

/** Hashes exactly like the service does when it recorded the source. */
function sourceHashesOf(path: string, content: string): Array<{ pathOrUrl: string; contentHash: string }> {
  return parseMarkdownIntoChunks(path, content).map((chunk) => ({
    pathOrUrl: path,
    contentHash: hashText(chunk.content)
  }));
}

function topic(record: Partial<LlmWikiTopicRecord> & { id: string; topic: string }): LlmWikiTopicRecord {
  return {
    indexPath: `${SYSTEM_FOLDER}/LLM Wiki/${record.id}/概览.md`,
    status: "fresh",
    updatedAt: "2026-09-01T00:00:00.000Z",
    sourceHashes: [],
    pages: [],
    ...record
  };
}

async function writeRegistry(registry: LlmWikiRegistry): Promise<void> {
  const target = join(root, REGISTRY_PATH);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, JSON.stringify(registry, null, 2), "utf8");
}

async function readRegistry(): Promise<LlmWikiRegistry> {
  return createLlmWikiRegistry(JSON.parse(await readFile(join(root, REGISTRY_PATH), "utf8")) as Partial<LlmWikiRegistry>);
}

describe("wiki health review", () => {
  it("reports nothing when no topic has been compiled", async () => {
    const review = await service.reviewHealth();

    expect(review.topics).toEqual([]);
    expect(review.openErrors).toEqual([]);
  });

  it("reports a topic whose source note was edited", async () => {
    await writeNote("notes/a.md", "# 来源\n\n初始内容。");
    await writeRegistry(createLlmWikiRegistry({
      topics: [topic({
        id: "LangGraph",
        topic: "LangGraph",
        sourceHashes: sourceHashesOf("notes/a.md", "# 来源\n\n初始内容。")
      })]
    }));
    await writeNote("notes/a.md", "# 来源\n\n改过的内容。");

    const review = await service.reviewHealth();

    expect(review.topics).toHaveLength(1);
    expect(review.topics[0]).toMatchObject({ id: "LangGraph", topic: "LangGraph" });
    expect(review.topics[0]?.changedSources).toEqual(["notes/a.md"]);
    expect(review.topics[0]?.missingSources).toEqual([]);
  });

  it("separates deleted sources from edited ones", async () => {
    await writeNote("notes/kept.md", "# 保留\n\n内容。");
    await writeNote("notes/gone.md", "# 删除\n\n内容。");
    await writeRegistry(createLlmWikiRegistry({
      topics: [topic({
        id: "RAG",
        topic: "RAG",
        sourceHashes: [
          ...sourceHashesOf("notes/kept.md", "# 保留\n\n内容。"),
          ...sourceHashesOf("notes/gone.md", "# 删除\n\n内容。")
        ]
      })]
    }));
    await writeNote("notes/kept.md", "# 保留\n\n内容已更新。");
    await import("node:fs/promises").then((fs) => fs.rm(join(root, "notes/gone.md")));

    const review = await service.reviewHealth();

    expect(review.topics).toHaveLength(1);
    expect(review.topics[0]?.changedSources).toEqual(["notes/kept.md"]);
    expect(review.topics[0]?.missingSources).toEqual(["notes/gone.md"]);
  });

  it("opens an Error Book entry for drift and closes it again once back in sync", async () => {
    const original = "# 来源\n\n初始内容。";
    await writeNote("notes/a.md", original);
    await writeRegistry(createLlmWikiRegistry({
      topics: [topic({
        id: "LangGraph",
        topic: "LangGraph",
        sourceHashes: sourceHashesOf("notes/a.md", original)
      })]
    }));
    await writeNote("notes/a.md", "# 来源\n\n改过的内容。");

    const drifted = await service.reviewHealth();
    expect(drifted.openErrors.some((error) => error.type === "source-stale")).toBe(true);
    expect((await readRegistry()).topics[0]?.status).toBe("stale");

    // Re-compiling from the current content puts the recorded hashes back in sync.
    const registry = await readRegistry();
    await writeRegistry(createLlmWikiRegistry({
      ...registry,
      topics: [topic({
        ...registry.topics[0]!,
        sourceHashes: sourceHashesOf("notes/a.md", "# 来源\n\n改过的内容。")
      })]
    }));

    const settled = await service.reviewHealth();
    expect(settled.topics).toEqual([]);
    expect(settled.openErrors.filter((error) => error.type === "source-stale" && error.status === "open")).toEqual([]);
  });

  it("still reads a registry that the broken folder join wrote elsewhere", async () => {
    await writeNote("notes/a.md", "# 来源\n\n初始内容。");
    const registry = createLlmWikiRegistry({
      topics: [topic({
        id: "LangGraph",
        topic: "LangGraph",
        sourceHashes: sourceHashesOf("notes/a.md", "# 来源\n\n初始内容。")
      })]
    });
    const legacyPath = join(root, "知识体系/AgentLLM Wiki/_system/registry.json");
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, JSON.stringify(registry), "utf8");
    await writeNote("notes/a.md", "# 来源\n\n改过的内容。");

    const review = await service.reviewHealth();

    expect(review.topics.map((entry) => entry.topic)).toEqual(["LangGraph"]);
    // The corrected path takes over from here on.
    expect((await readRegistry()).topics[0]?.status).toBe("stale");
  });

  it("leaves untouched topics out of the report", async () => {
    await writeNote("notes/a.md", "# 来源\n\n内容。");
    await writeNote("notes/b.md", "# 另一来源\n\n内容。");
    await writeRegistry(createLlmWikiRegistry({
      topics: [
        topic({ id: "A", topic: "A", sourceHashes: sourceHashesOf("notes/a.md", "# 来源\n\n内容。") }),
        topic({ id: "B", topic: "B", sourceHashes: sourceHashesOf("notes/b.md", "# 另一来源\n\n内容。") })
      ]
    }));
    await writeNote("notes/b.md", "# 另一来源\n\n改过了。");

    const review = await service.reviewHealth();

    expect(review.topics.map((entry) => entry.topic)).toEqual(["B"]);
  });
});
