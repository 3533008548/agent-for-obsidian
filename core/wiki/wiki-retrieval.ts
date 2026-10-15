import type { MarkdownSearchResult } from "../indexing/markdown-search";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import type { LlmWikiRegistry } from "./llm-wiki-system";

/**
 * Choosing what the model gets to read, with the Wiki taken seriously.
 *
 * The problem this solves was measured, not assumed: in every one of five real
 * queries, a Wiki page and the notes it was compiled from both reached the
 * result list. The model was handed the same material twice, and since the
 * budget is six sources, what got squeezed out was something else — a
 * comparison, a counter-example, a note that had nothing to do with either.
 *
 * So the compiled page is not merely a competitor. When a topic has a page that
 * covers what the question asks, that page answers in the model's own words
 * across every source it drew on, and re-reading its inputs adds nothing. The
 * original notes stay reachable — a compiled page is a synthesis, so a question
 * that needs the raw detail or a specific quote is still better served by the
 * note — but they yield their slot.
 *
 * The rule is deliberately one-directional. A note never displaces a page,
 * because the page is the more considered statement of the same material; and a
 * note is only displaced when a page is *actually in the result list*, so a
 * topic nobody has compiled yet loses nothing.
 */
export interface WikiSourcePlan {
  /** Sources to send, in the order they should be read. */
  sources: WikiPlannedSource[];
  /** Notes that yielded their slot to a compiled page. */
  displacedByWiki: Array<{ path: string; title: string; byTopic: string }>;
  /** Pages that took a slot. */
  promotedPages: Array<{ path: string; title: string; topic: string }>;
  /** True when at least one page replaced a note. */
  wikiLed: boolean;
}

export interface WikiPlannedSource {
  kind: "wiki-page" | "note";
  path: string;
  title: string;
  topic?: string;
  /** The chunk that matched, and the text the model should actually read. */
  seed: MarkdownSearchResult;
  /**
   * Neighbouring chunks to pull in with it. A compiled page is a synthesis
   * across sources, so reading one section of it tends to understate it.
   */
  expansion: MarkdownSearchResult[];
}

/** Topics, indexed the two ways the planner needs to look them up. */
interface WikiIndex {
  /** Source note path → topics that took it in. */
  topicsBySource: Map<string, Set<string>>;
  /** Wiki page path → its topic. */
  topicByPage: Map<string, string>;
}

/**
 * Pages that list rather than explain.
 *
 * Two judgements are needed, not one. Inside the registry, a page whose title
 * promises navigation is a table of contents. Outside it, whole directories are
 * navigation by construction: `_system/` holds the topic table and the error
 * book, and the map at the Wiki root is an index of the index. None of them are
 * registered as pages, so a rule that only looked at the registry would let them
 * through as if they were notes — and they score well precisely because they
 * mention every topic at once.
 */
const NAVIGATION_TITLE = /(?:索引|出处|来源清单|资料清单|导航|目录|概览|地图|主题表|错误|error ?book)/i;

const NAVIGATION_DIRECTORIES = ["/_system/", "/LLM Wiki/知识库地图.md", "/LLM Wiki/index.md"];

export function isNavigationalPage(path: string, title = ""): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (NAVIGATION_DIRECTORIES.some((part) => normalized.includes(part))) {
    return true;
  }
  const name = title || normalized.slice(normalized.lastIndexOf("/") + 1);
  return NAVIGATION_TITLE.test(name.replace(/\.md$/i, ""));
}

export function buildWikiIndex(registry: LlmWikiRegistry): WikiIndex {
  const topicsBySource = new Map<string, Set<string>>();
  const topicByPage = new Map<string, string>();
  for (const topic of registry.topics) {
    for (const source of topic.sourceHashes) {
      const set = topicsBySource.get(source.pathOrUrl) ?? new Set<string>();
      set.add(topic.topic);
      topicsBySource.set(source.pathOrUrl, set);
    }
    for (const page of topic.pages) {
      topicByPage.set(page.path, topic.topic);
    }
  }
  return { topicsBySource, topicByPage };
}

export interface WikiPriorityInput {
  results: readonly MarkdownSearchResult[];
  registry: LlmWikiRegistry;
  /**
   * The index, needed only when `neighboursOf` is not supplied — the planner
   * can run on a result list alone, which is what makes the rules testable
   * without a vault.
   */
  index?: PortableMarkdownKnowledgeIndex;
  /** Sources the answer may cite at most. */
  maxSources: number;
  /** Neighbouring chunks pulled in per source. */
  expansionPerSource: number;
  /** How many of the top results may become the seeds. */
  maxSeeds: number;
  /** False when no topic has been compiled, so this layer does nothing. */
  isSubstantive?: (result: MarkdownSearchResult) => boolean;
  /** A page counts as covering its topic's sources. */
  neighboursOf?: (result: MarkdownSearchResult) => MarkdownSearchResult[];
}

/**
 * Rank and de-duplicate, in one pass over the results.
 *
 * Kept separate from the caller so the rule can be tested against the measured
 * case — a page and its sources in the same result list — without a model, an
 * index or a vault.
 */
export function planAnswerSources(input: WikiPriorityInput): WikiSourcePlan {
  const { results, registry, index, maxSources, expansionPerSource, maxSeeds } = input;
  const isSubstantive = input.isSubstantive ?? (() => true);
  const neighboursOf =
    input.neighboursOf ??
    (input.index ? defaultNeighbours(input.index, expansionPerSource) : () => []);

  const wikiIndex = buildWikiIndex(registry);
  const substantive = results.filter((result) => isSubstantive(result));
  // Sorted here, not assumed. The index returns chunks grouped by path rather
  // than by score — one page's sections come back together, so a page that
  // matched strongly reappears far down the list. Reading a tier break off that
  // order would measure the gap between two sections of the same note.
  const ranked = [...(substantive.length ? substantive : results)].sort(
    (left, right) => right.score - left.score
  );
  const pool = ranked.slice(0, maxSeeds);

  // The tier break is read off the whole ranked list, not the seed pool. With
  // three seeds the break is usually already past them — a question about vector
  // search scored 25.7, 25.6, then fell to a shelf at 13.9 — so measuring inside
  // the pool would compare neighbours and find no break at all, which is the one
  // case where filling the tail is exactly what goes wrong.
  const floor = tailFloor(ranked);

  // Which topics have a page competing in this result list. A topic without one
  // cannot displace anything, however well its notes score.
  const coveredTopics = new Set<string>();
  for (const result of results) {
    const path = result.chunk.source.pathOrUrl;
    const topic = wikiIndex.topicByPage.get(path);
    // A topic whose only page here is its index is not covered: a table of
    // contents says the material exists, not what it says, so its notes keep
    // their slots.
    if (topic && !isNavigationalPage(path)) {
      coveredTopics.add(topic);
    }
  }

  const displacedByWiki: WikiSourcePlan["displacedByWiki"] = [];
  const promotedPages: WikiSourcePlan["promotedPages"] = [];
  const sources: WikiPlannedSource[] = [];
  const seen = new Set<string>();

  // Pages first. A page that is in the list is the best available statement of
  // its topic, so it is read before any of the notes it was written from.
  // Navigation pages are skipped: they mention everything, which makes them
  // score well, and answering from one means answering from a table of contents.
  for (const result of results) {
    const path = result.chunk.source.pathOrUrl;
    const topic = wikiIndex.topicByPage.get(path);
    if (!topic || seen.has(path) || isNavigationalPage(path)) {
      continue;
    }
    seen.add(path);
    sources.push({
      kind: "wiki-page",
      path,
      title: result.chunk.heading ?? result.chunk.source.pathOrUrl,
      topic,
      seed: result,
      expansion: neighboursOf(result)
    });
    promotedPages.push({ path, title: result.chunk.heading ?? path, topic });
  }

  // Then the notes, minus the ones a promoted page already speaks for.
  //
  // Filling to the cap matters as much as displacing: a slot given up to a page
  // that already said it would otherwise be a slot left empty, and the budget is
  // small enough that an empty slot is a question half-answered.
  const fillFrom = (predicate: (result: MarkdownSearchResult) => boolean): void => {
    for (const result of results) {
      if (sources.length >= maxSources) {
        return;
      }
      const path = result.chunk.source.pathOrUrl;
      if (seen.has(path) || path.includes("LLM Wiki/") || !predicate(result)) {
        continue;
      }
      // A navigation page is not a worse note, it is not a note. Letting it
      // through would answer a question from a table of contents, and the slot
      // it took is one the filler below cannot reach past.
      if (isNavigationalPage(path)) {
        continue;
      }
      const topics = wikiIndex.topicsBySource.get(path);
      const covered = topics ? [...topics].find((topic) => coveredTopics.has(topic)) : undefined;
      if (covered) {
        // Displaced, not dropped: the note is still the better answer for a
        // question that wants its detail or its wording.
        displacedByWiki.push({ path, title: result.chunk.heading ?? path, byTopic: covered });
        continue;
      }
      seen.add(path);
      sources.push({
        kind: "note",
        path,
        title: result.chunk.heading ?? result.chunk.source.pathOrUrl,
        seed: result,
        // A note is the raw material, so the section that matched comes with
        // its neighbours. A page is a synthesis across every source it drew on,
        // so one section understates it — there the matched section is enough,
        // because the page itself is already the summary.
        expansion: neighboursOf(result)
      });
    }
  };

  fillFrom((result) => pool.includes(result));

  // The cap is not a target. A slot handed to a note about HTTP status codes
  // because the question was about vector search is worse than an empty slot:
  // the model spends attention on it and the reader sees a citation that does
  // not support the answer. So the tail is only taken from results on the same
  // tier as the real hits.
  fillFrom((result) => result.score >= floor);

  return {
    sources: sources.slice(0, maxSources),
    displacedByWiki,
    promotedPages,
    wikiLed: promotedPages.length > 0
  };
}

/**
 * The score below which a result is treated as belonging to another subject.
 *
 * A fixed fraction of the weakest hit does not work, because BM25 scores in a
 * real result list fall in two groups rather than sliding off a slope: two or
 * three hits that answer the question, then a flat shelf where everything scores
 * within a point of everything else. On the measured lists the break was 25.7 to
 * 13.9 — and *within* that shelf a question about vector search could be served
 * a note about HTTP status codes, which is the one thing a filler must not do.
 *
 * So the floor is read off the break rather than off the top: the largest drop
 * between consecutive scores, and anything past it is off-topic by construction.
 * When there is no clear break the list is a single group and everything in it is
 * admitted, which is the right default for a short or flat result list.
 */
function tailFloor(pool: readonly MarkdownSearchResult[]): number {
  if (pool.length < 2) {
    return 0;
  }
  let biggestDrop = 0;
  let floor = 0;
  for (let i = 1; i < pool.length; i += 1) {
    const drop = (pool[i - 1]!.score - pool[i]!.score) / Math.max(pool[i - 1]!.score, 1e-6);
    if (drop > biggestDrop) {
      biggestDrop = drop;
      floor = pool[i]!.score;
    }
  }
  // A drop that small is noise between neighbours, not a subject change.
  return biggestDrop >= TIER_BREAK_RATIO ? floor : 0;
}

/**
 * How large a relative drop has to be before it counts as a subject change.
 *
 * Set just under the steepest smooth decline in the measured lists (0.16, on a
 * query the library has no note for). Below that, a smooth slope is read as one
 * group and everything in it is admitted, which is the honest reading: no clear
 * break means the ranking itself is the only signal there is, and dropping the
 * tail on a guess would just be a second, worse guess.
 *
 * The clear-break case still helps, and that is the one worth the rule. A query
 * about checkpoint persistence scored 25.7, 25.6, then fell to 13.9 and stayed
 * there; there the tail is noise and admitting it put a note about HTTP status
 * codes into an answer about vector search.
 */
const TIER_BREAK_RATIO = 0.15;

function defaultNeighbours(
  index: PortableMarkdownKnowledgeIndex,
  limit: number
): (result: MarkdownSearchResult) => MarkdownSearchResult[] {
  return (result) =>
    index
      .getForPath(result.chunk.source.pathOrUrl)
      .filter((chunk) => chunk.source.locator !== result.chunk.source.locator)
      .slice(0, limit)
      .map((chunk) => ({ chunk, score: 0, excerpt: chunk.content }));
}

/** One line naming what the Wiki did, for the answer's own note. */
export function describeWikiPlan(plan: WikiSourcePlan): string {
  if (!plan.wikiLed) {
    return "";
  }
  const parts: string[] = [];
  if (plan.promotedPages.length) {
    const topics = [...new Set(plan.promotedPages.map((page) => page.topic))];
    parts.push(
      `优先采用 LLM Wiki 已编译页面：${plan.promotedPages.length} 个（${topics.join("、")}）`
    );
  }
  if (plan.displacedByWiki.length) {
    parts.push(`${plan.displacedByWiki.length} 篇原始笔记因已被编译覆盖而让位`);
  }
  return parts.join("；") + "。";
}
