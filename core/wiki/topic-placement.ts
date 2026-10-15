import type { LlmWikiRegistry } from "./llm-wiki-system";

/**
 * Deciding where a new note belongs, from two independent kinds of evidence.
 *
 * Neither source is trusted on its own, because each fails in a direction the
 * other does not. The model's judgement is fluent and can be confidently wrong
 * about a note it has never read closely; the corpus only shows that a topic
 * already *talks about* something, which is not the same as the note belonging
 * there. A note about Redis eviction can land beside either a caching topic or a
 * monitoring topic, and only one of those is right.
 *
 * So: agree, and act. Disagree, and stop. The cost of that asymmetry is
 * deliberate — a Wiki page that is missing a note is a gap the reader can see,
 * while a Wiki page that absorbed an unrelated note is a page nobody trusts.
 */
export type PlacementVerdict = "existing" | "needs-new-topic" | "undecided";

export interface PlacementEvidence {
  /** A term from the note that a topic's pages already talk about. */
  term: string;
  /** How many of the topic's pages mention it. */
  pageHits: number;
  /** The note's own title tokens found among them. */
  matchedInTitle: string[];
  /** Score for this topic, 0 when nothing matched. */
  score: number;
}

export interface PlacementOption {
  topicId: string;
  topic: string;
  evidence: PlacementEvidence[];
}

export interface PlacementDecision {
  notePath: string;
  verdict: PlacementVerdict;
  /** Topics the corpus supports, strongest first. */
  corpusSupports: PlacementOption[];
  /** Topics the model proposed. */
  modelProposes: string[];
  /** Topics both agree on. */
  agreed: PlacementOption[];
  /** Model proposals the corpus does not support. */
  unsupported: string[];
  /** Corpus-supported topics the model did not name. */
  missed: PlacementOption[];
  /** One line naming the deciding factor, for the report. */
  reason: string;
}

export interface PlacementInput {
  notePath: string;
  noteTitle: string;
  registry: LlmWikiRegistry;
  /**
   * Which topics the model proposed, with its own confidence. Kept separate
   * because the number is not evidence: nothing here verifies it, which is the
   * whole reason the corpus gets a vote.
   */
  modelProposals: Array<{ topicId: string; confidence: number }>;
  /** A note's own text, used to find the terms worth checking. */
  noteText: string;
  /** A topic needs this many pages mentioning a term before it counts. */
  minPageHits?: number;
}

/**
 * Words too common in a technical library to place anything.
 *
 * Without this, a note about interview questions gets filed under whatever topic
 * happens to mention "agent" and "llm" — which is every topic. A term has to
 * distinguish its subject, not merely appear in it.
 */
const STOP_TERMS = new Set([
  "agent", "agents", "llm", "llms", "ai", "app", "apps", "api", "apis", "the", "and", "for",
  "note", "notes", "use", "using", "how", "what", "why", "when", "with", "from", "this", "that",
  "开发", "使用", "如何", "什么", "为什么", "怎么", "笔记", "知识", "整理", "梳理", "介绍", "说明"
]);

/**
 * Characters that carry no subject on their own.
 *
 * Kept apart from {@link STOP_TERMS} because they are a different kind of
 * useless: they carry no subject at all, whereas "agent" names a real one that
 * simply appears in every topic here. Listed per character because a title is
 * segmented into single characters, so "什么是 B 树" has to lose 什么 one
 * character at a time or it would place a note by its own interrogative.
 */
const FUNCTION_CHARS = new Set(
  "什 么 的 了 和 与 或 及 在 对 为 是 把 被 从 中 到 上 下 一 有 个 不 这 那 其 所 以 但 因 如 则 该 并 且 如 何 怎 样 呢 吗 吧 啊 讲 述 涉 及 包 含".split(" ")
);

function isUsefulTerm(term: string): boolean {
  if (STOP_TERMS.has(term)) {
    return false;
  }
  if (/^[\u4e00-\u9fff]+$/.test(term)) {
    // A Han character is a real unit even alone, but a function word is not a
    // subject no matter how it is written.
    return term.length >= 2 || !FUNCTION_CHARS.has(term);
  }
  // Latin needs enough letters to be a word rather than a fragment.
  return term.length >= 3;
}

/**
 * Latin runs in the body, cut at word boundaries.
 *
 * The first character class of a naive `[a-z0-9]+` match consumes one char and
 * then the rest, so a long run yields every prefix of itself. Each of those
 * counts as another "mention" and a term nobody writes gets the same weight as
 * the real one.
 */
function segmentLatin(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g) ?? [];
}

/**
 * Title terms: Latin runs plus each Han character.
 *
 * Chinese has no spaces, so word segmentation would need a dictionary. Single
 * characters are a defensible unit here because the comparison that follows is
 * containment — a topic page about "检查点机制" contains "检查", and a note about
 * "状态流转" contains "状态" — whereas a wrong two-character split would not
 * match either side.
 */
function segmentTitle(title: string): string[] {
  const text = title.replace(/\.md$/i, "").toLowerCase();
  const latin = text.match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g) ?? [];
  const han = text.match(/[\u4e00-\u9fff]/g) ?? [];
  return [...latin, ...han];
}

/**
 * Terms worth testing a topic against.
 *
 * The title first, and it is the whole title — every piece of it, not a
 * selection. A note called "B 树" is placed by "树" as much as by anything else,
 * and a term list that quietly dropped single Han characters would lose exactly
 * the words short Chinese titles are made of.
 *
 * The opening of the body is a weak second source, taken after the title so it
 * can only ever break a tie. Its Latin runs are also cut at word boundaries: a
 * naive character class turns "redis" into "redis", "redi" and "redi", so the
 * same concept would weigh three times whatever it is worth.
 */
export function candidateTerms(noteTitle: string, noteText: string, limit = 12): string[] {
  const fromTitle = segmentTitle(noteTitle);
  const fromOpening = segmentLatin(noteText.slice(0, 400));
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...fromTitle, ...fromOpening]) {
    const key = term.trim();
    if (!key || seen.has(key) || !isUsefulTerm(key)) {
      continue;
    }
    seen.add(key);
    terms.push(key);
    if (terms.length >= limit) {
      break;
    }
  }
  return terms;
}

/** The words a topic's pages actually use, for the corpus side of the vote. */
function topicVocabulary(registry: LlmWikiRegistry): Map<string, Map<string, { pageHits: number; titleHits: number }>> {
  const vocabulary = new Map<string, Map<string, { pageHits: number; titleHits: number }>>();
  for (const topic of registry.topics) {
    const perTopic = new Map<string, { pageHits: number; titleHits: number }>();
    for (const page of topic.pages) {
      const title = page.title.toLowerCase();
      const haystack = `${page.title} ${page.summary}`.toLowerCase();
      for (const term of new Set(candidateTerms(page.title, page.summary, 24))) {
        const entry = perTopic.get(term) ?? { pageHits: 0, titleHits: 0 };
        if (haystack.includes(term)) {
          entry.pageHits += 1;
        }
        if (title.includes(term)) {
          entry.titleHits += 1;
        }
        perTopic.set(term, entry);
      }
    }
    vocabulary.set(topic.id, perTopic);
  }
  return vocabulary;
}

export function decidePlacement(input: PlacementInput): PlacementDecision {
  const minPageHits = input.minPageHits ?? 1;
  const terms = candidateTerms(input.noteTitle, input.noteText);
  const vocabulary = topicVocabulary(input.registry);

  const corpusSupports: PlacementOption[] = input.registry.topics
    .map((topic) => {
      const perTopic = vocabulary.get(topic.id) ?? new Map();
      const evidence: PlacementEvidence[] = [];
      for (const term of terms) {
        const hit = perTopic.get(term);
        if (!hit || hit.pageHits < minPageHits) {
          continue;
        }
        evidence.push({
          term,
          pageHits: hit.pageHits,
          matchedInTitle: hit.titleHits ? [term] : [],
          // A term in several page titles is much stronger than one buried in
          // a summary, so titles carry more than raw mention counts.
          score: hit.pageHits + hit.titleHits * 2
        });
      }
      evidence.sort((left, right) => right.score - left.score);
      return {
        topicId: topic.id,
        topic: topic.topic,
        evidence: evidence.slice(0, 5),
        score: evidence.reduce((sum, item) => sum + item.score, 0)
      };
    })
    .filter((option) => option.evidence.length > 0)
    .sort((left, right) => right.score - left.score || left.topic.localeCompare(right.topic));

  const modelProposes = input.modelProposals
    .filter((proposal) => input.registry.topics.some((topic) => topic.id === proposal.topicId))
    .sort((left, right) => right.confidence - left.confidence)
    .map((proposal) => proposal.topicId);

  const corpusIds = new Set(corpusSupports.map((option) => option.topicId));
  const modelIds = new Set(modelProposes);
  const agreed = corpusSupports.filter((option) => modelIds.has(option.topicId));
  const unsupported = modelProposes.filter((topicId) => !corpusIds.has(topicId));
  const missed = corpusSupports.filter((option) => !modelIds.has(option.topicId));

  let verdict: PlacementVerdict;
  let reason: string;
  if (agreed.length) {
    verdict = "existing";
    const names = agreed.map((option) => option.topic).join("、");
    reason = `模型与资料证据都指向：${names}`;
  } else if (modelProposes.length && unsupported.length) {
    // The model named a topic, but that topic's pages never mention anything
    // from this note. Either the topic is wrong or the note is too thin to place.
    verdict = "undecided";
    reason = `模型提议「${unsupported.join("、")}」，但该主题的页面没有提到这篇笔记用到的词，证据不足。`;
  } else if (corpusSupports.length && missed.length) {
    // The corpus sees the fit and the model did not name it. Often the model
    // was looking at a different facet of a note the topic already covers.
    verdict = "undecided";
    reason = `资料证据指向「${missed.map((option) => option.topic).join("、")}」，模型没有提到，需要你判断。`;
  } else if (modelProposes.length) {
    // Every proposal the corpus could not judge, because the note is new to it.
    verdict = "existing";
    reason = `模型提议「${modelProposes.join("、")}」；该主题尚无相关页面可作对照。`;
  } else if (corpusSupports.length) {
    verdict = "existing";
    reason = `资料证据指向「${corpusSupports.map((option) => option.topic).join("、")}」，模型未提出主题。`;
  } else {
    verdict = "needs-new-topic";
    reason = "现有主题都没有提到这篇笔记用到的词，可能需要新建主题。";
  }

  return {
    notePath: input.notePath,
    verdict,
    corpusSupports,
    modelProposes,
    agreed,
    unsupported,
    missed,
    reason
  };
}
