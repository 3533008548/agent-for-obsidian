import { FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopAgentSource,
  DesktopFilePreview,
  DesktopNoteEntry,
  DeletePreviewView,
  ConversationResume,
  DesktopWikiUpdatePreview,
  DesktopWikiVerificationReport,
  ProviderStatus,
  WikiHealthReview,
  WikiTopicHealth,
  WorkspaceState,
  WritePreviewView
} from "../shared/desktop-api";
import {
  CALLOUT_LABELS,
  isBlockStart,
  isIndentedContinuation,
  isTableDivider,
  isTableRow,
  parseBullet,
  parseCalloutHead,
  splitTableRow,
  stripMachineNoise
} from "./markdown-model";
import type { ParsedBullet } from "./markdown-model";
import { MermaidDiagram } from "./MermaidDiagram";

function describeTopicDrift(topic: WikiTopicHealth): string {
  const parts: string[] = [];
  if (topic.changedSources.length) {
    parts.push(`${topic.changedSources.length} 篇被修改`);
  }
  if (topic.missingSources.length) {
    parts.push(`${topic.missingSources.length} 篇已删除`);
  }
  return parts.join("、");
}

interface ConversationMessage {
  id: string;
  role: "agent" | "user";
  text: string;
  results?: DesktopAgentSource[];
  recoveryNote?: string;
  /** Steps the agent tried before answering; rendered collapsed under the answer. */
  decisionTrail?: string[];
  /** What the agent actually searched, when it resolved a follow-up first. */
  interpretedQuestion?: string;
  question?: string;
  savedPath?: string;
  /** Set by the main process so a capture can be filed against this answer. */
  turnId?: string;
  /** Read back off disk rather than produced in this session. */
  restored?: boolean;
  wikiVerification?: DesktopWikiVerificationReport;
  wikiUpdates?: DesktopWikiUpdatePreview[];
  tone?: "error";
}

export function App() {
  const api = window.knowledgeLoop;
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      id: "welcome",
      role: "agent",
      text: "选择一个本地 Markdown 知识库后，直接描述你的目标。我会判断是回答问题，还是执行编译 Wiki、解析图片、整理剪贴板、补全笔记关联或联网核验等操作。说“记住……”可更新用户画像；说“查看助手状态”或“设为当前重点：……”可管理持续状态。"
    }
  ]);
  const [input, setInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [isCreatingWikiUpdate, setIsCreatingWikiUpdate] = useState(false);
  const [writePreviews, setWritePreviews] = useState<WritePreviewView[]>([]);
  /** Awaiting the user's yes. Nothing has been removed while this is set. */
  const [deletePreview, setDeletePreview] = useState<DeletePreviewView | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<{ path: string; manifestPath: string } | null>(null);
  /** Right-click menu on a note row, in viewport coordinates. */
  const [noteMenu, setNoteMenu] = useState<{ path: string; title: string; x: number; y: number } | null>(null);
  /** In-place note editing; `null` while the note is only being read. */
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [editingContent, setEditingContent] = useState("");
  const [wikiHealth, setWikiHealth] = useState<WikiHealthReview | null>(null);
  const [isRewriting, setIsRewriting] = useState(false);
  const [isApplyingPreviews, setIsApplyingPreviews] = useState(false);
  const [filePreview, setFilePreview] = useState<DesktopFilePreview | null>(null);
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null);
  const [notes, setNotes] = useState<DesktopNoteEntry[]>([]);
  const [resumedSession, setResumedSession] = useState<{ title: string; count: number } | null>(null);
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeStreamRef = useRef<{ runId: string; messageId: string } | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    if (!api) {
      return;
    }
    void api.getWorkspace()
      .then(async (state) => {
        if (!state) {
          return;
        }
        setWorkspace(state);
        setMessages((current) => [
          ...current.filter((message) => message.id !== "welcome"),
          {
            id: "restored",
            role: "agent",
            text: "已恢复知识库「" + state.displayName + "」，索引 " + state.indexedFiles + " 篇笔记、" + state.chunkCount + " 个片段。"
          }
        ]);
        await restoreConversation();
        // A deletion proposed before a restart is still unconfirmed; showing it
        // again is safe, and dropping it silently would lose the user's pending
        // decision.
        void api.getPendingDelete().then((pending) => pending && setDeletePreview(pending)).catch(() => undefined);
      })
      .catch(appendError);
  }, [api]);

  /**
   * Puts the last conversation back on screen.
   *
   * The renderer only ever held the conversation in memory, so every start
   * began at zero. Restored messages keep whatever they were when they were
   * written — including whether they were already saved to a note, which is
   * what stops a replayed answer from offering to save itself twice.
   */
  async function restoreConversation(): Promise<void> {
    if (!api) {
      return;
    }
    let resumed: ConversationResume | null = null;
    try {
      resumed = await api.resumeConversation();
    } catch (error) {
      // A log we cannot read costs the replay, not the app.
      console.error("[resume]", error);
      return;
    }
    if (!resumed || !resumed.messages.length) {
      return;
    }
    setResumedSession({ title: resumed.sessionTitle, count: resumed.messages.length });
    setMessages((current) => [...current, ...resumed.messages.map((message) => ({ ...message, restored: true }))]);
  }

  useEffect(() => {
    void refreshNotes();
    setCollapsedFolders(new Set());
  }, [api, workspace?.rootPath]);

  useEffect(() => {
    void refreshWikiHealth();
  }, [api, workspace?.rootPath]);

  useEffect(() => {
    if (!api) {
      return;
    }
    void api.getProviderStatus().then(setProviderStatus).catch(appendError);
  }, [api]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSearching]);

  async function chooseWorkspace(): Promise<void> {
    try {
      if (!api) {
        return;
      }
      const state = await api.chooseWorkspace();
      if (!state) {
        return;
      }
      setWorkspace(state);
      setMessages((current) => [
        ...current,
        {
          id: "workspace-" + Date.now(),
          role: "agent",
          text: "已打开「" + state.displayName + "」。索引 " + state.indexedFiles + " 篇笔记、" + state.chunkCount + " 个片段；系统目录未纳入索引。"
        }
      ]);
    } catch (error) {
      appendError(error);
    }
  }

  async function openTrashFolder(): Promise<void> {
    try {
      if (!api) {
        return;
      }
      await api.openTrashFolder();
    } catch (error) {
      appendError(error);
    }
  }

  async function openModelConfig(): Promise<void> {
    try {
      if (!api) {
        return;
      }
      await api.openModelConfig();
      const status = await api.getProviderStatus();
      setProviderStatus(status);
      setMessages((current) => [
        ...current,
        {
          id: "config-" + Date.now(),
          role: "agent",
          text: "已打开本地 .env。保存密钥后，无需重启，下一次提问会自动读取新配置。"
        }
      ]);
    } catch (error) {
      appendError(error);
    }
  }

  async function createWikiUpdatePreview(message: ConversationMessage): Promise<void> {
    try {
      if (!api || !message.wikiVerification) {
        return;
      }
      setIsCreatingWikiUpdate(true);
      const updates = await api.createWikiUpdatePreview(message.wikiVerification.id);
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, wikiUpdates: updates }
        : item));
    } catch (error) {
      appendError(error);
    } finally {
      setIsCreatingWikiUpdate(false);
    }
  }

  async function saveAnswer(message: ConversationMessage, action: "createInboxNote" | "appendDailyNote"): Promise<void> {
    try {
      if (!api || !message.question) {
        return;
      }
      const result = await api.saveAnswer(action, message.question, message.text, message.results ?? [], message.turnId);
      await refreshNotes();
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, savedPath: result.targetPath }
        : item));
    } catch (error) {
      appendError(error);
    }
  }

  async function previewSource(path: string): Promise<void> {
    try {
      if (!api) {
        return;
      }
      const preview = await api.previewSource(path);
      setSelectedNotePath(preview.path);
      setFilePreview(preview);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "发生未知错误。";
      setMessages((current) => [
        ...current,
        {
          id: "source-missing-" + Date.now(),
          role: "agent",
          tone: "error",
          text: raw.includes("来源笔记已不存在")
            ? `无法打开「${path}」：这篇笔记已删除或不再是 Markdown 文件。可以在下方来源健康卡片点「校对缺失来源」清理对它的引用。`
            : raw
        }
      ]);
    }
  }

  async function refreshNotes(): Promise<void> {
    if (!api || !workspace) {
      setNotes([]);
      return;
    }
    setNotes(await api.listNotes());
  }

  /**
   * A Wiki is written once and then drifts. This is the check that notices:
   * it re-reads the sources behind every compiled topic and reports the ones
   * that no longer match. Failure is non-fatal — no Wiki compiled yet is the
   * normal case, and a hint is not worth an error message.
   */
  async function refreshWikiHealth(): Promise<void> {
    if (!api) {
      return;
    }
    try {
      setWikiHealth((await api.reviewWikiHealth()) ?? null);
    } catch {
      setWikiHealth(null);
    }
  }

  /**
   * Deleted sources cannot be recovered by another retrieval round, so the
   * repair is a proofread pass: drop the dead citations, flag the pages, and
   * let the user confirm — no model call, no re-search of unchanged notes.
   */
  async function auditMissingSources(topic: string): Promise<void> {
    if (!api) {
      return;
    }
    try {
      const result = await api.auditWikiMissingSources(topic);
      setMessages((current) => [
        ...current,
        {
          id: "audit-" + Date.now(),
          role: "agent",
          text: `已为「${result.topic}」校对 ${result.pageCount} 个页面：移除失效来源 ${result.removedSources.length} 个（${result.removedSources.join("、")}），页面顶部已标注证据失效。确认写入预览后生效。`
        }
      ]);
      setWritePreviews(await api.getWritePreviews());
    } catch (error) {
      appendError(error);
    }
  }

  function toggleFolder(path: string): void {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await sendQuery(input.trim());
  }

  /**
   * Sends a goal through the same pipeline as typed input — including the
   * intent router, which is what turns "增量编译 X" into an expansion of the
   * existing topic instead of a brand-new one.
   */
  async function sendQuery(query: string): Promise<void> {
    if (!query || isSearching) {
      return;
    }
    if (!workspace) {
      appendError(new Error("请先选择本地知识库目录。"));
      return;
    }

    setInput("");
    setIsSearching(true);
    setMessages((current) => [...current, { id: "user-" + Date.now(), role: "user", text: query }]);
    if (!api) {
      setIsSearching(false);
      return;
    }

    const messageId = "result-" + Date.now();
    const runId = "run-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const canStream = typeof api.askAgentStream === "function";
    if (canStream) {
      activeStreamRef.current = { runId, messageId };
      stopRequestedRef.current = false;
      setIsStreaming(true);
      setStreamingMessageId(messageId);
      setMessages((current) => [...current, { id: messageId, role: "agent", text: "" }]);
    }
    try {
      const request = { activeNotePath: selectedNotePath ?? undefined };
      const answer = canStream
        ? await api.askAgentStream(query, request, runId)
        : await api.askAgent(query, request);
      const wasStopped = stopRequestedRef.current;
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                text: answer.content,
                results: answer.sources,
                recoveryNote: wasStopped
                  ? "已停止生成，以上是已产生的部分。"
                  : answer.recoveryNote,
                decisionTrail: answer.decisionTrail,
                question: answer.intent === "answer" ? query : undefined,
                interpretedQuestion: answer.interpretedQuestion,
                ...(answer.turnId ? { turnId: answer.turnId } : {}),
                wikiVerification: answer.wikiVerification
              }
            : message
        )
      );
      if (answer.intent && answer.intent !== "answer") {
        setWorkspace(await api.getWorkspace());
        await refreshNotes();
        void refreshWikiHealth();
        // Operational intents can stage a write (the library map does); only the
        // planning flow used to look for previews, so they would never show up.
        setWritePreviews(await api.getWritePreviews());
        // A delete the agent proposed shows up as its own card, so the user
        // meets it before anything happens rather than reading about it later.
        const pendingDelete = await api.getPendingDelete();
        if (pendingDelete) {
          setDeletePreview(pendingDelete);
        }
      }
      if (answer.profilePath) {
        await previewSource(answer.profilePath);
      }
      if (answer.assistantStatePath) {
        await previewSource(answer.assistantStatePath);
      }
    } catch (error) {
      if (stopRequestedRef.current) {
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? { ...message, recoveryNote: "已停止生成，以上是已产生的部分。" }
              : message
          )
        );
      } else {
        setMessages((current) => current.filter((message) => message.id !== messageId));
        appendError(error);
      }
    } finally {
      activeStreamRef.current = null;
      stopRequestedRef.current = false;
      setIsStreaming(false);
      setStreamingMessageId(null);
      setIsSearching(false);
    }
  }

  async function applyPreviews(): Promise<void> {
    if (!api) {
      return;
    }
    setIsApplyingPreviews(true);
    try {
      const paths = await api.applyWritePreviews();
      setWritePreviews([]);
      setMessages((current) => [
        ...current,
        { id: "write-" + Date.now(), role: "agent", text: "已写入 " + paths.length + " 个文件：" + paths.join("、") }
      ]);
      setWorkspace(await api.getWorkspace());
      await refreshNotes();
      void refreshWikiHealth();
    } catch (error) {
      appendError(error);
    } finally {
      setIsApplyingPreviews(false);
    }
  }

  function appendError(error: unknown): void {
    const message = error instanceof Error ? error.message : "发生未知错误。";
    setMessages((current) => [
      ...current,
      { id: "error-" + Date.now(), role: "agent", text: message, tone: "error" }
    ]);
  }

  /** Ask the main process what deleting this note would do. Removes nothing. */
  async function askDeleteNote(targetPath: string, reason?: string): Promise<void> {
    if (!api) {
      return;
    }
    try {
      setDeletePreview(await api.previewDeleteNote(targetPath, reason));
    } catch (error) {
      appendError(error);
    }
  }

  /**
   * The only path that removes a note, and it is a button the user pressed.
   *
   * The manifest comes back so the note can be put back: a delete that cannot
   * be undone is a bad thing to offer as a routine action.
   */
  async function confirmDelete(): Promise<void> {
    if (!api || !deletePreview) {
      return;
    }
    setIsDeleting(true);
    try {
      const result = await api.confirmDelete();
      setDeletePreview(null);
      setLastDeleted({ path: result.targetPath, manifestPath: result.manifestPath });
      setMessages((current) => [
        ...current,
        {
          id: "delete-" + Date.now(),
          role: "agent",
          text: "已把「" + result.targetPath + "」移入回收站。笔记内容仍然保留，可以随时还原。"
        }
      ]);
      setWorkspace(await api.getWorkspace());
      await refreshNotes();
    } catch (error) {
      appendError(error);
    } finally {
      setIsDeleting(false);
    }
  }

  async function cancelDelete(): Promise<void> {
    if (!api) {
      return;
    }
    setDeletePreview(null);
    try {
      await api.cancelDelete();
    } catch (error) {
      appendError(error);
    }
  }

  /**
   * Save an in-place edit, then show what was actually written.
   *
   * The editor is left open only on failure: a successful save re-reads the
   * note, so what stays on screen is the file rather than the edit that was
   * typed — otherwise a rejected save would look like it succeeded.
   */
  async function saveNoteEdit(path: string): Promise<void> {
    if (!api) {
      return;
    }
    try {
      await api.saveNoteEdit(path, editingContent);
      setIsEditingNote(false);
      setEditingContent("");
      const refreshed = await api.previewSource(path);
      setFilePreview(refreshed);
      setMessages((current) => [
        ...current,
        { id: "edit-" + Date.now(), role: "agent", text: "已保存「" + path + "」的修改。" }
      ]);
      setWorkspace(await api.getWorkspace());
      await refreshNotes();
    } catch (error) {
      appendError(error);
    }
  }

  async function restoreDeleted(): Promise<void> {
    if (!api || !lastDeleted) {
      return;
    }
    const { path, manifestPath } = lastDeleted;
    setLastDeleted(null);
    try {
      await api.confirmDelete(manifestPath);
      setMessages((current) => [
        ...current,
        { id: "restore-" + Date.now(), role: "agent", text: "已还原「" + path + "」。" }
      ]);
      setWorkspace(await api.getWorkspace());
      await refreshNotes();
    } catch (error) {
      appendError(error);
    }
  }

  useEffect(() => {
    if (!api?.onAgentStreamEvent) {
      return;
    }
    return api.onAgentStreamEvent((event) => {
      const active = activeStreamRef.current;
      if (!active || event.runId !== active.runId) {
        return;
      }
      if (event.type === "delta") {
        setMessages((current) =>
          current.map((message) =>
            message.id === active.messageId ? { ...message, text: message.text + event.text } : message
          )
        );
      } else if (event.type === "reset") {
        // The answer switched to a different source; drop the stale partial text.
        setMessages((current) =>
          current.map((message) => (message.id === active.messageId ? { ...message, text: "" } : message))
        );
      }
    });
  }, [api]);

  const stopStreaming = useCallback(async (): Promise<void> => {
    const active = activeStreamRef.current;
    if (!active || !api) {
      return;
    }
    stopRequestedRef.current = true;
    await api.cancelAgentStream(active.runId);
  }, [api]);

  const hasStreamedText =
    streamingMessageId !== null &&
    (messages.find((message) => message.id === streamingMessageId)?.text ?? "") !== "";

  if (!api) {
    return (
      <main className="loading-fallback">
        <h1>知识环</h1>
        <p>界面服务未加载。请关闭应用后重新运行 npm.cmd run dev。</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button
            className="explorer-toggle"
            type="button"
            onClick={() => setIsExplorerCollapsed((current) => !current)}
            aria-label={isExplorerCollapsed ? "显示笔记目录" : "隐藏笔记目录"}
          >
            {isExplorerCollapsed ? "显示目录" : "隐藏目录"}
          </button>
          <div>
            <p className="eyebrow">本地优先 · 个人知识助手</p>
            <h1>知识环</h1>
          </div>
        </div>
        <div className="workspace-actions">
          <button className="workspace-button" type="button" onClick={() => void chooseWorkspace()}>
            {workspace ? "切换知识库 · " + workspace.indexedFiles + " 篇" : "打开知识库"}
          </button>
          {/* Settings, not "more". Everything the app can do to itself lives
              here now: the maintenance commands used to be reachable only by
              typing them, which made the app look like it could not do them. */}
          <details className="utility-menu">
            <summary>设置</summary>
            <div className="utility-menu-content">
              <p className="utility-menu-group">模型</p>
              <button type="button" onClick={() => void openModelConfig()}>
                {providerStatus?.deepSeekConfigured ? "模型配置（已就绪）" : "模型配置"}
              </button>
              <p className="utility-menu-group">知识库</p>
              <button type="button" onClick={() => void chooseWorkspace()}>
                {workspace ? "切换知识库" : "打开知识库"}
              </button>
              <button type="button" onClick={() => void sendQuery("梳理知识库主题")}>
                梳理知识库主题
              </button>
              <button type="button" onClick={() => void sendQuery("检查知识库维护问题")}>
                检查维护问题
              </button>
              <button type="button" onClick={() => void sendQuery("整理笔记命名")}>
                整理笔记命名
              </button>
              <button type="button" onClick={() => void sendQuery("检查重复笔记")}>
                检查重复笔记
              </button>
              <p className="utility-menu-group">索引</p>
              <button type="button" onClick={() => void sendQuery("重建 Markdown 索引")}>
                重建索引
              </button>
              <p className="utility-menu-group">回收站</p>
              <button type="button" onClick={() => void openTrashFolder()}>
                打开回收站文件夹
              </button>
            </div>
          </details>
        </div>
      </header>

      <div className={"workspace-layout " + (isExplorerCollapsed ? "explorer-collapsed" : "")}>
        {!isExplorerCollapsed ? (
          <aside className="file-explorer" aria-label="笔记目录">
            <div className="file-explorer-header">
              <strong>笔记目录</strong>
              <small>{notes.length} 篇</small>
            </div>
            {workspace ? (
              <NoteTree
                notes={notes}
                activePath={selectedNotePath ?? undefined}
                collapsedFolders={collapsedFolders}
                onToggleFolder={toggleFolder}
                onPreview={previewSource}
                onContextMenu={(event, note) => {
                  event.preventDefault();
                  setNoteMenu({ path: note.path, title: note.title, x: event.clientX, y: event.clientY });
                }}
              />
            ) : <p className="explorer-empty">选择知识库后显示目录。</p>}
          </aside>
        ) : null}
      <section className="conversation" aria-live="polite">
        {resumedSession ? (
          <p className="resume-note">
            继续上次会话「{resumedSession.title}」，已回放 {resumedSession.count} 条记录。
          </p>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={"message " + message.role + " " + (message.tone ?? "")}>
            <span className="message-label">{message.role === "agent" ? "知识助手" : "你"}</span>
            <div className="message-body">
              <MarkdownPreview content={message.text} onOpenLink={previewSource} />
              {message.id === streamingMessageId ? <span className="stream-cursor" aria-hidden="true" /> : null}
            </div>
            {message.interpretedQuestion ? (
              <p className="interpreted-note">按上下文理解为：{message.interpretedQuestion}</p>
            ) : null}
            {message.recoveryNote ? <p className="recovery-note">{message.recoveryNote}</p> : null}
            {message.decisionTrail?.length ? (
              <details className="process-trail">
                <summary>执行过程 · {message.decisionTrail.length} 步</summary>
                <ul>
                  {message.decisionTrail.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {message.results?.length ? (
              <div className="sources">
                {message.results.map((result) => (
                  <button
                    className="source"
                    type="button"
                    key={message.id + "-" + result.path + "-" + (result.heading ?? "")}
                    onClick={() => void previewSource(result.path)}
                  >
                    <span>{result.heading ?? result.path.split("/").pop()}</span>
                    <small>{result.path}</small>
                    <em>{result.excerpt}</em>
                  </button>
                ))}
              </div>
            ) : null}
            {message.wikiVerification ? (
              <div className="wiki-verification">
                <p className="wiki-section-title">命中的 Wiki 页面</p>
                <div className="sources">
                  {message.wikiVerification.pages.map((page) => (
                    <button className="source" type="button" key={page.path} onClick={() => void previewSource(page.path)}>
                      <span>{page.title}</span>
                      <small>{page.path}</small>
                      <em>{page.excerpt}</em>
                    </button>
                  ))}
                </div>
                {message.wikiVerification.findings.length ? (
                  <div className="verification-findings">
                    {message.wikiVerification.findings.map((finding, index) => (
                      <p key={index}><strong>{formatFindingKind(finding.kind)}</strong>{finding.pagePath ? ` · ${finding.pagePath}` : ""}：{finding.detail}</p>
                    ))}
                  </div>
                ) : null}
                {message.wikiVerification.needsUpdate && !message.wikiUpdates ? (
                  <div className="message-actions">
                    <button type="button" disabled={isCreatingWikiUpdate} onClick={() => void createWikiUpdatePreview(message)}>
                      {isCreatingWikiUpdate ? "正在生成…" : "生成 Wiki 更新预览"}
                    </button>
                  </div>
                ) : null}
                {message.wikiUpdates ? (
                  <div className="wiki-updates">
                    <p className="wiki-section-title">更新预览（尚未写入）</p>
                    {message.wikiUpdates.length ? message.wikiUpdates.map((update) => (
                      <details key={update.path}>
                        <summary>{update.title}：{update.summary}</summary>
                        <pre>{update.afterContent}</pre>
                      </details>
                    )) : <p>当前核验没有形成足够可靠的页面更新建议。</p>}
                  </div>
                ) : null}
              </div>
            ) : null}
            {message.role === "agent" && message.question ? (
              <div className="message-actions">
                {message.savedPath ? (
                  <span className="saved-note">已保存：{message.savedPath}</span>
                ) : (
                  <>
                    {message.restored ? <span className="replay-tag">回放</span> : null}
                    <button type="button" onClick={() => void saveAnswer(message, "createInboxNote")}>存入 Inbox</button>
                    <button type="button" onClick={() => void saveAnswer(message, "appendDailyNote")}>追加到 Daily</button>
                  </>
                )}
              </div>
            ) : null}
          </article>
        ))}
        {isSearching && !hasStreamedText ? (
          <article className="message agent loading">
            <span className="message-label">知识助手</span>
            <p>正在判断请求并执行必要操作…</p>
          </article>
        ) : null}
        {isCreatingWikiUpdate ? (
          <article className="message agent loading">
            <span className="message-label">知识助手</span>
            <p>正在生成 Wiki 更新预览…</p>
          </article>
        ) : null}
        {isRewriting ? (
          <article className="message agent loading">
            <span className="message-label">知识助手</span>
            <p>正在结合上一轮对话理解你的问题…</p>
          </article>
        ) : null}
        {noteMenu ? (
          <div
            className="note-menu-backdrop"
            onClick={() => setNoteMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setNoteMenu(null);
            }}
          >
            <div className="note-menu" style={{ left: noteMenu.x, top: noteMenu.y }} onClick={(event) => event.stopPropagation()}>
              <p className="note-menu-title">{noteMenu.title}</p>
              <button
                type="button"
                onClick={() => {
                  const target = noteMenu;
                  setNoteMenu(null);
                  void previewSource(target.path);
                }}
              >
                打开
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const target = noteMenu;
                  setNoteMenu(null);
                  void askDeleteNote(target.path);
                }}
              >
                删除这篇笔记
              </button>
            </div>
          </div>
        ) : null}
        {deletePreview ? (
          <section className="delete-card" aria-label="删除确认">
            <header className="delete-card-header">
              <div>
                <p className="delete-card-eyebrow">删除确认 · 尚未删除</p>
                <h3>{deletePreview.targetPath}</h3>
                <small>
                  确认后笔记会移入回收站（不是彻底删除），随时可以还原。
                </small>
              </div>
            </header>
            {deletePreview.excerpt ? (
              <p className="delete-excerpt">{deletePreview.excerpt}</p>
            ) : null}
            {deletePreview.inboundLinks.length ? (
              <p className="delete-warn">
                有 {deletePreview.inboundLinks.length} 篇笔记引用了它：
                {deletePreview.inboundLinks.slice(0, 4).join("、")}
                {deletePreview.inboundLinks.length > 4 ? " 等" : ""}。删除后这些链接会指向空。
              </p>
            ) : null}
            <p className="delete-reason">原因：{deletePreview.reason}</p>
            <div className="delete-actions">
              <button
                type="button"
                className="danger"
                onClick={() => void confirmDelete()}
                disabled={isDeleting}
              >
                {isDeleting ? "删除中…" : "确认移入回收站"}
              </button>
              <button type="button" onClick={() => void cancelDelete()} disabled={isDeleting}>
                取消
              </button>
            </div>
          </section>
        ) : null}
        {lastDeleted ? (
          <p className="delete-undo">
            已删除「{lastDeleted.path}」。
            <button type="button" onClick={() => void restoreDeleted()}>还原</button>
          </p>
        ) : null}
        {writePreviews.length ? (
          <section className="run-card" aria-label="写入预览">
            <header className="run-card-header">
              <div>
                <p className="run-card-eyebrow">写入预览 · 未写入磁盘</p>
                <h3>{writePreviews.length} 个待确认文件</h3>
                <small>确认后才会写入；预览后文件若被改动会拒绝覆盖。</small>
              </div>
              <button type="button" onClick={() => void applyPreviews()} disabled={isApplyingPreviews}>
                确认写入
              </button>
            </header>
            <ul className="preview-list">
              {writePreviews.map((preview) => (
                <li key={preview.targetPath}>
                  <p className="preview-path">{preview.targetPath}{preview.existedBefore ? "（将更新已有文件）" : "（新建）"}</p>
                  <div className="preview-body message-body">
                    <MarkdownPreview content={preview.afterContent} onOpenLink={previewSource} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {wikiHealth && wikiHealth.topics.length ? (
          <section className="health-card" aria-label="Wiki 来源健康">
            <header className="health-card-header">
              <div>
                <p className="health-card-eyebrow">Wiki 来源已变化</p>
                <h3>{wikiHealth.topics.length} 个主题需要增量编译</h3>
                <small>这些主题引用的笔记已被修改或删除，Wiki 页面仍是旧内容。</small>
              </div>
              <button type="button" onClick={() => setWikiHealth(null)}>忽略</button>
            </header>
            <ul className="health-list">
              {wikiHealth.topics.map((topic) => (
                <li key={topic.id}>
                  <div>
                    <p className="health-topic">{topic.topic}</p>
                    <p className="health-detail">{describeTopicDrift(topic)}</p>
                  </div>
                  <div className="health-actions">
                    {topic.missingSources.length ? (
                      <button
                        type="button"
                        onClick={() => void auditMissingSources(topic.topic)}
                        disabled={isSearching}
                      >
                        校对缺失来源
                      </button>
                    ) : null}
                    {topic.changedSources.length ? (
                      <button
                        type="button"
                        onClick={() => void sendQuery(`增量编译 ${topic.topic} LLM Wiki`)}
                        disabled={isSearching}
                      >
                        增量编译
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {wikiHealth.openErrors.length ? (
              <p className="health-errors">Error Book 还有 {wikiHealth.openErrors.length} 条未关闭条目。</p>
            ) : null}
          </section>
        ) : null}
        <div ref={bottomRef} />
      </section>
      </div>

      <form className={"composer " + (isExplorerCollapsed ? "explorer-collapsed" : "")} onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={workspace ? "直接提问或下达任务，例如：编译 LangGraph LLM Wiki" : "先在右上角选择知识库"}
          rows={1}
          disabled={isSearching || isCreatingWikiUpdate}
          aria-label="向知识库提问"
        />
        <button type="submit" disabled={!input.trim() || isSearching || isCreatingWikiUpdate}>
          发送
        </button>
        {isStreaming ? (
          <button type="button" className="composer-stop" onClick={() => void stopStreaming()}>
            停止生成
          </button>
        ) : null}
      </form>
      {filePreview ? (
        <div className="file-preview-backdrop" role="presentation" onMouseDown={() => setFilePreview(null)}>
          <aside
            className="file-preview"
            role="dialog"
            aria-modal="true"
            aria-label={"预览：" + filePreview.title}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="file-preview-header">
              <div>
                <p>笔记预览</p>
                <h2>{filePreview.title}</h2>
                <small>{filePreview.path}</small>
              </div>
            <div className="file-preview-actions">
              <button
                type="button"
                onClick={() => {
                  setEditingContent(filePreview.content);
                  setIsEditingNote(true);
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void askDeleteNote(filePreview.path)}
              >
                删除
              </button>
              <button type="button" onClick={() => void api.openSource(filePreview.path)}>外部打开</button>
              <button type="button" onClick={() => setFilePreview(null)}>关闭</button>
            </div>
          </header>
          {isEditingNote ? (
            <div className="note-editor">
              <textarea
                value={editingContent}
                onChange={(event) => setEditingContent(event.target.value)}
                spellCheck={false}
                aria-label="笔记内容"
              />
              <p className="note-editor-hint">
                直接改这里，改完选择保存或放弃。放弃不会动磁盘上的文件。
              </p>
              <div className="note-editor-actions">
                <button type="button" onClick={() => void saveNoteEdit(filePreview.path)}>保存修改</button>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingNote(false);
                    setEditingContent("");
                  }}
                >
                  放弃修改
                </button>
              </div>
            </div>
          ) : (
            <article className="markdown-preview">
              <MarkdownPreview content={filePreview.content} onOpenLink={previewSource} />
            </article>
          )}
          </aside>
        </div>
      ) : null}
    </main>
  );
}

function formatFindingKind(kind: "confirmed" | "missing" | "outdated" | "conflict"): string {
  switch (kind) {
    case "confirmed": return "已核验一致";
    case "missing": return "知识缺口";
    case "outdated": return "可能过时";
    case "conflict": return "存在差异";
  }
}

interface NoteFolder {
  name: string;
  path: string;
  folders: NoteFolder[];
  notes: DesktopNoteEntry[];
}

function NoteTree({
  notes,
  activePath,
  collapsedFolders,
  onToggleFolder,
  onPreview,
  onContextMenu
}: {
  notes: DesktopNoteEntry[];
  activePath?: string;
  collapsedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onPreview: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, note: DesktopNoteEntry) => void;
}): ReactNode {
  return <div className="note-tree">{
    renderFolder(buildNoteTree(notes), activePath, collapsedFolders, onToggleFolder, onPreview, onContextMenu)
  }</div>;
}

function renderFolder(
  folder: NoteFolder,
  activePath: string | undefined,
  collapsedFolders: Set<string>,
  onToggleFolder: (path: string) => void,
  onPreview: (path: string) => void,
  onContextMenu: (event: React.MouseEvent, note: DesktopNoteEntry) => void
): ReactNode {
  const isRoot = folder.path === "";
  const collapsed = !isRoot && collapsedFolders.has(folder.path);
  return (
    <div className="note-folder" key={folder.path || "root"}>
      {!isRoot ? (
        <button className="folder-row" type="button" onClick={() => onToggleFolder(folder.path)}>
          <span aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
          <span>{folder.name}</span>
        </button>
      ) : null}
      {!collapsed ? (
        <div className="note-folder-content">
          {folder.folders.map((child) => renderFolder(child, activePath, collapsedFolders, onToggleFolder, onPreview, onContextMenu))}
          {folder.notes.map((note) => (
            <button
              className={"note-row " + (note.path === activePath ? "active" : "")}
              type="button"
              key={note.path}
              onClick={() => onPreview(note.path)}
              // Right-click offers the same delete the note page does, so a note
              // can be removed without first opening it. It only *asks*; the
              // confirmation card still stands between here and the trash.
              onContextMenu={(event) => onContextMenu(event, note)}
              title={note.path}
            >
              <span aria-hidden="true">▤</span>
              <span>{note.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildNoteTree(notes: DesktopNoteEntry[]): NoteFolder {
  const root: NoteFolder = { name: "", path: "", folders: [], notes: [] };
  for (const note of notes) {
    const segments = note.path.split("/");
    const filename = segments.pop();
    if (!filename) {
      continue;
    }
    let current = root;
    for (const segment of segments) {
      const path = current.path ? `${current.path}/${segment}` : segment;
      let child = current.folders.find((folder) => folder.path === path);
      if (!child) {
        child = { name: segment, path, folders: [], notes: [] };
        current.folders.push(child);
      }
      current = child;
    }
    current.notes.push(note);
  }
  sortNoteFolder(root);
  return root;
}

function sortNoteFolder(folder: NoteFolder): void {
  folder.folders.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  folder.notes.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  folder.folders.forEach(sortNoteFolder);
}

/**
 * Mermaid blocks are drawn in place by {@link MermaidDiagram}; this only
 * decides which fenced blocks count as diagrams.
 */
const DIAGRAM_LANGUAGES = new Set(["mermaid"]);

function isDiagramLanguage(language: string): boolean {
  return DIAGRAM_LANGUAGES.has(language);
}

function DiagramCopyButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="diagram-copy"
      onClick={() => {
        copyDiagramSource(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? "已复制" : "复制源码"}
    </button>
  );
}

function copyDiagramSource(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => copyViaSelection(text));
    return;
  }
  copyViaSelection(text);
}

/** `file://` is not a secure context, so the clipboard API is not always here. */
function copyViaSelection(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(area);
  }
}

export function MarkdownPreview({ content, onOpenLink }: { content: string; onOpenLink: (path: string) => void }): ReactNode {
  const nodes: ReactNode[] = [];
  const lines = stripMachineNoise(content).split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.trimStart();
    if (fence.startsWith("```")) {
      const language = fence.slice(3).trim().toLowerCase();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      const source = body.join("\n");
      nodes.push(
        isDiagramLanguage(language)
          ? <div className="markdown-diagram" key={"diagram-" + nodes.length}>
              <div className="diagram-head">
                <span className="diagram-kind">示意图 · mermaid</span>
                <DiagramCopyButton text={source} />
              </div>
              {/* Drawn here, not left to whatever reads the note later: the
                  app is a standalone shell with no vault involved. */}
              <MermaidDiagram source={source} />
              <details className="diagram-source">
                <summary>查看源码</summary>
                <pre className="markdown-code">{source}</pre>
              </details>
            </div>
          : <pre className="markdown-code" key={"code-" + nodes.length}>{source}</pre>
      );
      continue;
    }

    if (isTableRow(line) && isTableDivider(lines[index + 1] ?? "")) {
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      nodes.push(
        <table className="markdown-table" key={"table-" + nodes.length}>
          <thead>
            <tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, onOpenLink)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell, onOpenLink)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length);
      const children = renderInline(heading[2]!, onOpenLink);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      nodes.push(<Tag key={"heading-" + nodes.length}>{children}</Tag>);
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      nodes.push(<hr key={"rule-" + nodes.length} />);
      index += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        quoted.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      const callout = parseCalloutHead(quoted[0] ?? "");
      if (callout) {
        const kind = callout.kind;
        const body = [callout.title, ...quoted.slice(1)].map((entry) => entry.trim()).filter(Boolean);
        nodes.push(
          <div className={"markdown-callout callout-" + kind} key={"callout-" + nodes.length}>
            <p className="callout-label">{CALLOUT_LABELS[kind] ?? kind}</p>
            {body.length ? <div>{body.map((entry, entryIndex) => <p key={entryIndex}>{renderInline(entry, onOpenLink)}</p>)}</div> : null}
          </div>
        );
      } else {
        nodes.push(
          <blockquote key={"quote-" + nodes.length}>
            {renderInline(quoted.filter((entry) => entry.trim()).join(" "), onOpenLink)}
          </blockquote>
        );
      }
      continue;
    }

    const bullet = parseBullet(line);
    if (bullet) {
      const ordered = bullet.ordered;
      const items: ParsedBullet[] = [];
      while (index < lines.length) {
        // A blank line between items is "loose" Markdown, not a new list. Both
        // notes and model answers use it, and without this every item became
        // its own <ol> — which a browser numbers from 1 each time, so a five
        // item list rendered as 1. 1. 1. 1. 1. 1.
        if (!(lines[index] ?? "").trim()) {
          const nextBullet = parseBullet(lines[index + 1] ?? "");
          if (nextBullet?.ordered !== ordered || nextBullet?.depth !== 0) {
            break;
          }
          index += 1;
          continue;
        }
        const current = parseBullet(lines[index] ?? "");
        if (!current) {
          // An indented, non-marker line right after an item belongs to that
          // item: models write "1. **标题**" and explain it on the next line.
          // Dumping that as a sibling paragraph both loses the association and
          // ends the list, so the next item started a fresh <ol> at 1 again.
          if (!items.length || !isIndentedContinuation(lines[index] ?? "")) {
            break;
          }
          const previous = items[items.length - 1]!;
          items[items.length - 1] = { ...previous, text: `${previous.text} ${(lines[index] ?? "").trim()}` };
          index += 1;
          continue;
        }
        // A different marker starts a new list, but only at the top level —
        // indentation means continuation, however it is marked.
        if (current.ordered !== ordered && current.depth === 0) {
          break;
        }
        items.push(current);
        index += 1;
      }
      const Tag = ordered ? "ol" : "ul";
      nodes.push(
        <Tag className="markdown-list" key={"list-" + nodes.length}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex} style={item.depth ? { marginLeft: item.depth * 18 } : undefined}>
              {renderInline(item.text, onOpenLink)}
            </li>
          ))}
        </Tag>
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines[index] ?? "")) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    if (paragraph.length) {
      nodes.push(<p key={"paragraph-" + nodes.length}>{renderInline(paragraph.join(" "), onOpenLink)}</p>);
    } else {
      index += 1;
    }
  }

  return <>{nodes}</>;
}

const INLINE_PATTERN = /\[\[([^\]]+)\]\]|\[([^\]]*)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

function renderInline(text: string, onOpenLink: (path: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push(<span key={key++}>{text.slice(cursor, start)}</span>);
    }
    const [full, wikilink, linkText, href, code, bold, italic] = match;
    if (wikilink !== undefined) {
      const parsed = /^([^|]*)(?:\|(.+))?$/.exec(wikilink.trim());
      const path = (parsed?.[1] ?? "").trim();
      const label = (parsed?.[2] ?? path.split("/").pop() ?? path).replace(/\.md$/iu, "");
      nodes.push(
        <button className="markdown-link" type="button" key={key++} onClick={() => onOpenLink(path)}>
          {label}
        </button>
      );
    } else if (linkText !== undefined && href !== undefined) {
      // Rendered as text with the target kept in the tooltip: opening a browser
      // from inside the app is not something a note should do on its own.
      nodes.push(<span className="markdown-external" key={key++} title={href}>{linkText || href}</span>);
    } else if (code !== undefined) {
      nodes.push(<code className="markdown-inline-code" key={key++}>{code}</code>);
    } else if (bold !== undefined) {
      nodes.push(<strong key={key++}>{bold}</strong>);
    } else if (italic !== undefined) {
      nodes.push(<em key={key++}>{italic}</em>);
    }
    cursor = start + full.length;
  }

  if (cursor < text.length) {
    nodes.push(<span key={key++}>{text.slice(cursor)}</span>);
  }
  return nodes;
}
