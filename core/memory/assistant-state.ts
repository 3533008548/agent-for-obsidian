import { normalizeVaultPath } from "../policy/policy-engine";

const FOCUS_START = "<!-- knowledge-loop-agent:focus:start -->";
const FOCUS_END = "<!-- knowledge-loop-agent:focus:end -->";
const ACTIONS_START = "<!-- knowledge-loop-agent:actions:start -->";
const ACTIONS_END = "<!-- knowledge-loop-agent:actions:end -->";
const MAX_ACTIONS = 20;

export interface AssistantStateAction {
  name: string;
  summary: string;
  sessionPath?: string;
}

export function getAssistantStatePath(memoryFolder: string): string {
  const folder = normalizeVaultPath(memoryFolder);
  if (!folder) {
    throw new Error("Agent 记忆目录不是有效的 Vault 相对路径。 ");
  }
  return `${folder}/Assistant State.md`;
}

export function buildAssistantStateSkeleton(now = new Date()): string {
  return [
    "---",
    "agent-memory: assistant-state",
    `created: \"${now.toISOString()}\"`,
    "index: false",
    "---",
    "",
    "# Agent 状态",
    "",
    "> 这份状态由 Agent 维护，用于延续当前关注和已执行动作。你可直接编辑；Agent 只会改写受托管标记包围的区域。",
    "",
    "## 当前关注",
    "",
    FOCUS_START,
    "- 暂无。可对 Agent 说“设为当前重点：……”。",
    FOCUS_END,
    "",
    "## 最近 Agent 操作",
    "",
    ACTIONS_START,
    ACTIONS_END,
    ""
  ].join("\n");
}

export function setAssistantFocus(
  currentContent: string,
  focus: string,
  sessionPath?: string,
  now = new Date()
): string {
  const content = ensureStateMarkers(currentContent, now);
  const normalizedFocus = cleanLine(focus, 180);
  if (!normalizedFocus) {
    return content;
  }
  const source = sessionPath ? `\n  - 来源：[[${sessionPath}]]` : "\n  - 来源：用户明确指令";
  const replacement = [
    FOCUS_START,
    `- ${normalizedFocus}`,
    `  - 更新：${formatTimestamp(now)}${source}`,
    FOCUS_END
  ].join("\n");
  return replaceManagedBlock(content, FOCUS_START, FOCUS_END, replacement);
}

export function appendAssistantStateAction(
  currentContent: string,
  action: AssistantStateAction,
  now = new Date()
): string {
  const content = ensureStateMarkers(currentContent, now);
  const existing = readManagedBlock(content, ACTIONS_START, ACTIONS_END)
    .split(/(?=^- \d{4}-\d{2}-\d{2} )/mu)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const summary = cleanLine(action.summary, 260);
  const name = cleanLine(action.name, 80);
  if (!summary || !name) {
    return content;
  }
  const entry = [
    `- ${formatTimestamp(now)} · ${name}：${summary}`,
    action.sessionPath ? `  - 会话：[[${action.sessionPath}]]` : ""
  ].filter(Boolean).join("\n");
  const replacement = [ACTIONS_START, entry, ...existing].slice(0, MAX_ACTIONS + 1).join("\n");
  return replaceManagedBlock(content, ACTIONS_START, ACTIONS_END, `${replacement}\n${ACTIONS_END}`);
}

function ensureStateMarkers(content: string, now: Date): string {
  const base = content.trim() || buildAssistantStateSkeleton(now).trim();
  if (base.includes(FOCUS_START) && base.includes(FOCUS_END) && base.includes(ACTIONS_START) && base.includes(ACTIONS_END)) {
    return `${base}\n`;
  }
  return `${base}\n\n## 当前关注\n\n${FOCUS_START}\n- 暂无。\n${FOCUS_END}\n\n## 最近 Agent 操作\n\n${ACTIONS_START}\n${ACTIONS_END}\n`;
}

function readManagedBlock(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? content.slice(start + startMarker.length, end).trim() : "";
}

function replaceManagedBlock(content: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) {
    return content;
  }
  return `${content.slice(0, start)}${replacement}${content.slice(end + endMarker.length)}`.replace(/\s*$/u, "\n");
}

function cleanLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().replace(/^[-•]\s*/u, "").slice(0, limit);
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
