# 独立桌面端

这是项目脱离 Obsidian 的 Electron + React 桌面端。界面保持单对话风格，能力在主进程中复用原插件的模型、记忆、写入和知识整合模块。

## 启动

需要 Node.js 20 或更高版本。

    cd desktop
    npm.cmd install
    npm.cmd run dev

选择过的知识库目录、会话索引和附件索引只保存在 Electron 的本地用户数据目录。除用户主动点击写入、编译 Wiki、处理附件或整理剪贴板外，应用不会改写知识库文件。

如果要彻底脱离 Obsidian，点击右上角“迁移 Obsidian 笔记”：先选择原 Vault，再选择迁移后知识库的存放位置。应用会创建“原库名-知识环迁移”目录，复制所有 Markdown、图片、PDF 和其他附件，并保持原目录结构与 Obsidian 链接路径。原 Vault 不会被改动；.obsidian、.git 和本地插件设置不会复制，因此 API Key 不会被带走。

## 当前功能

- src/main.ts：Electron 主进程、目录选择、索引生命周期与 IPC。
- src/preload.ts：通过 contextBridge 暴露最小桌面 API。
- src/renderer/：中文单对话界面，左侧提供可折叠的 Markdown 笔记目录；点击文件可在应用内预览 Markdown / LLM Wiki 页面、跟随 Wiki 链接继续阅读，也保留外部打开。用户在对话中直接描述目标，Agent 会路由到问答、会话、用户画像、LLM Wiki、图片解析、剪贴板整理、笔记关联或联网核验；模型配置与 Obsidian 迁移收在“更多”菜单。
- ../src/core/knowledge-repository.ts：桌面端与插件共用的只读工作区接口。
- ../src/indexing/portable-markdown-knowledge-index.ts：不依赖 Obsidian API 的 Markdown 分块、权限过滤和检索。
- ../src/desktop/node-file-system-knowledge-repository.ts：用户选择目录的 Node 文件系统适配器，负责 Markdown、原始 JSON 和附件读取写入。
- ../src/desktop/desktop-agent-service.ts：DeepSeek 本地问答、Tavily 补证和无网页结果兜底。
- ../src/desktop/desktop-session-service.ts：同一会话持续追加到一份 Markdown，并读取用户画像作为长期上下文。
- ../src/desktop/desktop-write-service.ts：沿用原策略的 Inbox/Daily 写入。
- ../src/desktop/desktop-wiki-service.ts：本地资料 → DeepSeek 知识地图 → LLM Wiki 页面和注册表。
- ../src/desktop/desktop-wiki-verification-service.ts：按问题命中已有 Wiki 页面，Tavily 联网检索后由 DeepSeek 对比两组证据；只生成查漏补缺报告和可确认的增量更新预览，不会自动写回页面。
- ../src/desktop/desktop-attachment-service.ts：图片扫描、DeepSeek Vision 解析、批量状态持久化和问答检索接入；PDF 会保留在知识库中，但当前不会被模型解析。
- ../src/desktop/desktop-relation-service.ts：基于当前笔记和候选笔记生成并写入托管关联区块。

模型密钥通过应用数据目录下的 `.env` 注入：DeepSeek 负责文本与图片（`DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp`），Tavily 负责网页检索。保存 `.env` 后下一次操作即时读取，无需重启。
