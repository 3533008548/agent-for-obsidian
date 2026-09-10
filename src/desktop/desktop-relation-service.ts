import { hashText } from "../domain/content-hash";
import {
  CURRENT_NOTE_SOURCE_ID,
  mergeManagedNoteRelations,
  renderNoteRelationItems
} from "../integration/note-relations";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import type { PolicyEngine } from "../policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";
import type { KnowledgeIntegrationSource } from "../integration/knowledge-system";

export interface DesktopRelationConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
}

export interface DesktopRelationResult {
  path: string;
  summary: string;
  relationCount: number;
}

export class DesktopRelationService {
  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopRelationConfiguration
  ) {}

  async complete(path: string): Promise<DesktopRelationResult> {
    const currentPath = path.trim().replace(/\\/g, "/");
    const currentFile = await this.repository.getMarkdownFile(currentPath);
    if (!currentFile) {
      throw new Error("当前笔记不存在或不是 Markdown 文件。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const currentContent = await this.repository.readText(currentPath);
    const currentChunk = this.index.getForPath(currentPath)[0];
    const currentSource = toSource(CURRENT_NOTE_SOURCE_ID, currentPath, currentChunk?.heading ?? currentPath, currentContent);
    const candidates = this.index.search(currentContent.slice(0, 240), 12)
      .filter((result) => result.chunk.source.pathOrUrl !== currentPath)
      .slice(0, 6);
    const sources: KnowledgeIntegrationSource[] = [currentSource, ...candidates.map((result, index) =>
      toSource(`S${index + 1}`, result.chunk.source.pathOrUrl, result.chunk.heading ?? result.chunk.source.pathOrUrl, result.chunk.content)
    )];
    if (sources.length < 2) {
      throw new Error("当前笔记没有找到足够的候选笔记。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    const plan = await client.proposeNoteRelations(sources);
    if (!plan.relations.length) {
      return { path: currentPath, summary: plan.summary, relationCount: 0 };
    }
    const decision = this.policy.decide({ action: "modifyExistingNote", targetPath: currentPath });
    if (!decision.allowed) {
      throw new Error(`关联写入被权限策略拒绝：${decision.reason}`);
    }
    const relationItems = renderNoteRelationItems(plan.relations, sources);
    await this.repository.writeText(currentPath, mergeManagedNoteRelations(currentContent, relationItems));
    return { path: currentPath, summary: plan.summary, relationCount: plan.relations.length };
  }
}

function toSource(id: string, path: string, locator: string, content: string): KnowledgeIntegrationSource {
  return {
    id,
    title: path.split("/").pop() ?? path,
    content,
    source: {
      type: "note",
      pathOrUrl: path,
      locator,
      contentHash: hashText(content),
      parserVersion: "portable-markdown-v1",
      retrievedAt: new Date().toISOString()
    }
  };
}
