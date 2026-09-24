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
  validateActionProposal,
  type AgentActionProposal,
  type CreateKnowledgeSystemNoteProposal,
  type ManualCaptureAction
} from "../actions/action-proposal";
import { PolicyEngine, normalizeVaultPath } from "../policy/policy-engine";
import type { DesktopAgentSource } from "./desktop-agent-service";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

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

/** The desktop counterpart of VaultActionService for answer capture. */
export class DesktopWriteService {
  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly policy: PolicyEngine,
    private readonly inboxFolder = "00 Inbox/Agent",
    private readonly dailyFolder = "daily",
    private readonly knowledgeSystemFolder = "知识体系/Agent"
  ) {}

  async previewAnswer(
    action: DesktopCaptureAction,
    subject: string,
    content: string,
    sources: DesktopAgentSource[]
  ): Promise<DesktopWritePreview> {
    const proposal = this.createProposal(action, subject, content, sources);
    const requestedPath = buildActionTargetPath(proposal, this.inboxFolder, this.dailyFolder);
    const targetPath = action === "createInboxNote"
      ? await this.findAvailablePath(requestedPath)
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

  private createProposal(
    action: DesktopCaptureAction,
    subject: string,
    content: string,
    sources: DesktopAgentSource[]
  ): AgentActionProposal {
    const sourceRefs = sources.map(toSourceRef);
    return sourceRefs.length
      ? createSourcedCaptureProposal(action, subject, content, sourceRefs)
      : createManualCaptureProposal(action, subject, content);
  }

  private async findAvailablePath(requestedPath: string): Promise<string> {
    if (!(await this.repository.getMarkdownFile(requestedPath))) {
      return requestedPath;
    }
    const extensionIndex = requestedPath.lastIndexOf(".");
    const stem = requestedPath.slice(0, extensionIndex);
    const extension = requestedPath.slice(extensionIndex);
    for (let suffix = 2; suffix <= 9999; suffix += 1) {
      const candidate = `${stem}-${suffix}${extension}`;
      if (!(await this.repository.getMarkdownFile(candidate))) {
        return candidate;
      }
    }
    throw new Error("无法为写入目标分配不冲突的文件名。");
  }
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
