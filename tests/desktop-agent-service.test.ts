import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeRepository } from "../src/core/knowledge-repository";
import { DesktopAgentService } from "../src/desktop/desktop-agent-service";
import { PortableMarkdownKnowledgeIndex } from "../src/indexing/portable-markdown-knowledge-index";
import { createDefaultPermissionPolicy, PolicyEngine } from "../src/policy/policy-engine";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DesktopAgentService", () => {
  it("automatically continues to Tavily and DeepSeek when local search has no direct evidence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        results: [{
          title: "Pydantic 文档",
          url: "https://docs.pydantic.dev/latest/",
          content: "Pydantic 使用 Python 类型注解进行数据验证和设置管理，并能将外部输入转换为经过验证的数据模型。"
        }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "Pydantic 是一个利用 Python 类型注解进行数据验证的库。" } }]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new DesktopAgentService(await createIndex(
      "daily/Redis.md",
      "# Redis\n\nRedis 是内存数据库。"
    ), {
      deepSeekApiKey: "deepseek-key",
      deepSeekModel: "deepseek-v4-flash",
      tavilyApiKey: "tavily-key",
      requestTimeoutMs: 60_000,
      webSearchResultLimit: 5,
      webFallbackPolicy: "stable-only"
    });

    await expect(service.answer("Pydantic 是什么")).resolves.toMatchObject({
      mode: "web",
      evidenceComplete: true,
      content: "Pydantic 是一个利用 Python 类型注解进行数据验证的库。",
      recoveryNote: "本地检索没有找到直接证据，已自动切换到补证路径。"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.tavily.com/search");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.deepseek.com/chat/completions");
  });

  it("uses local sourced answering before any web request when evidence is complete", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      model: "deepseek-v4-flash",
      choices: [{
        message: {
          content: JSON.stringify({
            answer: "Redis 是内存数据库。[S1]",
            evidenceComplete: true,
            missingEvidence: []
          })
        }
      }]
    }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new DesktopAgentService(await createIndex(
      "daily/Redis.md",
      "# Redis\n\nRedis 是内存数据库。"
    ), {
      deepSeekApiKey: "deepseek-key",
      deepSeekModel: "deepseek-v4-flash",
      tavilyApiKey: "tavily-key",
      requestTimeoutMs: 60_000,
      webSearchResultLimit: 5,
      webFallbackPolicy: "stable-only"
    });

    await expect(service.answer("Redis 是什么")).resolves.toMatchObject({
      mode: "local",
      evidenceComplete: true,
      content: "Redis 是内存数据库。[S1]"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

async function createIndex(path: string, content: string): Promise<PortableMarkdownKnowledgeIndex> {
  const repository: KnowledgeRepository = {
    listMarkdownFiles: async () => [{ path, extension: "md", mtime: 0, size: content.length }],
    getMarkdownFile: async (requestedPath) =>
      requestedPath === path ? { path, extension: "md", mtime: 0, size: content.length } : null,
    readText: async () => content
  };
  const index = new PortableMarkdownKnowledgeIndex(repository);
  await index.rebuild(new PolicyEngine(createDefaultPermissionPolicy()));
  return index;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
