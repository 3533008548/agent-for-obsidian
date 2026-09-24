import {
  createGardenerSources,
  type GardenerPlan
} from "../gardener/knowledge-gardener";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { PolicyEngine } from "../policy/policy-engine";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";

export interface DesktopMaintenanceConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
  memoryContext?: string;
}

const MAX_CANDIDATES = 24;

/**
 * Read-only knowledge-base inspection for the desktop shell.
 *
 * Only titles, paths and short excerpts reach the model, and only for notes
 * the policy allows to leave the device. It never writes anything.
 */
export class DesktopMaintenanceService {
  constructor(
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopMaintenanceConfiguration
  ) {}

  async analyze(goal: string): Promise<GardenerPlan> {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      throw new Error("知识库维护目标不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const permitted = this.index
      .search(normalizedGoal, MAX_CANDIDATES)
      .filter((result) => this.policy.decide({
        action: "sendToGlm",
        targetPath: result.chunk.source.pathOrUrl
      }).allowed);
    const sources = createGardenerSources(permitted);
    if (sources.length < 2) {
      throw new Error("没有找到足够且可外发的笔记来做维护分析。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    return client.planKnowledgeMaintenance(normalizedGoal, sources, this.configuration.memoryContext);
  }
}
