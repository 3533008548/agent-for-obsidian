import type {
  DesktopWikiHealthReview,
  DesktopWikiTopicHealth
} from "../../core/desktop/desktop-wiki-service";

export interface WorkspaceState {
  rootPath: string;
  displayName: string;
  indexedFiles: number;
  skippedFiles: number;
  chunkCount: number;
}

export interface DesktopSearchHit {
  sourcePath: string;
  heading: string | null;
  excerpt: string;
  score: number;
}

export interface DesktopFilePreview {
  path: string;
  title: string;
  content: string;
}

export interface DesktopNoteEntry {
  path: string;
  title: string;
}

export interface DesktopAgentSource {
  path: string;
  heading: string | null;
  excerpt: string;
}

export interface DesktopAgentResponse {
  content: string;
  mode: "local" | "web" | "general" | "evidence-gap";
  evidenceComplete: boolean;
  intent?: DesktopAgentIntent;
  sources: DesktopAgentSource[];
  recoveryNote?: string;
  /**
   * What the agent tried before answering (本地检索 → 联网搜索 → …)，按步分条。
   * 渲染层把它折进默认收起的展开块；recoveryNote 只留给必须立刻看见的提示。
   */
  decisionTrail?: string[];
  /**
   * Set when the question was a follow-up and the agent resolved "它/这个/为什么
   * 要有随机数" against the recent conversation before searching. The user's own
   * words stay on screen; this is what was actually looked up.
   */
  interpretedQuestion?: string;
  wikiVerification?: DesktopWikiVerificationReport;
  sessionStatus?: SessionStatus;
  profilePath?: string;
  assistantStatePath?: string;
  /** Set when the exchange was recorded, so a later capture can be filed against it. */
  turnId?: string;
}

export type DesktopAgentIntent =
  | "answer"
  | "start-session"
  | "close-session"
  | "open-profile"
  | "remember-profile"
  | "forget-profile"
  | "open-assistant-state"
  | "set-current-focus"
  | "compile-wiki"
  | "ingest-note"
  | "list-uncompiled"
  | "survey-wiki"
  | "expand-wiki"
  | "inspect-wiki-sources"
  | "process-images"
  | "format-clipboard"
  | "complete-relations"
  | "verify-wiki"
  | "wiki-overlap"
  | "tidy-notes"
  | "rename-notes"
  | "scan-duplicates";

export interface DesktopAgentRequestContext {
  activeNotePath?: string;
}

export type DesktopCaptureAction = "createInboxNote" | "appendDailyNote";

export interface DesktopWriteResult {
  targetPath: string;
  created: boolean;
}

/** What a confirmed deletion did, and how to take it back. */
export interface DesktopDeleteResult {
  targetPath: string;
  /** Empty when this call was a restore rather than a delete. */
  trashPath: string;
  /** Hand this back to `confirmDelete` to undo. */
  manifestPath: string;
  deletedAt: string;
}

export type DesktopWikiVerificationFindingKind = "confirmed" | "missing" | "outdated" | "conflict";

export interface DesktopWikiVerificationFinding {
  kind: DesktopWikiVerificationFindingKind;
  pagePath?: string;
  detail: string;
}

export interface DesktopWikiVerificationPage {
  path: string;
  title: string;
  excerpt: string;
}

export interface DesktopWikiVerificationReport {
  id: string;
  question: string;
  pages: DesktopWikiVerificationPage[];
  summary: string;
  findings: DesktopWikiVerificationFinding[];
  needsUpdate: boolean;
}

export interface DesktopWikiUpdatePreview {
  path: string;
  title: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
}

export type WikiHealthReview = DesktopWikiHealthReview;
export type WikiTopicHealth = DesktopWikiTopicHealth;

export interface ProviderStatus {
  deepSeekConfigured: boolean;
  tavilyConfigured: boolean;
  deepSeekVisionConfigured: boolean;
}

export interface SessionStatus {
  active: boolean;
  title?: string;
  path?: string;
}

/**
 * A message restored from disk rather than produced this run.
 *
 * `savedPath` carries forward what was already captured, so a replayed answer
 * does not offer to save itself again.
 */
export interface RestoredConversationMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  question?: string;
  sources?: DesktopAgentSource[];
  recoveryNote?: string;
  decisionTrail?: string[];
  savedPath?: string;
}

export interface ConversationResume {
  sessionTitle: string;
  sessionPath: string;
  messages: RestoredConversationMessage[];
}

export interface WritePreviewView {
  targetPath: string;
  existedBefore: boolean;
  beforeContent: string;
  afterContent: string;
}

/**
 * A deletion waiting for the user's yes.
 *
 * The renderer never receives a path it can delete on its own: it gets this
 * description, shows it, and posts back an explicit confirmation. The note
 * moves to the trash rather than disappearing, so a mistaken yes is undoable.
 */
export interface DeletePreviewView {
  targetPath: string;
  trashPath: string;
  reason: string;
  excerpt: string;
  /** Notes that link to the one being removed; empty means nothing referenced it. */
  inboundLinks: string[];
}

/** Progressive events emitted while an answer is being generated. */
export type DesktopAgentStreamEvent =
  | { runId: string; type: "delta"; text: string }
  | { runId: string; type: "reset" }
  | { runId: string; type: "done" }
  | { runId: string; type: "error"; message: string; cancelled: boolean };

export interface DesktopApi {
  chooseWorkspace(): Promise<WorkspaceState | null>;
  getWorkspace(): Promise<WorkspaceState | null>;
  getProviderStatus(): Promise<ProviderStatus>;
  openModelConfig(): Promise<void>;
  askAgent(question: string, context?: DesktopAgentRequestContext): Promise<DesktopAgentResponse>;
  /** Streams an answer, returning once the full response is available. */
  askAgentStream(
    question: string,
    context: DesktopAgentRequestContext | undefined,
    runId: string
  ): Promise<DesktopAgentResponse>;
  /** Aborts an in-flight streamed answer. */
  cancelAgentStream(runId: string): Promise<void>;
  /** Subscribes to stream events; returns an unsubscribe function. */
  onAgentStreamEvent(
    listener: (event: DesktopAgentStreamEvent) => void
  ): () => void;
  saveAnswer(
    action: DesktopCaptureAction,
    subject: string,
    content: string,
    sources: DesktopAgentSource[],
    turnId?: string
  ): Promise<DesktopWriteResult>;
  /** The last session, replayed so the conversation survives a restart. */
  resumeConversation(): Promise<ConversationResume | null>;
  createWikiUpdatePreview(id: string): Promise<DesktopWikiUpdatePreview[]>;
  /**
   * Proofs Wiki pages that cite deleted source notes: drops the dead
   * citations, adds a warning callout, and stages page previews — no model
   * call, no retrieval. The topic's records are pruned once previews apply.
   */
  auditWikiMissingSources(topic: string): Promise<{
    topic: string;
    pageCount: number;
    removedSources: string[];
    paths: string[];
  }>;
  /** Re-checks compiled Wiki topics against the notes they came from. */
  reviewWikiHealth(): Promise<WikiHealthReview | null>;
  search(query: string): Promise<DesktopSearchHit[]>;
  listNotes(): Promise<DesktopNoteEntry[]>;
  previewSource(path: string): Promise<DesktopFilePreview>;
  /** Saves an in-place edit. Refuses if the note changed since it was opened. */
  saveNoteEdit(path: string, content: string): Promise<{ targetPath: string }>;
  openSource(path: string): Promise<void>;
  getWritePreviews(): Promise<WritePreviewView[]>;
  applyWritePreviews(): Promise<string[]>;
  /** Describes what a delete would remove. Removes nothing. */
  previewDeleteNote(targetPath: string, reason?: string): Promise<DeletePreviewView>;
  /** The deletion the agent proposed, for its confirmation card. */
  getPendingDelete(): Promise<DeletePreviewView | null>;
  /**
   * Carries out a previewed deletion. Pass `manifestPath` to restore instead,
   * which is how the trash becomes an undo rather than a one-way door.
   */
  confirmDelete(manifestPath?: string): Promise<DesktopDeleteResult>;
  /** Drops a pending deletion without touching the filesystem. */
  cancelDelete(): Promise<void>;
  /** Reveals the trash folder in the file manager, creating it if empty. */
  openTrashFolder(): Promise<{ path: string }>;
}
