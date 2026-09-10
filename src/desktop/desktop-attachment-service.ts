import {
  AttachmentBatchQueue,
  DEFAULT_ATTACHMENT_BATCH_LIMITS,
  type AttachmentBatchLimits,
  type AttachmentBatchQueueState,
  type AttachmentBatchStatus
} from "../indexing/attachment-batch-queue";
import {
  AttachmentIndex,
  getAttachmentKind,
  getAttachmentMimeType,
  type AttachmentIndexRecord,
  type AttachmentScanSummary
} from "../indexing/attachment-index";
import { hashText } from "../domain/content-hash";
import type { PolicyEngine } from "../policy/policy-engine";
import type { MarkdownSearchResult } from "../indexing/markdown-search";
import { DeepSeekVisionClient } from "../services/deepseek-vision-client";
import { postJsonWithFetch } from "../services/fetch-api-request";
import { NodeFileSystemKnowledgeRepository } from "./node-file-system-knowledge-repository";

export interface DesktopAttachmentState {
  records: AttachmentIndexRecord[];
  queue?: AttachmentBatchQueueState;
}

export interface DesktopAttachmentConfiguration {
  deepSeekApiKey: string;
  deepSeekVisionModel: string;
  requestTimeoutMs: number;
  limits?: AttachmentBatchLimits;
}

export interface DesktopAttachmentScanResult extends AttachmentScanSummary {
  unsupportedPdfCount: number;
}

export interface DesktopAttachmentProcessResult {
  indexed: number;
  failed: number;
  pending: number;
}

export class DesktopAttachmentService {
  private readonly index: AttachmentIndex;
  private readonly queue: AttachmentBatchQueue;
  private readonly limits: AttachmentBatchLimits;

  constructor(
    private readonly repository: NodeFileSystemKnowledgeRepository,
    private readonly policy: PolicyEngine,
    private readonly configuration: DesktopAttachmentConfiguration,
    state: Partial<DesktopAttachmentState> = {}
  ) {
    this.index = new AttachmentIndex(state.records ?? []);
    this.queue = new AttachmentBatchQueue(state.queue);
    this.limits = configuration.limits ?? DEFAULT_ATTACHMENT_BATCH_LIMITS;
  }

  async scan(): Promise<DesktopAttachmentScanResult> {
    const allFiles = await this.repository.listFiles();
    const unsupportedPdfCount = allFiles.filter((file) => getAttachmentKind(file.extension) === "pdf").length;
    const files = allFiles
      .filter((file) => getAttachmentKind(file.extension) === "image")
      .map((file) => ({
        path: file.path,
        extension: file.extension,
        stat: { mtime: file.mtime, size: file.size }
      }));
    return { ...this.index.scan(files as never[], this.policy), unsupportedPdfCount };
  }

  getStatus(): AttachmentBatchStatus {
    return this.queue.getStatus(this.index.pendingCount, this.limits);
  }

  search(query: string, limit = 4): MarkdownSearchResult[] {
    return this.index.search(query, this.policy, limit);
  }

  async processAll(): Promise<DesktopAttachmentProcessResult> {
    if (!this.configuration.deepSeekApiKey.trim()) {
      throw new Error("请先在模型配置中填写 DEEPSEEK_API_KEY。");
    }
    let indexed = 0;
    let failed = 0;
    this.queue.setRunning(true);
    try {
      while (this.index.pendingCount > 0) {
        const result = await this.processNext();
        if (result === "blocked") {
          break;
        }
        if (result) {
          indexed += 1;
        } else {
          failed += 1;
        }
      }
    } finally {
      this.queue.setRunning(false);
    }
    return { indexed, failed, pending: this.index.pendingCount };
  }

  toState(): DesktopAttachmentState {
    return { records: this.index.toJSON(), queue: this.queue.toJSON() };
  }

  private async processNext(): Promise<true | false | "blocked"> {
    const record = this.index.nextPending();
    if (!record) {
      return "blocked";
    }
    if (record.kind !== "image") {
      this.index.markFailed(record.path, "DeepSeek Vision 暂不支持 PDF 解析。 ");
      return false;
    }
    const file = (await this.repository.listFiles()).find((item) => item.path === record.path);
    if (!file) {
      this.index.markFailed(record.path, "附件已不存在。");
      return false;
    }
    const indexDecision = this.policy.decide({ action: "indexAttachments", targetPath: record.path });
    const uploadDecision = this.policy.decide({ action: "sendToGlm", targetPath: record.path });
    if (!indexDecision.allowed || !uploadDecision.allowed) {
      this.index.markFailed(record.path, "附件索引或 DeepSeek Vision 上传权限未获授权。");
      return false;
    }
    const maxImageBytes = 24 * 1024 * 1024;
    if (file.size > maxImageBytes) {
      this.index.markFailed(record.path, "图片超过 DeepSeek Vision 内联请求的 24 MB 上限。 ");
      return false;
    }
    const budget = this.queue.reserveAttempt(file.size, this.limits);
    if (!budget.allowed) {
      return "blocked";
    }
    if (!this.index.markProcessing(record.path)) {
      return false;
    }
    try {
      const binary = await this.repository.readBinary(record.path);
      const base64 = binary.toString("base64");
      const client = new DeepSeekVisionClient({
        apiKey: this.configuration.deepSeekApiKey,
        model: this.configuration.deepSeekVisionModel,
        slowResponseMs: this.configuration.requestTimeoutMs,
        postJson: postJsonWithFetch
      });
      const result = await client.describeImage(base64, getAttachmentMimeType(record.kind, file.extension));
      this.index.markIndexed(record.path, {
        type: record.kind,
        pathOrUrl: record.path,
        locator: "image",
        contentHash: hashText(base64),
        parserVersion: result.parserVersion
      }, result.content);
      this.queue.markProcessed(record.path);
      return true;
    } catch (error) {
      this.index.markFailed(record.path, error instanceof Error ? error.message : "附件解析失败。");
      this.queue.markError(error instanceof Error ? error.message : "附件解析失败。");
      return false;
    }
  }
}
