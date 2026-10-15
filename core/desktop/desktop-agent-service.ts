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
import type { MarkdownChunk } from "../indexing/markdown-parser";
import { wantsDiagram } from "../domain/diagram-hint";
import type { LlmWikiRegistry } from "../wiki/llm-wiki-system";
import {
  describeWikiPlan,
  planAnswerSources,
  type WikiSourcePlan
} from "../wiki/wiki-retrieval";

export interface DesktopAgentConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  tavilyApiKey: string;
  requestTimeoutMs: number;
  webSearchResultLimit: number;
  webFallbackPolicy: WebFallbackPolicy;
  memoryContext?: string;
  attachmentSearch?: (query: string, limit?: number) => MarkdownSearchResult[];
  /**
   * Note open in the editor, if any. Retrieval boosts notes it links to, so
   * "这个和 X 的关系" resolves against the note the user is looking at.
   */
  activeNotePath?: string | null;
  /**
   * The Wiki's registry, when a topic has been compiled.
   *
   * Optional because the Wiki is not required to answer. With it, a compiled
   * page leads its own topic's results and the notes it was written from yield
   * their slots; without it the ranking is untouched, so a library with nothing
   * compiled behaves exactly as it did.
   */
  wikiRegistry?: LlmWikiRegistry | null;
}

export type DesktopAgentAnswerMode = "local" | "web" | "general" | "evidence-gap";

/**
 * `auto` keeps the standalone behaviour: missing local evidence silently
 * advances to web or general knowledge. `local-halt` returns the evidence gap
 * to the caller instead of recovering on its own — the conversation loop hands
 * the decision to the model.
 */
export type DesktopAgentAnswerScope = "auto" | "local-halt";

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
 * Progressive delivery hooks for {@link DesktopAgentService.answer}.
 *
 * `onReset` fires when the answer abandons an already-streamed partial result and
 * starts a different generation phase, so the UI can drop the stale text instead
 * of concatenating two unrelated answers.
 */
export interface DesktopAgentStreamOptions {
  onDelta: (text: string) => void;
  onReset?: () => void;
  signal?: AbortSignal;
}

/**
 * Desktop equivalent of the plugin's primary research route.
 *
 * It always starts with local evidence. If that evidence is absent or
 * incomplete, it advances to Tavily + DeepSeek when configured instead of
 * asking the user to retry the same local query.
 */
/** Hits that earn an expansion; the rest only crowd out the evidence budget. */
const MAX_ANSWER_SEED_CHUNKS = 3;
const MAX_EXPANSION_PER_SEED = 2;
const MAX_ANSWER_SOURCES = 6;

/**
 * Whether a chunk carries prose, as opposed to structure.
 *
 * Two separate shapes of non-evidence show up in a real 77-note vault, and
 * neither is caught by a length check:
 *
 *  - A heading flushed as its own block ("# 为什么说B树是自动平衡的"): short.
 *  - The generated "### 来源" footer: long, but it only *lists* — every line
 *    is a link to something else plus that thing's title ("- [[daily/BM25.md]]
 *    · Q78｜如何做 A/B 实验…"). Those titles are other notes' words, not this
 *    note's. They are the knowledge graph, and `wiki-follow` is the tool for
 *    them; as answer evidence they are a list of places, not an explanation.
 *
 * So the test is per line, not per chunk, and it turns on where the pointer
 * sits: at the start of the line the line is enumerating, mid-sentence it is
 * making a point. "因为 [[daily/B树.md]] 里的定义才成立" keeps its reason;
 * "- [[daily/B树.md]] · 简单记忆" does not.
 */
const MINIMUM_PROSE_LINE_SHARE = 0.5;
/**
 * And a floor on how much prose there actually is, because a share alone is
 * misleading: a one-line footer ("- 来源 - 当前会话中的手动记录") is 100% prose
 * by ratio and says nothing.
 *
 * The floor counts characters rather than lines on purpose. Most sections in a
 * real note are a single paragraph on one line, and "当一个节点装不下时，它分裂
 * 成两个同级节点…" is exactly the explanation worth spending a slot on.
 */
const MINIMUM_PROSE_CHARACTERS = 60;
const POINTER = /\[\[[^\]]*\]\]|https?:\/\/\S+/;

function isSubstantiveEvidence(chunk: MarkdownChunk): boolean {
  const lines = chunk.content
    .split("\n")
    .map((line) => line.trim())
    // Bare headings are structure too: they carry the title, not the answer.
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line));
  if (!lines.length) {
    return false;
  }
  const proseLines = lines.filter((line) => !isEnumerationLine(line));
  const proseCharacters = proseLines
    .map((line) => line.replace(/[*_`]/g, "").replace(/\s+/g, "").length)
    .reduce((total, count) => total + count, 0);
  return (
    proseCharacters >= MINIMUM_PROSE_CHARACTERS &&
    proseLines.length / lines.length >= MINIMUM_PROSE_LINE_SHARE
  );
}

/**
 * A line that enumerates other material rather than saying something.
 *
 * Only a list bullet or blockquote marker may precede the first pointer: that
 * is what makes "• [[note]] · title" an entry in a list while "由于 [[note]]
 * 的定义" stays a claim. Footers in this vault also carry timestamps and
 * relation words ("· 来源", "· 基本操作"), so the check is on what precedes the
 * pointer, not on what follows it.
 */
function isEnumerationLine(line: string): boolean {
  const firstPointer = line.search(POINTER);
  if (firstPointer < 0) {
    return false;
  }
  const before = line.slice(0, firstPointer).replace(/^[\s>*+\-–—•]+/, "").trim();
  return before.length === 0;
}

export class DesktopAgentService {
  /**
   * How the Wiki shaped the last answer, for the answer's own note.
   *
   * Set per answer rather than kept on the result, because "which pages led" is
   * only true of the answer that was just given: by the next question the
   * retrieval has been different and reporting the old plan would be a lie.
   */
  private lastWikiNote = "";

  constructor(
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly configuration: DesktopAgentConfiguration
  ) {}

  /** A sentence naming how the Wiki was used by the last answer, or "". */
  wikiNoteForLastAnswer(): string {
    return this.lastWikiNote;
  }

  async answer(
    question: string,
    scope: DesktopAgentAnswerScope = "auto",
    stream?: DesktopAgentStreamOptions
  ): Promise<DesktopAgentAnswer> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      throw new Error("问题不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先点击“模型配置”，在本地 .env 中填写 DEEPSEEK_API_KEY。");
    }

    const localResults = [
      ...this.index.search(normalizedQuestion, 8, this.configuration.activeNotePath ?? null),
      ...(this.configuration.attachmentSearch?.(normalizedQuestion, 4) ?? [])
    ]
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);
    const sources = toDesktopSources(localResults);
    // The Wiki leads when a compiled topic is in the result list: its pages are
    // the model's own synthesis of those notes, so re-reading the notes beside
    // them spent the source budget twice on one piece of material.
    const registry = this.configuration.wikiRegistry;
    const wikiPlan = registry
      ? planAnswerSources({
          results: localResults,
          registry,
          index: this.index,
          maxSources: MAX_ANSWER_SOURCES,
          expansionPerSource: MAX_EXPANSION_PER_SEED,
          maxSeeds: MAX_ANSWER_SEED_CHUNKS,
          isSubstantive: (result) => isSubstantiveEvidence(result.chunk),
          neighboursOf: (result: MarkdownSearchResult) =>
            neighbouringChunks(result.chunk, this.index).map((chunk) => ({
              chunk,
              score: 0,
              excerpt: chunk.content
            }))
        })
      : undefined;
    const modelSources = buildAnswerSources(localResults, this.index, wikiPlan);
    this.lastWikiNote = wikiPlan ? describeWikiPlan(wikiPlan) : "";
    const deepSeek = this.createClient();

    if (!modelSources.length) {
      if (scope === "local-halt") {
        return {
          content: "当前知识库没有找到与问题直接相关的资料。",
          mode: "evidence-gap",
          evidenceComplete: false,
          sources,
          recoveryNote: "本地检索没有命中，已把决定权交给模型。"
        };
      }
      return this.recoverWithoutLocalEvidence(normalizedQuestion, deepSeek, sources, stream);
    }

    const localAnswer = await deepSeek.answerWithSources(
      normalizedQuestion,
      modelSources,
      this.configuration.memoryContext,
      stream ? { onDelta: stream.onDelta, signal: stream.signal, streamField: "answer" } : undefined,
      wantsDiagram(normalizedQuestion)
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
    if (scope === "local-halt") {
      // The conversation loop decides what to try next; recovering here would
      // take that decision away from the model.
      return {
        content: localAnswer.content,
        mode: "evidence-gap",
        evidenceComplete: false,
        sources,
        recoveryNote
      };
    }
    const recovered = await this.answerFromWebOrGeneralKnowledge(normalizedQuestion, deepSeek, stream);
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

  /** Web research used by the runtime's `research:answer-web` action. */
  async answerFromWeb(question: string, stream?: DesktopAgentStreamOptions): Promise<DesktopAgentAnswer> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      throw new Error("问题不能为空。");
    }
    const recovered = await this.answerFromWebOrGeneralKnowledge(normalizedQuestion, this.createClient(), stream);
    if (!recovered) {
      throw new Error(getNoWebResultMessage(this.configuration.webFallbackPolicy, normalizedQuestion));
    }
    return { ...recovered, sources: [] };
  }

  /**
   * A general-knowledge answer, only when the fallback policy allows it.
   *
   * Exposed for the conversation loop: the model may choose "answer from
   * general knowledge" as an action, and the policy still gets a veto.
   */
  async answerFromGeneralKnowledge(question: string, stream?: DesktopAgentStreamOptions): Promise<DesktopAgentAnswer | null> {
    if (!shouldUseGeneralKnowledgeFallback(this.configuration.webFallbackPolicy, question)) {
      return null;
    }
    const deepSeek = this.createClient();
    stream?.onReset?.();
    const answer = await deepSeek.answerFromGeneralKnowledge(
      question,
      this.configuration.memoryContext,
      stream ? { onDelta: stream.onDelta, signal: stream.signal } : undefined,
      wantsDiagram(question.trim())
    );
    return { content: answer.content, mode: "general", evidenceComplete: true, sources: [] };
  }

  private createClient(): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
  }

  private async recoverWithoutLocalEvidence(
    question: string,
    deepSeek: DeepSeekClient,
    sources: DesktopAgentSource[],
    stream?: DesktopAgentStreamOptions
  ): Promise<DesktopAgentAnswer> {
    const recovered = await this.answerFromWebOrGeneralKnowledge(question, deepSeek, stream);
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
    deepSeek: DeepSeekClient,
    stream?: DesktopAgentStreamOptions
  ): Promise<Omit<DesktopAgentAnswer, "sources" | "recoveryNote"> | null> {
    if (this.configuration.tavilyApiKey.trim()) {
      try {
        const tavily = new TavilyClient({
          apiKey: this.configuration.tavilyApiKey,
          slowResponseMs: this.configuration.requestTimeoutMs,
          postJson: postJsonWithFetch
        });
        const search = await tavily.search(question, this.configuration.webSearchResultLimit);
        // A partial local answer may already be on screen; discard it first.
        stream?.onReset?.();
        const answer = await deepSeek.answerFromWeb(
          question,
          search.sources,
          this.configuration.memoryContext,
          stream ? { onDelta: stream.onDelta, signal: stream.signal } : undefined,
          wantsDiagram(question)
        );
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
      stream?.onReset?.();
      const answer = await deepSeek.answerFromGeneralKnowledge(
        question,
        this.configuration.memoryContext,
        stream ? { onDelta: stream.onDelta, signal: stream.signal } : undefined,
        wantsDiagram(question)
      );
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

/**
 * Turns hits into the evidence the model actually sees.
 *
 * Three corrections happen here, all of them about granularity.
 *
 * A hit is a fragment, but the answer to "how does it work" usually sits in
 * the *next* paragraph: BM25 finds where a word appears, not where something is
 * explained. So each hit is widened with its own neighbours — same section
 * first, then adjacent lines — which costs nothing, because those chunks are
 * already indexed. Without this the model can restate a property and nothing
 * more, which is exactly the failure that makes a knowledge base feel shallow.
 *
 * Expansion is only worth doing if what it pulls in is prose. Measured on a
 * real 77-note vault, a quarter of chunks are headings or generated "###
 * 来源" footers, and proximity ordering picks them first — so
 * {@link isSubstantiveEvidence} filters them out of both seeds and neighbours.
 *
 * Finally, the budget was small enough to be the binding constraint: four
 * fragments of 1500 characters is a summary, not an explanation. It is now six
 * fragments of 2000.
 */
/**
 * Choose the sources the model will read.
 *
 * The Wiki plan decides this when a compiled topic is in play, and the plain
 * ranking below is the fallback. Both paths exist because the Wiki is optional:
 * a library with nothing compiled must answer exactly as it did before.
 */
export function buildAnswerSources(
  results: MarkdownSearchResult[],
  index: PortableMarkdownKnowledgeIndex,
  wikiPlan?: WikiSourcePlan
): TextSourceSnippet[] {
  if (wikiPlan) {
    return wikiPlan.sources.map((source) => ({
      id: 0,
      path: source.path,
      locator: source.title,
      // The matched section, then what surrounds it. A page that was compiled
      // from several notes answers across all of them, so its own sections are
      // the expansion; a note expands into its neighbouring sections for the
      // same reason the fallback path below does.
      content: [source.seed.chunk.content, ...source.expansion.map((item) => item.chunk.content)]
        .filter((text) => text.trim())
        .join("\n\n")
    })).map((snippet, index_) => ({ ...snippet, id: index_ + 1 }));
  }

  // A heading that repeats the question scores well on BM25 while explaining
  // nothing, so structure is filtered out of the seeds too. If that leaves
  // nothing at all, the structure is still better than no evidence.
  const substantive = results.filter((result) => isSubstantiveEvidence(result.chunk));
  const seeds = (substantive.length ? substantive : results).slice(0, MAX_ANSWER_SEED_CHUNKS);
  const picked: TextSourceSnippet[] = [];
  const seen = new Set<string>();
  const take = (chunk: MarkdownChunk): void => {
    if (picked.length >= MAX_ANSWER_SOURCES) {
      return;
    }
    const key = `${chunk.source.pathOrUrl}::${chunk.source.locator}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    picked.push({
      // The locator already carries the heading (`heading=…&chunk=…`), which is
      // how the model cites it, so the heading is not duplicated here.
      id: picked.length + 1,
      path: chunk.source.pathOrUrl,
      locator: chunk.source.locator,
      content: chunk.content
    });
  };

  for (const seed of seeds) {
    take(seed.chunk);
    for (const neighbour of neighbouringChunks(seed.chunk, index)) {
      take(neighbour);
      if (picked.length >= MAX_ANSWER_SOURCES) {
        break;
      }
    }
  }
  return picked;
}

/**
 * The chunks most likely to hold the explanation the hit only gestures at.
 *
 * Same heading wins over adjacency: a section that states a property usually
 * explains it a few lines further down, while the line above is whatever the
 * previous section happened to end on.
 */
function neighbouringChunks(seed: MarkdownChunk, index: PortableMarkdownKnowledgeIndex): MarkdownChunk[] {
  const siblings = index
    .getForPath(seed.source.pathOrUrl)
    .filter((chunk) => chunk.source.locator !== seed.source.locator && isSubstantiveEvidence(chunk));
  const sameSection = siblings.filter((chunk) => chunk.heading === seed.heading);
  const adjacent = siblings
    .filter((chunk) => chunk.heading !== seed.heading)
    .sort((left, right) => distanceFrom(seed, left) - distanceFrom(seed, right));
  return [...sameSection, ...adjacent].slice(0, MAX_EXPANSION_PER_SEED);
}

function distanceFrom(seed: MarkdownChunk, candidate: MarkdownChunk): number {
  if (candidate.endLine < seed.startLine) {
    return seed.startLine - candidate.endLine;
  }
  if (candidate.startLine > seed.endLine) {
    return candidate.startLine - seed.endLine;
  }
  return 0;
}
