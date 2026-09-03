import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
  createDefaultPermissionPolicy,
  type PermissionPolicy,
  type PolicyAction
} from "./policy/policy-engine";
import {
  WEB_FALLBACK_POLICIES,
  type WebFallbackPolicy
} from "./services/web-answer-policy";
import type KnowledgeLoopAgentPlugin from "./main";

export interface KnowledgeLoopSettings {
  deepSeekModel: string;
  glmModel: string;
  requestTimeoutMs: number;
  attachmentDailyRequestLimit: number;
  attachmentDailyInputMbLimit: number;
  attachmentRequestIntervalMs: number;
  webSearchResultLimit: number;
  webFallbackPolicy: WebFallbackPolicy;
  autoAppendWebSearchToDaily: boolean;
  permissions: PermissionPolicy;
}

export const DEFAULT_SETTINGS: KnowledgeLoopSettings = {
  deepSeekModel: "deepseek-v4-flash",
  glmModel: "glm-4.6v-flash",
  requestTimeoutMs: 60_000,
  attachmentDailyRequestLimit: 30,
  attachmentDailyInputMbLimit: 100,
  attachmentRequestIntervalMs: 5_000,
  webSearchResultLimit: 5,
  webFallbackPolicy: "stable-only",
  autoAppendWebSearchToDaily: false,
  permissions: createDefaultPermissionPolicy()
};

export class KnowledgeLoopSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: KnowledgeLoopAgentPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Knowledge Loop Agent" });
    containerEl.createEl("p", {
      text: "模型与检索密钥从插件本地 .env 读取。DeepSeek 处理文本，GLM 只处理 PDF/图片，Tavily 只检索网页。初始权限覆盖整个 Vault；敏感目录内容不会发送给任何外部模型。"
    });

    new Setting(containerEl)
      .setName("本地 .env 模型密钥")
      .setDesc(`${this.plugin.getEnvFilePath()} · 填写 DEEPSEEK_API_KEY、GLM_API_KEY、TAVILY_API_KEY。${formatKeyStatus(this.plugin.getProviderKeyStatus())}`)
      .addButton((button) =>
        button.setButtonText("重新加载 .env").setCta().onClick(async () => {
          const status = await this.plugin.reloadApiKeyFromEnv();
          new Notice(`已重新加载本地 .env。${formatKeyStatus(status)}`);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("DeepSeek 文本模型")
      .setDesc("用于本地知识问答、联网检索后的直接回答和笔记提案。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deepSeekModel)
          .onChange(async (value) => this.plugin.updateSettings({ deepSeekModel: value.trim() }))
      );

    new Setting(containerEl)
      .setName("GLM 视觉模型")
      .setDesc("仅用于图片理解；PDF 使用 GLM-OCR 接口。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.glmModel)
          .onChange(async (value) => this.plugin.updateSettings({ glmModel: value.trim() }))
      );

    new Setting(containerEl)
      .setName("慢响应提示（毫秒）")
      .setDesc("DeepSeek、GLM 与 Tavily 超过此时间会提示仍在处理中，但不会中断真实请求；默认 60000。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.requestTimeoutMs))
          .onChange(async (value) => {
            const timeout = Number.parseInt(value, 10);
            if (Number.isFinite(timeout) && timeout >= 5_000) {
              await this.plugin.updateSettings({ requestTimeoutMs: timeout });
            }
          })
      );

    containerEl.createEl("h3", { text: "附件批处理" });
    new Setting(containerEl)
      .setName("每日附件解析次数")
      .setDesc("PDF OCR 和图片视觉解析共享此预算。请求开始后即计入，避免失败重试造成不可控消耗。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.attachmentDailyRequestLimit))
          .onChange(async (value) => {
            const limit = Number.parseInt(value, 10);
            if (Number.isFinite(limit)) {
              await this.plugin.updateSettings({ attachmentDailyRequestLimit: clampAttachmentRequestLimit(limit) });
            }
          })
      );

    new Setting(containerEl)
      .setName("每日附件上传体积（MB）")
      .setDesc("按原始 PDF 或图片的二进制大小计量；不会保存附件副本。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.attachmentDailyInputMbLimit))
          .onChange(async (value) => {
            const limit = Number.parseInt(value, 10);
            if (Number.isFinite(limit)) {
              await this.plugin.updateSettings({ attachmentDailyInputMbLimit: clampAttachmentInputMbLimit(limit) });
            }
          })
      );

    new Setting(containerEl)
      .setName("附件解析间隔（毫秒）")
      .setDesc("批处理在两次 GLM 请求之间等待，降低访问量过大和超时风险。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.attachmentRequestIntervalMs))
          .onChange(async (value) => {
            const interval = Number.parseInt(value, 10);
            if (Number.isFinite(interval)) {
              await this.plugin.updateSettings({ attachmentRequestIntervalMs: clampAttachmentInterval(interval) });
            }
          })
      );

    containerEl.createEl("h3", { text: "联网搜索" });
    new Setting(containerEl)
      .setName("搜索结果数量")
      .setDesc("Tavily 每次最多检索 1–10 个网页摘要，默认 5 个；这些摘要仅交给 DeepSeek 生成回答。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.webSearchResultLimit))
          .onChange(async (value) => {
            const limit = Number.parseInt(value, 10);
            if (Number.isFinite(limit)) {
              await this.plugin.updateSettings({
                webSearchResultLimit: Math.min(10, Math.max(1, limit))
              });
            }
          })
      );

    new Setting(containerEl)
      .setName("无有效网页时的回答策略")
      .setDesc("默认仅对稳定知识自动使用 DeepSeek 通用回答。涉及最新、价格、新闻、政策等实时问题时，默认不降级，避免给出过期信息。")
      .addDropdown((dropdown) => {
        for (const policy of WEB_FALLBACK_POLICIES) {
          dropdown.addOption(policy, formatWebFallbackPolicy(policy));
        }
        dropdown
          .setValue(this.plugin.settings.webFallbackPolicy)
          .onChange(async (value) => {
            if (isWebFallbackPolicy(value)) {
              await this.plugin.updateSettings({ webFallbackPolicy: value });
            }
          });
      });

    new Setting(containerEl)
      .setName("联网搜索后自动追加主题 Daily")
      .setDesc("关闭时回答只在当前面板显示。开启后，每次成功的 Tavily 检索 + DeepSeek 回答会追加到 daily/<搜索主题>.md；仍须开启“允许联网搜索”和“允许自动追加主题 Daily”。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoAppendWebSearchToDaily)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ autoAppendWebSearchToDaily: value });
          })
      );

    new Setting(containerEl)
      .setName("测试 DeepSeek 连通性")
      .setDesc("发送一条最小文本请求。不会读取或上传 Vault 内容。")
      .addButton((button) =>
        button.setButtonText("测试连接").setCta().onClick(async () => {
          await this.plugin.testDeepSeekConnection();
        })
      );

    new Setting(containerEl)
      .setName("测试 GLM 视觉连通性")
      .setDesc("发送一条最小文本请求验证 GLM 凭据与模型配置；不会读取或上传 Vault 内容。")
      .addButton((button) =>
        button.setButtonText("测试连接").onClick(async () => {
          await this.plugin.testGlmConnection();
        })
      );

    containerEl.createEl("h3", { text: "权限策略" });
    containerEl.createEl("p", {
      text: "初始状态下所有能力均可用，目录范围为整个 Vault（*）。可按需要缩小范围；敏感目录始终禁止发送给 DeepSeek 和 GLM。"
    });

    this.addPermissionToggle(containerEl, "readVault", "允许读取 Vault", "允许 Agent 读取已授权目录中的笔记。");
    this.addPermissionToggle(containerEl, "sendToGlm", "允许向模型发送内容", "控制向 DeepSeek 和 GLM 外发 Vault 内容；敏感目录优先阻断。 ");
    this.addPermissionToggle(containerEl, "indexAttachments", "允许后台索引附件", "仅可索引指定资料目录中的 PDF 和图片。 ");
    this.addPermissionToggle(containerEl, "webSearch", "允许联网搜索", "仅发送用户输入的搜索关键词给 Tavily；网页摘要只用于 DeepSeek 生成直接回答。 ");
    this.addPermissionToggle(containerEl, "createInboxNote", "允许创建 Inbox 笔记", "手动或带来源提案的 Inbox 写入均会先展示预览。 ");
    this.addPermissionToggle(containerEl, "createKnowledgeSystemNote", "允许创建知识体系笔记", "仅能在知识体系目录内创建新笔记；始终先显示预览，绝不改写原始笔记。 ");
    this.addPermissionToggle(containerEl, "appendDailyNote", "允许追加主题 Daily", "手动写入需确认；若另行开启联网结果自动追加，则会在每次搜索后直接追加。 ");
    this.addPermissionToggle(containerEl, "modifyExistingNote", "允许修改既有笔记", "后续启用时仍会强制展示 diff。 ");
    this.addPermissionToggle(containerEl, "createAgentSession", "允许创建 Agent 会话", "创建会话笔记时会显示预览；确认后，当前会话的问答与 Agent 工具摘要可自动追加到同一份笔记。 ");
    this.addPermissionToggle(containerEl, "appendAgentSession", "允许追加当前 Agent 会话", "仅追加到用户已确认创建的当前会话笔记；每次本地追加都会记录审计事件。 ");
    this.addPermissionToggle(containerEl, "updateAgentProfile", "允许更新 Agent 用户画像", "画像更新始终先展示预览；Agent 不能自动修改用户画像。 ");

    this.addFolderListSetting(containerEl, "可读取目录", "readableFolders", "默认：*（整个 Vault）");
    this.addFolderListSetting(containerEl, "可发送给模型的目录", "uploadableFolders", "默认：*（整个 Vault）");
    this.addFolderListSetting(containerEl, "可后台索引的资料目录", "indexableFolders", "默认：*（整个 Vault）");
    this.addFolderListSetting(containerEl, "可修改的既有笔记目录", "modifiableFolders", "默认：*（整个 Vault）");
    this.addFolderListSetting(containerEl, "敏感目录", "sensitiveFolders", "例如：Private, 证件");
    this.addFolderSetting(containerEl, "Inbox 目录", "inboxFolder", "默认：00 Inbox/Agent");
    this.addFolderSetting(containerEl, "主题 Daily 目录", "dailyFolder", "默认：daily");
    this.addFolderSetting(containerEl, "知识体系目录", "knowledgeSystemFolder", "默认：知识体系/Agent");
    this.addFolderSetting(containerEl, "Agent 记忆目录", "agentMemoryFolder", "默认：00 Inbox/Agent");

    new Setting(containerEl)
      .setName("恢复初始全 Vault 权限")
      .setDesc("将所有能力设为允许、目录范围恢复为 *，并清空敏感目录。适合将旧版本配置迁移到新的初始状态。")
      .addButton((button) =>
        button.setButtonText("恢复初始权限").setWarning().onClick(async () => {
          await this.plugin.resetPermissionPolicy();
          new Notice("已恢复全 Vault 初始权限，并清空敏感目录。 ");
          this.display();
        })
      );
  }

  private addPermissionToggle(
    containerEl: HTMLElement,
    action: PolicyAction,
    name: string,
    description: string
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.permissions.enabled[action])
          .onChange(async (value) => {
            await this.plugin.updatePermissionPolicy({
              enabled: { [action]: value }
            });
          })
      );
  }

  private addFolderListSetting(
    containerEl: HTMLElement,
    name: string,
    key: "readableFolders" | "uploadableFolders" | "indexableFolders" | "modifiableFolders" | "sensitiveFolders",
    placeholder: string
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(key === "sensitiveFolders"
        ? "用英文逗号分隔。敏感目录仍可本地使用，但绝不会发送给 DeepSeek 或 GLM。"
        : "用英文逗号分隔。使用 * 表示整个 Vault。")
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.permissions[key].join(", "))
          .onChange(async (value) => {
            const folders = value
              .split(",")
              .map((folder) => folder.trim())
              .filter(Boolean);
            await this.plugin.updatePermissionPolicy({ [key]: folders });
          })
      );
  }

  private addFolderSetting(
    containerEl: HTMLElement,
    name: string,
    key: "inboxFolder" | "dailyFolder" | "knowledgeSystemFolder" | "agentMemoryFolder",
    placeholder: string
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc("必须是 Vault 内的相对路径。")
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.permissions[key])
          .onChange(async (value) => {
            await this.plugin.updatePermissionPolicy({ [key]: value.trim() });
          })
      );
  }
}

function formatKeyStatus(status: { deepSeek: boolean; glm: boolean; tavily: boolean }): string {
  const describe = (loaded: boolean) => loaded ? "已加载" : "未填写";
  return `当前状态：DeepSeek ${describe(status.deepSeek)}；GLM ${describe(status.glm)}；Tavily ${describe(status.tavily)}。`;
}

function clampAttachmentRequestLimit(value: number): number {
  return Math.min(500, Math.max(1, value));
}

function clampAttachmentInputMbLimit(value: number): number {
  return Math.min(2_000, Math.max(1, value));
}

function clampAttachmentInterval(value: number): number {
  return Math.min(300_000, Math.max(0, value));
}

function formatWebFallbackPolicy(policy: WebFallbackPolicy): string {
  switch (policy) {
    case "stable-only":
      return "仅稳定知识自动兜底（推荐）";
    case "always-with-warning":
      return "始终兜底，并提示可能过期";
    case "disabled":
      return "不使用通用回答兜底";
  }
}

function isWebFallbackPolicy(value: string): value is WebFallbackPolicy {
  return (WEB_FALLBACK_POLICIES as readonly string[]).includes(value);
}
