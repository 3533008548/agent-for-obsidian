/**
 * 一次性桥接入口（只读检索）：JSON in → JSON out。
 *
 * 与 PPTAgent 的 bridge 同构，但**不渲染、不调模型、不写出**，只做：
 *
 *     读 request.json → 用 core/ 索引 Vault（PortableMarkdownKnowledgeIndex）
 *     → searchMarkdownChunks 检索 → 写 response.json
 *
 * 选择的形态是 CLI 子进程（不是 HTTP 服务）：知识库目前没有 HTTP 服务，
 * `core/` 又零 electron 依赖，纯 Node 即可跑。这与阶段 2 的 PPT 完全对称——
 * 复用同一套 `SubprocessExecutor` 抽象与同一套适配器模式，进程隔离天然符合
 * 本地优先。将来知识库若加了长驻 HTTP 服务，只需把执行器从 Subprocess 切到
 * Http，这正是 Executor 抽象的价值。
 *
 * 索引策略：每次调用都是无状态——重新读盘、重新解析、重新检索。检索是只读
 * CPU 操作，无模块级状态串扰，因此**无需**像 PPT 那样强制每次新建进程之外的
 * 额外隔离；但桥接本身始终是独立进程（TS 不可能在 Python 底座内联运行）。
 */

import { readFile, writeFile } from "node:fs/promises";
import { NodeFileSystemKnowledgeRepository } from "../core/desktop/node-file-system-knowledge-repository";
import { PortableMarkdownKnowledgeIndex } from "../core/indexing/portable-markdown-knowledge-index";
import { PolicyEngine, createDefaultPermissionPolicy } from "../core/policy/policy-engine";
import {
  BridgeError,
  failResponse,
  okResponse,
  parseRequest,
  type KnowledgeBridgeResponse,
  type KnowledgeSearchResult,
} from "./bridge-schema";

/** 仅允许命中 scope 内文件夹；scope 为空则全部放行。 */
function makeExclusionFilter(scope: string[] | null): (path: string) => boolean {
  if (!scope || scope.length === 0) {
    return () => false;
  }
  const folders = scope.map((entry) => entry.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
  return (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return !folders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
  };
}

async function run(reqPath: string, respPath: string): Promise<void> {
  const started = Date.now();

  let raw: string;
  try {
    raw = await readFile(reqPath, "utf8");
  } catch (error) {
    const response = failResponse(
      "READ_REQUEST_FAILED",
      `cannot read request file: ${(error as Error).message}`,
      Date.now() - started,
    );
    await writeFile(respPath, JSON.stringify(response, null, 2) + "\n", "utf8");
    return;
  }

  let request: ReturnType<typeof parseRequest>;
  try {
    request = parseRequest(JSON.parse(raw));
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : "BAD_REQUEST";
    const response = failResponse(code, (error as Error).message, Date.now() - started);
    await writeFile(respPath, JSON.stringify(response, null, 2) + "\n", "utf8");
    return;
  }

  try {
    const repository = new NodeFileSystemKnowledgeRepository(request.vault);
    const index = new PortableMarkdownKnowledgeIndex(
      repository,
      makeExclusionFilter(request.scope),
    );
    const policy = new PolicyEngine(createDefaultPermissionPolicy());
    const summary = await index.rebuild(policy);

    const found = index.search(request.query, request.limit);
    const results: KnowledgeSearchResult[] = found.map((item) => ({
      score: item.score,
      excerpt: item.excerpt,
      chunk: {
        content: item.chunk.content,
        heading: item.chunk.heading,
        headingPath: item.chunk.headingPath,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
        source: {
          type: item.chunk.source.type,
          pathOrUrl: item.chunk.source.pathOrUrl,
          locator: item.chunk.source.locator,
          contentHash: item.chunk.source.contentHash,
          parserVersion: item.chunk.source.parserVersion,
        },
      },
    }));

    const response = okResponse({
      indexedFiles: summary.indexedFiles,
      skippedFiles: summary.skippedFiles,
      chunkCount: summary.chunkCount,
      elapsedMs: Date.now() - started,
      results,
    });
    await writeFile(respPath, JSON.stringify(response, null, 2) + "\n", "utf8");
  } catch (error) {
    const response = failResponse(
      "INDEX_FAILED",
      `search failed: ${(error as Error).message}`,
      Date.now() - started,
    );
    await writeFile(respPath, JSON.stringify(response, null, 2) + "\n", "utf8");
  }
}

async function main(): Promise<void> {
  const [reqPath, respPath] = process.argv.slice(2);
  if (!reqPath || !respPath) {
    process.stderr.write("usage: node knowledge-bridge.mjs <request.json> <response.json>\n");
    process.exit(2);
  }
  await run(reqPath, respPath);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
