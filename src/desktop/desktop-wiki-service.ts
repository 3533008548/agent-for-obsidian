import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import {
  createLlmWikiRegistry,
  compileLlmWikiTopic,
  type LlmWikiRegistry
} from "../wiki/llm-wiki-system";
import type { KnowledgeIntegrationSession, KnowledgeIntegrationSource } from "../integration/knowledge-system";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { PolicyEngine } from "../policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export interface DesktopWikiConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
  knowledgeSystemFolder?: string;
}

export interface DesktopWikiResult {
  topic: string;
  pageCount: number;
  sourceCount: number;
  updatedCount: number;
  paths: string[];
}

/** Builds and persists the deterministic LLM Wiki pages used by the plugin. */
export class DesktopWikiService {
  private readonly knowledgeSystemFolder: string;

  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopWikiConfiguration
  ) {
    this.knowledgeSystemFolder = configuration.knowledgeSystemFolder ?? "知识体系/Agent";
  }

  private get registryPath(): string {
    return `${this.knowledgeSystemFolder.replace(/\\/g, "/").replace(/\/+$/u, "/")}LLM Wiki/_system/registry.json`;
  }

  async compile(topic: string): Promise<DesktopWikiResult> {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      throw new Error("LLM Wiki 主题不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const wikiPrefix = `${this.knowledgeSystemFolder.replace(/\\/g, "/").replace(/\/+$/u, "/")}LLM Wiki/`;
    const sources = this.collectSources(normalizedTopic, wikiPrefix);
    if (!sources.length) {
      throw new Error("本地没有命中可用于编译 Wiki 的资料。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    const map = await client.createKnowledgeMap(normalizedTopic, sources);
    const session: KnowledgeIntegrationSession = {
      id: `desktop-wiki-${Date.now()}`,
      topic: normalizedTopic,
      scopeLabel: `本地检索：${normalizedTopic}`,
      createdAt: new Date().toISOString(),
      sources,
      map
    };
    const registry = await this.readRegistry();
    const compilation = compileLlmWikiTopic(session, registry, this.knowledgeSystemFolder);
    let updatedCount = 0;
    for (const page of compilation.pages) {
      const decision = this.policy.decide({
        action: "createKnowledgeSystemNote",
        targetPath: `${this.knowledgeSystemFolder}/${page.relativePath}`
      });
      if (!decision.allowed) {
        throw new Error(`Wiki 写入被权限策略拒绝：${decision.reason}`);
      }
      if (await this.repository.getMarkdownFile(`${this.knowledgeSystemFolder}/${page.relativePath}`)) {
        await this.repository.writeText(`${this.knowledgeSystemFolder}/${page.relativePath}`, page.content);
      } else {
        await this.repository.createText(`${this.knowledgeSystemFolder}/${page.relativePath}`, page.content);
      }
      updatedCount += 1;
    }
    await this.repository.writeRaw(this.registryPath, JSON.stringify(compilation.nextRegistry, null, 2));
    return {
      topic: normalizedTopic,
      pageCount: compilation.pages.length,
      sourceCount: sources.length,
      updatedCount,
      paths: compilation.pages.map((page) => `${this.knowledgeSystemFolder}/${page.relativePath}`)
    };
  }

  private collectSources(topic: string, wikiPrefix: string): KnowledgeIntegrationSource[] {
    const queries = [topic, ...topic.split(/[\s,，、；;]+/u).filter((term) => term.length >= 2)];
    const seen = new Set<string>();
    const results = queries.flatMap((query) => this.index.search(query, 80))
      .filter((result) => !result.chunk.source.pathOrUrl.startsWith(wikiPrefix))
      .filter((result) => {
        const key = `${result.chunk.source.pathOrUrl}:${result.chunk.heading ?? ""}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, 80);
    return results.map((result, index): KnowledgeIntegrationSource => ({
        id: `S${index + 1}`,
        title: result.chunk.heading ?? result.chunk.source.pathOrUrl,
        content: result.chunk.content,
        source: toSourceRef(result.chunk.source.pathOrUrl, result.chunk.source.locator, result.chunk.content)
      }));
  }

  private async readRegistry(): Promise<LlmWikiRegistry> {
    try {
      const raw = await this.repository.readRaw(this.registryPath);
      const value = JSON.parse(raw) as Partial<LlmWikiRegistry>;
      return createLlmWikiRegistry(value);
    } catch {
      return createLlmWikiRegistry();
    }
  }
}

function toSourceRef(pathOrUrl: string, locator: string, content: string): SourceRef {
  return {
    type: "note",
    pathOrUrl,
    locator,
    contentHash: hashText(content),
    parserVersion: "portable-markdown-v1",
    retrievedAt: new Date().toISOString()
  };
}
