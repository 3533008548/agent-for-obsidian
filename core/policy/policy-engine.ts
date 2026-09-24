export const POLICY_ACTIONS = [
  "readVault",
  "sendToGlm",
  "indexAttachments",
  "webSearch",
  "createInboxNote",
  "createKnowledgeSystemNote",
  "appendDailyNote",
  "modifyExistingNote",
  "createAgentSession",
  "appendAgentSession",
  "updateAgentProfile"
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export interface PermissionPolicy {
  enabled: Record<PolicyAction, boolean>;
  readableFolders: string[];
  uploadableFolders: string[];
  indexableFolders: string[];
  modifiableFolders: string[];
  sensitiveFolders: string[];
  inboxFolder: string;
  dailyFolder: string;
  knowledgeSystemFolder: string;
  agentMemoryFolder: string;
}

export interface PolicyRequest {
  action: PolicyAction;
  targetPath?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  action: PolicyAction;
  reason: string;
  normalizedPath?: string;
}

export function createDefaultPermissionPolicy(): PermissionPolicy {
  return {
    enabled: {
      readVault: true,
      sendToGlm: true,
      indexAttachments: true,
      webSearch: true,
      createInboxNote: true,
      createKnowledgeSystemNote: true,
      appendDailyNote: true,
      modifyExistingNote: true,
      createAgentSession: true,
      appendAgentSession: true,
      updateAgentProfile: true
    },
    readableFolders: ["*"],
    uploadableFolders: ["*"],
    indexableFolders: ["*"],
    modifiableFolders: ["*"],
    sensitiveFolders: [],
    inboxFolder: "00 Inbox/Agent",
    dailyFolder: "daily",
    knowledgeSystemFolder: "知识体系/Agent",
    agentMemoryFolder: "00 Inbox/Agent"
  };
}

export function normalizeVaultPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.some((segment: string) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return normalized;
}

export class PolicyEngine {
  constructor(private readonly policy: PermissionPolicy) {}

  decide(request: PolicyRequest): PolicyDecision {
    const { action } = request;
    if (!this.policy.enabled[action]) {
      return this.denied(action, "该操作尚未获得授权。");
    }

    if (action === "webSearch") {
      return { allowed: true, action, reason: "联网搜索已获授权。" };
    }

    const normalizedPath = request.targetPath ? normalizeVaultPath(request.targetPath) : null;
    if (!normalizedPath) {
      return this.denied(action, "目标路径缺失或不是有效的 Vault 相对路径。");
    }

    if (action === "sendToGlm" && this.matchesFolder(normalizedPath, this.policy.sensitiveFolders)) {
      return this.denied(action, "目标位于敏感目录，禁止发送给外部模型。 ");
    }

    switch (action) {
      case "readVault":
        return this.decideFolderAccess(action, normalizedPath, this.policy.readableFolders, "读取范围");
      case "sendToGlm":
        return this.decideFolderAccess(action, normalizedPath, this.policy.uploadableFolders, "上传范围");
      case "indexAttachments":
        return this.decideFolderAccess(action, normalizedPath, this.policy.indexableFolders, "索引范围");
      case "createInboxNote":
        return this.decideFixedTarget(action, normalizedPath, this.policy.inboxFolder, "Inbox 目录");
      case "createKnowledgeSystemNote":
        return this.decideFixedTarget(action, normalizedPath, this.policy.knowledgeSystemFolder, "知识体系目录");
      case "appendDailyNote":
        return this.decideFixedTarget(action, normalizedPath, this.policy.dailyFolder, "Daily 目录");
      case "createAgentSession":
      case "appendAgentSession":
      case "updateAgentProfile":
        return this.decideFixedTarget(action, normalizedPath, this.policy.agentMemoryFolder, "Agent 记忆目录");
      case "modifyExistingNote":
        return this.decideFolderAccess(action, normalizedPath, this.policy.modifiableFolders, "修改范围");
      default:
        return this.denied(action, "未知操作类型。");
    }
  }

  private decideFolderAccess(
    action: PolicyAction,
    targetPath: string,
    allowedFolders: string[],
    scopeName: string
  ): PolicyDecision {
    if (!this.matchesFolder(targetPath, allowedFolders)) {
      return this.denied(action, `目标不在已授权的${scopeName}内。`);
    }

    return {
      allowed: true,
      action,
      normalizedPath: targetPath,
      reason: `${scopeName}匹配。`
    };
  }

  private decideFixedTarget(
    action: PolicyAction,
    targetPath: string,
    targetFolder: string,
    scopeName: string
  ): PolicyDecision {
    const normalizedFolder = normalizeVaultPath(targetFolder);
    if (!normalizedFolder || !isWithinFolder(targetPath, normalizedFolder)) {
      return this.denied(action, `目标不在配置的${scopeName}内。`);
    }

    return {
      allowed: true,
      action,
      normalizedPath: targetPath,
      reason: `${scopeName}匹配。`
    };
  }

  private denied(action: PolicyAction, reason: string): PolicyDecision {
    return { allowed: false, action, reason };
  }

  private matchesFolder(targetPath: string, folders: string[]): boolean {
    return folders
      .map(normalizeFolderScope)
      .filter((folder): folder is string => folder !== null)
      .some((folder) => folder === "*" || isWithinFolder(targetPath, folder));
  }
}

function normalizeFolderScope(path: string): string | null {
  return path.trim() === "*" ? "*" : normalizeVaultPath(path);
}

function isWithinFolder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}
