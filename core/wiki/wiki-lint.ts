import type { LlmWikiPageRecord, LlmWikiTopicRecord, LlmWikiRegistry } from "./llm-wiki-system";

/**
 * Structural check of a compiled Wiki.
 *
 * Pure rules, no model: the questions here are all answerable by comparing
 * paths, source lists and link targets, and a report that costs nothing can be
 * produced on every compile. What it cannot judge — whether a page is *good* —
 * is left to the model-driven verification pass.
 *
 * The recurring defect it exists to catch: a recompile that writes a page under
 * a new name leaves the previous one in place, because paths differ even when
 * the sources are identical. Over a few compiles the topic accumulates several
 * pages that answer the same question, and nothing in the data says which is
 * current.
 */
export type WikiLintFindingKind =
  /** Two or more pages compiled from the same source set; keep the newest. */
  | "duplicate-source"
  /** On disk but absent from the registry, so nothing links to it any more. */
  | "orphan"
  /** Links nothing; a reader arriving from the index has no next step. */
  | "dead-end"
  /** Topic has more concept pages than a topic is meant to hold. */
  | "topic-overflow"
  /** Registry lists a page that is no longer on disk. */
  | "missing-page"
  /** Sources recorded for the topic no longer resolve to a file. */
  | "stale-source";

export interface WikiLintFinding {
  kind: WikiLintFindingKind;
  /** Short label naming the page or topic, for the report header. */
  subject: string;
  detail: string;
  /** Paths involved; more than one for duplicate-source. */
  paths: string[];
  /** For duplicate-source: the page to keep and the ones that should retire. */
  resolution?: { keep: string; retire: string[] };
}

export interface WikiLintReport {
  topics: number;
  pagesOnDisk: number;
  pagesInRegistry: number;
  findings: WikiLintFinding[];
  /** True when nothing needs changing. */
  clean: boolean;
  health: WikiHealth;
}

/**
 * Whether the Wiki is still shaped like a set of topics.
 *
 * Drift is the failure that has no single bad day. Each new note is placed
 * reasonably, and after a few months the topic has split into several thin ones
 * that each repeat the introduction. Nothing in the data is wrong at any moment,
 * which is exactly why it needs measuring on purpose instead of being noticed.
 *
 * None of this triggers a change. Merging topics is a different operation with
 * its own risks, and a report that acted on its own would be doing the risky
 * thing without asking.
 */
export interface WikiHealth {
  topics: TopicHealth[];
  /** Topics whose pages thin out into several near-copies of one another. */
  possiblyFragmented: string[];
  /** Topics carrying more pages than a topic should hold. */
  oversized: string[];
  /** Notes that exist but are in no topic at all. */
  uncoveredNotes: number;
  /** The library's total page count, for reading the ratios above. */
  totalPages: number;
}

export interface TopicHealth {
  topicId: string;
  topic: string;
  pages: number;
  sources: number;
  /** Pages per source; below 1 means the topic is mostly generated prose. */
  pagesPerSource: number;
  /** Pages with no inbound link from another page in the same topic. */
  unlinkedPages: number;
  /** Status recorded at the last compile. */
  status: string;
  updatedAt: string;
}

/**
 * Pages per source above which a topic is likely several copies of one thing.
 *
 * A topic that draws on one long note has plenty to say, but a *page* normally
 * rests on more than one. Once a topic averages more than about two pages per
 * source, the pages are re-covering the same material in different words — which
 * is what fragmentation looks like from the inside, and what the orphan pages
 * cleaned up earlier were the leftover of.
 *
 * The ratio is the signal rather than the page count because page count alone
 * says nothing: a topic with 20 sources and 24 pages is fine, and one with 2
 * sources and 8 pages is not.
 */
const FRAGMENTED_PAGES_PER_SOURCE = 2;

/** A topic is meant to stay navigable; past this it is a folder, not a topic. */
export const MAX_PAGES_PER_TOPIC = 12;

export interface WikiLintInput {
  registry: LlmWikiRegistry;
  /**
   * Every path that exists, relative and normalized: Wiki pages and notes
   * together. Coverage is about notes, so the caller has to pass the whole
   * library rather than the Wiki folder — passing only Wiki pages makes every
   * note look uncovered.
   */
  diskPaths: readonly string[];
  /**
   * True when the path is a real note eligible for compiling.
   *
   * Not "any file that exists": Wiki pages exist on disk too, and counting them
   * as notes waiting to be compiled inflates the coverage gap by however many
   * pages the Wiki happens to have.
   */
  isCompilableNote: (path: string) => boolean;
}

export function lintWiki(input: WikiLintInput): WikiLintReport {
  const { registry, diskPaths } = input;
  const isCompilableNote = input.isCompilableNote;
  const onDisk = new Set(diskPaths.map(normalizePath));
  const findings: WikiLintFinding[] = [];

  for (const topic of registry.topics) {
    findings.push(...lintTopic(topic, onDisk, isCompilableNote));
  }

  // Pages on disk that no topic claims. Includes both unregistered pages under a
  // topic folder and anything in a folder the registry never wrote.
  const claimed = new Set(
    registry.topics.flatMap((topic) => [topic.indexPath, ...topic.pages.map((page) => page.path)])
  );
  for (const path of onDisk) {
    if (!isWikiPagePath(path) || isWikiSystemPath(path) || isEntryPagePath(path) || claimed.has(path)) {
      continue;
    }
    findings.push({
      kind: "orphan",
      subject: pageName(path),
      detail: "文件存在于磁盘，但不在 registry 里，没有入口链接指向它。",
      paths: [path]
    });
  }

  return {
    topics: registry.topics.length,
    pagesOnDisk: onDisk.size,
    pagesInRegistry: registry.topics.reduce((sum, topic) => sum + topic.pages.length, 0),
    findings,
    clean: findings.length === 0,
    health: measureHealth(registry, onDisk, isCompilableNote)
  };
}

/**
 * Read the shape of the Wiki without changing it.
 *
 * Every number here is something a person could have counted by hand and did
 * not. That is the point: the drift this catches has no error message, no failed
 * write and no prompt saying the library is losing its shape.
 */
function measureHealth(
  registry: LlmWikiRegistry,
  onDisk: ReadonlySet<string>,
  isCompilableNote: (path: string) => boolean
): WikiHealth {
  const compiledSources = new Set<string>();
  const topics: TopicHealth[] = [];

  for (const topic of registry.topics) {
    for (const source of topic.sourceHashes) {
      compiledSources.add(source.pathOrUrl);
    }
    const conceptPages = topic.pages.filter((page) => !isTopicIndexPath(topic, page.path));
    // Link targets are paths as the compiler wrote them; a page linked from
    // elsewhere in the same topic counts as reachable, and one that is only
    // linked from its own index is not what a reader would find.
    const linkedFromWithin = new Set<string>();
    for (const page of topic.pages) {
      for (const link of page.links) {
        if (link !== topic.indexPath) {
          linkedFromWithin.add(normalizePath(link));
        }
      }
    }

    topics.push({
      topicId: topic.id,
      topic: topic.topic,
      pages: conceptPages.length,
      sources: topic.sourceHashes.length,
      pagesPerSource:
        topic.sourceHashes.length === 0
          ? conceptPages.length
          : round2(conceptPages.length / topic.sourceHashes.length),
      unlinkedPages: conceptPages.filter(
        (page) => !linkedFromWithin.has(normalizePath(page.path)) && onDisk.has(normalizePath(page.path))
      ).length,
      status: topic.status,
      updatedAt: topic.updatedAt
    });
  }

  // Notes on disk that no topic claims. Counted here rather than in the findings
  // list: it is the one number a reader wants without reading any prose.
  let uncoveredNotes = 0;
  const counted = new Set(compiledSources);
  for (const path of onDisk) {
    if (!path.toLowerCase().endsWith(".md") || isWikiSystemPath(path) || isEntryPagePath(path)) {
      continue;
    }
    if (counted.has(path)) {
      continue;
    }
    if (isCompilableNote(path)) {
      uncoveredNotes += 1;
    }
  }

  return {
    topics,
    possiblyFragmented: topics
      .filter(
        (topic) => topic.pages > 2 && topic.pagesPerSource > FRAGMENTED_PAGES_PER_SOURCE
      )
      .map((topic) => topic.topic),
    oversized: topics.filter((topic) => topic.pages > MAX_PAGES_PER_TOPIC).map((topic) => topic.topic),
    uncoveredNotes,
    totalPages: topics.reduce((sum, topic) => sum + topic.pages, 0)
  };
}

/** A report a person can act on, not a metrics dump. */
export function renderWikiHealth(health: WikiHealth): string {
  const lines: string[] = [];
  if (!health.topics.length) {
    return "还没有编译任何 LLM Wiki 主题。";
  }

  lines.push("| 主题 | 页面 | 来源 | 页面/来源 | 无入链 | 最后更新 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const topic of health.topics) {
    lines.push(
      `| ${topic.topic} | ${topic.pages} | ${topic.sources} | ${topic.pagesPerSource} | ${topic.unlinkedPages} | ${topic.updatedAt.slice(0, 10)} |`
    );
  }

  const notes: string[] = [];
  if (health.possiblyFragmented.length) {
    notes.push(
      `页面密度偏高（> ${FRAGMENTED_PAGES_PER_SOURCE} 页/来源），可能是同一主题裂成了几个薄页面：${health.possiblyFragmented.join("、")}。`
    );
  }
  if (health.oversized.length) {
    notes.push(`超过 ${MAX_PAGES_PER_TOPIC} 个页面的主题：${health.oversized.join("、")}。`);
  }
  if (health.uncoveredNotes) {
    notes.push(`知识库里有 ${health.uncoveredNotes} 篇笔记尚未被任何主题收录。`);
  }
  if (!notes.length) {
    notes.push("主题结构正常：没有发现页面密度过低或超限的主题。");
  }
  lines.push("");
  lines.push(...notes);

  return lines.join("\n");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function lintTopic(
  topic: LlmWikiTopicRecord,
  onDisk: ReadonlySet<string>,
  isCompilableNote: (path: string) => boolean
): WikiLintFinding[] {
  const findings: WikiLintFinding[] = [];
  const conceptPages = topic.pages.filter((page) => !isTopicIndexPath(topic, page.path));

  // Group by source set, which is the thing that survives a rename.
  const bySources = new Map<string, LlmWikiPageRecord[]>();
  for (const page of conceptPages) {
    const key = sourceFingerprint(page);
    const bucket = bySources.get(key);
    if (bucket) {
      bucket.push(page);
    } else {
      bySources.set(key, [page]);
    }
  }
  for (const [key, candidates] of bySources) {
    if (candidates.length < 2) {
      continue;
    }
    // Sharing sources makes them related; it does not make them the same page.
    // Only a shared subject turns that into a duplicate worth retiring.
    const clusters = clusterBySubject(candidates);
    const shared = key ? key.split("|") : [];
    for (const cluster of clusters) {
      if (cluster.length < 2) {
        continue;
      }
      // Keep the most recently compiled: the registry is written in compile
      // order, so the last recorded page is the current one.
      const keep = cluster[cluster.length - 1]!;
      const retire = cluster.slice(0, -1);
      findings.push({
        kind: "duplicate-source",
        subject: pageName(keep.path),
        detail:
          `${cluster.length} 个页面讲同一件事且来自同一批来源` +
          `（${shared.length} 份：${shared.slice(0, 2).join("、")}${shared.length > 2 ? " 等" : ""}），内容互为重述。`,
        paths: cluster.map((page) => page.path),
        resolution: { keep: keep.path, retire: retire.map((page) => page.path) }
      });
    }
  }

  for (const page of conceptPages) {
    if (!onDisk.has(normalizePath(page.path))) {
      findings.push({
        kind: "missing-page",
        subject: pageName(page.path),
        detail: "registry 记录了这个页面，但磁盘上找不到。",
        paths: [page.path]
      });
      continue;
    }
    if (!page.links.length) {
      findings.push({
        kind: "dead-end",
        subject: pageName(page.path),
        detail: "没有任何出链，从主题页点进来之后无处可去。",
        paths: [page.path]
      });
    }
  }

  if (conceptPages.length > MAX_PAGES_PER_TOPIC) {
    findings.push({
      kind: "topic-overflow",
      subject: topic.topic,
      detail: `概念页 ${conceptPages.length} 个，超过单主题上限 ${MAX_PAGES_PER_TOPIC}；此时主题已经变成文件夹而不是主题。`,
      paths: conceptPages.map((page) => page.path)
    });
  }

  const gone = topic.sourceHashes
    .map((source) => source.pathOrUrl)
    .filter((path) => !isCompilableNote(path));
  if (gone.length) {
    findings.push({
      kind: "stale-source",
      subject: topic.topic,
      detail: `${gone.length} 份来源笔记已不存在，主题状态可能已经过时：${gone.slice(0, 3).join("、")}${gone.length > 3 ? " 等" : ""}。`,
      paths: gone
    });
  }

  return findings;
}

/**
 * Identity of a page's origin.
 *
 * Paths cannot be used: a recompile may well name the same material
 * differently. Hashes cannot either, because a recompile of changed material
 * produces new ones. The set of source paths is the part that stays put.
 *
 * A shared source is only a hint, not proof. Two pages can legitimately draw on
 * one long note and still answer different questions — "how state flows" and
 * "what the state holds" are neighbours, not twins. So this is a two-stage
 * signal: the pages have to share sources *and* say the same thing, which the
 * title comparison below decides.
 */
function sourceFingerprint(page: LlmWikiPageRecord): string {
  return [...new Set(page.sourcePaths.map(normalizePath))].sort().join("|");
}

/**
 * How much of the shorter title must sit inside the longer one before the two
 * pages count as the same subject.
 *
 * The real pair in a recompiled topic scores 0.73; two pages that merely share
 * a source note score 0.29. Anything in between is a judgement call, and the
 * report is a proposal either way, so the bar is set where the two populations
 * separate rather than in the gap.
 */
const TITLE_TOKEN_THRESHOLD = 0.6;

/**
 * The second gate, for pages whose titles disagree.
 *
 * A recompile that renames by topic ("N2-为什么使用 LangGraph 而不是一个很长的
 * Prompt") leaves an older page whose title is phrased differently
 * ("comparison_with_prompt-LangGraph vs 长 Prompt 的优势") — the same subject,
 * barely 0.44 containment. Summaries are what catch those.
 *
 * Weak on its own and deliberately not sufficient: neighbouring pages compiled
 * from one long note legitimately share phrasing about that note's subject, so
 * a summary match only counts when the titles are not obviously about different
 * things.
 */
const SUMMARY_TOKEN_THRESHOLD = 0.75;

/** Titles this different are different subjects, whatever the summaries say. */
const TITLE_DIVERGENCE_FLOOR = 0.2;

/**
 * How much of the shorter title survives inside the longer one.
 *
 * Asymmetric on purpose. A recompile tends to produce a shorter name for the
 * same subject — "N5-LangGraph 中的 checkpoint" against "checkpoint_mechanism-
 * LangGraph 中的 checkpoint(检查点)机制" — so symmetric Jaccard scores that
 * pair *lower* than a pair of unrelated pages, because the leftover words in the
 * long name count against it. Containment asks the useful question instead:
 * does the short title's vocabulary sit inside the long one?
 */
function titleContainment(left: LlmWikiPageRecord, right: LlmWikiPageRecord): number {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  const [shorter, longer] = leftTokens.size <= rightTokens.size ? [leftTokens, rightTokens] : [rightTokens, leftTokens];
  if (shorter.size < 2) {
    return 0;
  }
  let shared = 0;
  for (const token of shorter) {
    if (longer.has(token)) {
      shared += 1;
    }
  }
  return shared / shorter.size;
}

/**
 * Whether a page is about the same thing as another, on a weaker signal than
 * the title.
 *
 * Summaries are compared rather than bodies: the summary is what the compile
 * step wrote to say what the page covers, so a shared phrasing there is the
 * compiler's own statement that these are one subject. Bodies would compare
 * equal far more often, because a compiled page quotes its sources.
 */
function summariesAgree(left: LlmWikiPageRecord, right: LlmWikiPageRecord): boolean {
  const a = significantWords(left.summary);
  const b = significantWords(right.summary);
  if (a.size < 3 || b.size < 3) {
    return false;
  }
  const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of shorter) {
    if (longer.has(word)) {
      shared += 1;
    }
  }
  return shared / shorter.size >= SUMMARY_TOKEN_THRESHOLD;
}

function significantWords(summary: string): Set<string> {
  const latin = summary.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const han = summary.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return new Set([...latin, ...han]);
}

/**
 * Split pages that share sources into groups that also share a subject.
 *
 * Single-link grouping: a page joins the first cluster whose representative it
 * resembles. That keeps "how state flows" and "what state holds" apart even
 * though both come from the same note, while still catching a chain of
 * reworded titles.
 */
/**
 * Whether one page restates another.
 *
 * Two gates, and a pair has to clear one of them. Titles carry the subject
 * directly; summaries are the fallback for pages that were renamed between
 * compiles. The floor check keeps the fallback honest — if the titles barely
 * overlap at all, the two are about different things and a shared summary is
 * the compiler having reused boilerplate, not a duplicate.
 *
 * The summary bar is high on purpose. Two pages compiled from one long note
 * score around 0.5 on a shared summary simply by both describing that note,
 * while a genuine reworded duplicate scores 1.0 — the compiler wrote the same
 * sentence twice. Anything below "nearly identical" is not evidence.
 */
function isRestatement(left: LlmWikiPageRecord, right: LlmWikiPageRecord): boolean {
  const containment = titleContainment(left, right);
  if (containment >= TITLE_TOKEN_THRESHOLD) {
    return true;
  }
  return containment >= TITLE_DIVERGENCE_FLOOR && summariesAgree(left, right);
}

function clusterBySubject(pages: LlmWikiPageRecord[]): LlmWikiPageRecord[][] {
  const clusters: LlmWikiPageRecord[][] = [];
  for (const page of pages) {
    const target = clusters.find((cluster) => isRestatement(cluster[0]!, page));
    if (target) {
      target.push(page);
    } else {
      clusters.push([page]);
    }
  }
  return clusters;
}

function titleTokens(page: LlmWikiPageRecord): Set<string> {
  const base = pageName(page.path);
  const latin = base.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  // Han characters carry no spaces, so each one counts as its own token.
  const han = base.match(/[\u4e00-\u9fff]/g) ?? [];
  return new Set([...latin, ...han]);
}

function isTopicIndexPath(topic: LlmWikiTopicRecord, path: string): boolean {
  return normalizePath(path) === normalizePath(topic.indexPath);
}

function isWikiPagePath(path: string): boolean {
  return path.endsWith(".md") && path.includes("LLM Wiki/");
}

function isWikiSystemPath(path: string): boolean {
  return path.includes("LLM Wiki/_system/");
}

/**
 * The two hand-maintained front doors.
 *
 * They are written outside the compile flow and are not registered as pages, so
 * counting them as orphans would report a problem on a healthy library.
 */
function isEntryPagePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "知识体系/Agent/LLM Wiki/index.md" || normalized.endsWith("/知识库地图.md");
}

function pageName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
