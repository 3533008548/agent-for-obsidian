/**
 * 桥接线格式：`knowledge-bridge/1`（只读检索）。
 *
 * 这是工作台底座（Python）与「知识环」技能（Node）之间**唯一**的契约面。
 * 两侧都有同形定义：这里是手写的严格校验（本仓库暂无 zod），Python 侧是
 * `workstation/skills/knowledge/contract.py`（pydantic，`extra="forbid"`）。
 * 任一侧加字段都会被另一侧立刻拒绝，不会静默漂移。
 *
 * 设计约束（与 ppt-bridge/1 对齐、不可回退）：
 * - 只读：本桥接**不写** Vault，只索引 + 检索，因此不需要 fs:primary 审批、
 *   不需要 LLM、不需要出网。Vault 的唯一写入通道仍归知识库桌面端。
 * - 字段严格：未知 key 必须报错，不能静默回落（例如把 `vault` 拼成 `valut`
 *   会让检索静默对空目录进行）。
 * - 失败也是响应：任何错误都写一份 `ok:false` 的 resp.json，退出码仍是 0，
 *   让调用方统一从响应文件判断，而不是靠进程退出码猜。
 */

export const BRIDGE_API_VERSION = "knowledge-bridge/1";

export type KnowledgeSourceType = "note" | "pdf" | "image" | "web" | "conversation";

export interface KnowledgeSourceRef {
  type: KnowledgeSourceType;
  pathOrUrl: string;
  locator: string;
  contentHash: string;
  parserVersion: string;
  retrievedAt?: string;
}

export interface KnowledgeChunk {
  content: string;
  heading: string | null;
  headingPath: string[];
  startLine: number;
  endLine: number;
  source: KnowledgeSourceRef;
}

export interface KnowledgeSearchResult {
  score: number;
  excerpt: string;
  chunk: KnowledgeChunk;
}

export interface KnowledgeBridgeRequest {
  apiVersion: string;
  mode: "search";
  /** 绝对路径；相对路径会被拒绝（NodeFileSystemKnowledgeRepository 只接受绝对根）。 */
  vault: string;
  query: string;
  limit: number;
  /** 仅在这些文件夹内检索；null = 全库。 */
  scope: string[] | null;
}

export interface KnowledgeBridgeResponse {
  apiVersion: string;
  ok: boolean;
  errorCode: string | null;
  error: string | null;
  indexedFiles: number;
  skippedFiles: number;
  chunkCount: number;
  elapsedMs: number;
  results: KnowledgeSearchResult[];
}

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "BridgeError";
  }
}

const REQUEST_KEYS = ["apiVersion", "mode", "vault", "query", "limit", "scope"];

function isAbsolutePath(value: string): boolean {
  // Windows: C:\ 或 C:/ ；POSIX: 以 / 开头。
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

export function parseRequest(raw: unknown): KnowledgeBridgeRequest {
  if (typeof raw !== "object" || raw === null) {
    throw new BridgeError("BAD_REQUEST", "request must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const extra = Object.keys(obj).filter((key) => !REQUEST_KEYS.includes(key));
  if (extra.length > 0) {
    // 严格：未知字段立即报错，漂移不会悄悄发生。
    throw new BridgeError("CONTRACT_DRIFT", `unknown request keys: ${extra.join(", ")}`);
  }
  if (obj.apiVersion !== BRIDGE_API_VERSION) {
    throw new BridgeError(
      "BAD_API_VERSION",
      `expected ${BRIDGE_API_VERSION}, got ${String(obj.apiVersion)}`,
    );
  }
  if (obj.mode !== "search") {
    throw new BridgeError(
      "UNSUPPORTED_MODE",
      `only "search" is supported in this build, got ${String(obj.mode)}`,
    );
  }
  const vault = obj.vault;
  if (typeof vault !== "string" || !vault) {
    throw new BridgeError("MISSING_VAULT", "vault must be a non-empty string");
  }
  if (!isAbsolutePath(vault)) {
    throw new BridgeError("MISSING_VAULT", "vault must be an absolute path");
  }
  const query = obj.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new BridgeError("MISSING_QUERY", "query must be a non-empty string");
  }
  let limit = 8;
  if (obj.limit !== undefined && obj.limit !== null) {
    if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 1) {
      throw new BridgeError("BAD_LIMIT", "limit must be a positive integer");
    }
    limit = obj.limit;
  }
  let scope: string[] | null = null;
  if (obj.scope !== undefined && obj.scope !== null) {
    if (!Array.isArray(obj.scope) || obj.scope.some((item) => typeof item !== "string")) {
      throw new BridgeError("BAD_SCOPE", "scope must be an array of strings");
    }
    scope = obj.scope as string[];
  }
  return {
    apiVersion: BRIDGE_API_VERSION,
    mode: "search",
    vault,
    query: query.trim(),
    limit,
    scope,
  };
}

export function okResponse(opts: {
  indexedFiles: number;
  skippedFiles: number;
  chunkCount: number;
  elapsedMs: number;
  results: KnowledgeSearchResult[];
}): KnowledgeBridgeResponse {
  return {
    apiVersion: BRIDGE_API_VERSION,
    ok: true,
    errorCode: null,
    error: null,
    indexedFiles: opts.indexedFiles,
    skippedFiles: opts.skippedFiles,
    chunkCount: opts.chunkCount,
    elapsedMs: opts.elapsedMs,
    results: opts.results,
  };
}

export function failResponse(
  code: string,
  error: string,
  elapsedMs: number,
): KnowledgeBridgeResponse {
  return {
    apiVersion: BRIDGE_API_VERSION,
    ok: false,
    errorCode: code,
    error,
    indexedFiles: 0,
    skippedFiles: 0,
    chunkCount: 0,
    elapsedMs,
    results: [],
  };
}
