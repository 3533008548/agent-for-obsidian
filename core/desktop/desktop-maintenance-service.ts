import {
  createGardenerSources,
  type GardenerPlan
} from "../gardener/knowledge-gardener";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";
import {
  buildOverlapCandidates,
  PAIRS_PER_REQUEST,
  renderOverlapReportMarkdown,
  type NoteForOverlapScan,
  type OverlapScanReport,
  type OverlapVerdict
} from "../notes/duplicate-scan";
import type { PolicyEngine } from "../policy/policy-engine";
import { DeepSeekClient } from "../services/deepseek-client";
import { postJsonWithFetch } from "../services/fetch-api-request";

export interface DesktopMaintenanceConfiguration {
  deepSeekApiKey: string;
  deepSeekModel: string;
  requestTimeoutMs: number;
  memoryContext?: string;
}

export interface DesktopOverlapScan {
  targetPath: string;
  content: string;
  scanned: number;
  compared: number;
  actionable: number;
  merge: number;
  extract: number;
  link: number;
  conflict: number;
  /** Batches whose model call failed; the scan still reports the rest. */
  failedBatches: number;
}

const MAX_CANDIDATES = 24;

/**
 * Read-only knowledge-base inspection for the desktop shell.
 *
 * Only titles, paths and short excerpts reach the model, and only for notes
 * the policy allows to leave the device. It never writes anything.
 */
export class DesktopMaintenanceService {
  constructor(
    private readonly index: PortableMarkdownKnowledgeIndex,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopMaintenanceConfiguration
  ) {}

  async analyze(goal: string): Promise<GardenerPlan> {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      throw new Error("知识库维护目标不能为空。");
    }
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const permitted = this.index
      .search(normalizedGoal, MAX_CANDIDATES)
      .filter((result) => this.policy.decide({
        action: "sendToGlm",
        targetPath: result.chunk.source.pathOrUrl
      }).allowed);
    const sources = createGardenerSources(permitted);
    if (sources.length < 2) {
      throw new Error("没有找到足够且可外发的笔记来做维护分析。");
    }
    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });
    return client.planKnowledgeMaintenance(normalizedGoal, sources, this.configuration.memoryContext);
  }

  /**
   * Looks for notes that overlap and says what to do about each pair.
   *
   * Read-only: it returns a report for a write preview. Merging or extracting
   * rewrites notes the user wrote, so the scan never does it on its own.
   */
  async scanNoteOverlaps(
    targetPath: string,
    topics?: ReadonlyMap<string, string>
  ): Promise<DesktopOverlapScan> {
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    const notes = this.collectScanNotes();
    if (notes.length < 2) {
      throw new Error("可外发的笔记不足两篇，无法检查重复。");
    }
    const candidates = buildOverlapCandidates(notes, { ...(topics ? { topics } : {}) });
    if (!candidates.length) {
      return {
        targetPath,
        content: renderOverlapReportMarkdown(
          { verdicts: [], scanned: notes.length, compared: 0 },
          byPath(notes),
          new Date().toISOString()
        ),
        scanned: notes.length,
        compared: 0,
        actionable: 0,
        merge: 0,
        extract: 0,
        link: 0,
        conflict: 0,
        failedBatches: 0
      };
    }

    const client = new DeepSeekClient({
      apiKey: this.configuration.deepSeekApiKey,
      model: this.configuration.deepSeekModel,
      slowResponseMs: this.configuration.requestTimeoutMs,
      postJson: postJsonWithFetch
    });

    let failedBatches = 0;
    const verdicts: OverlapVerdict[] = [];
    for (let start = 0; start < candidates.length; start += PAIRS_PER_REQUEST) {
      const batch = candidates.slice(start, start + PAIRS_PER_REQUEST);
      try {
        verdicts.push(...(await client.analyzeNoteOverlaps(batch, byPath(notes))));
      } catch (error) {
        failedBatches += 1;
        console.error("[overlap-scan]", error);
      }
    }

    const report: OverlapScanReport = { verdicts, scanned: notes.length, compared: candidates.length };
    const count = (disposition: string) => verdicts.filter((verdict) => verdict.disposition === disposition).length;
    return {
      targetPath,
      content: renderOverlapReportMarkdown(report, byPath(notes), new Date().toISOString()),
      scanned: notes.length,
      compared: candidates.length,
      actionable: verdicts.length,
      merge: count("merge"),
      extract: count("extract"),
      link: count("link"),
      conflict: count("conflict"),
      failedBatches
    };
  }

  /** Local notes only: web and attachment chunks have no note to compare. */
  private collectScanNotes(): NoteForOverlapScan[] {
    const byPathMap = new Map<string, string[]>();
    for (const chunk of this.index.getAllChunks()) {
      const path = chunk.source.pathOrUrl;
      if (!path.endsWith(".md") || path.includes("://") || path.startsWith("知识体系/") || path.includes("/Sessions/")) {
        continue;
      }
      if (!this.policy.decide({ action: "sendToGlm", targetPath: path }).allowed) {
        continue;
      }
      const parts = byPathMap.get(path) ?? [];
      parts.push(chunk.content);
      byPathMap.set(path, parts);
    }
    return [...byPathMap].map(([path, parts]) => ({
      path,
      title: path.split("/").pop()?.replace(/\.md$/iu, "") ?? path,
      text: parts.join("\n")
    }));
  }
}

function byPath(notes: readonly NoteForOverlapScan[]): Map<string, NoteForOverlapScan> {
  return new Map(notes.map((note) => [note.path, note]));
}
