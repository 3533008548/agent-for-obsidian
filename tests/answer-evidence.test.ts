import { describe, expect, it } from "vitest";
import { buildAnswerSources } from "../core/desktop/desktop-agent-service";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import { PolicyEngine, createDefaultPermissionPolicy } from "../core/policy/policy-engine";
import type { KnowledgeFile, KnowledgeRepository } from "../core/core/knowledge-repository";
import type { MarkdownSearchResult } from "../core/indexing/markdown-search";

class MemoryRepository implements KnowledgeRepository {
  constructor(private readonly contents: Map<string, string>) {}

  async listMarkdownFiles(): Promise<KnowledgeFile[]> {
    return [...this.contents.keys()].map((path) => this.toFile(path));
  }

  async getMarkdownFile(path: string): Promise<KnowledgeFile | null> {
    return this.contents.has(path) ? this.toFile(path) : null;
  }

  async readText(path: string): Promise<string> {
    return this.contents.get(path) ?? "";
  }

  async listFiles(): Promise<KnowledgeFile[]> {
    return this.listMarkdownFiles();
  }

  private toFile(path: string): KnowledgeFile {
    return { path, extension: "md", mtime: 1, size: (this.contents.get(path) ?? "").length };
  }
}

const B_TREE = [
  "# B 树",
  "",
  "B 树是一种多路平衡查找树，为磁盘存储而设计。",
  "",
  "## 自动平衡",
  "",
  "B 树通过节点分裂与合并维持平衡，因此所有叶子都处在同一层。",
  "平衡不是靠旋转，而是靠插入与删除时的结构调整来保证。",
  "",
  "## 分裂规则",
  "",
  "当一个节点装不下时，它分裂成两个同级节点，键值分到两边，中位数上浮到父节点。父节点因此多了一个键，"
    + "如果父节点也满了，就继续向上分裂，根节点则整体上移一层，树高增加但所有叶子仍在同一层。",
  "",
  "## 合并规则",
  "",
  "删除时若键数低于下限，就从相邻兄弟借一个键（旋转），借不到才合并两个同级节点。",
  "合并之后键数回升，父节点少了一个键，可能触发向上的连锁合并。",
  "",
  "## 来源",
  "",
  "- [[daily/B树.md]] · 基本操作",
  "- [[daily/什么是B树,有什么特点.md]] · 来源",
  "- [[daily/B+ 树有什么特点.md]] · 来源"
].join("\n");

const policy = new PolicyEngine(createDefaultPermissionPolicy());

async function indexOf(files: Map<string, string>): Promise<PortableMarkdownKnowledgeIndex> {
  const index = new PortableMarkdownKnowledgeIndex(new MemoryRepository(files));
  await index.rebuild(policy);
  return index;
}

/** A hit built from the indexed chunk, so its locator matches what expansion sees. */
function hit(index: PortableMarkdownKnowledgeIndex, path: string, heading: string): MarkdownSearchResult {
  const chunk = index
    .getForPath(path)
    .find((candidate) => candidate.heading === heading);
  if (!chunk) {
    throw new Error(`fixture 没有小节：${heading}`);
  }
  return { chunk, score: 1, excerpt: chunk.content.slice(0, 40) };
}

describe("answer evidence", () => {
  const path = "daily/B树.md";

  it("pulls in the section next to a hit, so a stated property is not the whole answer", async () => {
    const index = await indexOf(new Map([[path, B_TREE]]));
    const sources = buildAnswerSources([hit(index, path, "自动平衡")], index);
    const contents = sources.map((source) => source.content).join("\n");

    expect(sources.length).toBeGreaterThan(1);
    expect(contents).toContain("分裂成两个同级节点");
  });

  it("keeps the hit itself first so its score still decides the framing", async () => {
    const index = await indexOf(new Map([[path, B_TREE]]));
    const sources = buildAnswerSources([hit(index, path, "自动平衡")], index);

    expect(sources[0]?.content).toContain("维持平衡");
  });

  it("prefers the adjacent section over the one before it", async () => {
    const index = await indexOf(new Map([[path, B_TREE]]));
    const sources = buildAnswerSources([hit(index, path, "合并规则")], index);
    const contents = sources.map((source) => source.content);

    // "分裂规则" sits directly above "合并规则" and explains the rotation the
    // deletion paragraph refers to, so it is the more useful neighbour.
    expect(contents.some((content) => content.includes("中位数上浮"))).toBe(true);
  });

  it("never spends the budget on a generated 来源 footer", async () => {
    const index = await indexOf(new Map([[path, B_TREE]]));
    const sources = buildAnswerSources([hit(index, path, "自动平衡")], index);

    // Every line of that footer is a pointer to another note. It scores well
    // on BM25 and sits next to the hit, but it lists places rather than
    // explaining anything, so it must not displace real prose.
    expect(sources.some((source) => source.locator.includes("%E6%9D%A5%E6%BA%90"))).toBe(false);
    expect(sources.some((source) => source.content.includes("[[daily/什么是B树,有什么特点.md]]"))).toBe(false);
  });

  it("keeps prose that merely mentions a link mid-sentence", async () => {
    const linked = [
      "# 平衡",
      "",
      "## 机制",
      "",
      "这里的平衡和 [[daily/其他笔记.md]] 讨论的不是一回事：前者靠结构调整，",
      "后者靠旋转。两者的触发时机与代价都不同，不能混为一谈。"
    ].join("\n");
    const linkedPath = "daily/平衡.md";
    const index = await indexOf(new Map([[linkedPath, linked]]));
    const sources = buildAnswerSources([hit(index, linkedPath, "机制")], index);

    expect(sources.some((source) => source.content.includes("不能混为一谈"))).toBe(true);
  });

  it("falls back to structure-only hits rather than reporting no evidence", async () => {
    const stub = ["# 红黑树", "", "## 查找", "", "待补充。"].join("\n");
    const stubPath = "daily/红黑树.md";
    const index = await indexOf(new Map([[stubPath, stub]]));
    const sources = buildAnswerSources([hit(index, stubPath, "查找")], index);

    // Nothing here is worth explaining, but an empty answer is worse than a
    // thin one: the model can still say what it does and does not know.
    expect(sources).toHaveLength(1);
  });

  it("never sends the same chunk twice", async () => {
    const index = await indexOf(new Map([[path, B_TREE]]));
    const sources = buildAnswerSources(
      [hit(index, path, "自动平衡"), hit(index, path, "自动平衡"), hit(index, path, "分裂规则")],
      index
    );

    expect(new Set(sources.map((source) => `${source.path}::${source.locator}`)).size).toBe(sources.length);
  });

  it("keeps the evidence budget bounded", async () => {
    const manyNotes = new Map<string, string>();
    for (let note = 0; note < 10; note += 1) {
      manyNotes.set(`daily/n${note}.md`, `# n${note}\n\n## 自动平衡\n\n结论 ${note}。`);
    }
    const index = await indexOf(manyNotes);
    const results = [...manyNotes.keys()].map((notePath) => hit(index, notePath, "自动平衡"));

    expect(buildAnswerSources(results, index).length).toBeLessThanOrEqual(6);
  });
});
