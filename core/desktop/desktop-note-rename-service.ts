import { buildNoteDigests } from "../indexing/note-survey";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import {
  buildLinkMapping,
  buildRenameProposals,
  renderRenamePlanMarkdown,
  renameNoteContent,
  rewriteNoteLinks,
  type NoteRenamePlan
} from "../notes/note-maintenance";
import { backupMarkdownNotes } from "../notes/vault-backup";
import type { PolicyEngine } from "../policy/policy-engine";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export interface DesktopNoteRenamePlan {
  targetPath: string;
  content: string;
  /** Notes whose filename is a question and whose new name is free. */
  count: number;
  /** Notes that would collide with an existing name; usually duplicates. */
  blocked: number;
  /** Notes the rule could not name cleanly; left for a human or the model. */
  needsDecision: number;
  scanned: number;
}

export interface DesktopRenameApplyResult {
  backupPath: string;
  backupFileCount: number;
  /** New paths, in the order they were applied. */
  renamed: string[];
  /** Notes whose incoming links were rewritten. */
  linksRewritten: string[];
  failures: Array<{ path: string; error: string }>;
}

/** Applied in small batches so a failure leaves a known, reportable state. */
const RENAME_BATCH_SIZE = 10;

/**
 * Renames notes that were named after a question.
 *
 * Two steps on purpose: `plan()` only reads and drafts a list, `apply()`
 * writes. A rename also rewrites other notes' links and deletes the old file,
 * so it is never part of an automatic pass — it runs only on an explicit
 * command, after a backup, and stops at the first failure.
 */
export class DesktopNoteRenameService {
  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly rootDirectory: string
  ) {}

  async plan(targetPath: string): Promise<DesktopNoteRenamePlan> {
    const { plan, digests } = this.buildPlan();
    return {
      targetPath,
      content: renderRenamePlanMarkdown({ plan, generatedAt: new Date().toISOString() }),
      count: plan.proposals.length,
      blocked: plan.blocked.length,
      needsDecision: plan.needsDecision.length,
      scanned: digests.length
    };
  }

  async apply(): Promise<DesktopRenameApplyResult> {
    const { plan } = this.buildPlan();
    if (!plan.proposals.length) {
      throw new Error("没有可执行的改名建议：先说「整理笔记命名」生成清单。");
    }
    const backup = await backupMarkdownNotes(this.rootDirectory);
    const renamed: string[] = [];
    const failures: Array<{ path: string; error: string }> = [];
    const mapping = buildLinkMapping(plan.proposals);

    for (let start = 0; start < plan.proposals.length; start += RENAME_BATCH_SIZE) {
      const batch = plan.proposals.slice(start, start + RENAME_BATCH_SIZE);
      for (const proposal of batch) {
        try {
          const content = await this.repository.readText(proposal.from);
          // Links inside the note itself are rewritten too: a note can point
          // at another note that is about to be renamed in the same pass.
          await this.repository.createText(
            proposal.to,
            renameNoteContent(rewriteNoteLinks(content, mapping), {
              fromTitle: proposal.fromTitle,
              toTitle: proposal.toTitle
            })
          );
          await this.repository.deleteText(proposal.from);
          renamed.push(proposal.to);
        } catch (error) {
          // Stop rather than continue: the remaining notes still point at the
          // old names, and a partial rename is easier to reason about when it
          // stops where it failed.
          failures.push({ path: proposal.from, error: describeError(error) });
          return {
            backupPath: backup.path,
            backupFileCount: backup.fileCount,
            renamed,
            linksRewritten: [],
            failures
          };
        }
      }
    }

    return {
      backupPath: backup.path,
      backupFileCount: backup.fileCount,
      renamed,
      linksRewritten: await this.rewriteLinks(renamed, mapping),
      failures
    };
  }

  /**
   * Points every `[[link]]` at the new names.
   *
   * Every note is scanned rather than only the links the index reported: most
   * references in this vault live in frontmatter `sources:`, which the index
   * does not index as links. A rename that leaves those dangling is worse than
   * the rename is worth.
   */
  private async rewriteLinks(renamedPaths: readonly string[], mapping: ReadonlyMap<string, string>): Promise<string[]> {
    const alreadyRewritten = new Set(renamedPaths);
    const rewritten: string[] = [];
    const files = await this.repository.listMarkdownFiles();

    for (const file of files) {
      if (alreadyRewritten.has(file.path)) {
        continue;
      }
      if (!this.policy.decide({ action: "modifyExistingNote", targetPath: file.path }).allowed) {
        continue;
      }
      const before = await this.repository.readText(file.path);
      const after = rewriteNoteLinks(before, mapping);
      if (after === before) {
        continue;
      }
      await this.repository.writeText(file.path, after);
      rewritten.push(file.path);
    }
    return rewritten;
  }

  private buildPlan(): { plan: NoteRenamePlan; digests: ReturnType<typeof buildNoteDigests> } {
    // Notes only: the index also holds web and attachment chunks whose "path"
    // is a URL or a page title, and those have no filename to fix.
    const digests = buildNoteDigests(this.index.getAllChunks()).filter(
      (digest) =>
        digest.path.endsWith(".md") &&
        !digest.path.includes("://") &&
        !digest.path.startsWith("知识体系/") &&
        !digest.path.includes("/Sessions/")
    );
    return {
      plan: buildRenameProposals(digests, {
        existingPaths: new Set(digests.map((digest) => digest.path))
      }),
      digests
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
