import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type {
  DesktopAgentSource,
  DesktopFilePreview,
  DesktopNoteEntry,
  DesktopWikiUpdatePreview,
  DesktopWikiVerificationReport,
  ProviderStatus,
  WorkspaceState
} from "../shared/desktop-api";

interface ConversationMessage {
  id: string;
  role: "agent" | "user";
  text: string;
  results?: DesktopAgentSource[];
  recoveryNote?: string;
  question?: string;
  savedPath?: string;
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
      text: "选择一个本地 Markdown 知识库后，直接描述你的目标。我会判断是回答问题，还是执行编译 Wiki、解析图片、整理剪贴板、补全笔记关联或联网核验等操作。"
    }
  ]);
  const [input, setInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isCreatingWikiUpdate, setIsCreatingWikiUpdate] = useState(false);
  const [filePreview, setFilePreview] = useState<DesktopFilePreview | null>(null);
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null);
  const [notes, setNotes] = useState<DesktopNoteEntry[]>([]);
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api) {
      return;
    }
    void api.getWorkspace()
      .then((state) => {
        if (state) {
          setWorkspace(state);
          setMessages((current) => [
            ...current,
            {
              id: "restored",
              role: "agent",
              text: "已恢复知识库「" + state.displayName + "」，索引 " + state.indexedFiles + " 篇笔记、" + state.chunkCount + " 个片段。"
            }
          ]);
        }
      })
      .catch(appendError);
  }, [api]);

  useEffect(() => {
    void refreshNotes();
    setCollapsedFolders(new Set());
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

  async function migrateObsidianVault(): Promise<void> {
    try {
      if (!api) {
        return;
      }
      const migration = await api.migrateObsidianVault();
      if (!migration) {
        return;
      }
      setWorkspace(migration.workspace);
      setMessages((current) => [
        ...current,
        {
          id: "migration-" + Date.now(),
          role: "agent",
          text: "迁移完成：已复制 " + migration.noteCount + " 篇笔记和 " + migration.attachmentCount + " 个附件，当前已打开新的独立知识库「" + migration.workspace.displayName + "」。"
        }
      ]);
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
      const result = await api.saveAnswer(action, message.question, message.text, message.results ?? []);
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
      appendError(error);
    }
  }

  async function refreshNotes(): Promise<void> {
    if (!api || !workspace) {
      setNotes([]);
      return;
    }
    setNotes(await api.listNotes());
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
    const query = input.trim();
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
    try {
      if (!api) {
        return;
      }
      const answer = await api.askAgent(query, { activeNotePath: selectedNotePath ?? undefined });
      setMessages((current) => [
        ...current,
        {
          id: "result-" + Date.now(),
          role: "agent",
          text: answer.content,
          results: answer.sources,
          recoveryNote: answer.recoveryNote,
          question: answer.intent === "answer" ? query : undefined,
          wikiVerification: answer.wikiVerification
        }
      ]);
      if (answer.intent && answer.intent !== "answer") {
        setWorkspace(await api.getWorkspace());
        await refreshNotes();
      }
      if (answer.profilePath) {
        await previewSource(answer.profilePath);
      }
    } catch (error) {
      appendError(error);
    } finally {
      setIsSearching(false);
    }
  }

  function appendError(error: unknown): void {
    const message = error instanceof Error ? error.message : "发生未知错误。";
    setMessages((current) => [
      ...current,
      { id: "error-" + Date.now(), role: "agent", text: message, tone: "error" }
    ]);
  }

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
          <details className="utility-menu">
            <summary>更多</summary>
            <div className="utility-menu-content">
              <button type="button" onClick={() => void openModelConfig()}>
                {providerStatus?.deepSeekConfigured ? "模型配置（已就绪）" : "模型配置"}
              </button>
              <button type="button" onClick={() => void migrateObsidianVault()}>迁移 Obsidian 笔记</button>
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
              />
            ) : <p className="explorer-empty">选择知识库后显示目录。</p>}
          </aside>
        ) : null}
      <section className="conversation" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={"message " + message.role + " " + (message.tone ?? "")}>
            <span className="message-label">{message.role === "agent" ? "知识助手" : "你"}</span>
            <p>{message.text}</p>
            {message.recoveryNote ? <p className="recovery-note">{message.recoveryNote}</p> : null}
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
                    <button type="button" onClick={() => void saveAnswer(message, "createInboxNote")}>存入 Inbox</button>
                    <button type="button" onClick={() => void saveAnswer(message, "appendDailyNote")}>追加到 Daily</button>
                  </>
                )}
              </div>
            ) : null}
          </article>
        ))}
        {isSearching ? (
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
                <button type="button" onClick={() => void api.openSource(filePreview.path)}>外部打开</button>
                <button type="button" onClick={() => setFilePreview(null)}>关闭</button>
              </div>
            </header>
            <article className="markdown-preview">
              <MarkdownPreview content={filePreview.content} onOpenLink={previewSource} />
            </article>
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
  onPreview
}: {
  notes: DesktopNoteEntry[];
  activePath?: string;
  collapsedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onPreview: (path: string) => void;
}): ReactNode {
  return <div className="note-tree">{
    renderFolder(buildNoteTree(notes), activePath, collapsedFolders, onToggleFolder, onPreview)
  }</div>;
}

function renderFolder(
  folder: NoteFolder,
  activePath: string | undefined,
  collapsedFolders: Set<string>,
  onToggleFolder: (path: string) => void,
  onPreview: (path: string) => void
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
          {folder.folders.map((child) => renderFolder(child, activePath, collapsedFolders, onToggleFolder, onPreview))}
          {folder.notes.map((note) => (
            <button
              className={"note-row " + (note.path === activePath ? "active" : "")}
              type="button"
              key={note.path}
              onClick={() => onPreview(note.path)}
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

function MarkdownPreview({ content, onOpenLink }: { content: string; onOpenLink: (path: string) => void }): ReactNode {
  const nodes: ReactNode[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let codeLines: string[] | null = null;

  const flushParagraph = (): void => {
    if (!paragraph.length) {
      return;
    }
    nodes.push(<p key={"paragraph-" + nodes.length}>{renderInline(paragraph.join(" "), onOpenLink)}</p>);
    paragraph = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      if (codeLines) {
        nodes.push(<pre className="markdown-code" key={"code-" + nodes.length}>{codeLines.join("\n")}</pre>);
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const text = renderInline(heading[2], onOpenLink);
      if (heading[1].length === 1) {
        nodes.push(<h1 key={"heading-" + nodes.length}>{text}</h1>);
      } else if (heading[1].length === 2) {
        nodes.push(<h2 key={"heading-" + nodes.length}>{text}</h2>);
      } else {
        nodes.push(<h3 key={"heading-" + nodes.length}>{text}</h3>);
      }
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      nodes.push(<blockquote key={"quote-" + nodes.length}>{renderInline(quote[1], onOpenLink)}</blockquote>);
      continue;
    }
    const list = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      flushParagraph();
      nodes.push(<p className="markdown-list-item" key={"list-" + nodes.length}>• {renderInline(list[1], onOpenLink)}</p>);
      continue;
    }
    if (/^---+$/.test(line)) {
      flushParagraph();
      nodes.push(<hr key={"rule-" + nodes.length} />);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  if (codeLines) {
    nodes.push(<pre className="markdown-code" key={"code-" + nodes.length}>{codeLines.join("\n")}</pre>);
  }
  return <>{nodes}</>;
}

function renderInline(text: string, onOpenLink: (path: string) => void): ReactNode[] {
  return text.split(/(\[\[[^\]]+\]\])/g).filter(Boolean).map((part, index) => {
    const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(part);
    if (!match) {
      return <span key={index}>{part}</span>;
    }
    const path = match[1].trim();
    const label = (match[2] ?? path.split("/").pop() ?? path).replace(/\.md$/i, "");
    return <button className="markdown-link" type="button" key={index} onClick={() => onOpenLink(path)}>{label}</button>;
  });
}
