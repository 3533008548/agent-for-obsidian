import type { PolicyEngine } from "../policy/policy-engine";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import { NoUsableWebResultsError, TavilyClient } from "../services/tavily-client";
import {
  createLlmWikiRegistry,
  getLinkedWikiPages,
  searchLlmWiki,
  type LlmWikiRegistry
} from "../wiki/llm-wiki-system";
import {
  mergeWikiVerificationBlock,
  type WikiVerificationFinding,
  type WikiVerificationPageInput,
  type WikiVerificationWebInput
} from "../wiki/wiki-verification";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export interface DesktopWikiVerificationConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  tavilyApiKey: string;
  requestTimeoutMs: number;
  webSearchResultLimit: number;
  knowledgeSystemFolder?: string;
}

export interface DesktopWikiVerificationPage {
  path: string;
  title: string;
  excerpt: string;
}

export interface DesktopWikiVerificationReport {
  id: string;
  question: string;
  pages: DesktopWikiVerificationPage[];
  summary: string;
  findings: WikiVerificationFinding[];
  needsUpdate: boolean;
}

export interface DesktopWikiUpdatePreview {
  path: string;
  title: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
}

interface StoredVerification {
  question: string;
  pages: WikiVerificationPageInput[];
  webSources: WikiVerificationWebInput[];
  report: Omit<DesktopWikiVerificationReport, "id" | "question" | "pages">;
}

export class DesktopWikiVerificationService {
  private readonly reports = new Map<string, StoredVerification>();
  private readonly registryPath: string;

  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopWikiVerificationConfiguration
  ) {
    const folder = (configuration.knowledgeSystemFolder ?? "知识体系/Agent").replace(/\\/g, "/").replace(/\/+$/u, "");
    this.registryPath = `${folder}/LLM Wiki/_system/registry.json`;
  }

  async verify(question: string): Promise<DesktopWikiVerificationReport> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      throw new Error("核验问题不能为空。 ");
    }
    if (!this.configuration.deepSeekApiKey.trim() || !this.configuration.tavilyApiKey.trim()) {
      throw new Error("Wiki 联网核验需要同时配置 DEEPSEEK_API_KEY 和 TAVILY_API_KEY。 ");
    }
    const pages = await this.readRelevantPages(normalizedQuestion);
    if (!pages.length) {
      throw new Error("没有命中可核验的 LLM Wiki 页面；请先编译对应主题。 ");
    }
    const tavily = new TavilyClient({
      apiKey: this.configuration.tavilyApiKey,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    let webSources: WikiVerificationWebInput[];
    try {
      const search = await tavily.search(normalizedQuestion, this.configuration.webSearchResultLimit);
      webSources = search.sources.map((source) => ({
        title: source.title,
        summary: source.summary,
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {})
      }));
    } catch (error) {
      if (error instanceof NoUsableWebResultsError) {
        throw new Error("联网检索没有返回可用于核验的摘要，本次不会生成通用知识替代结论。 ");
      }
      throw error;
    }
    const client = this.createDeepSeekClient();
    const report = await client.verifyWikiCoverage(normalizedQuestion, pages, webSources);
    const id = `wiki-verification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.reports.set(id, { question: normalizedQuestion, pages, webSources, report });
    return {
      id,
      question: normalizedQuestion,
      pages: pages.map(toPreviewPage),
      ...report
    };
  }

  async createUpdatePreview(id: string): Promise<DesktopWikiUpdatePreview[]> {
    const stored = this.reports.get(id);
    if (!stored) {
      throw new Error("核验预览已失效，请重新核验后再生成更新预览。 ");
    }
    const blocks = await this.createDeepSeekClient().createWikiUpdatePreview(
      stored.question,
      stored.report,
      stored.pages,
      stored.webSources
    );
    return blocks.map((block) => {
      const page = stored.pages.find((candidate) => candidate.path === block.path);
      if (!page) {
        throw new Error("更新预览引用了未知 Wiki 页面。 ");
      }
      return {
        path: page.path,
        title: page.title,
        summary: block.summary,
        beforeContent: page.content,
        afterContent: mergeWikiVerificationBlock(page.content, block.content)
      };
    });
  }

  private createDeepSeekClient(): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
  }

  private async readRelevantPages(question: string): Promise<WikiVerificationPageInput[]> {
    const registry = await this.readRegistry();
    const primary = searchLlmWiki(registry, question, 4).map((result) => result.page);
    const linked = getLinkedWikiPages(registry, primary, 2);
    const selected = [...primary, ...linked]
      .filter((page, index, pages) => pages.findIndex((candidate) => candidate.path === page.path) === index)
      .slice(0, 6);
    const pages: WikiVerificationPageInput[] = [];
    for (const page of selected) {
      const decision = this.policy.decide({ action: "readVault", targetPath: page.path });
      if (!decision.allowed || !(await this.repository.getMarkdownFile(page.path))) {
        continue;
      }
      pages.push({ path: page.path, title: page.title, content: await this.repository.readText(page.path) });
    }
    return pages;
  }

  private async readRegistry(): Promise<LlmWikiRegistry> {
    try {
      return createLlmWikiRegistry(JSON.parse(await this.repository.readRaw(this.registryPath)) as Partial<LlmWikiRegistry>);
    } catch {
      return createLlmWikiRegistry();
    }
  }
}

function toPreviewPage(page: WikiVerificationPageInput): DesktopWikiVerificationPage {
  return {
    path: page.path,
    title: page.title,
    excerpt: page.content.replace(/\s+/gu, " ").slice(0, 240).trim()
  };
}
