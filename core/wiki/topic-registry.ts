import type { NoteDigest } from "../indexing/note-survey";

/**
 * The library's topic table.
 *
 * Clustering used to invent topic names per batch and merge them by name
 * alone, so the same theme came back split ("RAG 与检索基础" and "RAG 检索
 * 技术") and a note could sit in whatever group its batch happened to produce
 * (Redis TTL landed under monitoring because Prometheus was in the same
 * batch). Topics are now defined once, then notes are assigned against that
 * table — the table, not the batch, decides membership.
 *
 * The table is persisted as a readable note so a human can correct a
 * definition and the next survey will follow the correction.
 */
export interface TopicDefinition {
  id: string;
  name: string;
  /** One sentence: the criterion the assignment step matches against. */
  definition: string;
  parentId?: string;
  aliases?: string[];
}

export interface NoteTopicAssignment {
  topicId: string;
  confidence: number;
  secondaryTopicIds?: string[];
}

export interface TopicRegistry {
  version: number;
  updatedAt: string;
  topics: TopicDefinition[];
  /** Note path to assignment. A note has one primary topic and optional cross-links. */
  assignments: Record<string, NoteTopicAssignment>;
}

export type NoteTopicVote = {
  path: string;
  topicId: string;
  confidence: number;
  secondaryTopicId?: string;
};

export const TOPIC_REGISTRY_VERSION = 1;
export const UNCLASSIFIED_TOPIC_ID = "unclassified";
export const UNCLASSIFIED_TOPIC_NAME = "未归类";
/** Topics below this many notes are folded into their parent, if they have one. */
export const MIN_NOTES_PER_TOPIC = 2;

const MAX_ID_LENGTH = 40;
const MAX_DEFINITION_LENGTH = 160;
const MAX_SECONDARY_TOPICS = 2;

export const UNCLASSIFIED_TOPIC: TopicDefinition = {
  id: UNCLASSIFIED_TOPIC_ID,
  name: UNCLASSIFIED_TOPIC_NAME,
  definition: "暂时无法归入任何既有主题的笔记。"
};

export function createTopicRegistry(now = new Date()): TopicRegistry {
  return {
    version: TOPIC_REGISTRY_VERSION,
    updatedAt: now.toISOString(),
    topics: [],
    assignments: {}
  };
}

/** Stable id derived from the name, so the same topic keeps its id between runs. */
export function topicDefinitionId(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\w一-龥]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, MAX_ID_LENGTH);
  return slug || UNCLASSIFIED_TOPIC_ID;
}

/**
 * Merges freshly proposed topics into the table.
 *
 * Existing definitions win: a definition the user corrected is the whole point
 * of keeping the table, and a proposal is only ever a suggestion.
 */
export function upsertTopics(
  existing: readonly TopicDefinition[],
  incoming: readonly TopicDefinition[]
): TopicDefinition[] {
  const byId = new Map(existing.map((topic) => [topic.id, topic]));
  const order = existing.map((topic) => topic.id);
  for (const topic of incoming) {
    if (topic.id === UNCLASSIFIED_TOPIC_ID || byId.has(topic.id)) {
      continue;
    }
    byId.set(topic.id, topic);
    order.push(topic.id);
  }
  return order
    .map((id) => byId.get(id))
    .filter((topic): topic is TopicDefinition => Boolean(topic));
}

/**
 * Applies assignment votes.
 *
 * A vote for an unknown topic, or for a note that was never offered, is
 * dropped rather than trusted — otherwise a fabricated id would become a
 * dangling topic in the map.
 */
export function assignNotes(
  registry: TopicRegistry,
  votes: readonly NoteTopicVote[],
  allowedPaths: ReadonlySet<string>
): TopicRegistry {
  const topicIds = new Set(registry.topics.map((topic) => topic.id));
  topicIds.add(UNCLASSIFIED_TOPIC_ID);
  const assignments: Record<string, NoteTopicAssignment> = {};

  for (const vote of votes) {
    if (!allowedPaths.has(vote.path) || assignments[vote.path]) {
      continue;
    }
    const primary = topicIds.has(vote.topicId) ? vote.topicId : UNCLASSIFIED_TOPIC_ID;
    const secondary = vote.secondaryTopicId && vote.secondaryTopicId !== primary && topicIds.has(vote.secondaryTopicId)
      ? [vote.secondaryTopicId]
      : undefined;
    assignments[vote.path] = {
      topicId: primary,
      confidence: clampConfidence(vote.confidence),
      ...(secondary ? { secondaryTopicIds: secondary.slice(0, MAX_SECONDARY_TOPICS) } : {})
    };
  }

  // Notes the model never voted on are unclassified, not silently absent: an
  // incomplete map should look incomplete.
  for (const path of allowedPaths) {
    if (!assignments[path]) {
      assignments[path] = { topicId: UNCLASSIFIED_TOPIC_ID, confidence: 0 };
    }
  }

  return { ...registry, assignments };
}

/**
 * Folds sparse topics into their parent and drops topics that ended up empty.
 *
 * A topic with one note is usually a naming artefact, not a theme. Folding is
 * only done along an existing parent link — guessing a "closest" topic would
 * need a similarity measure this project deliberately does not have.
 */
export function convergeRegistry(
  registry: TopicRegistry,
  minNotes = MIN_NOTES_PER_TOPIC
): { registry: TopicRegistry; merged: Array<{ from: string; to: string }> } {
  const counts = countNotes(registry);
  const byId = new Map(registry.topics.map((topic) => [topic.id, topic]));
  const redirect = new Map<string, string>();

  for (const topic of registry.topics) {
    if (topic.id === UNCLASSIFIED_TOPIC_ID || (counts.get(topic.id) ?? 0) >= minNotes) {
      continue;
    }
    const parentId = topic.parentId && topic.parentId !== topic.id ? topic.parentId : undefined;
    if (parentId && byId.has(parentId)) {
      redirect.set(topic.id, parentId);
    }
  }

  const merged: Array<{ from: string; to: string }> = [];
  if (!redirect.size) {
    return { registry: pruneEmptyTopics(registry, counts), merged };
  }

  const assignments: Record<string, NoteTopicAssignment> = {};
  for (const [path, assignment] of Object.entries(registry.assignments)) {
    const target = redirect.get(assignment.topicId);
    if (!target) {
      assignments[path] = assignment;
      continue;
    }
    merged.push({ from: assignment.topicId, to: target });
    const secondary = [...(assignment.secondaryTopicIds ?? [])]
      .map((id) => redirect.get(id) ?? id)
      .filter((id) => id !== target);
    assignments[path] = {
      topicId: target,
      confidence: assignment.confidence,
      ...(secondary.length ? { secondaryTopicIds: [...new Set(secondary)].slice(0, MAX_SECONDARY_TOPICS) } : {})
    };
  }

  const next: TopicRegistry = { ...registry, assignments };
  return { registry: pruneEmptyTopics(next, countNotes(next)), merged };
}

export function countNotes(registry: TopicRegistry): Map<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of Object.values(registry.assignments)) {
    counts.set(assignment.topicId, (counts.get(assignment.topicId) ?? 0) + 1);
  }
  return counts;
}

export function notesOfTopic(registry: TopicRegistry, topicId: string): string[] {
  return Object.entries(registry.assignments)
    .filter(([, assignment]) => assignment.topicId === topicId)
    .map(([path]) => path)
    // Code-unit order, not locale: locale collation reorders paths by local
    // rules and made the same list come out differently across environments.
    .sort(comparePaths);
}

function normalizeTopicText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_\-]+/gu, "");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface TopicStat {
  topic: TopicDefinition;
  count: number;
}

export function topicStats(registry: TopicRegistry): TopicStat[] {
  const counts = countNotes(registry);
  return registry.topics
    .filter((topic) => topic.id !== UNCLASSIFIED_TOPIC_ID)
    .map((topic) => ({ topic, count: counts.get(topic.id) ?? 0 }))
    .filter((stat) => stat.count > 0)
    .sort((left, right) => right.count - left.count);
}

/** Rendered as a note: readable above, machine-readable below. */
export function renderTopicRegistryMarkdown(registry: TopicRegistry, generatedAt: string): string {
  const stats = topicStats(registry);
  const lines = [
    "---",
    "title: 主题表",
    "tags: [主题表]",
    `updatedAt: ${generatedAt}`,
    "---",
    "",
    "# 主题表",
    "",
    "这张表决定笔记的归属。改下方 JSON 块里的 `definition`（主题的一句话判据）或 `name`，下次梳理会按改后的表重新分配；`id` 不要改，改了笔记归属会对不上。",
    "",
    "| id | 名称 | 定义 | 笔记 |",
    "| --- | --- | --- | --- |"
  ];
  for (const stat of stats) {
    lines.push(`| ${stat.topic.id} | ${stat.topic.name} | ${oneLine(stat.topic.definition)} | ${stat.count} |`);
  }
  const unclassified = notesOfTopic(registry, UNCLASSIFIED_TOPIC_ID);
  if (unclassified.length) {
    lines.push(`| ${UNCLASSIFIED_TOPIC_ID} | ${UNCLASSIFIED_TOPIC_NAME} | ${UNCLASSIFIED_TOPIC.definition} | ${unclassified.length} |`);
  }

  lines.push("", "## 笔记归属", "", "| 笔记 | 主题 | 另见 |", "| --- | --- | --- |");
  const nameById = new Map(registry.topics.map((topic) => [topic.id, topic.name]));
  for (const path of Object.keys(registry.assignments).sort(comparePaths)) {
    const assignment = registry.assignments[path];
    const secondary = (assignment.secondaryTopicIds ?? [])
      .map((id) => nameById.get(id))
      .filter(Boolean)
      .join("、");
    lines.push(`| [[${path}]] | ${nameById.get(assignment.topicId) ?? UNCLASSIFIED_TOPIC_NAME} | ${secondary || "—"} |`);
  }

  lines.push(
    "",
    "<!-- topic-registry -->",
    "```json",
    JSON.stringify(registry, null, 2),
    "```",
    ""
  );
  return lines.join("\n");
}

/** Returns null when the note holds no usable block, so callers start fresh. */
export function parseTopicRegistryMarkdown(content: string): TopicRegistry | null {
  const block = extractJsonBlock(content);
  if (!block) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.topics) || !isRecord(parsed.assignments)) {
    return null;
  }
  const topics = parsed.topics.flatMap((raw): TopicDefinition[] => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
      return [];
    }
    return [{
      id: raw.id,
      name: raw.name,
      definition: typeof raw.definition === "string" ? raw.definition : "",
      ...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
      ...(Array.isArray(raw.aliases) ? { aliases: raw.aliases.filter((item): item is string => typeof item === "string") } : {})
    }];
  });
  if (!topics.some((topic) => topic.id !== UNCLASSIFIED_TOPIC_ID)) {
    return null;
  }
  const assignments: Record<string, NoteTopicAssignment> = {};
  for (const [path, raw] of Object.entries(parsed.assignments)) {
    if (!isRecord(raw) || typeof raw.topicId !== "string") {
      continue;
    }
    assignments[path] = {
      topicId: raw.topicId,
      confidence: clampConfidence(raw.confidence),
      ...(Array.isArray(raw.secondaryTopicIds)
        ? { secondaryTopicIds: raw.secondaryTopicIds.filter((item): item is string => typeof item === "string") }
        : {})
    };
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : TOPIC_REGISTRY_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    topics: upsertTopics(topics, [UNCLASSIFIED_TOPIC]),
    assignments
  };
}

export interface TopicReference {
  topicId: string;
  name: string;
}

/**
 * Maps a phrase to a topic in the table.
 *
 * The same theme is written many ways — "RAG", "RAG 检索", "检索增强" — and
 * without this step each wording became its own wiki topic folder. Matching
 * goes from strict to loose and stops at the first unambiguous hit: an id, a
 * name, an alias, and only then a containment match, and only when exactly one
 * topic could be meant.
 */
export function resolveTopicReference(registry: TopicRegistry, phrase: string): TopicReference | null {
  const text = phrase.trim();
  if (!text) {
    return null;
  }
  const normalized = normalizeTopicText(text);
  const candidates = registry.topics.filter((topic) => topic.id !== UNCLASSIFIED_TOPIC_ID);

  const byId = candidates.find((topic) => topic.id === text)
    ?? candidates.find((topic) => topic.id === topicDefinitionId(text));
  if (byId) {
    return { topicId: byId.id, name: byId.name };
  }

  const byName = candidates.find((topic) => topic.name === text)
    ?? candidates.find((topic) => normalizeTopicText(topic.name) === normalized);
  if (byName) {
    return { topicId: byName.id, name: byName.name };
  }

  const byAlias = candidates.find((topic) =>
    (topic.aliases ?? []).some((alias) => alias === text || normalizeTopicText(alias) === normalized)
  );
  if (byAlias) {
    return { topicId: byAlias.id, name: byAlias.name };
  }

  if (normalized.length >= 2) {
    const contained = candidates.filter((topic) => {
      const name = normalizeTopicText(topic.name);
      return name.includes(normalized) || normalized.includes(name);
    });
    if (contained.length === 1) {
      return { topicId: contained[0]!.id, name: contained[0]!.name };
    }
  }
  return null;
}

/** Topic name of one note, for routing hints. Null when the note is unclassified. */
export function topicOfNote(registry: TopicRegistry, path: string): string | null {
  const assignment = registry.assignments[path];
  if (!assignment || assignment.topicId === UNCLASSIFIED_TOPIC_ID) {
    return null;
  }
  return registry.topics.find((topic) => topic.id === assignment.topicId)?.name ?? null;
}

/** Existing topic names, handed to the proposal step so names stay stable. */
export function existingTopicNames(registry: TopicRegistry): string[] {
  return registry.topics
    .filter((topic) => topic.id !== UNCLASSIFIED_TOPIC_ID)
    .map((topic) => topic.name);
}

export function digestPaths(digests: readonly NoteDigest[]): Set<string> {
  return new Set(digests.map((digest) => digest.path));
}

function pruneEmptyTopics(registry: TopicRegistry, counts: Map<string, number>): TopicRegistry {
  const kept = registry.topics.filter((topic) => (counts.get(topic.id) ?? 0) > 0);
  return kept.length === registry.topics.length ? registry : { ...registry, topics: kept };
}

function clampConfidence(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/\|/gu, "／").trim().slice(0, MAX_DEFINITION_LENGTH);
}

function extractJsonBlock(content: string): string | null {
  const marker = content.lastIndexOf("<!-- topic-registry -->");
  const start = marker < 0 ? content.indexOf("```json") : content.indexOf("```json", marker);
  if (start < 0) {
    return null;
  }
  const bodyStart = content.indexOf("\n", start);
  const end = content.indexOf("```", bodyStart < 0 ? start + 7 : bodyStart);
  if (bodyStart < 0 || end < 0) {
    return null;
  }
  return content.slice(bodyStart + 1, end).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
