import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import {
  buildActionTargetPath,
  createManualCaptureProposal,
  createSourcedCaptureProposal,
  renderCreatedInboxNote,
  renderDailyAppend,
  type AgentActionProposal,
  type ManualCaptureAction
} from "../actions/action-proposal";
import { PolicyEngine } from "../policy/policy-engine";
import type { DesktopAgentSource } from "./desktop-agent-service";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export type DesktopCaptureAction = Extract<ManualCaptureAction, "createInboxNote" | "appendDailyNote">;

export interface DesktopWritePreview {
  action: DesktopCaptureAction;
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
    private readonly dailyFolder = "daily"
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
    throw new Error("无法为 Inbox 分配不冲突的文件名。");
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
