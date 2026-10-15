import type { NoteDigest } from "../indexing/note-survey";
import {
  MAX_NOTE_TITLE_LENGTH,
  normalizeQuestionToStem,
  resolveFallbackNoteTopic,
  type NoteTopicResolution
} from "./note-naming";

/**
 * Tidy-up for notes created before notes were named by subject.
 *
 * Those files carry the whole question as their name ("后端中redis是什么,起
 * 什么作用.md"), so the vault fills up with sentences and the same subject
 * lands in several files. This pass only *proposes*: renaming touches other
 * notes' links, so the plan is rendered for review instead of applied.
 */
export interface NoteRenameProposal {
  from: string;
  to: string;
  fromTitle: string;
  toTitle: string;
  reason: string;
  /** Notes whose `[[links]]` point at the old name and would need rewriting. */
  linkSites: string[];
}

export interface RenamePlanOptions {
  /** Every path already in the vault, used to refuse collisions. */
  existingPaths: ReadonlySet<string>;
}

export interface NoteRenamePlan {
  proposals: NoteRenameProposal[];
  /** Notes whose name is a question but whose target name is already taken. */
  blocked: Array<{ path: string; toTitle: string }>;
  /** Notes the rule could not name cleanly; left for a human or the model. */
  needsDecision: Array<{ path: string; fromTitle: string; toTitle: string; reason: string }>;
  scanned: number;
}

const MAX_LINK_SITES = 12;

/**
 * Marks a filename as a question.
 *
 * Wider than the check applied to model-suggested titles: real filenames in an
 * existing vault put the question word anywhere ("429是什么问题",
 * "后端中redis是什么,起什么作用"), so an end-of-string test misses most of them.
 */
const QUESTION_MARKER =
  /(?:是什么|什么是|为什么|为何|怎么|怎样|如何|是啥|干嘛|什么叫|有什么|？|\?|吗|有哪些|哪些地方|有什么区别|有什么不同|有什么影响)/u;

export function isQuestionNamed(value: string): boolean {
  return QUESTION_MARKER.test(value);
}

/** Particles a truncated stem is left dangling on: "编程中hook是", "…进程分别". */
const DANGLING_TAIL = /(?:是|的|了|都|分别|有|和|与|以及|具体|及|或|在|对|把|被)$/u;
/** "A 与 B 的区别" is a title, not a sentence, so it gets more room. */
const COMPARISON_TITLE = /(?:的区别|的差异|的差别|的不同)$/u;
const MAX_COMPARISON_TITLE_LENGTH = 32;
/** "了" marks a clause, not a subject: "Redis 事件流设置了 TTL". */
const NARRATIVE_MARKER = /了/u;

/**
 * Why a rule-derived stem is not offered as a rename.
 *
 * Renaming is a bulk, link-rewriting operation, so a clipped or still-
 * interrogative name is worse than no rename: those notes are listed for a
 * human or a model call instead.
 */
function rejectionReason(toTitle: string): string | null {
  if (isQuestionNamed(toTitle)) {
    return "规则去掉问句后仍是问句，需要模型或人工取名";
  }
  if (DANGLING_TAIL.test(toTitle)) {
    return `规则给出的名字收尾不完整（${toTitle}）`;
  }
  if (NARRATIVE_MARKER.test(toTitle)) {
    return `规则给出的名字仍是一句话（${toTitle}）`;
  }
  const limit = COMPARISON_TITLE.test(toTitle) ? MAX_COMPARISON_TITLE_LENGTH : MAX_NOTE_TITLE_LENGTH;
  if (toTitle.length > limit) {
    return "规则给出的名字过长，需要模型或人工概括";
  }
  return null;
}

/**
 * Subject-style name for a capture whose subject is still the raw question.
 *
 * The manual "存入 Inbox / 追加到 Daily" buttons hand whatever the user typed
 * straight to the writer, while the routed path had already been naming notes
 * after their subject — so the same subject landed in two files, one named
 * "什么是分布式系统" and one "分布式系统".
 *
 * Returns null when the rules cannot produce a clean name; the caller then
 * keeps the original wording, because a mangled filename is worse than a
 * long one.
 */
export function subjectNameForQuestion(question: string): NoteTopicResolution | null {
  const trimmed = question.trim();
  if (!trimmed || !isQuestionNamed(trimmed)) {
    return null;
  }
  const resolution = resolveFallbackNoteTopic(trimmed);
  if (!resolution.title || resolution.title === trimmed || rejectionReason(resolution.title)) {
    return null;
  }
  return resolution;
}

export function titleFromNotePath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/iu, "").trim();
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/**
 * Proposes a subject-style name for every question-named note.
 *
 * Only the filename is judged — a note whose body is fine keeps its body. A
 * proposed name that already exists is reported rather than applied, because
 * silently picking a "2" suffix is how a vault gets two notes about one thing.
 */
export function buildRenameProposals(
  digests: readonly NoteDigest[],
  options: RenamePlanOptions
): NoteRenamePlan {
  const proposals: NoteRenameProposal[] = [];
  const blocked: Array<{ path: string; toTitle: string }> = [];
  const needsDecision: NoteRenamePlan["needsDecision"] = [];
  const targets = new Set(options.existingPaths);

  for (const digest of digests) {
    const fromTitle = titleFromNotePath(digest.path);
    if (!fromTitle || !isQuestionNamed(fromTitle)) {
      continue;
    }
    const toTitle = normalizeQuestionToStem(fromTitle);
    if (!toTitle || toTitle === fromTitle) {
      continue;
    }
    const rejected = rejectionReason(toTitle);
    if (rejected) {
      needsDecision.push({ path: digest.path, fromTitle, toTitle, reason: rejected });
      continue;
    }
    const directory = directoryOf(digest.path);
    const to = `${directory ? `${directory}/` : ""}${toTitle}.md`;
    if (targets.has(to)) {
      blocked.push({ path: digest.path, toTitle });
      continue;
    }
    // Reserve it too: two question notes can normalise to the same subject.
    targets.add(to);
    proposals.push({
      from: digest.path,
      to,
      fromTitle,
      toTitle,
      reason: "文件名是问句，已改为主题式命名",
      linkSites: findLinkSites(digests, fromTitle, digest.path)
    });
  }

  return { proposals, blocked, needsDecision, scanned: digests.length };
}

/**
 * Notes that link to the old name.
 *
 * Wikilinks are stored resolved from the index, so no file is re-read here;
 * a link matches either the bare filename or the path.
 */
function findLinkSites(
  digests: readonly NoteDigest[],
  fromTitle: string,
  fromPath: string
): string[] {
  const sites: string[] = [];
  for (const digest of digests) {
    if (digest.path === fromPath) {
      continue;
    }
    const hit = digest.links.some((link) => {
      const target = link.split("#")[0]?.trim();
      if (!target) {
        return false;
      }
      return target === fromTitle || target.endsWith(`/${fromTitle}`) || target === fromPath;
    });
    if (hit) {
      sites.push(digest.path);
    }
    if (sites.length >= MAX_LINK_SITES) {
      break;
    }
  }
  return sites;
}

export interface RenamePlanReportInput {
  plan: NoteRenamePlan;
  generatedAt: string;
}

/** Rendered as a note: the user reads the plan before anything is renamed. */
export function renderRenamePlanMarkdown(input: RenamePlanReportInput): string {
  const { plan, generatedAt } = input;
  const lines = [
    "---",
    "title: 笔记命名整理建议",
    "tags: [维护]",
    `generatedAt: ${generatedAt}`,
    "---",
    "",
    "# 笔记命名整理建议",
    "",
    `扫描了 ${plan.scanned} 篇笔记，其中 ${plan.proposals.length} 篇的文件名是问句且规则能给出干净的主题名，建议改名；${plan.needsDecision.length} 篇需要模型或人工取名，${plan.blocked.length} 篇目标名已被占用。`,
    "",
    "这是**建议清单，尚未执行**。确认后才会改名并同步修复指向它们的双链；原问法会写进笔记的 `aliases`，检索不受影响。",
    ""
  ];

  if (!plan.proposals.length) {
    lines.push("没有需要改名的笔记。", "");
  } else {
    lines.push("| 当前文件名 | 建议文件名 | 理由 | 需修链接 |", "| --- | --- | --- | --- |");
    for (const proposal of plan.proposals) {
      const links = proposal.linkSites.length
        ? proposal.linkSites.map((site) => `[[${site}]]`).join("、")
        : "—";
      lines.push(`| [[${proposal.from}]] | ${proposal.toTitle} | ${proposal.reason} | ${links} |`);
    }
    lines.push("");
  }

  if (plan.needsDecision.length) {
    lines.push(
      "## 需要模型或人工取名",
      "",
      "规则去掉问句后名字仍然别扭，不自动改名：",
      "",
      "| 当前文件名 | 规则结果 | 原因 |",
      "| --- | --- | --- |"
    );
    for (const entry of plan.needsDecision) {
      lines.push(`| [[${entry.path}]] | ${entry.toTitle} | ${entry.reason} |`);
    }
    lines.push("");
  }

  if (plan.blocked.length) {
    lines.push("## 已被占用，需人工决定", "", "| 当前文件名 | 建议文件名 | 说明 |", "| --- | --- | --- |");
    for (const entry of plan.blocked) {
      lines.push(
        `| [[${entry.path}]] | ${entry.toTitle} | 同名笔记已存在，可能需要合并而不是改名 |`
      );
    }
    lines.push("");
  }

  lines.push(
    "## 执行方式",
    "",
    "1. 逐条确认上表：改名会同时改写其他笔记里的 `[[双链]]`。",
    "2. 标记为「已被占用」的通常是重复笔记，建议把两篇内容合并到一篇再删除另一篇。",
    "3. 确认后再让 Agent 执行改名；执行前会自动备份知识库目录。"
  );
  return lines.join("\n");
}

export interface RenameContentInput {
  fromTitle: string;
  toTitle: string;
}

/**
 * Renames a note's content to match its new filename.
 *
 * The old question is kept in `aliases` — the whole point of renaming is that
 * the subject becomes the name, not that the original wording stops being
 * findable. The H1 is rewritten too, because in this vault the H1 *is* the
 * title; frontmatter is added when the note has none.
 */
export function renameNoteContent(content: string, input: RenameContentInput): string {
  const { fromTitle, toTitle } = input;
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/u.exec(content);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const lines = withAlias(
    frontmatter ? frontmatter[1]!.split("\n") : [],
    fromTitle
  );

  return ["---", ...lines, "---", "", rewriteHeading(body, fromTitle, toTitle).replace(/^\n+/u, "")].join("\n");
}

/** Adds the old name to `aliases`, creating the block when it is missing. */
function withAlias(lines: string[], alias: string): string[] {
  if (!alias.trim() || lines.some((line) => line.trim() === `  - "${escapeYaml(alias)}"`)) {
    return lines;
  }
  const start = lines.findIndex((line) => /^aliases:/u.test(line));
  if (start < 0) {
    return [...lines, "aliases:", `  - "${escapeYaml(alias)}"`];
  }
  let end = start + 1;
  while (end < lines.length && /^\s+/u.test(lines[end]!)) {
    end += 1;
  }
  return [...lines.slice(0, end), `  - "${escapeYaml(alias)}"`, ...lines.slice(end)];
}

function rewriteHeading(body: string, fromTitle: string, toTitle: string): string {
  const escaped = fromTitle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(`^#[ \\t]+${escaped}[ \\t]*$`, "mu");
  return heading.test(body) ? body.replace(heading, `# ${toTitle}`) : body;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

/**
 * Link targets that change when these proposals are applied.
 *
 * A wikilink can name a note by title or by path, with or without `.md`, and
 * this vault stores source references as `[[daily/原名.md]] · locator` — so
 * all four spellings have to be mapped or the rewrite silently misses them.
 */
export function buildLinkMapping(proposals: readonly NoteRenameProposal[]): Map<string, string> {
  const mapping = new Map<string, string>();
  const withoutExtension = (path: string): string => path.replace(/\.md$/iu, "");
  for (const proposal of proposals) {
    mapping.set(proposal.fromTitle, proposal.toTitle);
    mapping.set(`${proposal.fromTitle}.md`, `${proposal.toTitle}.md`);
    mapping.set(proposal.from, proposal.to);
    mapping.set(withoutExtension(proposal.from), withoutExtension(proposal.to));
  }
  return mapping;
}

/**
 * Rewrites wikilinks that point at renamed notes.
 *
 * Handles `[[目标]]`, `[[目标|显示]]` and `[[目标#小节]]`; anything else is
 * left untouched, because a wrong rewrite is worse than a stale link.
 */
export function rewriteNoteLinks(
  content: string,
  mapping: ReadonlyMap<string, string>
): string {
  if (!mapping.size) {
    return content;
  }
  return content.replace(/\[\[([^\]]+)\]\]/gu, (match, raw: string) => {
    const target = raw.split("|")[0]?.trim() ?? "";
    if (!target) {
      return match;
    }
    const [stem, anchor] = splitAnchor(target);
    const replacement = mapping.get(stem) ?? mapping.get(target);
    if (!replacement) {
      return match;
    }
    const suffix = raw.slice(target.length);
    return `[[${replacement}${anchor ? `#${anchor}` : ""}${suffix}]]`;
  });
}

function splitAnchor(target: string): [string, string] {
  const index = target.indexOf("#");
  return index < 0 ? [target, ""] : [target.slice(0, index), target.slice(index + 1)];
}
