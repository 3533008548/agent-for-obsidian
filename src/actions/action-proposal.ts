import { hashText } from "../domain/content-hash";
import type { SourceRef } from "../domain/source-ref";
import { normalizeVaultPath } from "../policy/policy-engine";

export interface CreateInboxNoteProposal {
  type: "createInboxNote";
  title: string;
  content: string;
  sources: SourceRef[];
}

export interface AppendDailyNoteProposal {
  type: "appendDailyNote";
  topic: string;
  content: string;
  sources: SourceRef[];
}

export interface CreateKnowledgeSystemNoteProposal {
  type: "createKnowledgeSystemNote";
  title: string;
  content: string;
  sources: SourceRef[];
}

export interface CreateAgentSessionProposal {
  type: "createAgentSession";
  title: string;
  sessionPath: string;
  content: string;
  sources: SourceRef[];
}

export interface AppendAgentSessionProposal {
  type: "appendAgentSession";
  sessionPath: string;
  content: string;
  sources: SourceRef[];
}

export interface UpdateAgentProfileProposal {
  type: "updateAgentProfile";
  content: string;
  sources: SourceRef[];
}

export type AgentActionProposal =
  | CreateInboxNoteProposal
  | AppendDailyNoteProposal
  | CreateKnowledgeSystemNoteProposal
  | CreateAgentSessionProposal
  | AppendAgentSessionProposal
  | UpdateAgentProfileProposal;
export type ManualCaptureAction = "createInboxNote" | "appendDailyNote";

export function createManualCaptureSource(content: string): SourceRef {
  return {
    type: "conversation",
    pathOrUrl: "current-session",
    locator: "manual-capture",
    contentHash: hashText(content),
    parserVersion: "manual-v1",
    retrievedAt: new Date().toISOString()
  };
}

export function createManualCaptureProposal(
  type: ManualCaptureAction,
  subject: string,
  content: string
): AgentActionProposal {
  const sources = [createManualCaptureSource(content)];
  if (type === "createInboxNote") {
    return { type, title: subject, content, sources };
  }
  return { type, topic: subject, content, sources };
}

export function createSourcedCaptureProposal(
  type: ManualCaptureAction,
  subject: string,
  content: string,
  sources: SourceRef[]
): AgentActionProposal {
  const uniqueSources = deduplicateSources(sources);
  if (type === "createInboxNote") {
    return { type, title: subject, content, sources: uniqueSources };
  }
  return { type, topic: subject, content, sources: uniqueSources };
}

export function createKnowledgeSystemProposal(
  title: string,
  content: string,
  sources: SourceRef[]
): CreateKnowledgeSystemNoteProposal {
  return {
    type: "createKnowledgeSystemNote",
    title,
    content,
    sources: deduplicateSources(sources)
  };
}

export function validateActionProposal(proposal: AgentActionProposal): string[] {
  const errors: string[] = [];
  const subject = proposal.type === "appendDailyNote"
    ? proposal.topic
    : proposal.type === "createInboxNote" || proposal.type === "createKnowledgeSystemNote" || proposal.type === "createAgentSession"
      ? proposal.title
      : "agent-memory";
  if (!sanitizeFileStem(subject)) {
    errors.push("标题或主题不能为空，且必须包含至少一个有效文件名字符。");
  }
  if (
    (proposal.type === "createAgentSession" || proposal.type === "appendAgentSession") &&
    !normalizeVaultPath(proposal.sessionPath)
  ) {
    errors.push("会话目标不是有效的 Vault 相对路径。");
  }
  if (!proposal.content.trim()) {
    errors.push("写入内容不能为空。");
  }
  if (!proposal.sources.length) {
    errors.push("自动写入必须至少保留一条来源。");
  }
  return errors;
}

export function sanitizeFileStem(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^\.+/g, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 96)
    .trim();
  return sanitized.replace(/^[-. ]+|[-. ]+$/g, "");
}

export function buildActionTargetPath(
  proposal: AgentActionProposal,
  inboxFolder: string,
  dailyFolder: string,
  knowledgeSystemFolder = "知识体系/Agent",
  agentMemoryFolder = inboxFolder
): string {
  if (proposal.type === "createAgentSession" || proposal.type === "appendAgentSession") {
    const sessionPath = normalizeVaultPath(proposal.sessionPath);
    if (!sessionPath) {
      throw new Error("会话目标不是有效的 Vault 相对路径。 ");
    }
    return sessionPath;
  }
  const folder = normalizeVaultPath(
    proposal.type === "createInboxNote"
      ? inboxFolder
      : proposal.type === "appendDailyNote"
        ? dailyFolder
        : proposal.type === "createKnowledgeSystemNote"
          ? knowledgeSystemFolder
          : agentMemoryFolder
  );
  if (!folder) {
    throw new Error("配置的目标目录不是有效的 Vault 相对路径。");
  }

  const stem = proposal.type === "updateAgentProfile"
    ? "Agent Profile"
    : sanitizeFileStem(proposal.type === "appendDailyNote" ? proposal.topic : proposal.title);
  if (!stem || stem === "." || stem === "..") {
    throw new Error("标题或主题无法转换为安全的文件名。");
  }
  return `${folder}/${stem}.md`;
}

export function renderCreatedInboxNote(proposal: CreateInboxNoteProposal, createdAt: Date): string {
  return [
    "---",
    "agent-created: true",
    `created: \"${formatLocalTimestamp(createdAt)}\"`,
    "sources:",
    ...proposal.sources.map((source) => `  - \"${escapeYaml(sourceLabel(source))}\"`),
    "---",
    "",
    `# ${proposal.title.trim()}`,
    "",
    proposal.content.trim(),
    "",
    "## 来源",
    renderSourceList(proposal.sources),
    ""
  ].join("\n");
}

export function renderCreatedKnowledgeSystemNote(
  proposal: CreateKnowledgeSystemNoteProposal,
  createdAt: Date
): string {
  return [
    "---",
    "agent-created: true",
    "knowledge-system: true",
    `created: \"${formatLocalTimestamp(createdAt)}\"`,
    "sources:",
    ...proposal.sources.map((source) => `  - \"${escapeYaml(sourceLabel(source))}\"`),
    "---",
    "",
    `# ${proposal.title.trim()}`,
    "",
    proposal.content.trim(),
    "",
    "## 来源",
    renderSourceList(proposal.sources),
    ""
  ].join("\n");
}

export function renderCreatedAgentSession(proposal: CreateAgentSessionProposal): string {
  return proposal.content.trimEnd() + "\n";
}

export function renderAgentSessionAppend(
  proposal: AppendAgentSessionProposal,
  currentContent: string
): string {
  const prefix = currentContent.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${proposal.content.trim()}\n`;
}

export function renderAgentProfileUpdate(proposal: UpdateAgentProfileProposal): string {
  return proposal.content.trimEnd() + "\n";
}

export function renderDailyAppend(
  proposal: AppendDailyNoteProposal,
  currentContent: string,
  createdAt: Date
): string {
  const topic = proposal.topic.trim();
  const prefix = currentContent.trim()
    ? `${currentContent.replace(/\s+$/g, "")}\n\n`
    : `# ${topic}\n\n`;
  return [
    prefix,
    `## ${formatLocalTimestamp(createdAt)}`,
    "",
    proposal.content.trim(),
    "",
    "### 来源",
    renderSourceList(proposal.sources),
    ""
  ].join("\n");
}

function renderSourceList(sources: SourceRef[]): string {
  return sources.map((source) => `- ${sourceLabel(source)}`).join("\n");
}

function sourceLabel(source: SourceRef): string {
  if (source.type === "web") {
    return source.pathOrUrl;
  }
  if (source.type === "conversation") {
    return "当前会话中的手动记录";
  }
  return `[[${source.pathOrUrl}]]${source.locator ? ` · ${source.locator}` : ""}`;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function formatLocalTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function deduplicateSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.type}:${source.pathOrUrl}:${source.locator}:${source.contentHash}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
