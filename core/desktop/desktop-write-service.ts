import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import {
  buildActionTargetPath,
  createKnowledgeSystemProposal,
  createManualCaptureProposal,
  createSourcedCaptureProposal,
  renderCreatedInboxNote,
  renderCreatedKnowledgeSystemNote,
  renderDailyAppend,
  renderNoteSection,
  sanitizeFileStem,
  validateActionProposal,
  type AgentActionProposal,
  type CreateKnowledgeSystemNoteProposal,
  type ManualCaptureAction
} from "../actions/action-proposal";
import { PolicyEngine, TRASH_FOLDER, normalizeVaultPath } from "../policy/policy-engine";
import type { DesktopAgentSource } from "./desktop-agent-service";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";
import { subjectNameForQuestion } from "../notes/note-maintenance";
import {
  buildDeletePreview,
  contentFingerprint,
  renderTrashManifest,
  type DeleteNotePreview
} from "./desktop-delete-service";
import type { PortableMarkdownKnowledgeIndex } from "../indexing/portable-markdown-knowledge-index";

export type DesktopCaptureAction = Extract<ManualCaptureAction, "createInboxNote" | "appendDailyNote">;

/** Every write the desktop shell can perform after an explicit preview. */
export type DesktopWriteAction = DesktopCaptureAction | "createKnowledgeSystemNote" | "modifyExistingNote";

export interface DesktopWritePreview {
  action: DesktopWriteAction;
  targetPath: string;
  existedBefore: boolean;
  beforeContent: string;
  afterContent: string;
}

export interface DesktopWriteResult {
  targetPath: string;
  created: boolean;
}

/** Outcome of a confirmed deletion, with everything needed to undo it. */
export interface DesktopDeleteResult {
  targetPath: string;
  trashPath: string;
  manifestPath: string;
  deletedAt: string;
}

export interface DesktopAnswerPreviewOptions {
  /**
   * Treat a file already sitting at the target path as a name collision.
   *
   * Set when the routing step decided this answer is a *new* note: the name
   * matches an existing note but the content is not about the same thing, so
   * appending would silently bury a different subject inside it.
   */
  disambiguateOnCollision?: boolean;
}

/** One answer appended to an existing note. */
export interface DesktopNoteSection {
  heading?: string;
  question?: string;
  content: string;
  sources: DesktopAgentSource[];
}

/** The desktop counterpart of VaultActionService for answer capture. */
export class DesktopWriteService {
  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly policy: PolicyEngine,
    // Captured answers land in the Daily folder, not in a separate Inbox.
    // Inbox used to be "00 Inbox/Agent" — the same path as the agent's own
    // memory, so captured notes became invisible: excluded from the index and
    // filtered out of the note list. One folder, one place to look.
    private readonly inboxFolder = "daily",
    private readonly dailyFolder = "daily",
    private readonly knowledgeSystemFolder = "知识体系/Agent",
    // Optional: only used to report which notes point at the one being deleted.
    private readonly index?: PortableMarkdownKnowledgeIndex
  ) {}

  async previewAnswer(
    action: DesktopCaptureAction,
    subject: string,
    content: string,
    sources: DesktopAgentSource[],
    topic?: string,
    aliases?: string[],
    options: DesktopAnswerPreviewOptions = {}
  ): Promise<DesktopWritePreview> {
    // The routed path hands this a title ("分布式系统") and the manual buttons
    // hand it the raw question ("什么是分布式系统"). Naming here rather than per
    // caller keeps the two paths from disagreeing about what a note is called.
    const named = subjectNameForQuestion(subject);
    const proposal = this.createProposal(
      action,
      named?.title ?? subject,
      content,
      sources,
      // The rule-derived "topic" is just a short form of the title, so it is
      // not passed on: it would disambiguate a collision as "分布式系统（分布式系统）"
      // and would only restate the title in the frontmatter.
      topic,
      mergeAliases(aliases, named?.aliases)
    );
    const requestedPath = buildActionTargetPath(proposal, this.inboxFolder, this.dailyFolder);
    // "appendDailyNote" is append by name, and that is right when the user
    // captures into an existing topic file on purpose. It is wrong when the
    // routing step decided this answer is a new note that happens to share a
    // name — that decision has to survive, or a different subject gets folded
    // into a note whose title no longer describes it.
    const targetPath =
      action === "createInboxNote" || options.disambiguateOnCollision
        ? await this.findAvailablePath(requestedPath, topic)
        : requestedPath;
    const decision = this.policy.decide({ action, targetPath });
    if (!decision.allowed) {
      throw new Error(`写入被权限策略拒绝：${decision.reason}`);
    }
    const existing = await this.repository.getMarkdownFile(targetPath);
    const beforeContent = existing ? await this.repository.readText(targetPath) : "";
    const afterContent = action === "createInboxNote"
      ? renderCreatedInboxNote(proposal as Extract<AgentActionProposal, { type: "createInboxNote" }>, new Date())
      : renderDailyAppend(proposal as Extract<AgentActionProposal, { type: "appendDailyNote" }>, beforeContent, new Date());
    return { action, targetPath, existedBefore: Boolean(existing), beforeContent, afterContent };
  }

  /**
   * Preview a knowledge-system note.
   *
   * Never overwrites an existing page: a numeric suffix is allocated instead,
   * which mirrors the plugin's controlled-write guarantee.
   */
  async previewKnowledgeSystemNote(
    topic: string,
    content: string,
    sources: SourceRef[],
    relativePath?: string
  ): Promise<DesktopWritePreview> {
    const proposal = createKnowledgeSystemProposal(topic, content, sources, relativePath);
    const errors = validateActionProposal(proposal);
    if (errors.length) {
      throw new Error(errors.join(" "));
    }
    const requestedPath = buildActionTargetPath(
      proposal,
      this.inboxFolder,
      this.dailyFolder,
      this.knowledgeSystemFolder
    );
    const targetPath = await this.findAvailablePath(requestedPath);
    return this.preparePreview("createKnowledgeSystemNote", targetPath, () =>
      renderCreatedKnowledgeSystemNote(proposal as CreateKnowledgeSystemNoteProposal, new Date())
    );
  }

  /**
   * Preview a write to an explicit path.
   *
   * Used by multi-page compilations such as the LLM Wiki, where the same page
   * is intentionally overwritten on recompilation instead of getting a suffix.
   */
  async previewPath(
    targetPath: string,
    content: string,
    action: DesktopWriteAction = "createKnowledgeSystemNote"
  ): Promise<DesktopWritePreview> {
    const normalized = normalizeVaultPath(targetPath);
    if (!normalized) {
      throw new Error("写入目标不是有效的知识库相对路径。");
    }
    return this.preparePreview(action, normalized, () => content);
  }

  /**
   * Preview adding one answer as a new section of an existing note.
   *
   * The note must already exist: an append is a deliberate choice to grow a
   * note, and silently creating a file at a routed path would hide that choice.
   */
  async previewNoteAppend(
    notePath: string,
    section: DesktopNoteSection
  ): Promise<DesktopWritePreview> {
    const targetPath = normalizeVaultPath(notePath);
    if (!targetPath) {
      throw new Error("要追加的笔记目标不是有效的知识库相对路径。");
    }
    const decision = this.policy.decide({ action: "modifyExistingNote", targetPath });
    if (!decision.allowed) {
      throw new Error(`写入被权限策略拒绝：${decision.reason}`);
    }
    const existing = await this.repository.getMarkdownFile(targetPath);
    if (!existing) {
      throw new Error("要追加的笔记不存在，请改为新建笔记。");
    }
    const beforeContent = await this.repository.readText(targetPath);
    return {
      action: "modifyExistingNote",
      targetPath,
      existedBefore: true,
      beforeContent,
      afterContent: renderNoteSection({
        heading: section.heading,
        question: section.question,
        content: section.content,
        sources: section.sources.map(toSourceRef),
        createdAt: new Date()
      }, beforeContent)
    };
  }

  /** Preview an in-place edit of an existing note. */
  async previewExistingNote(notePath: string, afterContent: string): Promise<DesktopWritePreview> {
    const targetPath = normalizeVaultPath(notePath);
    if (!targetPath) {
      throw new Error("既有笔记目标不是有效的知识库相对路径。");
    }
    return this.preparePreview("modifyExistingNote", targetPath, () => afterContent);
  }

  private async preparePreview(
    action: DesktopWriteAction,
    targetPath: string,
    render: () => string
  ): Promise<DesktopWritePreview> {
    const decision = this.policy.decide({ action, targetPath });
    if (!decision.allowed) {
      throw new Error(`写入被权限策略拒绝：${decision.reason}`);
    }
    const existing = await this.repository.getMarkdownFile(targetPath);
    const beforeContent = existing ? await this.repository.readText(targetPath) : "";
    return {
      action,
      targetPath,
      existedBefore: Boolean(existing),
      beforeContent,
      afterContent: render()
    };
  }

  async apply(preview: DesktopWritePreview): Promise<DesktopWriteResult> {
    const decision = this.policy.decide({ action: preview.action, targetPath: preview.targetPath });
    if (!decision.allowed) {
      throw new Error(`写入被权限策略拒绝：${decision.reason}`);
    }
    const existing = await this.repository.getMarkdownFile(preview.targetPath);
    const currentContent = existing ? await this.repository.readText(preview.targetPath) : "";
    if (currentContent !== preview.beforeContent) {
      throw new Error("目标笔记在预览后已被修改，请重新生成写入预览。");
    }
    if (preview.action === "createInboxNote") {
      if (existing) {
        throw new Error("Inbox 目标已存在，请重新生成写入预览。");
      }
      await this.repository.createText(preview.targetPath, preview.afterContent);
      return { targetPath: preview.targetPath, created: true };
    }
    if (existing) {
      await this.repository.writeText(preview.targetPath, preview.afterContent);
    } else {
      await this.repository.createText(preview.targetPath, preview.afterContent);
    }
    return { targetPath: preview.targetPath, created: !existing };
  }

  /**
   * Preview removing a note.
   *
   * Nothing is removed here. The preview carries the note's content hash so
   * {@link applyDelete} can refuse a confirmation for a note that changed in
   * between — without that, a user could confirm a deletion of one version and
   * lose an edit they had just made.
   *
   * Inbound links are collected because a note others point at is exactly the
   * one a user is unlikely to have meant to remove.
   */
  async previewDelete(input: {
    targetPath: string;
    reason?: string;
    inboundLinks?: readonly string[];
  }): Promise<DeleteNotePreview> {
    const targetPath = normalizeVaultPath(input.targetPath);
    if (!targetPath) {
      throw new Error("要删除的笔记路径不是有效的知识库相对路径。 ");
    }
    const decision = this.policy.decide({ action: "deleteNote", targetPath });
    if (!decision.allowed) {
      throw new Error(`删除被权限策略拒绝：${decision.reason}`);
    }
    const existing = await this.repository.getMarkdownFile(targetPath);
    if (!existing) {
      throw new Error(`要删除的笔记不存在：${targetPath}`);
    }
    const content = await this.repository.readText(targetPath);
    return buildDeletePreview({
      targetPath,
      content,
      takenTrashPaths: await this.takenTrashPaths(),
      reason: input.reason ?? "",
      inboundLinks: input.inboundLinks ?? (await this.findInboundLinks(targetPath))
    });
  }

  /**
   * Carry out a confirmed deletion by moving the note into the trash.
   *
   * Copy-then-delete rather than a bare `rm`, so the content is already
   * durable in its new home before the original disappears.
   */
  async applyDelete(preview: DeleteNotePreview): Promise<DesktopDeleteResult> {
    const decision = this.policy.decide({ action: "deleteNote", targetPath: preview.targetPath });
    if (!decision.allowed) {
      throw new Error(`删除被权限策略拒绝：${decision.reason}`);
    }
    const existing = await this.repository.getMarkdownFile(preview.targetPath);
    if (!existing) {
      throw new Error("笔记已不存在，可能已被其他操作删除。 ");
    }
    const current = await this.repository.readText(preview.targetPath);
    if (contentFingerprint(current) !== preview.contentHash) {
      throw new Error("笔记在预览之后被修改过，请重新确认删除。 ");
    }
    const deletedAt = new Date();
    await this.repository.createText(preview.trashPath, current);
    await this.repository.createText(
      `${preview.trashPath}.trash.md`,
      renderTrashManifest(preview, deletedAt)
    );
    await this.repository.deleteText(preview.targetPath);
    return {
      targetPath: preview.targetPath,
      trashPath: preview.trashPath,
      manifestPath: `${preview.trashPath}.trash.md`,
      deletedAt: deletedAt.toISOString()
    };
  }

  /** Restore a note from the trash, used by the "撤销" affordance. */
  async restoreFromTrash(manifestPath: string): Promise<{ targetPath: string }> {
    const normalized = normalizeVaultPath(manifestPath);
    if (!normalized || !normalized.startsWith(`${TRASH_FOLDER}/`) || !normalized.endsWith(".trash.md")) {
      throw new Error("不是有效的回收站记录。 ");
    }
    const manifest = await this.repository.readText(manifestPath);
    const originalPath = /^original-path:\s*"?([^"\n]+)"?\s*$/mu.exec(manifest)?.[1]?.trim();
    if (!originalPath) {
      throw new Error("回收站记录里找不到原始路径。 ");
    }
    if (await this.repository.getMarkdownFile(originalPath)) {
      throw new Error("原位置已经有同名笔记，请先处理冲突。 ");
    }
    const notePath = normalized.slice(0, -".trash.md".length);
    await this.repository.createText(originalPath, await this.repository.readText(notePath));
    await this.repository.deleteText(notePath);
    await this.repository.deleteText(normalized);
    return { targetPath: originalPath };
  }

  /** Exact-path existence check, so a delete request can name a file directly. */
  async noteExists(targetPath: string): Promise<boolean> {
    const normalized = normalizeVaultPath(targetPath);
    return normalized ? Boolean(await this.repository.getMarkdownFile(normalized)) : false;
  }

  /**
   * Notes whose file name matches a spoken name.
   *
   * Only the file stem is compared, and only when the request itself is not
   * already a path. Matching is exact after trimming rather than fuzzy: for a
   * destructive action, "close enough" is how the wrong note gets deleted. The
   * caller is expected to refuse when this returns more than one path.
   */
  async findNotesByName(name: string): Promise<string[]> {
    const wanted = name
      .trim()
      .replace(/\.md$/i, "")
      .replace(/[《》"'`]/g, "")
      .toLocaleLowerCase();
    if (!wanted) {
      return [];
    }
    const files = await this.repository.listMarkdownFiles();
    return files
      .map((file) => file.path)
      .filter((path) => {
        if (path.startsWith(`${TRASH_FOLDER}/`)) {
          return false;
        }
        const stem = path.replace(/\.md$/i, "").split("/").pop() ?? "";
        return stem.toLocaleLowerCase() === wanted;
      });
  }

  private async takenTrashPaths(): Promise<Set<string>> {
    const taken = new Set<string>();
    for (const file of await this.repository.listMarkdownFiles()) {
      if (file.path.startsWith(`${TRASH_FOLDER}/`)) {
        taken.add(file.path);
        taken.add(file.path.replace(/\.trash\.md$/, ""));
      }
    }
    return taken;
  }

  /**
   * Which indexed notes mention this one.
   *
   * Read from the index rather than the filesystem because the search index
   * already parsed every note; a full-text sweep here would re-read the vault
   * on every confirmation card.
   *
   * All three spellings of a wikilink count, because notes in this vault use
   * all of them: `[[daily/B树]]`, `[[daily/B树.md]]` and `[[B树]]`.
   */
  private async findInboundLinks(targetPath: string): Promise<string[]> {
    const withoutExtension = targetPath.replace(/\.md$/i, "");
    const fileName = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
    const chunks = this.index?.getAllChunks() ?? [];
    const referencing = new Set<string>();
    for (const chunk of chunks) {
      const source = chunk.source.pathOrUrl;
      if (source === targetPath || source.startsWith(`${TRASH_FOLDER}/`)) {
        continue;
      }
      if (
        chunk.content.includes(`[[${withoutExtension}]]`) ||
        chunk.content.includes(`[[${targetPath}]]`) ||
        chunk.content.includes(`[[${fileName}]]`) ||
        chunk.content.includes(`[[${fileName}.md]]`)
      ) {
        referencing.add(source);
      }
    }
    return [...referencing].slice(0, 20);
  }

  private createProposal(
    action: DesktopCaptureAction,
    subject: string,
    content: string,
    sources: DesktopAgentSource[],
    topic?: string,
    aliases?: string[]
  ): AgentActionProposal {
    const sourceRefs = sources.map(toSourceRef);
    return sourceRefs.length
      ? createSourcedCaptureProposal(action, subject, content, sourceRefs, topic, aliases)
      : createManualCaptureProposal(action, subject, content, topic, aliases);
  }

  /**
   * Finds a path that does not overwrite an existing note.
   *
   * A colliding name is disambiguated with the topic first — "BM25（检索排序）"
   * says which side of the subject this note covers, while "BM25-2" says
   * nothing. The numeric suffix is the last resort.
   */
  private async findAvailablePath(requestedPath: string, topic?: string): Promise<string> {
    if (!(await this.repository.getMarkdownFile(requestedPath))) {
      return requestedPath;
    }
    const extensionIndex = requestedPath.lastIndexOf(".");
    const stem = requestedPath.slice(0, extensionIndex);
    const extension = requestedPath.slice(extensionIndex);
    const qualifiedStem = topic?.trim() ? `${stem}（${sanitizeFileStem(topic)}）` : "";
    if (qualifiedStem && !(await this.repository.getMarkdownFile(`${qualifiedStem}${extension}`))) {
      return `${qualifiedStem}${extension}`;
    }
    const base = qualifiedStem || stem;
    for (let suffix = 2; suffix <= 9999; suffix += 1) {
      const candidate = `${base}-${suffix}${extension}`;
      if (!(await this.repository.getMarkdownFile(candidate))) {
        return candidate;
      }
    }
    throw new Error("无法为写入目标分配不冲突的文件名。");
  }
}

/**
 * Keeps the original question findable after the note was renamed to its
 * subject: search still hits the wording the user actually used.
 */
function mergeAliases(primary: readonly string[] | undefined, extra: readonly string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(primary ?? []), ...(extra ?? [])]
    .map((value) => value.trim())
    .filter(Boolean))];
  return merged.length ? merged : undefined;
}

function toSourceRef(source: DesktopAgentSource): SourceRef {
  const isWeb = /^https?:\/\//iu.test(source.path);
  return {
    type: isWeb ? "web" : "note",
    pathOrUrl: source.path,
    locator: source.heading ?? "检索片段",
    contentHash: hashText(source.excerpt),
    parserVersion: "desktop-answer-v1",
    retrievedAt: new Date().toISOString()
  };
}
