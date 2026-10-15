import type { DesktopAgentSource } from "../desktop/desktop-agent-service";

/**
 * Append-only record of what the conversation actually showed.
 *
 * The session transcript in the vault is written for a person reading it: a
 * question, an answer, nothing more. Replaying the UI from it alone loses the
 * parts that are state rather than prose — which sources were cited, what the
 * answer loop tried, and whether the answer was already saved to a note. That
 * last one is the dangerous one: a replayed answer whose "存入 Inbox" button has
 * come back looks unsaved, and saving it twice is exactly how a vault fills
 * with duplicate notes.
 *
 * So every exchange is written twice from one source: the transcript for the
 * reader, this log for the interface. `.jsonl` is chosen because it is not
 * Markdown — it cannot be indexed, listed as a note, or mistaken for part of
 * the library.
 */
export const CONVERSATION_LOG_VERSION = 1;

export type ConversationLogMode = "local" | "web" | "general" | "evidence-gap";

export interface ConversationLogTurn {
  turnId: string;
  at: string;
  intent?: string;
  question: string;
  content: string;
  mode: ConversationLogMode;
  evidenceComplete: boolean;
  sources: DesktopAgentSource[];
  /** What the answer loop tried; shown under the answer. */
  decisionTrail: string[];
  /** Set once the answer was captured into a note. */
  captured?: ConversationCapture;
}

export interface ConversationCapture {
  action: "createInboxNote" | "appendDailyNote";
  targetPath: string;
  at: string;
}

/** A later fact about an earlier turn; written when the user saves an answer. */
interface ConversationCapturePatch {
  kind: "capture";
  turnId: string;
  captured: ConversationCapture;
}

/** `_logs/<id>.jsonl`, beside the transcript rather than inside the library. */
export function conversationLogPath(sessionPath: string, sessionId: string): string {
  const separator = sessionPath.lastIndexOf("/");
  const directory = separator < 0 ? "" : sessionPath.slice(0, separator);
  return `${directory}/_logs/${sessionId}.jsonl`;
}

export function renderTurnLine(turn: ConversationLogTurn): string {
  return `${JSON.stringify({ ...turn, v: CONVERSATION_LOG_VERSION })}\n`;
}

export function renderCapturePatch(turnId: string, captured: ConversationCapture): string {
  return `${JSON.stringify({ kind: "capture", turnId, captured, v: CONVERSATION_LOG_VERSION } satisfies ConversationCapturePatch & { v: number })}\n`;
}

/**
 * Reads the log back into turns.
 *
 * A malformed line costs one turn, not the whole history: this is the only
 * record of what was said, so it must degrade rather than throw away a session
 * because one line got truncated by a crash.
 */
export function parseConversationLog(raw: string): ConversationLogTurn[] {
  const turns: ConversationLogTurn[] = [];
  const byId = new Map<string, ConversationLogTurn>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const patch = readCapturePatch(record);
    if (patch) {
      const target = byId.get(patch.turnId);
      if (target) {
        target.captured = patch.captured;
      }
      continue;
    }
    const turn = readTurn(record);
    if (!turn) {
      continue;
    }
    turns.push(turn);
    byId.set(turn.turnId, turn);
  }
  return turns;
}

function readTurn(record: Record<string, unknown>): ConversationLogTurn | null {
  const turnId = record.turnId;
  const question = record.question;
  const content = record.content;
  if (typeof turnId !== "string" || !turnId) {
    return null;
  }
  if (typeof question !== "string" || typeof content !== "string") {
    return null;
  }
  return {
    turnId,
    at: typeof record.at === "string" ? record.at : "",
    ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
    question,
    content,
    mode: isMode(record.mode) ? record.mode : "local",
    evidenceComplete: record.evidenceComplete === true,
    sources: readSources(record.sources),
    decisionTrail: Array.isArray(record.decisionTrail)
      ? record.decisionTrail.filter((item): item is string => typeof item === "string")
      : []
  };
}

function readCapturePatch(record: Record<string, unknown>): ConversationCapturePatch | null {
  if (record.kind !== "capture" || typeof record.turnId !== "string") {
    return null;
  }
  const raw = record.captured;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const captured = raw as Record<string, unknown>;
  if (typeof captured.targetPath !== "string" || !captured.targetPath) {
    return null;
  }
  const action = captured.action;
  return {
    kind: "capture",
    turnId: record.turnId,
    captured: {
      action: action === "createInboxNote" || action === "appendDailyNote" ? action : "createInboxNote",
      targetPath: captured.targetPath,
      at: typeof captured.at === "string" ? captured.at : ""
    }
  };
}

function readSources(value: unknown): DesktopAgentSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sources: DesktopAgentSource[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const source = item as Record<string, unknown>;
    if (typeof source.path !== "string" || !source.path) {
      continue;
    }
    sources.push({
      path: source.path,
      heading: typeof source.heading === "string" ? source.heading : null,
      excerpt: typeof source.excerpt === "string" ? source.excerpt : ""
    });
  }
  return sources;
}

function isMode(value: unknown): value is ConversationLogMode {
  return value === "local" || value === "web" || value === "general" || value === "evidence-gap";
}
