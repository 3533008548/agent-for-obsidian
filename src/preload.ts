import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAgentStreamEvent, DesktopApi } from "./shared/desktop-api";

const api: DesktopApi = {
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  getProviderStatus: () => ipcRenderer.invoke("provider:get-status"),
  openModelConfig: () => ipcRenderer.invoke("provider:open-config"),
  askAgent: (question, context) => ipcRenderer.invoke("agent:answer", question, context),
  askAgentStream: (question, context, runId) =>
    ipcRenderer.invoke("agent:answer-stream", question, context, runId),
  cancelAgentStream: (runId) => ipcRenderer.invoke("agent:answer-cancel", runId),
  onAgentStreamEvent: (listener) => {
    const wrapped = (_event: unknown, payload: DesktopAgentStreamEvent): void => listener(payload);
    ipcRenderer.on("agent:answer-stream-event", wrapped);
    return () => {
      ipcRenderer.removeListener("agent:answer-stream-event", wrapped);
    };
  },
  saveAnswer: (action, subject, content, sources, turnId) =>
    ipcRenderer.invoke("answer:save", action, subject, content, sources, turnId),
  resumeConversation: () => ipcRenderer.invoke("session:resume"),
  createWikiUpdatePreview: (id) => ipcRenderer.invoke("wiki:create-update-preview", id),
  auditWikiMissingSources: (topic) => ipcRenderer.invoke("wiki:audit-missing-sources", topic),
  reviewWikiHealth: () => ipcRenderer.invoke("wiki:health-review"),
  search: (query) => ipcRenderer.invoke("knowledge:search", query),
  listNotes: () => ipcRenderer.invoke("knowledge:list-notes"),
  previewSource: (path) => ipcRenderer.invoke("knowledge:preview-source", path),
  openSource: (path) => ipcRenderer.invoke("knowledge:open-source", path),
  getWritePreviews: () => ipcRenderer.invoke("write:get-previews"),
  applyWritePreviews: () => ipcRenderer.invoke("write:apply-previews"),
  // Deletion is deliberately split: the preview only describes, and only
  // confirmDelete moves a note. The renderer has no "delete now" call.
  previewDeleteNote: (targetPath: string, reason?: string) =>
    ipcRenderer.invoke("note:preview-delete", targetPath, reason),
  getPendingDelete: () => ipcRenderer.invoke("note:get-pending-delete"),
  confirmDelete: (manifestPath?: string) => ipcRenderer.invoke("note:confirm-delete", manifestPath),
  cancelDelete: () => ipcRenderer.invoke("note:cancel-delete"),
  saveNoteEdit: (path: string, content: string) => ipcRenderer.invoke("note:save-edit", path, content),
  openTrashFolder: () => ipcRenderer.invoke("note:open-trash")
};

contextBridge.exposeInMainWorld("knowledgeLoop", api);
