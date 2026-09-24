import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./shared/desktop-api";

const api: DesktopApi = {
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  migrateObsidianVault: () => ipcRenderer.invoke("workspace:migrate-obsidian"),
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  getProviderStatus: () => ipcRenderer.invoke("provider:get-status"),
  openModelConfig: () => ipcRenderer.invoke("provider:open-config"),
  askAgent: (question, context) => ipcRenderer.invoke("agent:answer", question, context),
  saveAnswer: (action, subject, content, sources) => ipcRenderer.invoke("answer:save", action, subject, content, sources),
  createWikiUpdatePreview: (id) => ipcRenderer.invoke("wiki:create-update-preview", id),
  search: (query) => ipcRenderer.invoke("knowledge:search", query),
  listNotes: () => ipcRenderer.invoke("knowledge:list-notes"),
  previewSource: (path) => ipcRenderer.invoke("knowledge:preview-source", path),
  openSource: (path) => ipcRenderer.invoke("knowledge:open-source", path),
  planAgentRun: (goal) => ipcRenderer.invoke("agent:plan-run", goal),
  runAgentStep: (runId, stepId) => ipcRenderer.invoke("agent:run-step", runId, stepId),
  skipAgentStep: (runId, stepId) => ipcRenderer.invoke("agent:skip-step", runId, stepId),
  cancelAgentRun: (runId) => ipcRenderer.invoke("agent:cancel-run", runId),
  getWritePreviews: () => ipcRenderer.invoke("write:get-previews"),
  applyWritePreviews: () => ipcRenderer.invoke("write:apply-previews")
};

contextBridge.exposeInMainWorld("knowledgeLoop", api);
