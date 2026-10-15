import type { LlmWikiRegistry } from "./llm-wiki-system";
import type { PlacementDecision } from "./topic-placement";
import { diffSource, type SourceChange } from "./source-change";

/**
 * What ingesting a note would do, decided before anything is written.
 *
 * The point of separating this from the compile step is that the two have very
 * different failure modes. A compile that goes wrong writes a page you then
 * delete; a placement that goes wrong quietly files a note where nobody will
 * look for it, and the next compile treats that filing as fact. So the plan is
 * the thing the user reads, and the compile only happens for a plan they
 * approved.
 */
export type IngestAction =
  /** Incrementally update these topics; the note belongs there. */
  | "update-topics"
  /** A new topic is needed, and this note is the proposal. */
  | "propose-topic"
  /** Evidence disagreed, or nothing matched; a person has to say where it goes. */
  | "needs-decision"
  /** The note is already compiled into every topic it belongs to. */
  | "already-covered";

export interface IngestPlanTopic {
  topicId: string;
  topic: string;
  /** Why this topic is a candidate, in the words of whichever evidence agreed. */
  because: string;
  /** Pages the compile is likely to touch, for the reader to sanity-check. */
  likelyPages: Array<{ path: string; title: string }>;
  /** Existing sources the compile would treat as context. */
  sourceCount: number;
  /** True when nothing in the topic has changed yet. */
  firstTime: boolean;
}

export interface IngestPlan {
  notePath: string;
  noteTitle: string;
  action: IngestAction;
  /** One paragraph for the user, saying what will happen and why. */
  summary: string;
  topics: IngestPlanTopic[];
  /** Set when the evidence disagreed; names both sides. */
  disagreement?: {
    modelSaid: string[];
    corpusSaid: string[];
    explanation: string;
  };
  /** Set when the plan would create a topic, and what the model called it. */
  proposedTopic?: { name: string; definition: string; why: string };
  /** Sources of every topic this note touches, so the cost is visible. */
  changes: SourceChange[];
  /** Estimated model work: how many topics would be recompiled. */
  compilesRequired: number;
}

export interface IngestPlanInput {
  notePath: string;
  noteTitle: string;
  decision: PlacementDecision;
  registry: LlmWikiRegistry;
  /** What the model proposed when a new topic looked necessary. */
  proposedTopic?: { name: string; definition: string; why: string };
  /** Current text of every source across the affected topics. */
  sourceTexts: Map<string, string | null>;
}

/**
 * Page-count ceiling for the "likely to touch" list.
 *
 * A report that lists forty pages is a report nobody reads, and the ones left off
 * are the ones that would have prompted a correction.
 */
const MAX_LISTED_PAGES = 6;

export function planIngest(input: IngestPlanInput): IngestPlan {
  const { decision, registry } = input;
  const byId = new Map(registry.topics.map((topic) => [topic.id, topic]));

  // "Already covered" is a distinct answer from "unchanged": the note may be
  // compiled in, yet its content may have moved on. Only a note whose blocks all
  // match every source record is genuinely done, so this compares rather than
  // asking whether the path was ever seen.
  const changes: SourceChange[] = [];
  for (const topicId of [...decision.agreed, ...decision.missed].map((option) => option.topicId)) {
    const topic = byId.get(topicId);
    for (const source of topic?.sourceHashes ?? []) {
      if (source.pathOrUrl !== input.notePath) {
        continue;
      }
      changes.push(diffSource({ recorded: source, currentText: input.sourceTexts.get(source.pathOrUrl) ?? null }));
    }
  }

  const buildTopic = (option: { topicId: string; topic: string }, because: string): IngestPlanTopic | null => {
    const topic = byId.get(option.topicId);
    if (!topic) {
      return null;
    }
    return {
      topicId: topic.id,
      topic: topic.topic,
      because,
      likelyPages: topic.pages
        .filter((page) => page.path !== topic.indexPath)
        .slice(0, MAX_LISTED_PAGES)
        .map((page) => ({ path: page.path, title: page.title })),
      sourceCount: topic.sourceHashes.length,
      firstTime: !topic.sourceHashes.some((source) => source.pathOrUrl === input.notePath)
    };
  };

  if (decision.verdict === "needs-new-topic") {
    const proposed = input.proposedTopic;
    return {
      notePath: input.notePath,
      noteTitle: input.noteTitle,
      action: proposed ? "propose-topic" : "needs-decision",
      summary: proposed
        ? `现有主题都没有覆盖这篇笔记。模型建议新建主题「${proposed.name}」：${proposed.why}`
        : "现有主题都没有覆盖这篇笔记，也没有找到合适的新主题建议。",
      topics: [],
      proposedTopic: proposed,
      changes,
      compilesRequired: proposed ? 1 : 0
    };
  }

  if (decision.verdict === "undecided") {
    return {
      notePath: input.notePath,
      noteTitle: input.noteTitle,
      action: "needs-decision",
      summary: `两种证据对这篇笔记的归属不一致，需要你决定。${decision.reason}`,
      topics: [],
      disagreement: {
        modelSaid: decision.modelProposes,
        corpusSaid: decision.corpusSupports.map((option) => option.topic),
        explanation: decision.reason
      },
      changes,
      compilesRequired: 0
    };
  }

  const agreedIds = new Set(decision.agreed.map((option) => option.topicId));
  const topics = [
    ...decision.agreed.map((option) => buildTopic(option, "模型与资料证据一致")),
    // The corpus found a fit the model missed. Including it is a proposal, not a
    // merge: the report says where the overlap came from so it can be rejected.
    ...decision.missed
      .filter((option) => !agreedIds.has(option.topicId))
      .map((option) =>
        buildTopic(
          option,
          `资料证据命中「${option.evidence.map((item) => item.term).join("、")}」，模型未提及`
        )
      )
  ].filter((topic): topic is IngestPlanTopic => topic !== null);

  // A topic needs a compile when the note is new to it, or when the copy of it
  // the topic recorded no longer matches what is on disk. `firstTime` alone
  // would call an edited note already-covered, which is exactly the case where
  // recompiling is the whole point.
  const topicNeedsWork = new Map<string, boolean>();
  for (const topic of topics) {
    const related = changes.filter((change) => change.pathOrUrl === input.notePath);
    const contentChanged = related.some((change) => change.kind !== "unchanged");
    topicNeedsWork.set(topic.topicId, topic.firstTime || contentChanged);
  }
  const nothingNew = topics.length > 0 && topics.every((topic) => !topicNeedsWork.get(topic.topicId));
  const action: IngestAction = nothingNew ? "already-covered" : "update-topics";

  return {
    notePath: input.notePath,
    noteTitle: input.noteTitle,
    action,
    summary:
      action === "already-covered"
        ? "这篇笔记已经收录在下列主题中，内容没有变化，不需要重新编译。"
        : `将增量更新 ${topics.length} 个主题：${topics.map((topic) => topic.topic).join("、")}。`,
    topics,
    changes,
    compilesRequired: action === "already-covered" ? 0 : topics.length
  };
}

/** A short table for the answer, so the reader can check the placement. */
export function renderIngestPlan(plan: IngestPlan): string {
  const lines: string[] = [`**收录计划：${plan.noteTitle}**`, "", plan.summary];

  if (plan.topics.length) {
    lines.push("");
    for (const topic of plan.topics) {
      const role = topic.firstTime ? "新增来源" : "更新已有来源";
      lines.push(`- ${topic.topic}（${role}，将带入 ${topic.sourceCount} 份资料）— ${topic.because}`);
    }
  }

  if (plan.proposedTopic) {
    lines.push(`- 建议新建主题「${plan.proposedTopic.name}」：${plan.proposedTopic.definition}`);
  }

  if (plan.disagreement) {
    lines.push("");
    lines.push(`- 模型认为：${plan.disagreement.modelSaid.join("、") || "未提出主题"}`);
    lines.push(`- 资料指向：${plan.disagreement.corpusSaid.join("、") || "没有主题提到这篇笔记的用词"}`);
  }

  if (plan.compilesRequired) {
    lines.push("");
    lines.push(`确认后会调用 ${plan.compilesRequired} 次模型编译，之后生成写入预览。`);
  } else {
    lines.push("");
    lines.push("这一步不需要调用模型。");
  }

  return lines.join("\n");
}
