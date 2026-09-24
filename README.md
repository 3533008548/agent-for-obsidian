# 知识环（Knowledge Loop Agent）

本地优先的个人知识 Agent，Electron + React 桌面应用。它以你选择的一个普通文件夹作为知识库，目标是安全完成：

> 资料入库 → 带来源问答 → 受规则约束的笔记沉淀 → `daily/<主题>.md` → 按需知识回顾

项目不依赖 Obsidian。Vault 迁移只是可选入口之一：点“迁移 Obsidian 笔记”可把原 Vault 复制成独立知识库。

## 开始使用

需要 Node.js 20 或更高版本。

```powershell
npm.cmd install
npm.cmd run dev
```

密钥在应用数据目录的 `.env` 中填写（界面“模型配置”可直接打开），不写入知识库。DeepSeek 负责文本与图片，Tavily 负责网页检索。保存后下一次操作即时读取，无需重启。

```env
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp
TAVILY_API_KEY=
WEB_FALLBACK_POLICY=stable-only
```

常用命令：`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/` | Electron 主进程、preload 与 React 渲染层 |
| `core/` | 与界面无关的内核：权限、检索、模型客户端、Agent 运行时、Wiki、写入管线 |
| `tests/` | 内核与桌面服务的单元测试（不联网、不启动 Electron） |

`core/` 不引用任何 Obsidian API，这是它能被桌面应用直接复用的前提。

## 当前能力

- **语义化 Agent 运行时**：描述一个目标后，模型只提出至多四步的计划，由本地运行时校验工具白名单、步骤依赖与执行状态。模型不能直接调用工具，也不能直接写文件。
- **受控写入**：Inbox 新建、Daily 追加、知识地图、LLM Wiki 与笔记关联补全都先生成写入预览，确认后才落盘；预览后文件若被改动会拒绝覆盖。同名 Inbox 自动改用数字后缀。
- **带来源问答**：本地检索优先，零命中或来源不可外发时自动改为联网补证；通用回答会明确标识，且不能作为联网结果写入。
- **LLM Wiki**：把相关笔记编译成 `LLM Wiki/index.md`、主题概览与概念页，页面互相链接并回链原始资料；同主题再次编译只更新原页。已有 Wiki 时，提问会按“搜索 → 阅读 → 跟随链接 → 回答”遍历。
- **知识体系整合与维护分析**：生成知识地图与节点草稿，或按目标输出重叠、冲突、缺口与过时项，均只产出可确认的写入预览。
- **图片索引**：图片经 DeepSeek Vision 解析，支持可恢复批处理、限速与每日预算。**PDF 会保留在知识库中，但当前不由模型解析。**
- **权限与审计**：读取、外发、索引、写入分别授权；敏感目录内容永不出设备。审计只记录动作元数据，不记录正文。
- **记忆**：用户画像 `Agent Profile.md`、助手状态 `Assistant State.md` 与会话 `Sessions/*.md` 都是可直接编辑的 Markdown，不作为知识库事实。

## 使用 Agent 计划

输入框旁的“生成计划”会把目标交给 Agent 规划；计划卡片中逐步点“确认并执行”，涉及模型调用或写入的步骤都会先要你确认。写入预览出现后，检查内容再点“确认写入”。

直接回车仍然是快速问答，不会额外产生一次规划请求。

## 隐私与安全

- API Key 只保存在本机应用数据目录的 `.env`。
- 知识库路径、会话索引与附件索引保存在 Electron 用户数据目录。
- 除你主动确认的写入、Wiki 编译、附件处理与剪贴板整理外，应用不会改写知识库文件。
- 迁移 Obsidian Vault 时不复制 `.obsidian`、`.git` 与插件设置，因此不会带走 API Key；原 Vault 不会被改动。

## 开源协议

MIT
