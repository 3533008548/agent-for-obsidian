import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { AttachmentIndex } from "../src/indexing/attachment-index";
import { createDefaultPermissionPolicy, PolicyEngine } from "../src/policy/policy-engine";

function file(path: string, extension: string, mtime = 1, size = 100): TFile {
  return { path, extension, stat: { mtime, size } } as TFile;
}

describe("AttachmentIndex", () => {
  it("queues only supported files in explicitly authorized index folders", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.indexAttachments = true;
    policy.indexableFolders = ["资料"];
    const index = new AttachmentIndex();

    const summary = index.scan([
      file("资料/paper.pdf", "pdf"),
      file("资料/diagram.png", "png"),
      file("Private/photo.jpg", "jpg"),
      file("资料/notes.txt", "txt")
    ], new PolicyEngine(policy));

    expect(summary).toEqual({ queued: 2, unchanged: 0, blocked: 1, removed: 0 });
    expect(index.pendingCount).toBe(2);
  });

  it("preserves unchanged results and only exposes them to an authorized read scope", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.indexAttachments = true;
    policy.indexableFolders = ["资料"];
    const index = new AttachmentIndex();
    const attachment = file("资料/paper.pdf", "pdf", 5, 200);
    index.scan([attachment], new PolicyEngine(policy));
    index.markIndexed("资料/paper.pdf", {
      type: "pdf",
      pathOrUrl: "资料/paper.pdf",
      locator: "document",
      contentHash: "abc123",
      parserVersion: "glm-ocr-v1"
    }, "监督学习依赖带标签的数据。");

    expect(index.scan([attachment], new PolicyEngine(policy)).unchanged).toBe(1);
    policy.readableFolders = ["Other"];
    expect(index.search("监督学习", new PolicyEngine(policy))).toEqual([]);

    policy.readableFolders = ["资料"];
    const results = index.search("监督学习", new PolicyEngine(policy));
    expect(results).toHaveLength(1);
    expect(results[0].chunk.source.type).toBe("pdf");
  });

  it("restores an interrupted processing record to the pending queue", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.indexAttachments = true;
    const index = new AttachmentIndex();
    index.scan([file("资料/paper.pdf", "pdf")], new PolicyEngine(policy));

    expect(index.markProcessing("资料/paper.pdf")).toBe(true);
    expect(index.processingCount).toBe(1);
    expect(index.resumeInterrupted()).toBe(1);
    expect(index.pendingCount).toBe(1);
  });
});
