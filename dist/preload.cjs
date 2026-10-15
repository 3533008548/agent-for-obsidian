"use strict";

// src/preload.ts
var import_electron = require("electron");
var api = {
  chooseWorkspace: () => import_electron.ipcRenderer.invoke("workspace:choose"),
  getWorkspace: () => import_electron.ipcRenderer.invoke("workspace:get"),
  getProviderStatus: () => import_electron.ipcRenderer.invoke("provider:get-status"),
  openModelConfig: () => import_electron.ipcRenderer.invoke("provider:open-config"),
  askAgent: (question, context) => import_electron.ipcRenderer.invoke("agent:answer", question, context),
  askAgentStream: (question, context, runId) => import_electron.ipcRenderer.invoke("agent:answer-stream", question, context, runId),
  cancelAgentStream: (runId) => import_electron.ipcRenderer.invoke("agent:answer-cancel", runId),
  onAgentStreamEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    import_electron.ipcRenderer.on("agent:answer-stream-event", wrapped);
    return () => {
      import_electron.ipcRenderer.removeListener("agent:answer-stream-event", wrapped);
    };
  },
  saveAnswer: (action, subject, content, sources, turnId) => import_electron.ipcRenderer.invoke("answer:save", action, subject, content, sources, turnId),
  resumeConversation: () => import_electron.ipcRenderer.invoke("session:resume"),
  createWikiUpdatePreview: (id) => import_electron.ipcRenderer.invoke("wiki:create-update-preview", id),
  auditWikiMissingSources: (topic) => import_electron.ipcRenderer.invoke("wiki:audit-missing-sources", topic),
  reviewWikiHealth: () => import_electron.ipcRenderer.invoke("wiki:health-review"),
  search: (query) => import_electron.ipcRenderer.invoke("knowledge:search", query),
  listNotes: () => import_electron.ipcRenderer.invoke("knowledge:list-notes"),
  previewSource: (path) => import_electron.ipcRenderer.invoke("knowledge:preview-source", path),
  openSource: (path) => import_electron.ipcRenderer.invoke("knowledge:open-source", path),
  getWritePreviews: () => import_electron.ipcRenderer.invoke("write:get-previews"),
  applyWritePreviews: () => import_electron.ipcRenderer.invoke("write:apply-previews"),
  // Deletion is deliberately split: the preview only describes, and only
  // confirmDelete moves a note. The renderer has no "delete now" call.
  previewDeleteNote: (targetPath, reason) => import_electron.ipcRenderer.invoke("note:preview-delete", targetPath, reason),
  getPendingDelete: () => import_electron.ipcRenderer.invoke("note:get-pending-delete"),
  confirmDelete: (manifestPath) => import_electron.ipcRenderer.invoke("note:confirm-delete", manifestPath),
  cancelDelete: () => import_electron.ipcRenderer.invoke("note:cancel-delete"),
  saveNoteEdit: (path, content) => import_electron.ipcRenderer.invoke("note:save-edit", path, content),
  openTrashFolder: () => import_electron.ipcRenderer.invoke("note:open-trash")
};
import_electron.contextBridge.exposeInMainWorld("knowledgeLoop", api);
