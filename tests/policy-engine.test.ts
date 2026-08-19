import { describe, expect, it } from "vitest";
import {
  createDefaultPermissionPolicy,
  normalizeVaultPath,
  PolicyEngine
} from "../src/policy/policy-engine";

describe("PolicyEngine", () => {
  it("defaults to allowing the whole Vault", () => {
    const engine = new PolicyEngine(createDefaultPermissionPolicy());
    const decision = engine.decide({
      action: "readVault",
      targetPath: "Notes/private.md"
    });

    expect(decision.allowed).toBe(true);
    expect(engine.decide({ action: "sendToGlm", targetPath: "Notes/private.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "webSearch" }).allowed).toBe(true);
  });

  it("allows reads only inside an explicitly authorized folder", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.readVault = true;
    policy.readableFolders = ["Notes"];
    const engine = new PolicyEngine(policy);

    expect(engine.decide({ action: "readVault", targetPath: "Notes/project/plan.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "readVault", targetPath: "Notes-archive/plan.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "readVault", targetPath: "Private/plan.md" }).allowed).toBe(false);
  });

  it("rejects absolute paths and traversal attempts", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.readVault = true;
    policy.readableFolders = ["Notes"];
    const engine = new PolicyEngine(policy);

    expect(normalizeVaultPath("C:\\Users\\admin\\secret.md")).toBeNull();
    expect(normalizeVaultPath("Notes/../Private/secret.md")).toBeNull();
    expect(normalizeVaultPath("/Private/secret.md")).toBeNull();
    expect(engine.decide({ action: "readVault", targetPath: "Notes/../Private/secret.md" }).allowed).toBe(false);
  });

  it("keeps GLM upload scope independent from read scope", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.readVault = true;
    policy.enabled.sendToGlm = true;
    policy.readableFolders = ["Notes", "Private"];
    policy.uploadableFolders = ["Notes"];
    const engine = new PolicyEngine(policy);

    expect(engine.decide({ action: "readVault", targetPath: "Private/journal.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "sendToGlm", targetPath: "Private/journal.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "sendToGlm", targetPath: "Notes/summary.md" }).allowed).toBe(true);
  });

  it("keeps sensitive folders local even when the default upload scope is open", () => {
    const policy = createDefaultPermissionPolicy();
    policy.sensitiveFolders = ["Private", "证件"];
    const engine = new PolicyEngine(policy);

    expect(engine.decide({ action: "readVault", targetPath: "Private/journal.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "sendToGlm", targetPath: "Private/journal.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "sendToGlm", targetPath: "证件/id.png" }).reason).toContain("敏感目录");
  });

  it("restricts automated writes to their configured destinations", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.createInboxNote = true;
    policy.enabled.appendDailyNote = true;
    const engine = new PolicyEngine(policy);

    expect(engine.decide({ action: "createInboxNote", targetPath: "00 Inbox/Agent/idea.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "createInboxNote", targetPath: "Notes/idea.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "createKnowledgeSystemNote", targetPath: "知识体系/Agent/机器学习.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "createKnowledgeSystemNote", targetPath: "Notes/机器学习.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "appendDailyNote", targetPath: "daily/机器学习.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "appendDailyNote", targetPath: "00 Inbox/Agent/机器学习.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "createAgentSession", targetPath: "00 Inbox/Agent/Sessions/demo.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "appendAgentSession", targetPath: "Notes/demo.md" }).allowed).toBe(false);
    expect(engine.decide({ action: "updateAgentProfile", targetPath: "00 Inbox/Agent/Agent Profile.md" }).allowed).toBe(true);
  });

  it("requires a separate folder allowlist before existing notes can be modified", () => {
    const policy = createDefaultPermissionPolicy();
    policy.enabled.modifyExistingNote = true;
    policy.modifiableFolders = ["Notes/Projects"];
    const engine = new PolicyEngine(policy);

    expect(engine.decide({ action: "modifyExistingNote", targetPath: "Notes/Projects/plan.md" }).allowed).toBe(true);
    expect(engine.decide({ action: "modifyExistingNote", targetPath: "Notes/Journal/entry.md" }).allowed).toBe(false);
  });
});
