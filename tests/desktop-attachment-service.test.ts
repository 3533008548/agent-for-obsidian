import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAttachmentService } from "../src/desktop/desktop-attachment-service";
import { NodeFileSystemKnowledgeRepository } from "../src/desktop/node-file-system-knowledge-repository";
import { createDefaultPermissionPolicy, PolicyEngine } from "../src/policy/policy-engine";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DesktopAttachmentService", () => {
  it("queues images and leaves PDFs out of the DeepSeek Vision queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-loop-attachments-"));
    roots.push(root);
    await writeFile(join(root, "diagram.png"), "image", "utf8");
    await writeFile(join(root, "paper.pdf"), "pdf", "utf8");
    const service = new DesktopAttachmentService(
      new NodeFileSystemKnowledgeRepository(root),
      new PolicyEngine(createDefaultPermissionPolicy()),
      { deepSeekApiKey: "key", deepSeekVisionModel: "deepseek-v4-flash-vision-exp", requestTimeoutMs: 60_000 }
    );

    await expect(service.scan()).resolves.toMatchObject({ queued: 1, unsupportedPdfCount: 1 });
    expect(service.getStatus().pending).toBe(1);
  });
});
