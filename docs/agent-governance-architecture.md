# 智能体治理架构

## 分层

1. 接入层
   - `FeishuBotApp`
   - `POST /tasks`
   - `GET /tasks/:id`
   - `GET /monitor`

2. 编排治理层
   - `TaskOrchestrator`
   - `RouterV2`
   - `AuditEngine`
   - `RoleRegistry`
   - `SkillRegistry`
   - `MonitorHub`

3. 执行层
   - Web providers
   - `LocalCodexRunner`
   - Artifact executors
   - `LocalAccessLayer`

4. 存储与观测层
   - `PrismaTaskStore`
   - Task steps
   - Monitor event stream

## 角色制度

| 角色 ID | 名称 | 职责 | 默认资源 |
| --- | --- | --- | --- |
| `crown_orchestrator` | 舰长 | 统一编排、决策流转、升级策略 | 本地编排器 |
| `zhongshu_drafter` | 首席科学官 | 起草首稿、生成候选答复 | 轻量到中强模型 |
| `hanlin_reviewer` | 大副 | 复审和补充边界条件 | 中强模型 |
| `menxia_auditor` | 安全官 | 审核、门禁、驳回 | 强模型优先 |
| `zhongshu_arbiter` | 通讯官 | 多意见仲裁整合 | 强模型 |
| `shangshu_executor` | 轮机长 | 文档/PPT/图片/视频执行 | Executor |
| `junji_implementer` | 导航员 | 编码实施、Codex 交接、测试 | Codex + coding provider |
| `sitian_monitor` | 瞭望塔 | 实时监控、告警、干预视图 | MonitorHub |

## 审核触发规则

- 用户 prompt 包含 `审核 / 审查 / 复核 / 严审`
- 质量等级为 `high / strict`
- 风险等级为 `high / critical`
- 复杂度分 `>= 0.7`
- 任务产物类型为 `doc / ppt / image / video`

一旦命中触发规则，进入 `audit_pending`，安全官必须给出结构化输出：

```text
结论：pass / revise_required / reject
问题：
- ...
建议：
- ...
风险级别：low / medium / high / critical
```

## 状态流

```text
queued
-> classifying
-> routing
-> skill_planning
-> drafting
-> reviewing
-> arbitrating
-> audit_pending
-> audit_revising
-> handoff_to_codex
-> implementing
-> testing
-> completed
```

异常状态：

- `failed`
- `needs_manual_login`
- `needs_human_intervention`

## 监控事件

- `task.accepted`
- `task.status_changed`
- `task.route_selected`
- `task.skills_selected`
- `provider.started`
- `provider.completed`
- `provider.failed`
- `audit.required`
- `audit.passed`
- `audit.revise_required`
- `audit.rejected`
- `task.completed`
- `task.failed`

## API

- `GET /monitor`
  - 返回任务状态、心跳、provider 调用摘要、近期事件
- `GET /monitor/events`
  - 返回事件流
- `GET /monitor/dashboard`
  - 返回 WebSocket 实时看板页面
- `GET /roles`
  - 返回制度化角色定义
- `GET /skills`
  - 返回技能注册表

## 配置化入口

- [roles.yaml](/home/hcf/iai/config/roles.yaml)
  - 角色定义、职责、能力偏好、热切换能力
- [skills.yaml](/home/hcf/iai/config/skills.yaml)
  - 技能定义、适用意图、权重、关键字、资源提示

服务启动时会通过 [config.ts](/home/hcf/iai/packages/core/src/config.ts) 读取这些 YAML，再注入到 [bootstrap.ts](/home/hcf/iai/apps/server/src/bootstrap.ts) 里的 `RoleRegistry` 和 `SkillRegistry`。

## 热重载

- 默认开启 `CONFIG_HOT_RELOAD=true`
- 服务启动后会监听：
  - [roles.yaml](/home/hcf/iai/config/roles.yaml#L1)
  - [skills.yaml](/home/hcf/iai/config/skills.yaml#L1)
- 文件变更后会原地替换 registry，不需要重启服务
- 如果 YAML 写错，旧配置会继续保留，同时会发出 `config.reload_failed` 监控事件

## 启动与关闭

- 启动整套服务：
  - `pnpm stack:up:all`
- 关闭整套服务：
  - `pnpm stack:down`
- 实时看板：
  - `http://127.0.0.1:3000/monitor/dashboard`

## Task Metadata 示例

```json
{
  "intent": "doc",
  "budget": "high",
  "artifactType": "doc",
  "qualityLevel": "strict",
  "riskLevel": "high",
  "complexityScore": 0.82,
  "audit": {
    "requested": true,
    "required": true,
    "triggers": ["prompt_required", "quality_gate", "artifact_guardrail"],
    "strategy": "structured_gate",
    "maxRevisionRounds": 1,
    "provider": "chatgpt_web"
  },
  "selectedSkills": [
    {
      "id": "review_text",
      "weight": 1.35,
      "reason": "audit_guardrail",
      "required": true
    },
    {
      "id": "summarize",
      "weight": 0.63,
      "reason": "matched_registry",
      "required": false
    }
  ],
  "rolePlan": {
    "chain": [
      { "role": "crown_orchestrator", "title": "舰长", "mode": "required" },
      { "role": "zhongshu_drafter", "title": "首席科学官", "mode": "required", "provider": "doubao_web" },
      { "role": "hanlin_reviewer", "title": "大副", "mode": "optional", "provider": "gemini_web" },
      { "role": "menxia_auditor", "title": "安全官", "mode": "required", "provider": "chatgpt_web" },
      { "role": "zhongshu_arbiter", "title": "通讯官", "mode": "required", "provider": "chatgpt_web" },
      { "role": "shangshu_executor", "title": "轮机长", "mode": "required", "provider": "doc_markdown" },
      { "role": "sitian_monitor", "title": "瞭望塔", "mode": "required" }
    ]
  }
}
```

## 后续扩展建议

1. 将 `RoleRegistry` 和 `SkillRegistry` 配置化，支持 YAML/DB 热更新。
2. 将 `MonitorHub` 事件同步到 WebSocket 和飞书诊断群。
3. 为 `AuditEngine` 增加结构化 JSON parser 和更严格的重试策略。
4. 将 `needs_human_intervention` 接入人工审批按钮或飞书卡片回调。
