/**
 * Turns a question into the name of the thing it is about.
 *
 * Titles used to be the raw question, which made every rephrasing a new file
 * and left the vault full of "…是什么" pages. A note is named after its
 * subject; the question is kept as an alias so it stays findable.
 */
export interface NoteTopicResolution {
  /** Noun phrase, or "A 与 B 的区别" for comparisons. Never a question. */
  title: string;
  /** Upper-level topic, used for grouping and later for topic routing. */
  topic: string;
  /** Original phrasings, stored in frontmatter for retrieval. */
  aliases: string[];
  keywords: string[];
}

export const MAX_NOTE_TITLE_LENGTH = 24;
export const MAX_NOTE_TOPIC_LENGTH = 12;
const MAX_STEM_LENGTH = 40;
const MAX_ALIASES = 6;
const MAX_KEYWORDS = 8;
const MAX_KEYWORD_LENGTH = 30;

const QUESTION_TAIL = /[?？。！!]+$/u;
const TRAILING_PUNCTUATION = /[,，、;；:：]+$/u;
const LEADING_FILLER =
  /^(?:请问|请|我想知道|我想问|想问一下|帮我|给我|讲一下|讲讲|说一下|说说|介绍一下|介绍下|介绍|描述一下|描述|解释一下|解释|查一下|什么是|什么叫|何为|为何|为什么|为啥|怎么|如何|怎样|能否|能不能|可以|是否|有没有|有哪些)/u;
const TRAILING_QUESTION =
  /(?:是|叫|为)什么$|有什么(?:特点|作用|用|影响|意义|区别|不同|差别|好处|坏处)?$|起什么(?:作用|用)$|干嘛的$|干什么(?:的|用)?$|是什么问题$|是什么东西$/u;
const COMPARISON = /^(.{1,24}?)(?:和|与|跟|同|vs\.?|versus)(.{1,24}?)(?:有)?(?:什么)?(?:区别|差异|差别|不同)/iu;

/**
 * Rule-based fallback used when no model call is possible.
 *
 * It is intentionally imperfect: the model path is the primary one, and a
 * slightly clipped stem is better than a filename that is a full sentence.
 */
export function normalizeQuestionToStem(question: string): string {
  let text = question.trim().replace(/\s+/gu, " ");
  if (!text) {
    return "未命名主题";
  }

  const comparison = COMPARISON.exec(text);
  if (comparison?.[1] && comparison[2]) {
    return truncate(`${comparison[1].trim()} 与 ${comparison[2].trim()} 的区别`, MAX_STEM_LENGTH);
  }

  text = text.replace(QUESTION_TAIL, "").trim();
  text = stripLeadingFiller(text);
  // "X 是什么，起什么作用" needs more than one pass: each clause has its own
  // question tail, and removing one exposes the next.
  for (let round = 0; round < 3; round += 1) {
    const next = text.replace(TRAILING_QUESTION, "").replace(TRAILING_PUNCTUATION, "").trim();
    if (!next || next === text) {
      break;
    }
    text = next;
  }
  return truncate(text, MAX_STEM_LENGTH) || "未命名主题";
}

export function resolveFallbackNoteTopic(question: string): NoteTopicResolution {
  const stem = normalizeQuestionToStem(question);
  return {
    title: truncate(stem, MAX_NOTE_TITLE_LENGTH),
    topic: truncate(stem, MAX_NOTE_TOPIC_LENGTH),
    aliases: question.trim() ? [truncate(question.trim(), 120)] : [],
    keywords: []
  };
}

/**
 * Reads the naming half of a note-capture plan.
 *
 * Never throws: a malformed title degrades to the rule-based stem so one bad
 * response cannot block a write the user asked for.
 */
export function parseNoteTopicResolution(raw: Record<string, unknown>, question: string): NoteTopicResolution {
  const fallback = resolveFallbackNoteTopic(question);
  const title = readCleanString(raw.title, MAX_NOTE_TITLE_LENGTH);
  if (!title || looksLikeQuestion(title)) {
    return { ...fallback, topic: readCleanString(raw.topic, MAX_NOTE_TOPIC_LENGTH) || fallback.topic };
  }
  return {
    title,
    topic: readCleanString(raw.topic, MAX_NOTE_TOPIC_LENGTH) || truncate(title, MAX_NOTE_TOPIC_LENGTH),
    aliases: dedupe([
      ...(question.trim() ? [truncate(question.trim(), 120)] : []),
      ...readStringArray(raw.aliases, MAX_ALIASES, 120)
    ]),
    keywords: readStringArray(raw.keywords, MAX_KEYWORDS, MAX_KEYWORD_LENGTH)
  };
}

function looksLikeQuestion(value: string): boolean {
  return /[?？]/u.test(value) || /(?:是什么|为什么|怎么样|有什么|吗)$/u.test(value.trim());
}

function stripLeadingFiller(value: string): string {
  let text = value;
  for (let round = 0; round < 2; round += 1) {
    const next = text.replace(LEADING_FILLER, "").trim();
    if (next === text || !next) {
      break;
    }
    text = next;
  }
  return text;
}

function readCleanString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) {
    return "";
  }
  return truncate(text, maxLength);
}

function readStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const text = truncate(item.replace(/\s+/gu, " ").trim(), maxLength);
    if (text && !items.includes(text)) {
      items.push(text);
    }
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, MAX_ALIASES);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trimEnd();
}
