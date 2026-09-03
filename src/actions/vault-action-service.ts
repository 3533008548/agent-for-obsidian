import { TFile, TFolder, type Vault } from "obsidian";
import type { PolicyDecision, PolicyEngine } from "../policy/policy-engine";
import {
  buildActionTargetPath,
  renderAgentProfileUpdate,
  renderAgentSessionAppend,
  renderCreatedAgentSession,
  renderCreatedInboxNote,
  renderCreatedKnowledgeSystemNote,
  renderDailyAppend,
  validateActionProposal,
  type AgentActionProposal
} from "./action-proposal";
import { mergeManagedNoteRelations } from "../integration/note-relations";

export interface WritePreview {
  proposal: AgentActionProposal;
  decision: PolicyDecision;
  targetPath: string;
  existedBefore: boolean;
  beforeContent: string;
  afterContent: string;
}

export interface WriteResult {
  targetPath: string;
  created: boolean;
}

export class VaultActionService {
  constructor(
    private readonly vault: Vault,
    private readonly getPolicy: () => PolicyEngine,
    private readonly getTargetFolders: () => {
      inboxFolder: string;
      dailyFolder: string;
      knowledgeSystemFolder: string;
      agentMemoryFolder: string;
    },
    private readonly onPolicyDecision: (decision: PolicyDecision) => void
  ) {}

  async preview(proposal: AgentActionProposal): Promise<WritePreview> {
    const errors = validateActionProposal(proposal);
    if (errors.length) {
      throw new Error(errors.join(" "));
    }

    const targets = this.getTargetFolders();
    const requestedPath = buildActionTargetPath(
      proposal,
      targets.inboxFolder,
      targets.dailyFolder,
      targets.knowledgeSystemFolder,
      targets.agentMemoryFolder
    );
    const targetPath = proposal.type === "createInboxNote" || proposal.type === "createKnowledgeSystemNote"
      ? this.findAvailableInboxPath(requestedPath)
      : requestedPath;
    const decision = this.getPolicy().decide({ action: proposal.type, targetPath });
    this.onPolicyDecision(decision);
    if (!decision.allowed) {
      throw new Error(`写入被权限策略拒绝：${decision.reason}`);
    }

    const existing = this.vault.getAbstractFileByPath(targetPath);
    if (existing && !(existing instanceof TFile)) {
      throw new Error("目标路径已被同名文件夹占用。");
    }
    if (proposal.type === "modifyExistingNote" && !existing) {
      throw new Error(proposal.updateMode === "replace"
        ? "要更新的 Wiki 页面不存在；请重新生成预览。"
        : "关联补全只能修改已存在的 Markdown 笔记。 ");
    }

    const beforeContent = existing ? await this.vault.read(existing) : "";
    const now = new Date();
    const afterContent = proposal.type === "createInboxNote"
      ? renderCreatedInboxNote(proposal, now)
      : proposal.type === "createKnowledgeSystemNote"
        ? renderCreatedKnowledgeSystemNote(proposal, now)
        : proposal.type === "createAgentSession"
          ? renderCreatedAgentSession(proposal)
          : proposal.type === "appendAgentSession"
            ? renderAgentSessionAppend(proposal, beforeContent)
            : proposal.type === "updateAgentProfile"
              ? renderAgentProfileUpdate(proposal)
              : proposal.type === "modifyExistingNote"
                ? proposal.updateMode === "replace"
                  ? `${proposal.content.trimEnd()}\n`
                  : mergeManagedNoteRelations(beforeContent, proposal.content)
                : renderDailyAppend(proposal, beforeContent, now);

    return {
      proposal,
      decision,
      targetPath,
      existedBefore: Boolean(existing),
      beforeContent,
      afterContent
    };
  }

  async apply(preview: WritePreview): Promise<WriteResult> {
    const decision = this.getPolicy().decide({
      action: preview.proposal.type,
      targetPath: preview.targetPath
    });
    this.onPolicyDecision(decision);
    if (!decision.allowed) {
      throw new Error(`写入被权限策略拒绝：${decision.reason}`);
    }

    const current = this.vault.getAbstractFileByPath(preview.targetPath);
    if (preview.existedBefore) {
      if (
        preview.proposal.type === "createInboxNote" ||
        preview.proposal.type === "createKnowledgeSystemNote" ||
        preview.proposal.type === "createAgentSession"
      ) {
        throw new Error("新建笔记操作不能覆盖已有笔记；请重新生成预览。 ");
      }
      if (!(current instanceof TFile)) {
        throw new Error("预览后目标文件已被删除或替换；请重新生成预览。");
      }
      await this.vault.process(current, (content) => {
        if (content !== preview.beforeContent) {
          throw new Error("目标文件在预览后已被修改；请重新生成预览以避免覆盖用户内容。");
        }
        return preview.afterContent;
      });
      return { targetPath: preview.targetPath, created: false };
    }

    if (current) {
      throw new Error("预览后目标路径已存在；请重新生成预览以避免覆盖文件。");
    }

    await this.ensureFolder(this.parentPath(preview.targetPath));
    await this.vault.create(preview.targetPath, preview.afterContent);
    return { targetPath: preview.targetPath, created: true };
  }

  private async ensureFolder(path: string): Promise<void> {
    let currentPath = "";
    for (const segment of path.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const current = this.vault.getAbstractFileByPath(currentPath);
      if (!current) {
        await this.vault.createFolder(currentPath);
      } else if (!(current instanceof TFolder)) {
        throw new Error(`无法创建目录：${currentPath} 已被文件占用。`);
      }
    }
  }

  private parentPath(path: string): string {
    const separator = path.lastIndexOf("/");
    if (separator < 1) {
      throw new Error("目标路径缺少父目录。");
    }
    return path.slice(0, separator);
  }

  private findAvailableInboxPath(requestedPath: string): string {
    if (!this.vault.getAbstractFileByPath(requestedPath)) {
      return requestedPath;
    }

    const extensionIndex = requestedPath.lastIndexOf(".");
    const stem = requestedPath.slice(0, extensionIndex);
    const extension = requestedPath.slice(extensionIndex);
    for (let suffix = 2; suffix <= 9_999; suffix += 1) {
      const candidate = `${stem}-${suffix}${extension}`;
      if (!this.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }
    throw new Error("无法为 Inbox 新建笔记分配不冲突的文件名。 ");
  }
}
