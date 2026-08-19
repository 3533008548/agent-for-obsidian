import type { TFile } from "obsidian";
import type { SourceRef } from "../domain/source-ref";
import type { PolicyEngine } from "../policy/policy-engine";
import type { MarkdownChunk } from "./markdown-parser";
import { searchMarkdownChunks, type MarkdownSearchResult } from "./markdown-search";

const MAX_CACHED_TEXT_LENGTH = 16_000;

export type AttachmentKind = "pdf" | "image";
export type AttachmentStatus = "pending" | "processing" | "indexed" | "blocked" | "failed";

export interface AttachmentIndexRecord {
  path: string;
  kind: AttachmentKind;
  fingerprint: string;
  status: AttachmentStatus;
  source?: SourceRef;
  extractedText?: string;
  indexedAt?: string;
  error?: string;
}

export interface AttachmentScanSummary {
  queued: number;
  unchanged: number;
  blocked: number;
  removed: number;
}

export class AttachmentIndex {
  private readonly records = new Map<string, AttachmentIndexRecord>();

  constructor(records: AttachmentIndexRecord[] = []) {
    for (const record of records) {
      if (isValidRecord(record)) {
        this.records.set(record.path, record);
      }
    }
  }

  scan(files: TFile[], policy: PolicyEngine): AttachmentScanSummary {
    const seenPaths = new Set<string>();
    let queued = 0;
    let unchanged = 0;
    let blocked = 0;

    for (const file of files) {
      const kind = getAttachmentKind(file.extension);
      if (!kind) {
        continue;
      }
      seenPaths.add(file.path);
      const current = this.records.get(file.path);
      const fingerprint = `${file.stat.mtime}:${file.stat.size}`;
      const decision = policy.decide({ action: "indexAttachments", targetPath: file.path });
      if (!decision.allowed) {
        blocked += 1;
        if (current) {
          this.records.set(file.path, { ...current, status: "blocked" });
        }
        continue;
      }

      if (current?.fingerprint === fingerprint && current.status === "indexed") {
        unchanged += 1;
        continue;
      }

      queued += 1;
      this.records.set(file.path, {
        path: file.path,
        kind,
        fingerprint,
        status: "pending"
      });
    }

    let removed = 0;
    for (const path of this.records.keys()) {
      if (!seenPaths.has(path)) {
        this.records.delete(path);
        removed += 1;
      }
    }

    return { queued, unchanged, blocked, removed };
  }

  nextPending(): AttachmentIndexRecord | null {
    return [...this.records.values()].find((record) => record.status === "pending") ?? null;
  }

  markProcessing(path: string): boolean {
    const record = this.records.get(path);
    if (!record || record.status !== "pending") {
      return false;
    }
    this.records.set(path, { ...record, status: "processing", error: undefined });
    return true;
  }

  resumeInterrupted(): number {
    let resumed = 0;
    for (const [path, record] of this.records) {
      if (record.status === "processing") {
        this.records.set(path, { ...record, status: "pending" });
        resumed += 1;
      }
    }
    return resumed;
  }

  markIndexed(path: string, source: SourceRef, extractedText: string): void {
    const record = this.records.get(path);
    if (!record) {
      return;
    }
    this.records.set(path, {
      ...record,
      status: "indexed",
      source,
      extractedText: extractedText.slice(0, MAX_CACHED_TEXT_LENGTH),
      indexedAt: new Date().toISOString(),
      error: undefined
    });
  }

  markFailed(path: string, error: string): void {
    const record = this.records.get(path);
    if (!record) {
      return;
    }
    this.records.set(path, {
      ...record,
      status: "failed",
      error: error.slice(0, 500)
    });
  }

  search(query: string, policy: PolicyEngine, limit = 8): MarkdownSearchResult[] {
    const chunks = [...this.records.values()]
      .filter((record) => record.status === "indexed" && record.source && record.extractedText)
      .filter((record) => policy.decide({ action: "readVault", targetPath: record.path }).allowed)
      .map((record): MarkdownChunk => ({
        source: record.source!,
        content: record.extractedText!,
        heading: record.path.split("/").pop() ?? record.path,
        headingPath: [record.path],
        startLine: 1,
        endLine: record.extractedText!.split("\n").length
      }));
    return searchMarkdownChunks(chunks, query, limit);
  }

  get pendingCount(): number {
    return [...this.records.values()].filter((record) => record.status === "pending").length;
  }

  get processingCount(): number {
    return [...this.records.values()].filter((record) => record.status === "processing").length;
  }

  toJSON(): AttachmentIndexRecord[] {
    return [...this.records.values()];
  }
}

export function getAttachmentKind(extension: string): AttachmentKind | null {
  const normalized = extension.toLocaleLowerCase();
  if (normalized === "pdf") {
    return "pdf";
  }
  if (["png", "jpg", "jpeg", "webp"].includes(normalized)) {
    return "image";
  }
  return null;
}

export function getAttachmentMimeType(kind: AttachmentKind, extension: string): string {
  if (kind === "pdf") {
    return "application/pdf";
  }
  const normalized = extension.toLocaleLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") {
    return "image/jpeg";
  }
  return `image/${normalized}`;
}

function isValidRecord(record: AttachmentIndexRecord): boolean {
  return Boolean(record.path && record.kind && record.fingerprint && record.status);
}
