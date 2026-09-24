import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import {
  renderKnowledgeMapContent,
  renderKnowledgeNodeContent,
  type KnowledgeIntegrationSession,
  type KnowledgeIntegrationSource,
  type KnowledgeNodeDraft
} from "../integration/knowledge-system";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { PolicyEngine } from "../policy/policy-engine";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import { DesktopWriteService, type DesktopWritePreview } from "./desktop-write-service";

export interface DesktopKnowledgeSystemConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
  knowledgeSystemFolder: string;
  memoryContext?: string;
}

const MAX_MAP_SOURCES = 16;
const MAX_CONTENT_LENGTH = 6_000;

/**
 * Desktop counterpart of the plugin's knowledge-system integration.
 *
 * The map stage only sends titles, paths and short excerpts. The node stage
 * sends the full source bodies, but still only for sources the policy allows
 * to leave the device.
 */
export class DesktopKnowledgeSystemService {
  constructor(
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly writeService: DesktopWriteService,
    private readonly configuration: DesktopKnowledgeSystemConfiguration
  ) {}

  async createMap(topic: string): Promise<KnowledgeIntegrationSession> {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      throw new Error("知识体系主题不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const sources = this.collectSources(normalizedTopic);
    if (sources.length < 2) {
      throw new Error("没有找到足够且可外发的笔记来生成知识地图。");
    }
    const client = this.createClient();
    const map = await client.createKnowledgeMap(normalizedTopic, sources);
    return {
      id: `map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      topic: normalizedTopic,
      scopeLabel: "本地搜索结果",
      createdAt: new Date().toISOString(),
      sources,
      map
    };
  }

  async composeNode(session: KnowledgeIntegrationSession, nodeId: string): Promise<KnowledgeNodeDraft> {
    const node = session.map.nodes.find((candidate) => candidate.id === nodeId)
      ?? session.map.nodes.find((candidate) => candidate.priority === "high")
      ?? session.map.nodes[0];
    if (!node) {
      throw new Error("本次知识地图没有可展开的节点。");
    }
    const sources = session.sources.filter((source) => node.sourceIds.includes(source.id));
    if (!sources.length) {
      throw new Error(`节点“${node.title}”没有可发送给模型的来源。`);
    }
    return this.createClient().composeKnowledgeNode(session.topic, node, sources);
  }

  async previewMap(session: KnowledgeIntegrationSession): Promise<DesktopWritePreview> {
    return this.writeService.previewKnowledgeSystemNote(
      session.topic,
      renderKnowledgeMapContent(session.topic, session.map, session.scopeLabel, session.createdAt),
      session.sources.map((source) => source.source)
    );
  }

  async previewNode(session: KnowledgeIntegrationSession, nodeId: string): Promise<DesktopWritePreview> {
    const draft = await this.composeNode(session, nodeId);
    const sources = session.sources
      .filter((source) => draft.sourceIds.includes(source.id))
      .map((source) => source.source);
    return this.writeService.previewKnowledgeSystemNote(
      draft.title,
      renderKnowledgeNodeContent(draft),
      sources.length ? sources : session.sources.map((source) => source.source)
    );
  }

  private collectSources(topic: string): KnowledgeIntegrationSource[] {
    const sources: KnowledgeIntegrationSource[] = [];
    for (const result of this.index.search(topic, MAX_MAP_SOURCES)) {
      const path = result.chunk.source.pathOrUrl;
      const decision = this.policy.decide({ action: "sendToGlm", targetPath: path });
      if (!decision.allowed) {
        continue;
      }
      sources.push({
        id: `S${sources.length + 1}`,
        title: result.chunk.heading ?? path.split("/").pop() ?? path,
        content: result.chunk.content.slice(0, MAX_CONTENT_LENGTH),
        source: {
          type: "note",
          pathOrUrl: path,
          locator: result.chunk.source.locator,
          contentHash: hashText(result.chunk.content),
          parserVersion: "portable-markdown-v1",
          retrievedAt: new Date().toISOString()
        }
      });
    }
    return sources;
  }

  private createClient(): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
  }
}

export function toKnowledgeSourceRefs(sources: KnowledgeIntegrationSource[]): SourceRef[] {
  return sources.map((source) => source.source);
}
