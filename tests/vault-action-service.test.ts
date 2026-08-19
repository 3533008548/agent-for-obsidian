import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class TFile {
    constructor(public path: string) {}
  }
  class TFolder {
    constructor(public path: string) {}
  }
  return { TFile, TFolder };
});

import { TFile, TFolder, type Vault } from "obsidian";
import { createManualCaptureSource } from "../src/actions/action-proposal";
import { VaultActionService } from "../src/actions/vault-action-service";
import { createDefaultPermissionPolicy, PolicyEngine } from "../src/policy/policy-engine";

class MemoryVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) {
      return new TFile(path);
    }
    if (this.folders.has(path)) {
      return new TFolder(path);
    }
    return null;
  }

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.files.has(path)) {
      throw new Error("already exists");
    }
    this.files.set(path, content);
    return new TFile(path);
  }

  async process(file: TFile, update: (content: string) => string | Promise<string>): Promise<void> {
    const current = this.files.get(file.path) ?? "";
    this.files.set(file.path, await update(current));
  }
}

function createService(vault: MemoryVault): VaultActionService {
  const policy = createDefaultPermissionPolicy();
  policy.enabled.createInboxNote = true;
  policy.enabled.appendDailyNote = true;
  return new VaultActionService(
    vault as unknown as Vault,
    () => new PolicyEngine(policy),
    () => ({ inboxFolder: policy.inboxFolder, dailyFolder: policy.dailyFolder }),
    () => undefined
  );
}

describe("VaultActionService", () => {
  it("creates an Inbox note only after a preview is applied", async () => {
    const vault = new MemoryVault();
    const service = createService(vault);
    const content = "将损失函数整理成题卡。";
    const preview = await service.preview({
      type: "createInboxNote",
      title: "机器学习想法",
      content,
      sources: [createManualCaptureSource(content)]
    });

    expect(vault.files.size).toBe(0);
    expect(preview.targetPath).toBe("00 Inbox/Agent/机器学习想法.md");

    const result = await service.apply(preview);
    expect(result.created).toBe(true);
    expect(vault.files.get(result.targetPath)).toContain("## 来源");
    expect(vault.folders).toEqual(new Set(["00 Inbox", "00 Inbox/Agent"]));
  });

  it("creates a numbered Inbox note instead of replacing a note with the same title", async () => {
    const vault = new MemoryVault();
    vault.files.set("00 Inbox/Agent/机器学习想法.md", "用户已有内容");
    const service = createService(vault);
    const content = "新的整理内容。";

    const preview = await service.preview({
      type: "createInboxNote",
      title: "机器学习想法",
      content,
      sources: [createManualCaptureSource(content)]
    });

    expect(preview.targetPath).toBe("00 Inbox/Agent/机器学习想法-2.md");
    expect(preview.existedBefore).toBe(false);

    await service.apply(preview);
    expect(vault.files.get("00 Inbox/Agent/机器学习想法.md")).toBe("用户已有内容");
    expect(vault.files.get("00 Inbox/Agent/机器学习想法-2.md")).toContain("新的整理内容。");
  });

  it("appends a topic daily entry and detects edits made after preview", async () => {
    const vault = new MemoryVault();
    const service = createService(vault);
    const firstContent = "监督学习需要带标签的数据。";
    const firstPreview = await service.preview({
      type: "appendDailyNote",
      topic: "机器学习",
      content: firstContent,
      sources: [createManualCaptureSource(firstContent)]
    });
    await service.apply(firstPreview);

    const secondContent = "损失函数衡量预测误差。";
    const secondPreview = await service.preview({
      type: "appendDailyNote",
      topic: "机器学习",
      content: secondContent,
      sources: [createManualCaptureSource(secondContent)]
    });
    vault.files.set(secondPreview.targetPath, "用户在预览后自行修改的内容");

    await expect(service.apply(secondPreview)).rejects.toThrow("预览后已被修改");
  });
});
