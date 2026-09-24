"use strict";

// src/preload.ts
var import_electron = require("electron");
var api = {
  chooseWorkspace: () => import_electron.ipcRenderer.invoke("workspace:choose"),
  migrateObsidianVault: () => import_electron.ipcRenderer.invoke("workspace:migrate-obsidian"),
  getWorkspace: () => import_electron.ipcRenderer.invoke("workspace:get"),
  getProviderStatus: () => import_electron.ipcRenderer.invoke("provider:get-status"),
  openModelConfig: () => import_electron.ipcRenderer.invoke("provider:open-config"),
  askAgent: (question, context) => import_electron.ipcRenderer.invoke("agent:answer", question, context),
  saveAnswer: (action, subject, content, sources) => import_electron.ipcRenderer.invoke("answer:save", action, subject, content, sources),
  createWikiUpdatePreview: (id) => import_electron.ipcRenderer.invoke("wiki:create-update-preview", id),
  search: (query) => import_electron.ipcRenderer.invoke("knowledge:search", query),
  listNotes: () => import_electron.ipcRenderer.invoke("knowledge:list-notes"),
  previewSource: (path) => import_electron.ipcRenderer.invoke("knowledge:preview-source", path),
  openSource: (path) => import_electron.ipcRenderer.invoke("knowledge:open-source", path),
  planAgentRun: (goal) => import_electron.ipcRenderer.invoke("agent:plan-run", goal),
  runAgentStep: (runId, stepId) => import_electron.ipcRenderer.invoke("agent:run-step", runId, stepId),
  skipAgentStep: (runId, stepId) => import_electron.ipcRenderer.invoke("agent:skip-step", runId, stepId),
  cancelAgentRun: (runId) => import_electron.ipcRenderer.invoke("agent:cancel-run", runId),
  getWritePreviews: () => import_electron.ipcRenderer.invoke("write:get-previews"),
  applyWritePreviews: () => import_electron.ipcRenderer.invoke("write:apply-previews")
};
import_electron.contextBridge.exposeInMainWorld("knowledgeLoop", api);
