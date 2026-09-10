import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import { DeepSeekClient, type TextSourceSnippet } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import { NoUsableWebResultsError, TavilyClient } from "../services/tavily-client";
import {
  getNoWebResultMessage,
  shouldUseGeneralKnowledgeFallback,
  type WebFallbackPolicy
} from "../services/web-answer-policy";
import type { MarkdownSearchResult } from "../indexing/markdown-search";

export interface DesktopAgentConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  tavilyApiKey: string;
  requestTimeoutMs: number;
  webSearchResultLimit: number;
  webFallbackPolicy: WebFallbackPolicy;
  memoryContext?: string;
  attachmentSearch?: (query: string, limit?: number) => MarkdownSearchResult[];
}

export type DesktopAgentAnswerMode = "local" | "web" | "general" | "evidence-gap";

export interface DesktopAgentSource {
  path: string;
  heading: string | null;
  excerpt: string;
}

export interface DesktopAgentAnswer {
  content: string;
  mode: DesktopAgentAnswerMode;
  evidenceComplete: boolean;
  sources: DesktopAgentSource[];
  recoveryNote?: string;
}

/**
 * Desktop equivalent of the plugin's primary research route.
 *
 * It always starts with local evidence. If that evidence is absent or
 * incomplete, it advances to Tavily + DeepSeek when configured instead of
 * asking the user to retry the same local query.
 */
export class DesktopAgentService {
  constructor(
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly configuration: DesktopAgentConfiguration
  ) {}

  async answer(question: string): Promise<DesktopAgentAnswer> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      throw new Error("问题不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先点击“模型配置”，在本地 .env 中填写 DEEPSEEK_API_KEY。");
    }

    const localResults = [
      ...this.index.search(normalizedQuestion, 8),
      ...(this.configuration.attachmentSearch?.(normalizedQuestion, 4) ?? [])
    ]
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);
    const sources = toDesktopSources(localResults);
    const modelSources = toModelSources(localResults);
    const deepSeek = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });

    if (!modelSources.length) {
      return this.recoverWithoutLocalEvidence(normalizedQuestion, deepSeek, sources);
    }

    const localAnswer = await deepSeek.answerWithSources(
      normalizedQuestion,
      modelSources,
      this.configuration.memoryContext
    );
    if (localAnswer.evidenceComplete) {
      return {
        content: localAnswer.content,
        mode: "local",
        evidenceComplete: true,
        sources
      };
    }

    const recoveryNote = "本地资料缺少直接证据：" + localAnswer.missingEvidence.join("、") + "。已自动继续补证。";
    const recovered = await this.answerFromWebOrGeneralKnowledge(normalizedQuestion, deepSeek);
    if (recovered) {
      return {
        ...recovered,
        sources,
        recoveryNote
      };
    }
    return {
      content: localAnswer.content,
      mode: "evidence-gap",
      evidenceComplete: false,
      sources,
      recoveryNote: recoveryNote + " " + getNoWebResultMessage(this.configuration.webFallbackPolicy, normalizedQuestion)
    };
  }

  private async recoverWithoutLocalEvidence(
    question: string,
    deepSeek: DeepSeekClient,
    sources: DesktopAgentSource[]
  ): Promise<DesktopAgentAnswer> {
    const recovered = await this.answerFromWebOrGeneralKnowledge(question, deepSeek);
    if (recovered) {
      return {
        ...recovered,
        sources,
        recoveryNote: "本地检索没有找到直接证据，已自动切换到补证路径。"
      };
    }
    return {
      content: "当前知识库没有找到与问题直接相关的资料。",
      mode: "evidence-gap",
      evidenceComplete: false,
      sources,
      recoveryNote: "本地检索没有命中，且" + getNoWebResultMessage(this.configuration.webFallbackPolicy, question)
    };
  }

  private async answerFromWebOrGeneralKnowledge(
    question: string,
    deepSeek: DeepSeekClient
  ): Promise<Omit<DesktopAgentAnswer, "sources" | "recoveryNote"> | null> {
    if (this.configuration.tavilyApiKey.trim()) {
      try {
        const tavily = new TavilyClient({
          apiKey: this.configuration.tavilyApiKey,
          slowResponseMs: this.configuration.requestTimeoutMs,
          postJson: postJsonWithFetch
        });
        const search = await tavily.search(question, this.configuration.webSearchResultLimit);
        const answer = await deepSeek.answerFromWeb(question, search.sources, this.configuration.memoryContext);
        return {
          content: answer.content,
          mode: "web",
          evidenceComplete: true
        };
      } catch (error) {
        if (!(error instanceof NoUsableWebResultsError)) {
          throw error;
        }
      }
    }

    if (shouldUseGeneralKnowledgeFallback(this.configuration.webFallbackPolicy, question)) {
      const answer = await deepSeek.answerFromGeneralKnowledge(question, this.configuration.memoryContext);
      return {
        content: answer.content,
        mode: "general",
        evidenceComplete: false
      };
    }
    return null;
  }
}

function toDesktopSources(results: MarkdownSearchResult[]): DesktopAgentSource[] {
  return results.map((result) => ({
    path: result.chunk.source.pathOrUrl,
    heading: result.chunk.heading,
    excerpt: result.excerpt
  }));
}

function toModelSources(results: MarkdownSearchResult[]): TextSourceSnippet[] {
  return results.slice(0, 4).map((result, index) => ({
    id: index + 1,
    path: result.chunk.source.pathOrUrl,
    locator: result.chunk.source.locator,
    content: result.chunk.content
  }));
}
