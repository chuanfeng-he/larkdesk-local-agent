# LarkDesk Local Agent

一个本地优先、低成本、高可控的 TypeScript/Node.js 智能体工作台，面向飞书消息接入、网页大模型调度、任务审计、知识沉淀，以及本地编码 handoff / CLI 执行。

它适合这几类场景：

- 把飞书当作移动端入口，在手机上发消息驱动本机工作流
- 统一编排 `ChatGPT / Gemini / Claude / Qwen / Grok / DeepSeek / 豆包` 等 provider
- 对复杂问答、文档、PPT、图片、视频规划、编码任务做不同链路路由
- 为本地执行保留任务状态、审计记录、审批流和工件产物

## 项目亮点

- 低成本可落地：默认可用网页 provider + 本地持久化会话，很多场景下几乎不需要额外 API 成本
- 性能强：把不同模型和执行链拆开调度，复杂任务、编码任务、文档任务都能走更合适的路径
- 高可控：任务路由、审批策略、工件产物、Provider 开关、提示词和选择器都能自己掌握
- 复杂任务不裸跑：复杂、高风险或高质量要求的任务会按需进入审核、复核、仲裁和人工审批链路，不是单轮直接执行
- 多阶段执行更稳：支持 `分类 -> 路由 -> 草拟 -> 复核 -> 审计 -> 仲裁 -> 执行 / 交付` 的结构化流程
- 知识库与记忆沉淀：支持 `knowledge / memory` 读写与检索，方便沉淀项目上下文、人工经验和长期信息
- 全链路可追踪：任务状态、步骤、审批记录、Provider 状态、监控事件都能通过接口回查
- 工件交付完整：文档、PPT、图片提示词包、视频规划、编码 handoff 等产物会结构化落盘，便于复用和交接
- 飞书双接入：同时支持 `Webhook 推送` 和 `自建应用事件接收`
- 本地优先：默认数据写入 `data/`，浏览器会话写入 `.profiles/`
- 路由可控：按任务类型、风险、质量等级、预算选择 provider 与执行链
- 审批友好：内置授权续跑、桌面控制、工程写入、模型升级等审批策略
- 编码闭环：支持 `Codex handoff artifacts`，也支持按需启用本地 CLI runner
- 二次开发友好：支持注入自定义 `provider / executor / notifier / route / approval policy`

## 架构概览

```text
.
├── apps/server                # Fastify 服务入口、HTTP API、监控控制台
├── packages/core              # 任务模型、编排器、路由、审计、契约类型
├── packages/integrations      # 飞书接入
├── packages/providers         # 各类网页 / API provider
├── packages/executors         # 文档、PPT、图片、视频等工件执行器
├── packages/storage           # Prisma + SQLite 持久化
├── packages/local-access      # 本地上下文访问层
├── config                     # provider、route、prompt、selector 配置
├── scripts                    # 初始化、登录、验收、辅助脚本
└── tests                      # 回归与启动测试
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 复制环境变量模板

```bash
cp .env.example .env
```

### 3. 本地开发启动

```bash
pnpm dev
```

默认服务地址：

- `GET http://127.0.0.1:3000/health`
- `GET http://127.0.0.1:3000/providers`
- `GET http://127.0.0.1:3000/tasks`
- `POST http://127.0.0.1:3000/tasks`

### 4. 一键拉起整套环境

如果你已经配置好飞书和浏览器登录态，推荐直接：

```bash
pnpm stack:up
```

如果你想一次性拉起全部网页 provider，并尽量减少窗口干扰：

```bash
pnpm stack:up:all
```

需要可见浏览器窗口排查登录问题时：

```bash
STARTUP_BROWSER_UI=visible pnpm stack:up:all
```

## 详细飞书配置

项目里有两条飞书链路：

1. `FEISHU_WEBHOOK_URL`
用途：给固定群或机器人 webhook 推送状态消息

2. `FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFICATION_TOKEN / FEISHU_DEFAULT_CHAT_ID`
用途：让飞书自建应用接收用户消息、回复结果、驱动本地任务

### A. 创建飞书自建应用

1. 打开飞书开放平台并创建一个“企业自建应用”
2. 进入应用的“凭证与基础信息”
3. 记录以下字段：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

4. 打开机器人能力，给应用开启机器人
5. 按控制台提示申请消息相关权限

建议至少确认这些方向的权限已经开通：

- 接收用户发送给机器人的消息
- 发送消息到单聊 / 群聊
- 获取会话或群聊基础信息

### B. 配置事件订阅

如果你用的是公网回调：

- 事件接收地址配置为 `POST http://<your-host>/feishu/events`

如果你主要通过本机长连接模式跑飞书机器人，可以在 `.env` 打开：

```env
FEISHU_USE_LONG_CONNECTION=true
```

这样服务重启后执行：

```bash
pnpm stack:up
```

飞书机器人会尝试继续以长连接方式工作。

### C. 配置 `.env`

最小示例：

```env
FEISHU_WEBHOOK_URL=
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
FEISHU_USE_LONG_CONNECTION=true
FEISHU_DEFAULT_CHAT_ID=
```

说明：

- `FEISHU_WEBHOOK_URL` 可选，只影响 webhook 推送
- `FEISHU_APP_ID / FEISHU_APP_SECRET` 是自建应用必填
- `FEISHU_VERIFICATION_TOKEN` 用于事件订阅校验
- `FEISHU_DEFAULT_CHAT_ID` 建议显式填写，便于调度器稳定推送

### D. 获取 `FEISHU_DEFAULT_CHAT_ID`

这个值是飞书会话或群聊的 `chat_id`。

推荐方式：

1. 先把机器人加进目标会话或目标群
2. 先在那个会话里给机器人发一条消息
3. 再通过接口查询，或直接从本地历史任务里读取

获取 `tenant_access_token`：

```bash
curl -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"cli_xxx","app_secret":"xxx"}'
```

查询会话列表：

```bash
curl -X GET 'https://open.feishu.cn/open-apis/im/v1/chats?page_size=50' \
  -H 'Authorization: Bearer tenant_access_token'
```

返回数据中的 `chat_id` 就是要填入 `.env` 的值，通常形如：

```env
FEISHU_DEFAULT_CHAT_ID=oc_xxx
```

补充说明：

- 如果 `FEISHU_DEFAULT_CHAT_ID` 暂时留空，调度器会优先尝试复用最近一次飞书会话里的 `chat_id`
- 这适合本地调试，但生产或长期运行仍建议显式填写

### E. 验证飞书接入

1. 先验证服务是否起来：

```bash
curl http://127.0.0.1:3000/health
```

2. 验证 webhook：

```bash
curl -X POST http://127.0.0.1:3000/feishu/webhook/push \
  -H 'content-type: application/json' \
  -d '{"text":"hello from LarkDesk Local Agent"}'
```

3. 给飞书机器人发一条消息，比如：

```text
请简单介绍一下这个系统
```

4. 本地服务应收到 `POST /feishu/events`，并回写结果

## 代码使用说明

### 环境变量

基础运行相关：

```env
PORT=3000
HOST=127.0.0.1
DATABASE_URL=file:../../../data/office-agent.db
CONFIG_DIR=./config
TASK_ARTIFACT_DIR=./data/task-artifacts
SCREENSHOT_DIR=./data/screenshots
```

本地 CLI / 编码接入相关：

```env
CODEX_RUNNER_ENABLED=false
CODEX_RUNNER_MODE=artifacts_only
CODEX_COMMAND=codex
CODEX_ARGS=
LOCAL_ACCESS_WORKSPACE_ROOT=.
LOCAL_ACCESS_CODEX_MODE=disabled
LOCAL_ACCESS_CODEX_COMMAND=codex
LOCAL_ACCESS_CODEX_ARGS=
```

Gemini CLI / API 相关：

```env
GEMINI_RUNNER_ENABLED=false
GEMINI_COMMAND=gemini
GEMINI_ARGS=
GEMINI_API_KEY=
```

### 常用命令

```bash
pnpm install
pnpm dev
pnpm stack:up
pnpm stack:up:all
pnpm stack:down
pnpm test
pnpm typecheck
pnpm demo:mock
pnpm provider:login chatgpt_web
pnpm provider:login claude_web
pnpm provider:login qwen_web
pnpm provider:login grok_web
pnpm playwright:install
```

### 最小任务提交示例

```bash
curl -X POST http://127.0.0.1:3000/tasks \
  -H 'content-type: application/json' \
  -d '{"input":"请简单介绍一下这个系统","requestedType":"SIMPLE"}'
```

### 常用 API

- `GET /health`：健康检查
- `GET /providers`：provider 健康状态
- `GET /tasks`：最近任务列表
- `GET /tasks/:id`：任务详情
- `POST /tasks`：提交任务
- `POST /tasks/:id/stop`：人工停止任务
- `POST /tasks/:id/intervene`：转人工介入
- `POST /tasks/:id/approve`：批准续跑
- `POST /tasks/:id/reject`：拒绝续跑
- `GET /knowledge`：知识检索
- `POST /knowledge`：手工写入知识
- `GET /approvals`：审批记录
- `POST /feishu/events`：飞书事件回调
- `POST /feishu/webhook/push`：测试 webhook 推送

## Provider 与模型使用建议

配置入口：

- `config/providers.yaml`
- `config/routing-policy.yaml`
- `config/prompts/*.md`
- `config/selector-profiles/*.yaml`

推荐的运行方式：

- `chatgpt_web`：CDP 常开窗口
- `gemini_web`：CDP 常开窗口
- `doubao_web`：CDP 常开窗口
- `claude_web`：CDP 常开窗口
- `qwen_web`：CDP 常开窗口
- `grok_web`：CDP 常开窗口
- `deepseek_web`：持久化 profile 复用
- `gemini_api`：适合纯 API 路径
- `mock_provider`：本地联调和 smoke test

首次登录网页 provider：

```bash
pnpm playwright:install
pnpm provider:login chatgpt_web
pnpm provider:login claude_web
pnpm provider:login qwen_web
pnpm provider:login grok_web
```

如果某个页面改版，优先调整对应 selector profile，而不是先改业务逻辑。

## 编码任务与工件产物

默认情况下，编码任务会保留 handoff 产物，不强依赖本地 CLI：

- `codex_task.md`
- `implementation_brief.md`
- `implementation_plan.json`
- `acceptance_checklist.md`
- `context_summary.md`

这些文件会落在：

```text
data/task-artifacts/<taskId>/
```

如果你希望真的调本地 Codex CLI，可按需启用：

```env
CODEX_RUNNER_ENABLED=true
CODEX_RUNNER_MODE=cli
CODEX_COMMAND=codex
CODEX_ARGS=
```

## 图片 / 文档 / PPT / 视频规划能力

当前工件执行器已经覆盖：

- `doc_markdown`
- `ppt_markdown`
- `image_prompt`
- `video_plan`

图片任务特性：

- 会生成 prompt pack
- 若 provider 返回可下载图片，会自动写入 artifact 目录
- 飞书侧优先尝试回图片消息，失败时会退化为明确错误提示

## 二次开发与扩展

当前框架已经留出这些扩展入口：

- 自定义 provider
- 自定义 artifact executor
- 自定义 notifier
- 自定义审批策略
- 自定义 HTTP route

服务启动层支持扩展注入，避免二次开发者直接硬改主链路。

示例能力包括：

- 在 `createServices(..., { extensions })` 里注册扩展
- 在 `buildApp(..., { extensions })` 里追加 API route
- 在扩展里注入新的 `ProviderAdapter`
- 在扩展里追加新的审批策略

详细示例见：

- [docs/extension-guide.md](./docs/extension-guide.md)
