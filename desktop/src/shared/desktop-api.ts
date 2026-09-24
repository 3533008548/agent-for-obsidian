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
  wikiVerification?: DesktopWikiVerificationReport;
  sessionStatus?: SessionStatus;
  profilePath?: string;
  assistantStatePath?: string;
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
  | "expand-wiki"
  | "inspect-wiki-sources"
  | "process-images"
  | "format-clipboard"
  | "complete-relations"
  | "verify-wiki";

export interface DesktopAgentRequestContext {
  activeNotePath?: string;
}

export type DesktopCaptureAction = "createInboxNote" | "appendDailyNote";

export interface DesktopWriteResult {
  targetPath: string;
  created: boolean;
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

export interface ObsidianMigrationState {
  workspace: WorkspaceState;
  noteCount: number;
  attachmentCount: number;
  totalFiles: number;
}

/** Serializable view of one agent run, safe to send to the renderer. */
export interface AgentRunStepView {
  id: string;
  tool: string;
  action: string;
  title: string;
  reason: string;
  requiresConfirmation: boolean;
  status: "pending" | "running" | "completed" | "skipped" | "failed" | "blocked";
  resultSummary?: string;
}

export interface AgentRunView {
  id: string;
  goal: string;
  status: "planned" | "running" | "completed" | "cancelled";
  planSummary: string;
  replanCount: number;
  steps: AgentRunStepView[];
}

export interface WritePreviewView {
  targetPath: string;
  existedBefore: boolean;
  beforeContent: string;
  afterContent: string;
}

export interface DesktopApi {
  chooseWorkspace(): Promise<WorkspaceState | null>;
  migrateObsidianVault(): Promise<ObsidianMigrationState | null>;
  getWorkspace(): Promise<WorkspaceState | null>;
  getProviderStatus(): Promise<ProviderStatus>;
  openModelConfig(): Promise<void>;
  askAgent(question: string, context?: DesktopAgentRequestContext): Promise<DesktopAgentResponse>;
  saveAnswer(action: DesktopCaptureAction, subject: string, content: string, sources: DesktopAgentSource[]): Promise<DesktopWriteResult>;
  createWikiUpdatePreview(id: string): Promise<DesktopWikiUpdatePreview[]>;
  search(query: string): Promise<DesktopSearchHit[]>;
  listNotes(): Promise<DesktopNoteEntry[]>;
  previewSource(path: string): Promise<DesktopFilePreview>;
  openSource(path: string): Promise<void>;
  planAgentRun(goal: string): Promise<AgentRunView>;
  runAgentStep(runId: string, stepId: string): Promise<AgentRunView>;
  skipAgentStep(runId: string, stepId: string): Promise<AgentRunView>;
  cancelAgentRun(runId: string): Promise<AgentRunView>;
  getWritePreviews(): Promise<WritePreviewView[]>;
  applyWritePreviews(): Promise<string[]>;
}
