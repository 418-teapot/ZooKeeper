> Path note (2026-06-28): prompt files have since moved to src/agents/<name>.ts; paths below reflect the pre-refactor layout.

# ZooKeeper Plan Mode: 完整设计文档

**Version: 1.7 — Date: 2026-06-27 — Classification: 设计方案**

> **前置阅读**: [`plan-mode-research.md`](./plan-mode-research.md) 覆盖 6 月 10 日的早期调研（plan mode 检测与切换机制）。本文档 v1.0 在调研 omo/slim/omp 的基础上加入 ECC，深入探索了 session reuse、handoff、unreconciled 等具体机制。**v1.1** 对四项目约 20 个关键源文件进行代码级验证。**v1.3** P0 mola subagent 废弃，handoff 确认为正确方向。**v1.5** P1 Steps 2 & 6 完成实施。**v1.6** sessionID 正式采纳，project-id 方案废弃——plan 文件按 sessionID 分子目录，跨 session 发现用扫描方案替代索引文件。**v1.7** Plan progress nudge pipeline 统一——共享检查函数 + 6 个对称 nudge 常量 + 两端点注入覆盖所有代码变更。

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [为什么需要 Plan Mode](#2-为什么需要-plan-mode)
3. [四项目架构全景对比](#3-四项目架构全景对比)
4. [深度机制调研: Session Reuse](#4-深度机制调研-session-reuse)
5. [深度机制调研: Handoff](#5-深度机制调研-handoff)
6. [深度机制调研: Background Job Board](#6-深度机制调研-background-job-board)
7. [核心架构决策: Resume vs Handoff](#7-核心架构决策-resume-vs-handoff)
8. [最终设计方案](#8-最终设计方案)
9. [状态机设计](#9-状态机设计)
10. [Plan 文件结构](#10-plan-文件结构)
11. [完备性门控 (Completeness Gate)](#11-完备性门控-completeness-gate)
12. [多 Project Plan 管理](#12-多-project-plan-管理)
13. [权限与工具控制](#13-权限与工具控制)
14. [实施路径](#14-实施路径)
15. [未来演进](#15-未来演进)
16. [决策日志](#16-决策日志)
17. [参考资料](#17-参考资料)
18. [修订记录](#18-修订记录)

---

## 1. 执行摘要

本文档记录了对 **oh-my-openagent (omo)**、**oh-my-opencode-slim (slim)**、**oh-my-pi (omp)**、**ECC** 四个 OpenCode 生态项目的深度调研，并基于调研结果敲定了 ZooKeeper Plan Mode 的完整架构设计。

**关键发现**:

1. **编排质量上限不在 subagent 能力，而在任务分解精准度** —— Plan Mode 是 ZooKeeper 当前最大杠杆点
2. **四个项目用完全不同的方式解决"追踪并行任务"**，但核心思想趋同：外挂 LLM 的短期记忆，用结构化状态呈现
3. **Plan 必须是 primary agent（handoff 模式）** —— subagent 方案（P0）尝试后证实不可行，handoff 是唯一满足多轮规划需求的架构
4. **ZooKeeper 已有 session reuse 基础设施**（OpenCode 原生 `task_id`），缺的是 prompt 纪律 + 自动追踪 + plan 文件持久化

**最终设计要点**:

- **Plan 作为 primary agent**（handoff 模式），通过新会话 handoff 与 build orchestrator 协作
- **Plan 文件存储于 `~/.zoo/plans/<project-id>/<slug>-<YYYYMMDD>.md`** —— 用户级集中管理，按 git remote / basename 推导 project-id
- **YAML frontmatter + markdown body + checkboxes** —— 状态字段（`planning`/`planning-done`/`executing`/`done`）+ TODOs 列表
- **新会话 handoff 为默认方案** —— 规划与执行 session 物理分离，`parentID` 关联保留可追溯性
- **静态 deny + hook 路径约束**: mola 允许 `edit`/`write`（路径约束至 `~/.zoo/**/*.md`），禁止 `task`（P2 再开）；bash 靠 prompt 约束只跑诊断命令
- **Plan 文件由 mola 直接写**（hook 路径约束保证安全），orchestrator 仅维护 `_projects.json` 索引与状态更新
- **完备性门控**: 四个知识缺口自检 + reasoning 输出，替代原始的三层混合判定
- **未来为 BackgroundManager 和 Job Board 预留扩展点**（P2）

**实施路径**: 6 步，分布在 6 个组件（P0 mola subagent 已尝试并废弃）。

---

## 2. 为什么需要 Plan Mode

### 2.1 当前 ZooKeeper 的痛点

ZooKeeper 当前的工作流是 build agent + 5 个 subagent（general/explore/spider/eagle/kiwi）的委派模式。这种模式在处理明确任务时流畅，但存在结构性缺陷：

| 问题 | 表现 | 影响 |
|------|------|------|
| **分解粒度不稳定** | 有时拆太细（micro-delegation），有时拆太粗（"also"/"additionally"）| 每个多步任务都可能出错 |
| **无显式依赖图** | sub-task 间的先后关系和上下文传递全靠 orchestrator 写 CONTEXT | 信息容易丢失 |
| **无回溯机制** | sub-task 失败后只能机械重试，不能重新规划 | 错误累积 |
| **缺乏规划触发器** | 用户说"帮我想想怎么重构"时，build agent 仍尝试直接实现 | 用户体验断层 |
| **实现冲动** | LLM 天然倾向产出可运行代码，在讨论场景仍尝试工具调用 | 规划沦为形式 |

### 2.2 Plan Mode 解决什么

Plan Mode 在"**说**"和"**做**"之间建立一个结构化的过渡阶段：

```
用户提出模糊需求
     ↓
[Plan Mode] —— 只讨论、只分析、只读代码，不修改任何实现
     ↓
用户确认方案
     ↓
[Implementation Mode] —— 按 plan 文件委派 subagent 执行
```

**核心价值**：将"规划"和"实现"显式解耦，强制 planner 角色聚焦于分析和决策，而非急于产出代码。

---

## 3. 四项目架构全景对比

### 3.1 项目基本信息

| | **omo** (oh-my-openagent) | **slim** (oh-my-opencode-slim) | **omp** (oh-my-pi) | **ECC** |
|---|---|---|---|---|
| 定位 | OpenCode + Codex 全栈 AI 开发环境 | OpenCode 精简插件 | 独立 AI 编码 CLI (Bun) | 跨工具 Agent 技能开发服务器 |
| 语言 | TS (37 包 monorepo) | TS (单包) + Rust (companion) | TS + Rust | TS + Rust + Python |
| 代码规模 | ~37 包, 60 hook | 中等 | 13 TS 包 + 6 Rust crate | 67 agent, 271 skill, 92 cmd |
| 配置格式 | JSONC + Zod v4 | JSONC + Zod | YAML | JSON/YAML + plugin.json |
| 框架绑定 | OpenCode + Codex | OpenCode | 自有 CLI | 7 个工具（Claude/Codex/OpenCode/Cursor/Gemini/Zed/Copilot）|

### 3.2 Agent 架构

| | **omo** | **slim** | **omp** | **ECC** |
|---|---|---|---|---|
| Agent 数量 | 11 (4 primary + 7 subagent) | 9 (1 orchestrator + 8 specialist) | 8 捆绑 + 用户自定义 | 67 个专业 agent |
| 定义方式 | TS 工厂函数（编译后）| TS 工厂 + `.md` 覆盖 | `.md` + YAML frontmatter + 自动发现 | `.md` + YAML frontmatter |
| Orchestrator 角色 | Sisyphus（协调者）| 明确不做实现（"You are not the default implementation worker"）| 主 agent（system-prompt.ts 组合）| 无固定 orchestrator，由 planner agent 路由 |
| SubAgent 模型 | Prometheus → Atlas → Sisyphus-Junior 三层 | orchestrator → specialist（background task）| plan → task/explore/oracle 动态生成 | 平面 —— 主 agent 按需调用专业 agent |
| 模型多态 | ⭐ 每个模型家族不同 prompt（8 变体）| 支持 preset 切换 | 角色路由（default/smol/slow/plan）| 按 agent 指定（opus/sonnet）|

### 3.3 工作流 / 编排

| | **omo** | **slim** | **omp** | **ECC** |
|---|---|---|---|---|
| Plan 模式 | ⭐ Prometheus → Metis → Momus 三层规划 → Atlas 执行 | Background Job Board + 4 阶段 workflow | `orchestrate` 命令 → plan agent（只读）+ task agent | `plan.md` 命令 → planner agent → 用户确认 → 执行 |
| 分解粒度 | 三层层级：战略(Pr)→战术(At)→执行(SJ)| 背景任务 + 依赖图 | DAG + topo 排序 | 按命令/技能粒度分解 |
| 并行执行 | ⭐ Team Mode（8 并行 + mailbox 通信）| ✅ `background: true` + Job Board | ✅ 工作树隔离 + 子 agent IRC | ❌ 基本串行 |
| 用户参与计划 | 用户审核后写入 `.omo/plans/` | 无显式计划审核步骤 | 无显式计划审核步骤 | ⭐ 强制用户确认后才执行 |
| 多模型协同 | 多模型 prompt（同 agent 不同模型）| ⭐ Council（多 LLM 共识引擎）| 无 | ⭐ Multi-plan（Claude+Codex+Gemini 并行）|

### 3.4 权限 / 安全

| | **omo** | **slim** | **omp** | **ECC** |
|---|---|---|---|---|
| 权限模型 | 每 agent `ask/allow/deny` (Zod) | 每 agent permission map（代码声明）| 工具 tier + 批准模式 | 每 agent 工具 allowlist |
| 审查者限制 | 无专门角色 | oracle 只读 | plan agent 工具受限 | ⭐ reviewer 明确无 `write`/`edit` |
| 安全护栏 | 53-60 hook | 12+ hook | TTSR（流中止 + 重试）| ⭐ AgentShield + 提示防御基线 + 配置保护 |

### 3.5 独特设计亮点

| 项目 | 核心独创设计 |
|---|---|
| **omo** | 模型家族多态（8 套 prompt 按检测到的模型自动选择）；Hashline 内容哈希锚定编辑；Metis 预规划 + Momus 严苛审阅；BackgroundManager 完整运行时 |
| **slim** | Council 多 LLM 共识引擎（嵌套 subagent 架构）；BackgroundJobBoard（unreconciled 状态机 + alias 重写）|
| **omp** | TTSR（时间旅行流规则 —— 在 LLM 输出流中间匹配、中止、注入、重试，零上下文开销）；Advisor/Watchdog（次级模型并行观察主 agent）|
| **ECC** | 跨工具可移植（7 个 AI 工具共享 skill/rule/hook）；持续学习 v2（直觉系统自动从会话提取模式）；多模型编排（Claude+Codex+Gemini 分工协作）|

---

## 4. 深度机制调研: Session Reuse

### 4.1 三种实现思路对比

| | **omo** | **slim** | **omp** |
|---|---|---|---|
| **核心机制** | `task_id` 参数直传 | `BackgroundJobBoard` + alias 重写 | keep-alive + revive + IRC |
| **状态载体** | OpenCode session（LLM 看到完整历史）| OpenCode session（同上）| JSONL 文件（session 被 park 后 revive 重建）|
| **续期触发** | orchestrator 显式传 `task_id` | orchestrator 传 alias，hook 重写为真实 ID | IRC 消息 → `ensureLive()` 自动 revive |
| **续期时的上下文** | 完整对话历史（零截断）| 完整对话历史（零截断）| 完整 JSONL 重建的历史 |
| **超时/清理** | 30 min 不活跃 → 清理 | 按 agent 类型保留最多 2 个 | 420s idle → park，可 revive |

### 4.2 omo: task_id 续期的完整实现

**核心文件**: `packages/omo-opencode/src/tools/delegate-task/sync-continuation.ts`

```
orchestrator 调用 task(task_id="ses_abc123", prompt="Fix: 类型错误")
  → tools.ts 检测到 task_id → 跳过 agent discovery / model selection / session creation
  → 调用 client.session.messages() 读取完整历史
  → 在同一 session 上调用 client.session.prompt()
  → subagent 的 LLM 看到：完整先前对话 + 新 prompt
  → 返回结果（metadata 里带同一个 ses_abc123）
```

**Prompt 工程（强制续期纪律）**:

Sisyphus prompt 在每个模型变体里都包含：

```
### Session Continuity (MANDATORY)

Every `task()` output exposes a continuation session ID (`ses_...`). Pass it to
`task(task_id="ses_...")` for follow-ups. **USE IT.**

**ALWAYS continue when:**
- Task failed/incomplete → `task(task_id="ses_...", prompt="Fix: {specific error}")`
- Follow-up question on result → `task(task_id="ses_...", prompt="Also: {question}")`
- Multi-turn with same agent → `task(task_id="ses_...")` - NEVER start fresh
- Verification failed → `task(task_id="ses_...", prompt="Failed verification: {error}. Fix.")`

**Why continuation is CRITICAL:**
- Subagent has FULL conversation context preserved
- No repeated file reads, exploration, or setup
- Saves 70%+ tokens on follow-ups
```

**自动 hook**: `task-resume-info` 自动追加 `to continue: task(task_id="ses_xxx")` 到 task() 输出末尾（tool.execute.after hook）。

### 4.3 slim: alias 重写 + Job Board 注入

**核心创新**: orchestrator 不记真实 session ID，只记**别名**（`fix-1`, `exp-2`）。

```typescript
// src/hooks/task-session-manager/index.ts:466-534
tool.execute.before:
  orchestrator 调用 task(subagent_type="fixer", task_id="fix-1")
    → BackgroundJobBoard.resolveReusable(sessionID, "fix-1", "fixer")
    → 找到真实 session ID → 重写 task_id 参数
    → OpenCode 框架复用该 session
```

**Job Board 注入**：通过 `experimental.chat.messages.transform` hook，在每次 API 调用前追加到 orchestrator 的 last user message：

```
Active/Unreconciled:
  [fix-1] fixer — 修复 auth.ts 类型错误 — completed (UNRECONCILED, ready to pull)
  [exp-2] explorer — 搜索认证模块 — running (2m elapsed)

Reusable Sessions:
  [lib-3] librarian — 查找第三方 API 文档 — completed+reconciled, lastUsed 5m ago
```

### 4.4 omp: keep-alive + IRC revive

**没有 task_id 概念**。子 agent 完成后变成 `"idle"` 状态的**对等体**（peer），通过 IRC 消息唤醒。

```
主 agent 调 task(agent="explore", assignment="搜索认证模块")
  → 生成子 agent，运行完毕后 status="idle"
  → 420 秒后 park（JSONL 关闭，进程保留）
  
之后主 agent 调 irc.send(to="explore-1", msg:"auth.ts 里那个 token 校验在哪？")
  → IrcBus.send() 发现 explore-1 是 parked
  → AgentLifecycleManager.ensureLive() → 重新打开 JSONL，重建完整 session
  → explore-1 收到消息，处理，回复
```

### 4.5 关键洞察

**核心共同点**: 三个项目都**保留完整对话历史**（零截断）——续期时 subagent 看到全部先前上下文，这是避免重复探索和 token 浪费的关键。

**关键差异**:
- **omo **是"显式续期"：orchestrator 必须记得用 `task_id`
- **slim** 是"自动重写"：orchestrator 只记别名，hook 负责翻译
- **omp** 是"被动唤醒"：子 agent 不消失，等消息唤醒

---

## 5. 深度机制调研: Handoff

### 5.1 omo Prometheus → Atlas: 核心机制

**最关键的事实**: handoff 发生在**同一个 OpenCode session** 里，不是 session 切换。对话历史保留，plan 通过文件系统传递，agent config 在同一 session 内切换。

### 5.2 完整的三层 handoff 流程

```
Layer 1: 规划阶段 (Prometheus)
  ├── Prometheus prompt 切换（但 session 不变）
  ├── 探索代码库，使用 Metis 做预分析
  ├── 写 .omo/plans/<slug>.md（YAML frontmatter + markdown checkbox）
  ├── 可选: Momus 审查 plan 完整性
  └── 用户批准

Layer 2: 触发 handoff
  ├── 用户说 "start work" 或 $start-work
  ├── OpenCode 路由到 /start-work 命令
  ├── 命令模板里 agent: "atlas" → 切换 agent config（session 不变）
  ├── start-work hook 写 .omo/boulder.json（plan 路径、agent、session IDs）
  └── Atlas 激活（prompt 完全切换，历史保留）

Layer 3: 执行阶段 (Atlas)
  ├── Atlas 读 .omo/boulder.json + plan 文件
  ├── 批量 task() 委派 subagent 执行 checkbox
  ├── 完成一项就改 plan: - [ ] → - [x]
  └── 三层续命 hook（todo-continuation-enforcer / atlas idle-event / Codex stop-checking）
```

### 5.3 状态桥: 文件而不是消息

| 文件 | 写入者 | 读取者 | 内容 |
|---|---|---|---|
| `.omo/plans/<slug>.md` | Prometheus | Atlas | 任务列表（checkboxes）|
| `.omo/boulder.json` | start-work hook | Atlas | 元数据（plan 路径、状态、session IDs）|

**好处**:
- Atlas 的 system prompt 完全独立，不继承 Prometheus 的风格
- Atlas 只需读 plan 文件就知道做什么
- 即使 session 重启，boulder.json 还在 → 可恢复

### 5.4 三层续命 hook

| Hook | 检查条件 | 注入什么 |
|---|---|---|
| `todo-continuation-enforcer` | 有未完成 todo | 剩余 todo 列表 + 状态 |
| `atlas idle-event` | boulder.json 状态 = active + 未完成的 plan | "Read plan file NOW, continue" |
| Codex `stop-checking-start-work` | Stop 事件 + 未勾选的 checkbox | block 决定 + directive 注入 |

**关键洞察**: 自动续命是 **hook 驱动的**，不是 agent prompt 里写的"请继续"。agent 停下来时，系统层面注入续命消息，agent 不知道（也不关心）这是自动的还是用户的。

### 5.5 用户体验

```
用户: "I need to add auth middleware"
  → Sisyphus 决定要规划 → 调 Metis
  → Prometheus 激活（prompt 切换），和用户讨论 plan

用户: "Looks good, start work"
  → /start-work 触发 → Atlas 接管（同一 session）
  → Atlas 开始 task() 委派

用户: [看到 task 一个个完成，plan checkbox 一个个变勾]
  → 全部完成 → boulder.json 标记 completed
```

用户全程感觉在和**同一个 AI** 对话。但底层是三个不同的 agent（Sisyphus→Prometheus→Atlas）在接管。

### 5.6 关键局限 → 已发现可行机制

**原结论**（v1.0）：OpenCode session 绑定一个 agent 配置，切换需要 slash command 或重建 session。

**v1.2 更新**：发现 OpenCode 存在一个未命名的 agent 切换机制——在 `chat.message` 钩子中设置 `output.message["agent"]`，OpenCode 框架读取该字段将消息路由到目标 agent。omo 的 `start-work-hook.ts:81-84` 在生产中验证了此模式：

```typescript
"chat.message"(input, output) {
  output.message["agent"] = "atlas"  // 同一 session 切换到 atlas
}
```

**约束：**
- 只在 `chat.message` 或 `command.execute.before` 钩子生效（`tool.execute.after` 无权访问 `output.message`）
- 需要用户下一条消息触发切换（build 说完 → 用户回复 → hook 拦截 → 路由到 mola）
- 切换后是"粘性的"——后续消息持续路由到目标 agent，直到 hook 显式改回
- **对话历史完全保留**——session ID 不变，消息列表不受影响
- 非官方 API——OpenCode 可能在未来版本变更此行为
- 目标 agent 需 `mode = "primary"` 或 `"all"`（P0 subagent 方案验证了此约束 —— subagent 不能作为 handoff 目标，需升级为 primary）

**新会话 handoff 方案（推荐用于长规划场景）：** 除同会话切换外，OpenCode 还支持自动创建新会话并切换焦点：

- `client.session.create({ body: { parentID, title } })` — 创建子 session，`parentID` 关联原会话
- `client.session.promptAsync({ body: { agent, parts } })` — 注入 plan 上下文并启动目标 agent
- `client.tui.publish({ body: { type: "tui.session.select", properties: { sessionID } } })` — 通过 SSE 事件总线触发 TUI 自动跳转

**v1.2 Day-2 实测修正**：原设计中写的 `tui.selectSession()` 虽然 endpoint 存在且返回 200，但**不会触发 TUI 切换**。TUI 前端通过 SSE 事件总线订阅 `tui.session.select` 事件，必须使用 `tui.publish()` 发布事件才能触发切换（详见 [§16 #42](#16-决策日志)）。

优势：执行会话上下文干净（不受规划长跑拖累）、角色无混淆、规划与执行日志分离便于追溯；`parentID` 关联使 zfind/ztrace 可跨会话追踪。omo 的 `ralph-loop` 模块（迭代延续场景）已在生产验证此三步骤模式。

### 5.7 Omo 规划架构的关键洞见 + P0 mola subagent 方案验证

omo 的规划 agent（Prometheus）是 `mode = "primary"`，与实现编排者（Sisyphus）平级。它拥有独立 session，通过 hook 路径约束其写操作——`prometheus-md-only` hook 把 `edit: "allow"` 限制在 `.omo/*.md` 内。"进入规划" 在 omo 里本身就是 handoff：用户在 UI agent 下拉菜单切换到 Prometheus。

**P0 mola subagent 方案：尝试与废弃。** 基于 omo 架构分析，我们尝试了将规划 agent 作为 subagent 实现的折中路径：mola 通过 `task()` 派生，输出 markdown 文本，由 orchestrator 代写 plan 文件。实际测试发现此方案存在三个不可接受的结构性问题：

1. **无多轮采访能力** —— subagent 在单次 `task()` 调用中只能输出一段文本，无法与用户进行反复辩论、场景压力测试、替代方案权衡等深度对话
2. **编排器沦为消息中继** —— 若通过 orchestrator 透传用户回复实现多轮对话，orchestrator 的 session 上下文被规划对话填满，角色从编排者降格为转发器
3. **角色混淆** —— orchestrator 同时承担编排和中继职责，任务边界模糊，用户感知不到明确的规划角色切换

**验证结论：** P0 mola subagent 的失败恰好**证实了本文档自身的分析** —— subagent 模式是 handoff 不可用时的权宜方案，它无法满足规划任务对多轮深度对话的需求。subagent 能做的所有事情（单次 plan 生成 + 探索），handoff 都能做且做得更好。**mola agent prompt / config 条目已从代码库清除** —— 但 mola-plan skill 设计范式（分层加载、CLEAR/UNCLEAR 双路径、explore-before-ask 协议、两过滤器纪律、审批门）作为有效架构向前存活至 P1（详见 [§14.0](#140-p0-mola-subagent-尝试与废弃) 与 [§18 v1.3](#v13-2026-06-24--p0-mola-subagent-废弃与-p1-范围修订)）。完备性门控（四个自检 + reasoning）仅为本文档 §11 的设计规格，**从未在代码中实现**，需在 P1 中实现。

**Handoff 确认为正确方向。** P1 中 mola 升级为 primary 后应**接管 plan 文件写入**（hook 路径约束至 `~/.zoo/**/*.md`），orchestrator 仅维护 `_projects.json` 索引等系统级状态，并保留 `executing` / `done` 的状态更新权（因为这些状态发生在规划之后）。subagent 角色在 P1 中应被完全取代。

**执行阶段 plan 修改规则：** 规划完成进入执行阶段后，对 plan 的中等/轻微调整无需 handoff 回 mola。build 可直接编辑 plan 文件（更新 TODOs、标记完成项、调整步骤顺序等），写入权通过 `~/.zoo/**/*.md` 路径约束控制。仅当需要**完整的重新规划**（架构重设计、方案全面推翻）时才触发新的 mola handoff 会话。此规则确保执行效率不受不必要的 agent 切换拖累。

### 5.8 Handoff 的上下文处理

omo 在规划交接给执行时**不传递上下文也不会清理历史**——同 session 模式下对话历史全部保留。但执行 agent（Atlas）的系统提示将 plan 文件设计为唯一的**真相源**：

- Workflow 第一步硬编码为 "Read the plan file"
- "可用证据" 的清单（plan 文件、notepad、子 agent 输出）显式**排除**对话历史
- 交接时注入结构化上下文块（plan 路径 + 进度 + 当前状态）让执行 agent 直接定位

**核心洞见**：上下文传递 ≠ 上下文使用。omo 依靠**提示工程**而非上下文工程来让执行 agent 不被规划历史分心。

**新会话 handoff 从根本解决此问题**：执行会话天然没有规划历史，无需依赖提示工程隔离。规划长跑超过智能窗（~120k tokens）时，新会话 handoff 是唯一可靠方案。

---

## 6. 深度机制调研: Background Job Board

### 6.1 BackgroundManager (omo) vs BackgroundJobBoard (slim)

| 维度 | **omo BackgroundManager** | **slim BackgroundJobBoard** |
|---|---|---|
| 定位 | **运行时管理器**（~2000+ 行）| **状态追踪器**（~528 行）|
| 职责 | 创建/执行/续期/检测卡死/并发控制/清理 + 追踪 | 仅追踪 + 注入 |
| 派发机制 | ✅ 自己用 dispatchInternalPrompt | ❌ 依赖 OpenCode 原生 task() |
| 并发控制 | ✅ Concurrency group 管理 | ❌ 无 |
| 卡死检测 | ✅ 三层 stale check（60min/45min/session gone）| ⚠️ 只记 timedOut 标记 |
| 持久化 | ✅ globalThis（热重载不丢）| ❌ 内存 |
| unreconciled 概念 | ❌ 无 | ✅ 显式区分 |
| 续期机制 | ✅ 完整 resume() | 依赖 OpenCode session 续期 |
| 清理策略 | 30 分钟 TTL | 按 agent 类型保 2 个 reusable |

**本质差异**: omo 是**操作系统进程管理器**，slim 是**看板**。

### 6.2 Unreconciled 状态机

**slim 的精巧设计**: `running → completed → reconciled（可复用）→ 清理`

只有 `completed && !terminalUnreconciled` 的 session 才能被续期。防止 orchestrator 续期一个还没读结果的 session（语义等价于覆盖已生成的工作）。

```typescript
// BackgroundJobBoard.ts
function isReusable(job): boolean {
  const terminal = job.terminalState ?? terminalStateOf(job.state);
  return terminal === 'completed' && !job.terminalUnreconciled;
}
```

**生命周期触发**:
- `updateStatus()` 时 `terminalUnreconciled = true`
- `session.idle` 时调用 `reconcileInjectedTerminalJobs` → `markReconciled`

### 6.3 为什么这是个好的设计

1. **外挂 LLM 的短期记忆** —— LLM 不擅长在长对话里维护状态，但擅长读结构化文本
2. **unreconciled 概念是真洞见** —— "完成了 vs orchestrator 读了没" 是两个不同的状态
3. **alias 重写是工程妥协的胜利** —— 模型记 `fix-1` 远比记 `ses_7f3a...` 可靠
4. **按 agent 类型的缓存上限** —— 承认复用不是无本万利
5. **user message 注入而非 system prompt** —— user message 注意力更高，不破坏 prompt cache

### 6.4 为什么不是通用好设计

**根本问题**: 这是 OpenCode 的框架缺陷被插件补丁化。如果 OpenCode 原生提供 `list_active_tasks()`、自动 session 状态注入、别名/续期支持，BackgroundJobBoard 可能只需要 50 行配置而不是 528 行代码。

**四个项目对"追踪并行任务"的不同解法**:

| 项目 | 方案 | 为什么不用 job board |
|---|---|---|
| **omo** | 动态 system prompt 注入段 + BackgroundManager | 把状态塞进 system prompt，由 BackgroundManager 维护 |
| **omp** | IRC peer registry + keep-alive + revive | 子 agent 完成后变成 idle peer，IRC 通信 |
| **ECC** | 不做真正的并行编排 | `/orchestrate` 串行派生，需求不存在 |
| **slim** | **BackgroundJobBoard** | 唯一把"追踪并行任务"显式化的项目 |

**深层原因**: slim 是唯一一个把 orchestrator 明确定义为"纯调度员"的项目 —— **当 orchestrator 只做调度时，任务追踪就成了它全部的工作**。

---

## 7. 核心架构决策: Resume vs Handoff

### 7.1 本质差异

| | **Resume** | **Handoff** |
|---|---|---|
| **本质** | orchestrator 把规划当成一个**工具调用** | orchestrator 把控制权**交给另一个 agent** |
| **谁主导对话** | 始终是 orchestrator | 规划阶段是 planner，执行阶段是 executor |
| **对话形态** | `task(plan_agent)` → 返回结果 → orchestrator 继续 | 主 agent role 切换，同一 session，prompt 变化 |
| **用户体验** | 用户和 orchestrator 一问一答，规划是 orchestrator 的一个"步骤" | 用户和规划师对话，规划师把活交棒给执行指挥 |

**本质**: 两者对应不同的**对话强度**维度。对话强度的判断不是基于"任务有多复杂"，而是基于"orchestrator 缺多少信息"：

| 知识缺口 | 对话强度 | 谁做规划 | 用什么机制 |
|---|---|---|---|
| **无缺口**（知道改哪里、怎么改、边界清晰） | none | orchestrator 自己（脑内规划） | 都不用，直接 task(general) |
| **中等缺口**（缺方案/步骤，需要探索+设计） | low（1-2 个澄清问题） | plan agent（subagent，被 task() 派出） | **Resume** |
| **大量缺口**（缺意图、缺架构理解、需要反复权衡） | high（反复辩论、迭代） | plan agent（变成 primary） | **Handoff** |

### 7.2 Resume 的优势（覆盖 90% 场景）

1. **实现轻** —— 只需 task() 原生续期 + plan agent prompt
2. **上下文开销小** —— system prompt 不变，不破坏 prefix cache
3. **状态可控** —— orchestrator 始终是主人，没有 handoff 时序 bug
4. **适合大多数代码任务** —— 不需要深度对话就能规划

### 7.3 Handoff 的优势（重度场景不可替代）

1. **真实的对话式规划** —— 用户可反复辩论、提反对意见、要求看替代方案
2. **规划过程的上下文独立** —— plan agent 的 prompt 专注于规划，不会被 orchestrator 的"调度员"人格污染
3. **执行阶段的彻底切换** —— Atlas 接管，planning mode 完全退出
4. **适合架构重构、跨模块大改** —— 这类任务规划本身就需要 20+ 轮对话

### 7.4 最终决策: 直接 handoff（P0 subagent 方案已废弃）

**P0 mola subagent 方案（已废弃）。** 曾在 v1.2 中列为"当前临时方案"并实施了三个组件（mola agent prompt、mola-plan skill、config.toml 注册）。实际测试后废弃，原因详见 [§5.7](#57-omo-规划架构的关键洞见--p0-mola-subagent-方案验证)。mola prompt/skill/config 条目已清除。mola-plan skill 设计范式作为前向携带架构存活至 P1（详见 [§14.0](#140-p0-mola-subagent-尝试与废弃)）。完备性门控仅为本文档 §11 的设计规格，**从未在代码中实现**，需在 P1 中实现。

**关键确认：** P0 的失败验证了 handoff 是唯一可行的规划架构。规划需要多轮深度对话、独立的上下文空间、清晰的角色边界——这些都是 subagent 模式无法提供的。

**P1（唯一路径）：Handoff — 新会话 handoff 为默认方案**

```
P1 实施:
├── mola 升级为 primary agent（hook 路径约束 ~/.zoo/**/*.md）
├── 用户与 mola 直接对话（多轮采访得以实现）
├── mola 自己写 plan 文件 + durable draft
├── 完备性门控（待实现）触发 handoff — §11 设计规格的四个自检确定"缺方案" → handoff 到 mola（需在 build.md 中首次实现）
├── mola-plan skill 重建 — SKILL.md + CLEAR/UNCLEAR 双路径 + explore-before-ask 协议 + 双过滤器 + 审批门
├── 长规划（>100k tokens）使用新会话 handoff
├── build 接管时按 plan 委派 general 执行
├── mola-spec 重新启用（依赖 handoff 的多轮 grill 采访）
├── 执行阶段 plan 修改：build 直接编辑 plan 文件（中等/轻微调整）
└── 仅完整重新规划时才触发新 mola handoff 会话
```

**范围裁剪（基于实施经验）：**

| 组件 | 决策 | 理由 |
|------|------|------|
| `session-tracker.ts` | **暂缓至 P2** | handoff 模式下规划与执行完全隔离，P1 不需要追踪 active sessions；与 Background Job Board 一起在 P2 实现 |
| `plan-lifecycle hook` | **去掉 idle 检测** | handoff 替代了 idle 自动转 executing 的需求——执行 session 在 handoff 时显式创建，无需推测状态转换 |
| `plan-state.ts` | **逻辑不变** | 读写 plan 文件、解析 frontmatter、状态校验仍必需；写入者由 orchestrator 代理写改为 mola 直接写 |
| `project-id.ts` | **不变** | 无影响 |
| Background Job Board | **暂缓至 P2** | handoff 模式下规划与执行物理分离，P1 不需要并行任务追踪；可独立实现 |

**推荐方案：新会话 handoff**

规划完成后（`status: ready`），plan-lifecycle hook 调用三段 API 创建干净的执行会话：

```
session.create(parentID=planSession, title="执行: X")                                → executionSession
session.promptAsync(executionSession, agent="build", text=readPlanText)             → 注入 plan
tui.publish({body:{type:"tui.session.select", properties:{sessionID}}})             → TUI 自动跳转
```

**v1.2 Day-2 实测确认**：第三段必须使用 `tui.publish()` 发布 SSE 事件，而非 `tui.selectSession()`（后者 endpoint 存在但不触发 TUI 响应）。详见 [§16 #42](#16-决策日志)。

**优势 vs 同会话 handoff**：
- 执行会话有满额智能窗，不受规划长跑拖累
- 角色不会混淆（build 看到的全是自己的对话）
- 规划与执行日志物理分离，便于 zfind 检索
- `parentID` 关联让 ztrace 可跨会话追踪

**同会话 handoff 仅作短规划 fallback**（规划 < 50k tokens 时）：
```
chat.message hook → output.message["agent"] = "build"
build 提示工程："读 plan 文件，对话历史仅作参考"
```

完整端到端流程：

```
用户: "帮我加个 auth 中间件"
  ↓
build → Phase 1 完备性门控 → 缺方案 → 输出 "[完备性: 需要规划 → 切换到 mola]"
  ↓
chat.message hook → output.message["agent"] = "mola"
  ↓
用户在 mola session 中多轮采访、场景压力测试
  ↓
mola: 输出 plan → 用户批准 → 写文件 + status: ready
  ↓
plan-lifecycle hook 检测 plan 完成，调用三段 API 创建 executionSession
build 在新会话中读 plan 文件，按 TODOs 委派 general 执行
TUI 自动跳转到新会话
```

执行阶段中 build 可直接编辑 plan 文件进行中等/轻微调整，无需 handoff 回 mola。仅完整重新规划（架构重设计、方案全面推翻）时触发新的 mola handoff。

**设计为 handoff 预留的基础设施**：
- **Plan 文件位置** —— `~/.zoo/plans/` 中 mola 和 build 都能读
- **Plan 状态机** —— `planning-done` 状态是 handoff 触发点
- **`active_sessions`** —— handoff 时把 session ID 加入此列表
- **完备性门控 + reasoning 输出** —— §11 设计规格定义了重度缺口 → handoff 的判定路径，需在 P1 实现
- **内存 Map 追踪** —— 插件级 session→target-agent 映射（omo 的 `state.ts` 模式）

---

> **v1.6 注：** 本节架构图保留设计意图。实际实现的 agent 命名为 "dolphin"（非 "build"），plan 文件路径为 `~/.zoo/plans/<sessionID>/`（§12 已更新为正式设计，非退化方案）。

## 8. 最终设计方案

### 8.1 整体架构

```
┌──────────────────────────────────────────────────┐
│  用户层                                           │
│  └─ 单一入口 orchestrator (build)                 │
└──────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────┐
│  完备性门控 (Completeness Gate, prompt)           │
│  └─ 四个自检：改哪里？怎么改？边界？意图？         │
│  └─ 缺文件→explore / 缺方案→handoff 到 mola      │
│                     / 缺意图→反问                  │
└──────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────┐
│  Handoff 通道 (plan-lifecycle hook)               │
│  ├─ chat.message hook → output.message["agent"]   │
│  │  = "mola"（同会话，短规划 <50k）               │
│  └─ session.create + session.promptAsync          │
│     + tui.publish（新会话，长规划，推荐）          │
└──────────────────────────────────────────────────┘
                        ↕
┌──────────────────────────────────────────────────┐
│  Mola (primary agent, 独立 session)               │
│  ├─ 两层 skill 架构:                              │
│  │  ├─ mola-plan (CLEAR/UNCLEAR 双路径)           │
│  │  └─ mola-spec (深度设计探索/grill 通道)         │
│  ├─ 路由内嵌 Workflow(无独立 Intent Routing 段)    │
│  ├─ 多轮采访/辩论/场景压力测试                     │
│  ├─ 读代码库 (read/grep/glob/bash)                │
│  ├─ 写 plan 文件 (edit/write 路径约束)            │
│  └─ 输出 status: ready → 触发 handoff 回 build    │
└──────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────┐
│  状态层                                           │
│  ├── 文件: ~/.zoo/plans/<slug>.md                 │
│  │     YAML frontmatter + markdown body           │
│  │     status / active_sessions / project         │
│  │                                                │
│  └── (P1 无内存 tracker — 暂缓至 P2)              │
│        P2: PlanSessionTracker → BackgroundManager │
└──────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────┐
│  实现层                                           │
│  ├─ build 在新会话中读 plan 文件，委派 subagent   │
│  ├─ session resume 续期失败/未完成任务            │
│  ├─ build 直接编辑 plan（中等/轻微调整）          │
│  └─ P2: Background Job Board + 并行多 subagent    │
└──────────────────────────────────────────────────┘
```

### 8.2 组件清单

| 组件 | 设计文件 | 实际文件 | 状态 | 行数 |
|---|---|---|---|---|
| Mola primary prompt | `core/prompts/mola.md` | 同左 | ✅ 已实现 | 60 |
| Plan state manager（countOpenTodos, allTodosDone） | `src/core/plan-state.ts` | `src/core/plan.ts` | ✅ 已实现 | 263 (+379 测试) |
| Plan progress checks | `src/core/checks.ts` | 同左 | ✅ 已实现 | 133 (+7 测试) |
| 完备性门控 | `core/prompts/build.md`（§11 规格） | `core/prompts/dolphin.md` Phase 1（简化版） | ⚠️ 简化版存在，§11 四问版本未实现 | ~10（简化版） |
| Plan lifecycle hook | `src/hooks/plan-lifecycle/` | 同左 | ✅ 已实现 | 273 (+398 测试) |
| `/go` 命令注册 | `src/index.ts` | 同左 | ✅ 已实现 | ~40（command.execute.before） |
| mola-plan skill | `core/skills/mola-plan/` | 同左 | ✅ 已实现 | SKILL.md 241 + references 350 + templates 158 |
| 集成测试 | `tests/runner.py` 场景 | — | ❌ 未实现 | 设计估 ~80 |

**P1 核心已实现**: plan.ts + plan-lifecycle hook + mola.md + mola-plan skill + config.toml + `/go` 命令 ≈ 1,340 行代码 + 735 行测试。**未实现**: 完备性门控（§11 四问版）、集成测试场景。**设计变更**: project-id.ts + `_projects.json` 已废弃——sessionID 替代为正式方案（§12）。**已暂缓至 P2**: `session-tracker.ts`、Background Job Board、idle 检测、active-plans 概况注入。

### 8.3 Plan Progress Nudge Pipeline

**问题：** dolphin 在委派子 agent 或直接编辑文件后，经常遗漏更新 plan 文件的 checkbox 进度。这导致 Todo 完成情况与 plan 状态脱节，丢失进度上下文。

**解决方案：** 每次代码变更后，向 tool output 流中注入进度提醒。系统**永不自动修改 plan 文件**——仅做感知提醒（nudge），将决策权留给模型。

**三个 nudge 场景：**

| 场景 | 条件 | 对应常量 |
|------|------|----------|
| PROGRESS | plan 中存在未勾选的 `- [ ]` 待办项 | `PLAN_PROGRESS_NUDGE` / `TODO_PROGRESS_NUDGE` |
| DONE | 全部 checkbox 已勾选但 plan 状态未更新为 done | `PLAN_DONE_NUDGE` / `TODO_DONE_NUDGE` |
| RESUME | plan 状态为 done 但用户仍通过 tool 继续修改 | `PLAN_RESUME_NUDGE` / `TODO_RESUME_NUDGE` |

**管道架构：**

```
┌─ hook 触发 ──→  checks.ts 共享函数 ──→  prompts.ts 常量 ──→ 注入 tool output
│                 同步/异步检查            6 个 nudge 模板
│                 返回 nudge | null        统一 <internal-reminder> 包裹
```

- **两个共享检查函数**（`src/core/checks.ts`，133 行 + 7 测试）：
  - `checkPlanProgress(sessionID)` — 同步文件系统读取，扫描 `~/.zoo/plans/<sessionID>/` 下的 plan 文件
  - `checkTodoProgress(client, sessionID)` — 异步 API 调用，通过 OpenCode client 读取当前会话消息计算 checkbox 状态
- **薄 hook 适配器**：将框架 (input, output) 解包后调用共享函数
  - `post-task-nudge/hook.ts` — 在 `VERIFY_REMINDER` 后注入
  - `direct-work-nudge/hook.ts` — 在 `DIRECT_WORK_NUDGE` 后注入，仅 edit/write 操作触发

**六个统一 nudge 常量**（`src/core/prompts.ts`，重构：+72/-22 行）：

| 命名 | 格式 | 尾部公式 |
|------|------|----------|
| `TODO_PROGRESS_NUDGE` | `<internal-reminder>` 包裹 | `X = Y = LOST PROGRESS` |
| `PLAN_PROGRESS_NUDGE` | 同上 | 同上 |
| `TODO_DONE_NUDGE` | 同上 | 同上 |
| `PLAN_DONE_NUDGE` | 同上 | 同上 |
| `TODO_RESUME_NUDGE` | 同上 | 同上 |
| `PLAN_RESUME_NUDGE` | 同上 | 同上 |

**新的纯函数**（`src/core/plan.ts`，+32 行）：
- `countOpenTodos(content: string): number` — 统计 `- [ ]` 开头的未勾选 checkbox 行数
- `allTodosDone(content: string): boolean` — 当无未勾选 checkbox 时返回 true

**注入端点：** 两个 hook 各自独立注入 todo + plan nudge，覆盖所有代码变更路径：

| Hook | 触发时机 | 注入内容 | 位置 |
|------|----------|----------|------|
| post-task-nudge | `task()` 返回后 | todo + plan | 接在 `VERIFY_REMINDER` 之后 |
| direct-work-nudge | edit/write 执行后 | todo + plan | 接在 `DIRECT_WORK_NUDGE` 之后 |

> **v1.6 对比：** direct-work-nudge 原来只注入 plan nudge，缺失 todo 检查；post-task-nudge 的 todo 处理中 `TODO_RESUME_NUDGE` 场景（全部完成但仍在编辑）被静默跳过。v1.7 补全了两端点的 todo + plan 完整覆盖。

**无 plan 文件 → 静默跳过：** 若 session 目录下无 plan 文件，两个检查函数均返回 `null`，不注入任何 nudge。

**错误处理：** 每个 nudge 独立执行。`checkPlanProgress()` 的文件 I/O 错误或 `checkTodoProgress()` 的 API 错误以 `warn` 级别记录日志，不影响其他 nudge 的注入。完整容错设计保证一个 nudge 失败不会阻断另一个。

---

## 9. 状态机设计

### 9.1 Plan 状态

```
planning → planning-done → executing → done
   ↑                       ↑
   │                       │
   plan agent 正在规划      orchestrator 开始委派实现
   (unreconciled 概念)      (自动解除 unreconciled)
```

| 状态 | 含义 | 谁写入 |
|---|---|---|---|
| `planning` | mola 正在探索/多轮采访/生成 plan | **mola 直接写**（hook 路径约束至 `~/.zoo/**/*.md`） |
| `planning-done` | plan 已就绪，等 handoff 到 build | mola 设 `status: ready` 并触发 handoff |
| `executing` | build 开始委派实现 subagent | build（委派第一个 subagent 时或直接编辑 plan） |
| `done` | 所有 TODO 完成 + 验证通过 | build（最后一个 checkbox 勾完后） |

### 9.2 Plan 迭代

**原地更新**: 同一文件，多次修改（planning-done → planning 回退是允许的）。

**不做版本化**: 历史靠 git 跟踪（虽然 `~/.zoo/plans/` 默认 gitignore，用户可以手动 init git 仓库备份）。

### 9.3 Plan 废弃

**直接删除**: 用户说"算了，不做这个"时，orchestrator 直接删除 plan 文件。不 archive，不 abandoned 状态。

### 9.4 Unreconciled 生命周期（P1 简化版）

1. mola 完成多轮采访，产出 plan 并直接写入文件，状态设为 `planning-done`（`status: ready`）
2. plan-lifecycle hook 检测到 `planning-done`，触发 handoff 三段 API（创建执行 session + 注入 plan + TUI 跳转）
3. build 在新会话中读 plan 文件，委派第一个 subagent 时将状态改为 `executing`
4. 如果用户在 executing 前要求修改 plan，mola 将状态改回 `planning` 并继续采访

**注意**：P1 不使用 idle 检测（handoff 显式创建执行 session，无需推测状态转换）。Unreconciled 概念在 P2 引入 Background Job Board 时再完整实现。

---

## 10. Plan 文件结构

### 10.1 完整示例

`.zoo/plans/auth-middleware-20260115.md`:

```yaml
---
status: executing
slug: "auth-middleware-20260115"
project_root: "/home/cambricon/Agent/ZooKeeper"
created_at: "2026-01-15T10:23:45"
updated_at: "2026-01-15T10:28:12"
active_sessions:
  - "ses_abc123"
---

# Auth Middleware

## Scope
### Must have
- JWT access token 验证(签入所有 /api/* 路由)
- 过期 token 返回 401 + WWW-Authenticate header
- 中间件可插拔(不影响现有路由测试)

### Must NOT have
- 不在本 plan 实现 refresh token 轮换(依赖现有 refresh 机制)
- 不改动 rate limiting / logging 中间件
- 不引入新的数据库表或配置项

## Context
为现有 API 路由添加 JWT 验证中间件。现有代码在 `src/server/routes.ts`，
需要插入到路由注册前。需要考虑 access token + refresh token 两种场景。

## Approach
1. 创建 `src/server/middleware/auth.ts` 实现验证逻辑
2. 修改 `src/server/routes.ts` 在敏感路由前挂上中间件
3. 添加对 expired token 的 401 响应

## Execution strategy
依赖矩阵: auth.ts → types.ts(类型扩展) → routes.ts(挂载) → test.ts(验证)
各步骤间无并行依赖，可串行执行。

## Critical Files
- `src/server/routes.ts` (现有路由定义，必须插入中间件)
- `src/server/types.ts` (需要扩展 RequestWithAuth 类型)
- `tests/server/auth.test.ts` (不存在，需要新建)

## Verification
- 跑 `ts-node tests/server/auth.test.ts` 验证验证逻辑
- 跑现有测试套件确保无回归
- 测试 expired/invalid/malformed 三种 token 的 401 响应

## Final verification wave
- F1: 单元测试全部通过
- F2: 手动 curl 验证三种 token 的 401 行为
- F3: 现有测试零回归
- F4: 中间件不影响 rate limit / logger 等已有中间件

## Commit strategy
- 步骤 1-3 完成 → 单 commit "feat: add auth middleware"
- 步骤 4-5 完成 → squash commit "test: add auth middleware tests"

## Success criteria
- 所有 TODO checkbox 勾选
- F1-F4 全部 pass
- 用户确认最终实现与 plan scope 一致

## TODOs
- [ ] 创建 middleware/auth.ts（推荐用 general）
- [ ] 扩展 types.ts 的 Request 类型（推荐用 general）
- [ ] 修改 routes.ts 使用新中间件（推荐用 general）
- [ ] 写 tests/server/auth.test.ts（推荐用 general）
- [ ] 跑完整测试套件确保无回归（推荐用 general）

## Risks
- access/refresh token 边界情况可能漏掉（缓解: 测试覆盖 5 种 token 状态）
- 中间件顺序可能影响 rate limiting（缓解: 验证现有 rate limit 测试仍然通过）
```

### 10.2 输出协议

Plan agent 完成任务时，输出以下结构化 markdown（通过 prompt 强制 section）：

```
# <Title>

## Context              ← 重述任务（2-4 句）
## Approach             ← 步骤化方案
## Critical Files       ← ≤ 5 个关键文件 + 理由
## Verification         ← 精确命令 + 预期输出
## Risks                ← 风险 + 缓解
## TODOs                ← 可执行 checklist，每项可注明推荐 subagent

## Metadata Block       ← plan agent 输出末尾包含:
  ### Plan Status
  status: ready / questions
  questions: [若有需要澄清的问题]
```

orchestrator 用正则匹配 `## Metadata Block` 提取 status/questions，其余部分作为 plan file body。

### 10.3 Plan slug 生成

```
时间戳 (YYYYMMDD) + LLM 生成 + 用户确认
例如: auth-middleware-20260115
```

流程:
1. LLM 基于任务生成 slug（如 `auth-middleware`）
2. Hook 追加时间戳（防重名）
3. Orchestrator 通过 `question` 工具让用户确认/修改 slug
4. 写入文件

Trivial 任务可跳过 step 3（orchestrator 自己决定）。

---

## 11. 完备性门控 (Completeness Gate)

> **2026-06-23 修订：** 原设计为"意图门 (IntentGate)"，基于复杂度三档（trivial/standard/complex）+ 关键词 + 文件数。omo 代码验证后发现 omo 的 Sisyphus 不使用复杂度评分——它的路由基于请求分类和知识缺口自检。改为完备性门控，核心原则：**delegate to PLAN when you would need to GUESS the approach**。

### 11.1 请求分类（Phase 0，保持）

orchestrator 首先将用户请求归入五类之一：

| 意图 | 行为 |
|---|---|
| Discussion | 直接回答，不委派 |
| Wiki Ingestion | wiki-ingest skill |
| Exploration | task(explore) 或 task(spider) |
| Implementation | 进入完备性门控 ↓ |
| Diagnosis | task(explore) → 分析结果 → 进入完备性门控 ↓ |

### 11.2 完备性门控（Phase 1，新增）

实现和诊断意图在委派之前，orchestrator 必须自检四个问题。**这不是评估"任务有多大"，而是评估"我缺什么信息"。**

| 自检 | 不过 → 行为 | 原因 |
|---|---|---|
| 我知道改**哪里**吗？（文件位置不用猜） | task(explore) | 缺文件位置信息 |
| 我知道**怎么**改吗？（方案不用猜） | task(plan) | 缺方案/步骤 |
| 改动**边界**清晰吗？（不会误伤其他模块） | task(plan) | 需要先理清依赖 |
| 用户到底**想要什么**？（意图不用猜） | 反问用户，不做任何事 | **模糊 ≠ 复杂**——缺信息就该问，不该猜 |

**关键区分：模糊 vs 复杂。** 用户说"帮我改进一下认证模块"——听起来规模可控，但它是**模糊**的（不知道要修 bug、加功能、重构、还是加日志）。正确的反应是反问，不是规划。

只有四个问题全部通过时，orchestrator 才直接委派 task(general) 或自己动手。

### 11.3 输出 reasoning

orchestrator 做出完备性判断后，在输出里声明：

```
[完备性: 缺方案 → 派 plan agent]
[完备性: 全部通过 → 直接委派 general]
[完备性: 意图模糊 → 反问澄清]
```

用户看到 reasoning 后如有异议可纠正（如"不需要规划，直接改就行"）。reasoning 用中文以 `[完备性: ...]` 前缀输出，与现有的 discussion/exploration 等声明保持风格一致。

### 11.4 与 omo 的对照

om o 的 Sisyphus 使用了完全相同的模式（`sisyphus-dynamic-prompt-role.ts:53-81`）：

```
omo 的五请求分类 → ZooKeeper 的五意图门（Phase 0）
omo 的上下文完成门控（三条自问）→ ZooKeeper 的完备性门控（四条自问）
```

核心差异：omo 的"模糊"对应"问一个问题"，ZooKeeper 同样处理。omo 没有文件数阈值——无一行代码数文件。ZooKeeper 同样放弃文件数规则。

---

## 12. Plan 文件管理与中断恢复

### 12.1 目录结构

```
~/.zoo/plans/
├── ses_abc123/                         # 按 sessionID 分子目录
│   ├── auth-middleware-20260115.md
│   └── refactor-logging-20260120.md
├── ses_def456/
│   └── add-wiki-query-20260123.md
└── ses_ghi789/                         # 已完成 plan 的 session（仍保留）
    └── fix-typo-20260401.md
```

Plan 文件以 **sessionID** 为子目录名分组，而非 project-id。理由：

- **零索引依赖** — 不需要 `_projects.json` 或任何映射表，plan 天然归属创建它的 session
- **无需 project-id 推导** — 省去 `deriveProjectId()`（git remote → basename → 冲突 hash）的整套逻辑
- **删除会话即删除 plan** — 用户通过 OpenCode UI 删除 session 时，对应的 plan 子目录可一并清理
- **简化 `rewritePlanPath()`** — 路径重写逻辑已在 sessionID 模式下运行（见 `src/core/plan.ts`）

### 12.2 plan 发现：扫描方案（P2 实现）

config hook 在新 session 启动时注入 active plan 概况。发现方式：

1. **遍历** `~/.zoo/plans/` 下所有子目录
2. **mtime 过滤**：只扫描最近 30 天有修改的 session 子目录
3. 解析每个 `.md` 的 frontmatter
4. **状态过滤**：只保留 `status != done` 的 plan
5. 注入到 system prompt 动态段

不建立索引文件，不归档已完成 plan——靠 mtime + status 两层过滤保持 prompt 注入精简。复杂度 O(子目录数)，plan 数量不可能大到遍历成为瓶颈。

### 12.3 中断恢复

**新 session 启动时**，system prompt 动态段自动注入所有 active plan 的概况：

```
[Active Plans]
  auth-middleware-20260115 [executing] — 5 tasks (3 done, 2 pending)
    Session: ses_abc123
  refactor-logging-20260120 [planning] — 刚讨论完方案，未开始执行
    Session: ses_def456
```

用户自然知道当前有哪些 active plan，可以继续或切换。

### 12.4 多 plan 并存

✅ 支持。`active_sessions` frontmatter 字段 + in-memory active_plan_id 指针。

用户可显式切换："我现在要做的是重构日志的那个 plan，不是 auth middleware 的" —— orchestrator 自然语言理解即可切换 active plan。

已完成（`status: done`）的 plan 不做物理归档——留在原 session 子目录中，mtime 过滤自然排除。

---

## 13. 权限与工具控制

### 13.1 Mola 工具权限

**混合权限模型**（在 `config.toml` 中声明，install 时编译到 OpenCode 配置）:

```toml
[agent.mola.permission]
task = "deny"
# edit/write = "allow" 但由 hook 路径约束至 ~/.zoo/**/*.md
# 允许: read, grep, glob, bash (bash 由 prompt 约束只跑诊断命令)
```

**为什么混合**:
- ZooKeeper 的 `config.toml` 已有每个 agent 的 permission deny 列表
- mola 作为 primary agent 需要写入 plan 文件，但写权限必须路径受限——hook 在 `tool.execute.before` 中检查目标路径是否在 `~/.zoo/**/*.md` 范围内，超出则拒绝并提示
- `task = "deny"` ：mola 在 P1 中不自委派叶子 agent（自己 read/grep/glob 探索），P2 再开（仅 explore/spider）
- **2026-06-23 验证：** deny list 与现有 6 个 agent 风格一致。路径约束参考 omo 的 `prometheus-md-only` hook 模式，不引入白名单特例。ZooKeeper 的 deny 模型 + hook 级路径检查够用且一致。
- **P2 预留：** `task` 从 `"deny"` 改为 `"allow"` 并加轻量委派通道（参考 omo `call_omo_agent`）

### 13.2 Bash 的 prompt 约束

Plan agent 的 prompt 包含:

```
Bash Usage Rules:
- 仅允许跑诊断命令（test/lint/type-check/grep/find/git log/git diff）
- 禁止任何 mutating 命令（git commit/push、install、build 等）
- 如果用户要求跑 mutating 命令，回复:
  "Bash 在 plan mode 只允许诊断命令。如需执行，请在 plan 文件 TODOs 中列为执行任务。"
```

### 13.3 Plan 文件写入的责任分离（P1）

| 角色 | 职责 |
|---|---|
| **Mola**（primary）| **直接写 plan 文件**（edit/write 路径约束至 `~/.zoo/**/*.md`）|
| **Dolphin**（orchestrator）| 维护 `_projects.json` 索引；更新 `executing`/`done` 状态；执行阶段直接编辑 plan |

**为什么这样**:
- mola 在多轮采访后直接产出 plan 并写入，减少 orchestrator 的中继开销
- hook 路径约束保证写入安全（参考 omo `prometheus-md-only`）
- dolphin 保留状态更新权（`executing`/`done` 发生在规划之后）
- 执行阶段 dolphin 可直接编辑 plan（中等/轻微调整），无需 handoff 回 mola

**P0 旧设计（已废弃）**: plan agent 输出文本 → orchestrator 代理写。该方案因缺少多轮采访能力被放弃。

---

## 14. 实施路径

> **v1.3 更新：** P0 mola subagent 方案已废弃。本节重写以记录尝试过程与结论。mola prompt/skill/config 条目已清除。mola-plan skill 设计范式作为前向携带架构存活至 P1。完备性门控仅为设计规格（§11），从未在代码中实现，需在 P1 中实现。

### 14.0 P0 mola subagent：尝试与废弃

#### 尝试了什么

基于 v1.2 的设计，我们实现了三个核心组件：

| 组件 | 内容 | 行数 |
|------|------|------|
| mola agent prompt | `core/prompts/mola.md` — XML 标签结构，含意图路由、CLEAR/UNCLEAR 判定 | ~52 行 |
| mola-plan skill 分层 | `core/skills/mola-plan/SKILL.md` + 三个参考文件（intent-clear / intent-unclear / full-workflow） | ~262 行 |
| config.toml 注册 | `[agent.mola]` mode=subagent，deny edit/write/task；内置 plan 禁用 | ~25 行 |

并设计了完备性门控（§11 设计规格，四个自检问题 + reasoning 输出），使编排器在缺方案时路由到 mola。**注：该门控仅为设计规格，从未在代码中实现。**

**设计亮点（实施中确认有效的决策）：**

- **技能分层架构**（agent prompt → skill → reference）—— 只加载匹配的参考文件，token 效率优于单一大 prompt
- **意图路由在 agent prompt 中完成** —— skill 是纯执行引擎，不承担路由判断
- **完备性门控（设计阶段）** —— 四个知识缺口自检 + reasoning 输出（§11 设计规格），概念上使用户能纠正路由判断。**未在代码中实现，需在 P1 中实现。**

#### 为什么废弃

实际测试发现 mola subagent 方案存在三个不可接受的结构性问题：

1. **无多轮采访能力** —— subagent 在单次 `task()` 中只能输出一段文本，无法进行反复辩论、场景压力测试、替代方案权衡等深度对话
2. **编排器沦为消息中继** —— 若通过 orchestrator 透传实现多轮，orchestrator 上下文被规划对话填满，角色从编排者降格为转发器
3. **角色混淆** —— orchestrator 同时承担编排和转发职责，用户感知不到明确的规划角色切换

#### 现状

**文件已清除，设计遗产向前携带至 P1：**

- **代码库中 mola agent prompt / config 条目已清除** —— prompt、skill 文件、config.toml 注册条目在废弃后删除。但以下设计遗产存活：
  1. **mola-plan skill 设计范式（存活）** —— skill 文件已删除，但其设计范式（skill → reference 分层加载、CLEAR/UNCLEAR 双路径、explore-before-ask 协议、两过滤器问题纪律、审批门）是经过验证的有效架构，P1 中 mola 作为 primary agent 时将以此蓝本重建 skill
  2. **完备性门控（设计规格，待 P1 实现）** —— 四个自检问题 + reasoning 输出仅存在于本文档 §11 的设计规格中，**从未在代码中实现**。P1 中需在 `core/prompts/build.md` 中实现此门控，作为 handoff 的主动触发机制：detect 缺方案 → 输出 `[完备性: 缺方案 → handoff 到 mola]` → chat.message hook 截获并路由到 mola
- mola 的尝试证实了本文档自身分析：**subagent 无法满足规划的多轮深度对话需求**，handoff 是唯一正确方向

#### P0 的正面价值：前向携带 (forward-carried) 的架构组件

尽管被废弃，P0 的核心设计并非纯教训。两项架构设计在 P1 中复用，但**存活形态不同**：

1. **完备性门控（设计规格，待 P1 实现）** —— 四个自检问题 + reasoning 输出（§11）定义了 orchestrator 判定"缺方案 → handoff 到 mola"的**路由逻辑**。该门控**从未在代码中实现**——它仅存在于本文档的设计规格中。P1 中需在 `core/prompts/build.md` 中完整实现：自检四个问题 → reasoning 输出 → chat.message hook 触发 handoff。这是**新实现**，而非 P0 遗产的延续。

2. **mola-plan skill 设计范式 → P1 中重建的架构蓝本**
    虽然 skill 文件（SKILL.md + 三个 reference）已删除，但以下设计决策经过 P0 验证有效，将在 P1 中以 skill 重建形式复活：
   - **skill → reference 分层加载** —— 只加载匹配的参考文件（CLEAR/UNCLEAR），token 效率优于单一大 prompt
   - **CLEAR/UNCLEAR 双路径** —— 需求明确时走快速通道（推荐答案优先），需求模糊时走深度探索通道
   - **explore-before-ask 协议** —— 提问前先探索代码库，不凭空猜测
   - **两过滤器问题纪律** —— 证据过滤器（已有信息）→ 默认过滤器（仍未知），每轮 1-2 个问题 + 多选优先
   - **审批门** —— plan 输出后经用户批准才进入执行

P0 还提供了以下过程验证（lessons learned，非前向携带）：

- **确认 handoff 为正确方向** —— P0 的失败使 handoff 从"备选方案"升级为"唯一路径"
- **积累角色边界经验** —— orchestrator 不应承担规划对话的中继

### 14.1 六步分解（P1 工程实施）

> **v1.6 更新：** Steps 2 和 6 已完成。原 Step 3（project-id.ts）已废弃——sessionID 正式替代 project-id（详见 §12）。P1 剩余仅 Step 7（集成测试）。完备性门控（§11 四问版）暂缓至 P2。agent 命名为 "dolphin"。

```
Step 1. config.toml + install.py                 — ✅ mola primary agent 注册 + 内置 plan 禁用
Step 2. src/core/plan.ts                         — ✅ plan 文件解析/写入/状态机（sessionID 子目录）
Step 3. core/prompts/mola.md                     — ✅ mola prompt (60 行，含 Agents 委派段)
Step 4. core/skills/mola-plan/                   — ✅ plan skill (SKILL.md + 3 reference + 2 template)
Step 5. src/hooks/plan-lifecycle/ + src/index.ts — ✅ handoff `/go` 命令 + 三段 API + plan 状态更新
Step 6. 集成测试 + runner.py 场景               — ❌ 未实现
```

### 14.2 每步的具体产出

**Step 1: config.toml + install.py** (~15 行) ✅ 已完成
- `[agent.mola]` 块：默认 `mode = "primary"`（不显式声明），`model = "{env:ZOO_MODEL}"`，`color = "#FFA500"`
- 工具权限：`webfetch = "deny"`，`websearch = "deny"`。`task = "deny"` 为隐式（未列出，OpenCode 框架默认 deny）。`edit/write/read/grep/glob/bash/question` 默认 allow（hook 运行时路径约束至 `~/.zoo/**/*.md`）
- Skill 授权：`"*" = "deny"`，`"mola-plan" = "allow"`，`"wiki-query" = "allow"`
- `[agent.plan] disable = true`（内置 plan agent 禁用，mola 接管规划职责）
- `[agent.dolphin]`：orchestrator agent（设计文档原 "build" 最终命名为 "dolphin"）
- `[zoo.skills]` 新增 `mola-plan = "enable"`
- install.py 无需改动（直接透传 agent 配置，透传 `[zoo.skills]`）

**Step 2: plan.ts** (263 行 + 379 测试) ✅ 已完成
- 纯逻辑模块（零 OpenCode 依赖，可被 TS 运行时 import），文件名 `plan.ts`（设计文档原 `plan-state.ts`）
- 函数: `plansDir(sessionID)`, `parseFrontmatter(content)`, `findPlanByStatus(sessionID, targetStatus)`, `updatePlanStatus(content, newStatus)`, `writePlan(planPath, content)`, `rewritePlanPath(tool, args, sessionID)`, `buildPlanReference(planPath)`, `buildConfirmText()`, `countOpenTodos(content)`, `allTodosDone(content)`
- Plan 文件存储路径：`~/.zoo/plans/<sessionID>/<slug>.md`（详见 §12）
- `rewritePlanPath()` 透明地将 mola 对 `~/.zoo/plans/<file>.md` 的写入重定向到 `~/.zoo/plans/<sessionID>/<file>.md`
- 状态机校验未显式实现——`updatePlanStatus()` 是自由字符串替换，不校验状态合法性
- 测试覆盖：plansDir、parseFrontmatter（5 场景）、findPlanByStatus（5 场景）、updatePlanStatus（4 场景）、writePlan、rewritePlanPath（7 场景）、buildPlanReference、buildConfirmText、countOpenTodos、allTodosDone

**Step 3: mola prompt** (60 行) ✅ 已完成
- **Role** (~5 行): mola 规划顾问身份，plan mode sticky
- **Agents** (~21 行): 声明 lynx/spider 可通过 `task()` 委派（与设计 §14.2 原 "task=deny" 描述不同——mola prompt 中设委派通道，但 config.toml 未显式 allow task）
- **Contract** (~14 行): 6 条硬约束 (C1–C6)
- **Workflow** (~5 行): 3 步极简（Load → Execute → Handoff signal），所有规划逻辑下沉到 skill
- **Tools** (~9 行): task/read/grep/glob/bash + edit/write (路径约束) + question

**Step 4: mola-plan skill** (SKILL.md 241 + references 350 + templates 158 = 749 行) ✅ 已完成
- `core/skills/mola-plan/SKILL.md` — 单一技能（6 phases: Ground Check → Classify → Interview → Present Design → Produce → Handoff Signal）
- 3 个 reference 文件：`intent-clear.md`（83 行，明确路径）/ `intent-unclear.md`（105 行，调研默认值路径）/ `grill-protocol.md`（163 行，深度访谈 + 场景压力测试）
- 2 个 template 文件：`plan-template.md`（94 行）/ `spec-template.md`（64 行）—— **设计文档原 "scaffold-plan.py / scaffold-spec.py 作为格式唯一权威" 未实现**，模板文件替代此角色
- Classify 阶段根据 Ground 发现决定加载路径，支持 Graceful upgrade
- 统一 YAML frontmatter（plan 初始 `status: planning`，完成时设为 `planning-done`）

**Step 5: plan-lifecycle hook** (hook.ts 273 + index.ts 12 + src/index.ts 注册 ~40 = 325 行 + 398 测试) ✅ 已完成
- `src/index.ts` 中注册 `/go` 命令（`config.command.go`）和 `command.execute.before` handler
- `handleGoCommand()` 八步编排：查找 plan → 验证 client API → 创建 dolphin 子 session → 更新 plan status → navigate home + TUI publish → 注入 plan reference（promptAsync）→ 注入 silent confirmation（prompt + noReply）→ 可选删除旧 session
- 使用 `tui.publish()` SSE 事件触发 TUI 切换（非 `tui.selectSession()`）
- `rewritePlanPath()` 在 `tool.execute.before` 中注册，透明重定向 mola 的 plan 文件写入
- **未实现：** config hook 的 active-plans 概况注入、chat.message hook 的自动 handoff 触发（`output.message["agent"] = "mola"`）——当前 handoff 仅通过用户显式 `/go` 命令触发
- **测试覆盖：** 成功路径（5 场景）、错误处理（5 场景）、客户端 API 边界（5 场景）、plan 状态边界（2 场景）

**Step 6: 集成测试 + runner.py 场景** ❌ 未实现
- 设计规格：trivial/standard/complex 三场景验证
- `tests/thresholds.toml` 中已有空 `[mola]` 阈值条目
- 无 plan-mode 场景文件存在

**暂缓至 P2 的组件：**
- `session-tracker.ts` —— 与 Background Job Board 一起实现
- `plan-lifecycle hook` 的 idle 检测 —— handoff 替代了此需求
- `chat.message` hook 自动 handoff 触发 —— 当前仅 `/go` 命令方式
- `config` hook active-plans 概况注入 —— 扫描方案（§12.2），约 40 行

### 14.3 顺序约束

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6

理由:
- Step 1 是基础设施，先做 ✅
- Step 2 独立（plan.ts 纯逻辑模块）✅
- Step 3 依赖 step 1 的基础设施（mola agent 注册）✅
- Step 4（skill）依赖 Step 3 的 agent prompt Workflow 与 Contract ✅
- Step 5（handoff hook）依赖 Step 3 + 4 的 agent 与 skill 输出协议 ✅
- Step 6 依赖前面全部
```

### 14.4 验证策略

每个 Step 完成后:
- `./check.sh` 过 lint
- `./test.sh` 过现有测试
- dry-run 跑一个真实场景（用 `runner.py --dry-run`）

Step 6（集成测试）完成后验证:
- trivial 任务（typo 修复）→ 不应触发 plan
- standard 任务（加个功能）→ 应触发完备性门控 → handoff 到 mola
- handoff 流程：mola 多轮采访 → 写 plan → 触发 handoff → build 在新 session 执行
- 执行阶段 plan 修改：build 直接编辑 plan 文件，无需 handoff 回 mola

---

## 15. 未来演进

### 15.1 P1 稳定后的 P2 演进

在 P1 handoff 稳定后:

```
P2 新增:
├── Background Job Board（并行任务追踪 + unreconciled 状态机）
├── session-tracker.ts（活性 session 管理，与 Job Board 一起实现）
├── BackgroundManager 升级（并发控制、卡死检测、主动派发）
├── mola 叶子委派扩展（task=allow，仅 explore/spider）
└── complex 场景的意图门 → handoff（补充调研技术吸收）
```

**关键前置准备**（P1 已做的）:
- Plan 文件位置 `~/.zoo/plans/`（handoff 时 plan agent 和 executor 都能读）
- Plan 状态机（`planning-done` 状态是 handoff 触发点）
- active_sessions frontmatter 字段（handoff 时把 session ID 加入）

### 15.2 P2: BackgroundManager 升级

P1 暂缓的 `PlanSessionTracker` 接口在 P2 中升级为 BackgroundManager:

```typescript
// P0 简单 tracker
interface PlanSessionTracker {
  register(sessionId, agent, slug): void
  updateStatus(sessionId, status): void
  getReusables(agentType): SessionRecord[]
  getAllActive(): SessionRecord[]
}

// P2 升级为 BackgroundManager
interface BackgroundManager {
  // 继承上面 4 个方法
  run(prompt, agent, opts): TaskResult     // 主动派发
  resume(taskId, prompt): TaskResult       // 主动续期
  cancel(taskId): void                     // 主动取消
  setConcurrency(max): void                // 并发控制
}
```

现有调用方不会崩 —— 只是加方法，不改方法。

### 15.3 P3+: 其他可能的方向

- **多模型协同**（参考 slim Council / ECC multi-plan）
- **持续学习**（参考 ECC 直觉系统）
- **TTSR 风格流控制**（参考 omp）
- **跨工具兼容**（参考 ECC 的 7 工具支持）

---

## 16. 决策日志

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | Plan 作为什么实现 | **primary agent**（handoff 模式，非 subagent） | skill 会污染 orchestrator context；agent 提供干净分离。subagent 模式（P0）尝试后废弃——无法满足多轮深度对话需求 |
| 2 | Plan 文件位置 | `~/.zoo/plans/<sessionID>/<slug>-<YYYYMMDD>.md`（v1.6 修订：原 `<project-id>/` 已废弃） | sessionID 天然归属，零索引依赖 |
| 3 | project-id 推导 | **废弃（v1.6）** | sessionID 方案消除了跨 session 映射需求，不需要 git remote / basename 推导 |
| 4 | 索引文件 | **废弃（v1.6）** | `_projects.json` 随 project-id 一并废弃；plan 归属 session，无需映射表 |
| 5 | Plan 格式 | YAML frontmatter + markdown body + checkboxes | 状态在 frontmatter，人类可读 body |
| 6 | Git 管理 | 天然 gitignore（用户级） | 与 omo/slim/omp 一致 |
| 7 | 输出协议 | 结构化 markdown sections | 4 个项目都用 markdown 不用 JSON |
| 8 | Session resume | 透明显示 + 自动执行 | 用户可见但无需操作，omo 已验证可行 |
| 9 | Unreconciled | 显式检测 + session.idle 自动解除 | slim 的精巧设计，plan→实现解耦的关键 |
| 10 | 多 plan | ✅ 支持 + active_plan_id 指针（v1.6 修订：移除归档概念，靠 mtime+status 过滤） | omo/ECC 验证可行 |
| 11 | 意图门 | 混合（关键词 + 文件数 + LLM 兜底）| 4 个项目没有这种混合，这是 ZooKeeper 的差异化 |
| 12 | 意图门 reasoning | 输出 | 用户能纠正 |
| 13 | Plan slug 生成 | 时间戳 + LLM + 用户确认 | 防重名 + 用户可控 |
| 14 | 多项目切换 | CWD 自动识别 | 单一入口哲学 |
| 15 | Resume vs Handoff | **现在 Resume, P1 加 Handoff** | Resume 覆盖 90% 场景，Handoff 有工程成本 |
| 16 | 中断恢复 | 新 session 自动注入 active plans 概况 | 用户不感知也能恢复 |
| 17 | Plan 状态机 | 4 状态（planning/planning-done/executing/done）| 最简覆盖 |
| 18 | Plan 迭代 | 原地更新 | 简单够用，未来可加版本化 |
| 19 | Plan 废弃 | 直接删除 | 不做 archive |
| 20 | Plan agent 工具权限 | 静态 deny（edit/write/task）| ZooKeeper 已有基础设施 |
| 21 | Bash 权限 | allow + prompt 约束 | 需要跑诊断命令 |
| 22 | Plan 文件写入者（P0） | orchestrator 代理写 | 已废弃。P1 改为 mola 直接写（hook 路径约束）|
| 23 | Plan 执行期间可用 subagent | general + explore + spider | 灵活，TODOs 里可注明推荐 |
| 24 | 未来扩展性 | PlanSessionTracker 接口为 BackgroundManager 预留方法 | 升级不改现有调用方 |
| 25 | 意图门机制 | **完备性门控替代复杂度判定** | omo 代码验证：路由不是评估任务规模，是评估模型自身知识缺口（知道改哪里？知道怎么改？） |
| 26 | 路由粒度 | **基于知识缺口：缺文件→explore，缺方案→plan，缺意图→反问** | omo Sisyphus 的"请求分类 + 上下文完成门控"比文件数阈值更可靠 |
| 27 | Plan agent 叶子节点 | **P0 task = "deny"，不自委派探索** | ECC 模式（planner 自己 read/grep/glob）；P1 参考 omo Prometheus 开 task 只给 explore/spider |
| 28 | 叶子委派演进 | **P0 方案 A（不自委派）→ P1 方案 B（可调 explore/spider）** | omo plan-family guard 验证可行；需解决 deny 粒度问题（当前 deny 是全局二值） |
| 29 | 权限模型 | **deny list + hook 路径约束** | P1 中 mola 获取 edit/write 权限，但通过 hook 路径约束至 `~/.zoo/**/*.md`。P0 orchestrator 代理写模式已废弃。ZooKeeper deny list 风格不变，补充入路径检查 |
| 30 | Hook 层数 | **P0 两层（session.idle 解 unreconciled + tool.execute.after 续期提示），接口预留三层** | omo 三层 hook 经验证是不同 scope（Atlas/TodoEnforcer/StopGuard），P0 不需要但 P1 用得上 |
| 31 | Alias 机制 | **P1 再加（等 agent 命名稳定）** | slim alias 重写 30 行可做，但依赖 agent 前缀约定（pln-1 等） |
| 32 | 安全边界 | **prompt 管决策质量，code 管破坏范围** | omo 架构验证：路由判断靠 prompt（模型可无视），权限底线靠 config.toml deny（结构保证） |
| 33 | 意图路由位置 | **在 mola prompt 中完成，不在 skill 层** | 镜像 omo 模式：Sisyphus 决定是否进入规划，Prometheus/ulw-plan 决定如何规划。skill 是纯执行引擎 |
| 34 | Skill 分层架构 | **slim prompt → skill → reference 文件** | Token 高效：mola 只加载匹配的参考文件（clear/unclear），不加载全部 250+ 行 |
| 35 | Skill 命名 | **plan-mode → mola-plan** | 与 mola agent 命名空间一致，避免模糊的"plan-mode"命名 |
| 36 | 内置 plan agent | **`[agent.plan] disable = true`** | mola 接管规划职责，避免两个规划 agent 冲突 |
| 37 | mola-spec 创建后删除 | **暂不保留，等待 handoff** | 深度设计挖掘需要多轮采访，subagent 在单一 task() 中无法实现。需 handoff 机制（P1）|
| 38 | 多轮采访方案 | **拒绝 orchestrator 透传式转发** | orchestrator 透传用户回复使 orchestrator 沦为消息中继，浪费 orchestrator 上下文。改用 session reuse 或 handoff（P1）|
| 39 | Mola agent 角色演进 | **P1 升级为 primary，subagent 角色废弃** | omo 的规划 agent（Prometheus）本身就是 primary + 独立 session；subagent 的所有优势（orchestrator 替用户判断）在 handoff 中仍可通过 build 完备性门控保留。subagent 模式在 P1 中无独立价值 |
| 40 | P1-B handoff 实现方案 | **新会话 handoff 为默认，同会话切换为短规划 fallback** | 新会话避免规划长跑拖累执行智能窗、避免角色混淆、规划/执行日志物理分离；`parentID` 关联保留可追溯性（zfind/ztrace 跨会话）|
| 41 | Plan 文件写入权 | **P1 转移到 mola（hook 路径约束至 `~/.zoo/**/*.md`）** | 反转 P0 设计（mola 输出文本，orchestrator 代写）。omo 通过 `prometheus-md-only` hook 验证此模式。Dolphin 保留 `executing`/`done` 状态更新（v1.6 修订：`_projects.json` 已废弃） |

| 42 | TUI 切换机制 | **`tui.publish()` + SSE 事件总线** | 实测验证：`tui.selectSession()` endpoint 存在且返回 200，但不触发 TUI 响应。TUI 前端通过 SSE 订阅 `tui.session.select` 事件，必须用 `tui.publish({body:{type:"tui.session.select", properties:{sessionID}}})` 触发切换。这是 P1-B 新会话 handoff 的关键实现细节 |
| 43 | P0 mola subagent 方案 | **尝试后废弃，mola prompt/skill/config 条目已清除；设计遗产向前携带至 P1** | 实现三个组件（prompt/skill/config）后测试发现三个结构性问题：无多轮采访、编排器沦为消息中继、角色混淆。验证了本文档自身分析——subagent 无法满足规划需求。**存活组件：** (1) mola-plan skill 设计范式（分层加载、CLEAR/UNCLEAR 双路径、explore-before-ask 协议、两过滤器纪律、审批门）作为 P1 重建蓝本；(2) 完备性门控（§11 设计规格，**从未在代码中实现**）作为 P1 待实现的路由机制 |
| 44 | 实施方向 | **跳过 P0，直接 P1 handoff** | P0 失败使 handoff 从备选升级为唯一路径。不再需要两条腿走路。执行阶段 plan 修改由 build 直接编辑，仅完整重规划才 handoff 回 mola |
| 45 | 执行阶段 plan 修改 | **build 直接编辑 plan 文件，无需 handoff 回 mola** | 中等/轻微调整（更新 TODOs、标记完成、调整步骤顺序）由 build 直接做，写入权通过 `~/.zoo/**/*.md` 路径约束控制。仅完整重新规划（架构重设计、方案全面推翻）触发新 mola handoff |
| 46 | Background Job Board | **暂缓至 P2，非 handoff 前置** | handoff 模式下规划与执行物理分离，P1 不需要并行任务追踪。Job Board 在 P2 与 session-tracker 一起独立实现 |
| 47 | session-tracker.ts | **暂缓至 P2** | handoff 模式下规划与执行完全隔离，P1 不需要追踪 active sessions。与 Background Job Board 一起在 P2 实现 |
| 48 | plan-lifecycle idle 检测 | **去掉，handoff 替代此需求** | 原设计在 session.idle 时自动将 planning-done 转为 executing。handoff 显式创建执行 session，无需推测状态转换 |
| 49 | 规划 skill 架构 | **两 skill 分离: mola-plan + mola-spec** | 继承 P0 分层设计但拆分用途：mola-plan 负责常规规划(CLEAR/UNCLEAR 双路径)，mola-spec 负责深度设计探索/grill。两 skill 通过 Workflow 路由选择，非 agent prompt 层判断 |
| 50 | 路由位置 | **内嵌 Workflow 段，非独立 Intent Routing 段** | 旧版在 agent prompt 中设独立 `<Intent Routing>` 段。新版路由逻辑 = Workflow 第二步的子分支(Explore vs Interview)，减少 prompt 冗余 + 提升 token 密度 |
| 51 | Contract 替代 Discipline | **Contract 标签(6 硬约束)取代旧 Discipline 段** | 旧结构: Role → Discipline → Workflow。新结构: Role → Contract → Workflow。Contract 将约束从"软纪律"升级为"硬协议"(输出格式、工具限制、每轮问题数、探索纪律等)，Workflow 专注于流程步骤 |
| 52 | Spec→Plan 管道 | **通过 prompt 路由而非代码管道** | mola-spec 产出(深度设计文档)不经过代码层转换。spec 完成后用户批准，Workflow 引导进入 mola-plan 通道生成 plan 文件。两阶段共享同一 mola session，路由 = prompt 中的条件分支 |
| 53 | Plan 模板 | **从 omo 扩展：新增 Scope/Execution strategy/Final verification/Commit strategy/Success criteria** | 旧模板(Context/Approach/Critical Files/Verification/TODOs/Risks)缺少范围界定和验证标准。omo 的 plan 模板基础上加入 Must/Must NOT have、依赖矩阵、F1-F4 验证波、commit 策略、成功标准，使 plan 即可执行又可审计 |
| 54 | 两 skill 合并为一 skill | **mola-spec 整体合并进 mola-plan** | 路由判断（spec vs plan）下沉到 skill 内的 Classify 阶段。mola-spec 目录删除，grill-protocol.md + spec-template.md + scaffold-spec.py 全部迁移到 mola-plan。中途升级替代 prompt 层的重试（发现任务更重时追加加载 heavier reference，不需要回到 Workflow 重新路由）。试错成本极低 |
| 55 | 路由全面下沉 skill | **mola.md Workflow 极简为 3 步（Load/Execute/Handoff），不再做路由决策** | 所有路由（Clear/Unclear/Architecture）和升级逻辑下沉到 mola-plan 的 Phase 2 Classify。prompt 不再承担 Ground/Interview/Design/Produce 等任何阶段的描述。prompt 只声明身份+硬约束+交接 |
| 56 | 脚手架脚本作为格式唯一权威 | **scaffold-plan.py + scaffold-spec.py 是 plan/spec 格式的唯一事实来源** | 删除 `references/spec-template.md` 和 `SKILL.md` 中的 Plan/Spec File Output Format section。脚本生成的 YAML frontmatter + markdown body + 内联 `<!-- placeholder -->` 注释就是格式定义和填充指引。模型填充内容时看脚手架脚本生成的注释即可 |
| 57 | 统一 YAML frontmatter | **plan 和 spec 的 frontmatter 都是 YAML `---` 格式** | plan 原本用 TOML `+++`，spec 用 YAML `---`。统一到 YAML 使两个文件解析逻辑一致，未来 plan-state.ts 只需实现一套 parser。脚手架脚本同步更新为统一格式 |
| 58 | mola 工具权限具体配置 | **task=deny + webfetch=deny + websearch=deny；edit/write/read/grep/glob/bash/question 默认 allow** | mola 作为 primary 不委派子 agent（P1 阶段），hook 在运行时把 edit/write 路径约束到 `~/.zoo/**/*.md`。允许 bash 但 prompt 硬约束只跑诊断命令 |
| 59 | 禁用内置 plan agent | **`[agent.plan] disable = true`** | mola 接管规划职责后，OpenCode 内置 plan agent 会与 mola 冲突。禁用避免两个规划 agent 共存的歧义 |
| 60 | mola-plan 注册到 skills | **`[zoo.skills] mola-plan = "enable"`** | 通过现有的 skill 注册机制把 mola-plan 加入可用技能列表。mola 的 permission.skill 仅允许 mola-plan + wiki-query，防止 skill 滥用 |
| 61 | orchestrator 命名 | **"dolphin" 替代设计文档原 "build"** | 实施时最终确定 dolphin 为 orchestrator agent 名，语义更清晰（"海豚——海洋的编排者"）。`config.toml` 中为 `[agent.dolphin]`，prompt 文件为 `dolphin.md`。设计文档历史章节中 "build" 均应理解为 "dolphin" |
| 62 | plan 文件路径退化方案 | **`~/.zoo/plans/<sessionID>/` 作为 `<project-id>/` 未实现时的临时方案** | project-id.ts（Step 3）未实现时，以 sessionID 作为 plan 子目录名。`rewritePlanPath()` 和 `findPlanByStatus()` 均适配此模式。project-id.ts 实现后切换 |
| 63 | plan.ts 命名 | **`plan.ts` 替代设计原名 `plan-state.ts`** | 简化命名，state 隐含但非必需的限定词 |
| 64 | scaffold 脚本 | **不实现 scaffold Python 脚本，template markdown 文件替代** | 决策 #56（脚手架作为格式唯一权威）未落地。模板文件（`templates/plan-template.md` + `spec-template.md`）同时作为生成模板和内联内容指引，mola-plan skill Phase 5 基于模板通过 `write`+`edit` 创建 plan/spec 文件 |
| 65 | handoff 触发方式 | **仅 `/go` 命令手动触发，不实现 chat.message hook 自动触发** | chat.message hook 检测 `[完备性: ...]` 自动路由到 mola 的设计未实现。当前用户显式在 UI 下拉菜单切换到 mola 或 mola 输出后用户键入 `/go`。自动路由推迟至 P2 |
| 66 | mola prompt 委派段 | **`<Agents>` 段声明 lynx/spider 委派能力** | 设计文档在 prompt 结构和 config.toml 中均未给 mola 委派子 agent 的能力描述。实际 mola.md 设 `<Agents>` 段声明 task() 委派探索能力。config.toml 中 `task` 未显式 deny 或 allow——存在 prompt-config 权限声明不一致，需在 P2 中对齐 |
| 67 | plan 文件路径正式方案 | **`~/.zoo/plans/<sessionID>/` 正式替代 `<project-id>/`** | 零索引依赖，plan 天然归属创建 session；无需 `deriveProjectId()` 和 `_projects.json`；删除 session 时 plan 一并清理；`rewritePlanPath()` 已在 sessionID 模式运行 |
| 68 | project-id.ts 废弃 | **不实现 project-id.ts + `_projects.json`** | sessionID 方案消除了跨 session 映射需求；`_projects.json` 失去存在理由——plan 归属 session，不需要中间索引关联项目路径 |
| 69 | plan 归档 | **不归档，靠 mtime + status 过滤** | 已完成 plan 留在原 session 子目录；mtime 过滤（30 天）自然排除僵尸 session；等效于物理归档，无路径变更 bug 风险 |
| 70 | active-plans 概况注入 | **扫描方案：遍历所有 session 子目录 + mtime + status 两层过滤，P2 实现** | 不建索引文件；plan 数量不可能大到遍历成为瓶颈（每个 plan 是几十 KB markdown）；复杂度 O(子目录数)，约 40 行 |
| 71 | Plan progress nudge | nudge pipeline: shared check functions + unified constants + thin hook adapters | "只提醒，不做决策"（不自动修改 plan 文件）；两个 hook 均注入 todo + plan；错误降级到 warn 不阻断；两端点（task 返回 + edit/write）覆盖所有代码变更 |

---

## 17. 参考资料

### 调研的项目源码位置

| 项目 | 路径 | 关键文件 |
|---|---|---|
| omo | `~/Agent/oh-my-openagent/` | `packages/omo-opencode/src/agents/sisyphus/`, `packages/boulder-state/`, `packages/omo-opencode/src/features/background-agent/` |
| slim | `~/Agent/oh-my-opencode-slim/` | `src/utils/background-job-board.ts`, `src/hooks/task-session-manager/`, `src/agents/` |
| omp | `~/Agent/oh-my-pi/` | `packages/coding-agent/src/plan-mode/`, `packages/coding-agent/src/task/`, `packages/agent/src/agent-loop.ts` |
| ECC | `~/Agent/ECC/` | `agents/planner.md`, `commands/plan.md`, `commands/multi-plan.md`, `.opencode/opencode.json` |

### ZooKeeper 内部文档

- [`plan-mode-research.md`](./plan-mode-research.md) — 6 月 10 日早期调研（本文前置阅读）
- [`agent-framework-comparison.md`](./agent-framework-comparison.md) — 多框架对比
- [`hook-system-comparison.md`](./hook-system-comparison.md) — Hook 系统对比
- [`agent-loop-engineering-research.md`](./agent-loop-engineering-research.md) — Agent loop 工程
- [`code-review-research.md`](./code-review-research.md) — Code review 调研

### 关键发现引用

- **omo session reuse**: `tools/delegate-task/sync-continuation.ts`，hook 自动追加 `to continue:`
- **slim unreconciled**: `utils/background-job-board.ts` `isReusable()` + `reconcileInjectedTerminalJobs`
- **omo handoff**: `hooks/start-work/work-initializer.ts` + BoulderState
- **omo BackgroundManager**: `features/background-agent/manager.ts`（2000+ 行）
- **slim BackgroundJobBoard**: `utils/background-job-board.ts`（528 行）
- **omp plan mode guard**: `tools/plan-mode-guard.ts` `enforcePlanModeWrite()`
- **omp IRC revive**: `irc/bus.ts` + `agent-session.ts` `deliverIrcMessage`

---

## 18. 修订记录

### v1.1 (2026-06-23) — 代码验证修订

基于对 omo/slim/omp/ECC 四项目约 20 个关键源文件的代码级验证（两轮 8 个 explore subagent），对以下章节进行了修正：

| 章节 | 修订内容 | 验证来源 |
|---|---|---|
| **§7** Resume vs Handoff | 复杂度三档（trivial/standard/complex）→ 知识缺口三档（无缺口/中等缺口/大量缺口） | omo Sisyphus 的请求分类 + 上下文完成门控（`sisyphus-dynamic-prompt-role.ts`） |
| **§8** 架构图 | "意图门 (IntentGate) — trivial/standard/complex 分支" → "完备性门控 (Completeness Gate) — 四个自检" | 同上；slim BackgroundJobBoard 注入格式验证了 subagent 隔离上下文 |
| **§11** 意图门 | **完全重写**：三层混合判定（关键词+文件数+LLM兜底）→ 完备性门控（请求分类 → 四个知识缺口自检 → reasoning 输出）。核心原则：delegate to PLAN when GUESSING the approach | omo `sisyphus-dynamic-prompt-role.ts:53-81`（五分类+三条自问）；验证发现 omo 无一行代码使用文件数阈值 |
| **§13** 权限 | 补充 deny list 一致性验证 + P1 叶子委派预留说明 | omo plan-family guard + Prometheus 委派矩阵；ECC 工具白名单对比 |
| **§14** 实施路径 | 新增 **14.0 P0 前置**（完备性门控设计 + plan agent prompt + config.toml），约三个文件 ~110 行，零代码改动。**注：完备性门控在此阶段仅为设计规格（§11），未实际编码至 build.md。** 原 Step 1-7 顺延为 P1 工程实施 | ZooKeeper 当前 agent 层级分析（6 agent，两层结构）；omo 安全边界模型（prompt vs code 分层） |
| **§16** 决策日志 | 新增 #25-#32（完备性门控、知识缺口路由、叶子节点委派、deny list 一致性、hook 层数、alias 暂缓、安全边界分层） | 综合四项目验证结果 |

**代码验证确认无需修订的章节：**

| 章节 | 验证结论 |
|---|---|
| §4 Session Reuse | omo 的 `sync-continuation.ts` + slim 的 alias 重写均验证了设计文档描述准确 |
| §5 Handoff | omo 的 `start-work-hook.ts`（同 session `updateSessionAgent` 切换）+ `boulder.json` 状态桥验证准确 |
| §6 Background Job Board | slim 的 `background-job-board.ts` unreconciled 状态机验证准确；omo BackgroundManager 实际接近 3000 行（设计文档估算偏小，但对 P0 无影响） |
| §9-10 状态机和文件结构 | 无变更 |
| §12 多项目管理 | 无变更 |
| §15 未来演进 | P1/P2 演进方向与 omo/slim 实践路径一致 |

**主要发现源文件清单：**

| 项目 | 关键验证文件 |
|---|---|
| omo | `sync-continuation.ts`, `start-work-hook.ts`, `background-agent/manager.ts`, `sisyphus-dynamic-prompt-role.ts`, `subagent-request-preflight.ts`, `tool-config-handler.ts`, `boulder-state/src/types.ts` |
| slim | `background-job-board.ts`, `task-session-manager/index.ts`, `council-manager.ts`, `subagent-depth.ts`, `agents/orchestrator.ts`, `agents/permissions.ts` |
| omp | `plan-mode-guard.ts`, `irc/bus.ts`, `agent-lifecycle.ts`, `orchestrate-notice.md` |
| ECC | `commands/plan.md`, `agents/planner.md`, `commands/multi-plan.md`, `skills/continuous-learning-v2/SKILL.md` |
| ZooKeeper | `config.toml`, `core/prompts/build.md`, `install.py` |

**代码验证确认无需修订的章节：**

| 章节 | 验证结论 |
|---|---|
| §4 Session Reuse | omo 的 `sync-continuation.ts` + slim 的 alias 重写均验证了设计文档描述准确 |
| §5 Handoff | omo 的 `start-work-hook.ts`（同 session `updateSessionAgent` 切换）+ `boulder.json` 状态桥验证准确 |
| §6 Background Job Board | slim 的 `background-job-board.ts` unreconciled 状态机验证准确；omo BackgroundManager 实际接近 3000 行（设计文档估算偏小，但对 P0 无影响） |
| §9-10 状态机和文件结构 | 无变更 |
| §12 多项目管理 | 无变更 |
| §15 未来演进 | P1/P2 演进方向与 omo/slim 实践路径一致 |

### v1.2 (2026-06-24) — P0 实施与补充调研

P0 实施（详见 §14.0 与 [§16 #33-#38](#16-决策日志)）：mola agent prompt、mola-plan skill + 三个 references、config.toml agent 注册 + 内置 plan 禁用。总建成 ~470 行 prompt/skill，零 TS/Python/Rust 代码改动。**注：完备性门控（四个自检 + reasoning）在此阶段仅为 §11 设计规格，从未实际编码于 build.md。**

**架构决策沉淀：** 意图路由放在 agent prompt（`<Intent Routing>`），skill 只做执行引擎——镜像 omo 的 Sisyphus→Prometheus 分工。skill 采用分层加载（agent prompt → skill → reference），token 效率优于单一大 prompt。

**补充调研（Superpowers brainstorm + Matt Pocock 系列 skill）：**

| 关键技术 | 来源 | mola 现状 |
|----------|------|-----------|
| HARD-GATE（设计批准前不实现） | Superpowers brainstorm | ✅ 已吸收："plan mode is sticky" |
| 探索优先 + 两过滤器（证据/默认） | Matt Pocock grilling | ✅ 已吸收：mola-plan 核心协议 |
| 审批门 + 推荐答案先行 | 两者共有 | ⚠️ 部分：mola-plan 审批门已实现；推荐答案优先仅在 CLEAR 路径部分体现 |
| ONE question per turn + 多选优先 | Superpowers brainstorm | ❌ 需 mola 升级为 primary（handoff） |
| 深度优先分支遍历 + 场景压力测试 | Matt Pocock grill | ❌ 需 multi-turn 对话能力 |
| Spec 自审（4 项检查） | Superpowers brainstorm | ⚠️ Must-NOT-Have + QA 自动化指令部分覆盖 |

**mola-spec（深度设计探索 skill）：** 曾创建后删除。subagent 在单次 `task()` 中只能输出一段文本，无法进行多轮 grill 采访。需要 mola 升级为 primary agent 后才能重新启用，列入 P1-C 优先级。orchestrator 透传式转发方案被否决：使编排器沦为消息中继，浪费上下文（详见 [§16 #38](#16-决策日志)）。

**Handoff 机制发现：** 确认 OpenCode 支持两种 handoff 路径——**(1)** 同会话切换（`chat.message` hook + `output.message["agent"]`，omo 的 start-work-hook 已在生产验证）和 **(2)** 新会话 handoff（`session.create` + `session.promptAsync` + `tui.publish`，omo 的 ralph-loop 模块验证），后者是长规划场景的推荐方案，详见 §5.6 与 §7.4。

**Omo 规划架构洞见：** 确认 omo 的规划 agent（Prometheus）是 `mode = "primary"`，与实现编排者平级，拥有独立 session，并通过 hook 路径约束其写操作。用户通过 UI agent 切换进入规划——这本身就是 handoff，不是 subagent 委派。这意味着 mola 的 P0 subagent 模式（输出文本、orchestrator 代写）仅是 handoff 不可用时的临时方案。P1 阶段 mola 升级为 primary 后应接管 plan 文件写入，subagent 角色随之完全废弃。

**Session resume 独立性：** Resume 与 handoff 解决不同问题，P1 中两者并存不互斥——resume 用于 task_id 续期、跨会话恢复、失败后回拉同一 subagent；handoff 用于 build↔mola 之间的角色切换。

**P1 路线图修订：** session reuse（P1-A，独立通用基础）→ 新会话 handoff（P1-B，推荐）→ mola 升级 primary + mola-spec 复活（P1-C）→ 补充调研技术吸收（P1-D）。

#### Day-2 实测（同日晚间）

在 `/tmp/handoff-prototype/` 构建最小化 handoff 插件进行端到端验证。关键发现：

**TUI 切换的真正机制：** `tui.publish()` + SSE 事件总线，而非 `tui.selectSession()`。

实测过程：
1. SDK v1 client 上 `tui.selectSession` 方法运行时为 `undefined`（`typeof === "undefined"`）
2. 从 SDK v2 类型定义发现该方法存在，调用后返回 200 但 TUI 不切换
3. 逆向工程 opencode 1.17.9 二进制，发现 TUI 通过 SSE 订阅 `tui.session.select` 事件
4. 改用 `tui.publish({body:{type:"tui.session.select", properties:{sessionID}}})` 后成功触发切换

**影响：** P1-B 新会话 handoff 可以完全自动化，无需用户手动切换 session。详见 [§16 #42](#16-决策日志)。

> **⚠️ v1.3 订正：** 上文中"P0 前置全部完成"的结论是在实施测试之前作出的。实际测试后 mola subagent 方案被废弃。mola prompt/skill/config 文件已删除。mola-plan skill 设计范式作为前向携带架构存活至 P1。完备性门控仅为 §11 设计规格，**从未在代码中实现**，需在 P1 中实现。详见 v1.3 修订记录。

### v1.3 (2026-06-24) — P0 mola subagent 废弃与 P1 范围修订

**P0 mola subagent 方案被尝试后废弃。** v1.2 中实施的三个组件（mola agent prompt、mola-plan skill 分层、config.toml 注册）均经过实际测试，确认 subagent 模式无法满足规划的多轮深度对话需求。三个结构性问题：**(1)** 无多轮采访能力——单次 `task()` 只能输出一段文本；**(2)** orchestrator 透传使其沦为消息中继，上下文被规划对话污染；**(3)** 角色混淆，用户感知不到明确的规划角色切换。

**文件清除，设计遗产向前携带至 P1。** mola agent prompt、skill 文件、config.toml 注册条目已删除。存活情况如下：
1. **mola-plan skill 设计范式** —— 尽管文件已删除，其 skill → reference 分层加载、CLEAR/UNCLEAR 双路径、explore-before-ask 协议、两过滤器问题纪律、审批门等架构是经过验证的有效设计，P1 中以 skill 重建形式复活
2. **完备性门控（设计规格，待 P1 实现）** —— 四个自检 + reasoning 输出仅存在于本文档 §11 的设计规格中，**从未在代码中实现**。P1 中需在 `core/prompts/build.md` 中实现，作为 orchestrator 判定"缺方案 → handoff 到 mola"的主动路由机制

**修正的设计文档章节：**

| 章节 | 修订内容 |
|------|----------|
| **§5.7** Omo 规划架构关键洞见 | 新增 P0 方案验证说明，记录尝试与废弃过程；新增执行阶段 plan 修改规则（build 直接编辑，无需 handoff 回 mola） |
| **§7.4** 最终决策 | P0 从"当前临时方案"重写为"已废弃"；新增范围裁剪表（session-tracker 暂缓、idle 检测去掉、plan-state.ts 逻辑不变但写入者变更）；确认 handoff 为唯一路径 |
| **§8.1** 架构图 | Plan Agent 从 subagent 改为 primary handoff 模式 |
| **§8.2** 组件清单 | 更新 Plan agent prompt 文件路径；session-tracker 标注暂缓至 P2；更新行数估算 |
| **§13.1** 工具权限 | 移除 P0 引用；更新 P1 deny 模型说明 |
| **§13.3** 责任分离 | P1 中 plan 文件由 mola 直接写（hook 路径约束），orchestrator 仅维护 `_projects.json` 索引与状态更新 |
| **§14.0** 实施路径 | **完全重写**：从"P0 前置已完成"改为"P0 mola subagent 尝试与废弃"，详细记录尝试内容、废弃原因、正面价值。**v1.3 原版错误地将完备性门控列为已实现组件（实为 §11 设计规格，从未编码），已在本版修正** |
| **§14.1** 实施步骤 | 七步分解：移除 session-tracker 和 idle 检测（原 7→6），新增 mola-plan skill 重建（Step 5，6→7）；更新写入者 |
| **§14.2** 每步产出 | 按新步骤重写，增加 P2 暂缓组件说明；新增 Step 5 产出描述（skill 分层、CLEAR/UNCLEAR 双路径、参考文件） |
| **§14.3** 顺序约束 | 按新步骤重写，补充 Step 5/6 依赖关系 |
| **§15.1** 未来演进 | P1 段从"在 P0 稳定后"改为"在 P1 handoff 稳定后"，更新 P2 新增列表 |
| **§15.2** BackgroundManager | 更新为从 P1 暂缓的 PlanSessionTracker 升级 |
| **§16** 决策日志 | 新增 #43-#48（P0 废弃、执行阶段修改规则、Job Board/session-tracker 暂缓、idle 检测移除） |

**关键设计决策确认：**

- **Handoff 确认为正确方向** —— P0 的失败使 handoff 从备选升级为唯一路径
- **完备性门控作为主动 handoff 触发器（待 P1 实现）** —— §11 设计规格定义四个自检 + reasoning 输出路由"缺方案 → handoff 到 mola"，非旧式 `task(mola)` 调用。需在 P1 中首次实现于 `core/prompts/build.md`
- **mola-plan skill 设计范式存活** —— 文件已删除，但 skill → reference 分层、CLEAR/UNCLEAR 双路径、explore-before-ask 协议、两过滤器纪律、审批门在 P1 中重建
- **执行阶段 plan 修改** —— build 直接编辑 plan 文件（中等/轻微调整），仅完整重规划才 handoff 回 mola
- **Background Job Board 和 session-tracker 暂缓至 P2** —— handoff 模式下规划与执行物理分离，P1 不需要并行追踪
- **plan-lifecycle 去掉 idle 检测** —— handoff 显式创建执行 session，无需推测状态转换
- **plan-state.ts 逻辑不变，写入者从 orchestrator 改为 mola** —— hook 路径约束保证安全

---

### v1.4 (2026-06-25) — P1 前期实施：prompt、skill、config

**P1 已完成的步骤**（Step 1 + Step 4 + Step 5）：

| Step | 组件 | 状态 | 规模 |
|---|---|---|---|
| 1 | config.toml | ✅ 已完成 | mola 注册 + plan 禁用 |
| 2 | plan-state.ts | 待实施 | ~200 行 |
| 3 | project-id.ts | 待实施 | ~150 行 |
| 4 | mola.md | ✅ 已完成 | ~50 行 |
| 5 | mola-plan skill | ✅ 已完成 | SKILL.md + 3 reference + 2 scaffold 脚本 |
| 6 | plan-lifecycle hook | 待实施 | ~250 行 |
| 7 | 集成测试 | 待实施 | ~80 行 |

**mola-plan 单一 skill 架构**：

v1.3 中设计的 mola-plan + mola-spec 双 skill 架构在实际编写时发现**路由判断的脆弱性**——prompt 需要在 Ground 之后判断"明确 vs 模糊 vs 架构"，误判时需要回到 Workflow 重走，试错成本偏高。v1.4 改为：

- **单一 skill**（mola-plan）接管全部规划逻辑：Ground → Classify → Interview → Present Design → Produce → Handoff
- **Classify 阶段**（在 skill 内部）根据 Ground 发现决定加载哪些 reference：
  - Clear → `intent-clear.md`（明确路径）
  - Unclear → `intent-unclear.md`（调研默认值路径）
  - Architecture → `grill-protocol.md`（深度访谈 + 场景压力测试）
- **Graceful upgrade**：访谈中途发现任务更重，可以追加加载 heavier reference，不需要回到 prompt Workflow
- **mola-spec 已废弃**：目录删除，grill-protocol.md + spec-template.md + scaffold-spec.py 全部迁移到 mola-plan

**mola.md prompt 极简为 3 步 Workflow**：

原设计让 prompt 描述 Ground/Route/Interview/Design/Produce 5 个阶段，实际编写时发现这等同于在 prompt 层重复 skill 内容。v1.4 改为：

- **Load**（1 行）：加载 mola-plan skill
- **Execute**（1 行）：让 skill 接管
- **Handoff signal**（3 行）：检测 `[Plan approved and written. Ready for handoff to build orchestrator.]` 信号

**所有规划逻辑在 skill 内部**：Ground Check、Classify、Interview、Present Design、Produce、Handoff Signal 全部由 SKILL.md 拥有。Skill 现在是自洽的——不引用 prompt 的 Contract。

**脚手架脚本作为格式唯一权威**：

- 删除了 `references/spec-template.md`（spec 格式独立文档）
- 删除了 SKILL.md 中 `## Plan File Output Format` 和 `## Spec File Output Format` section
- `scaffold-plan.py` + `scaffold-spec.py` 现在既是文件生成器，又是格式定义+内容指引（内联的 `<!-- placeholder -->` 注释包含每节该写什么）
- 脚手架生成的 YAML frontmatter + markdown body 就是唯一格式权威

**统一 YAML frontmatter**：

plan 原本用 TOML `+++`，spec 用 YAML `---`。v1.4 统一为 YAML `---`：两个文件格式解析逻辑一致，未来 plan-state.ts 只需实现一套 parser。

**config.toml 实际配置**：

```toml
[agent.mola]
model = "{env:ZOO_MODEL}"
[agent.mola.permission]
task      = "deny"    # P1 阶段不自委派
webfetch  = "deny"
websearch = "deny"
# edit/write/read/grep/glob/bash/question 默认 allow（hook 路径约束至 ~/.zoo/**/*.md）

[agent.mola.permission.skill]
"*"           = "deny"
"mola-plan"   = "allow"
"wiki-query"  = "allow"

[agent.plan]
disable = true  # mola 接管规划职责

[zoo.skills]
mola-plan = "enable"
```

**测试修复**：

- `tests/test_static.py` 的 `_get_agent_names()` 加入 disabled agent 过滤，避免测试为 disabled 的 plan agent 找不存在的 prompt 文件
- `tests/thresholds.toml` 新增空 `[mola]` 阈值条目

**下一步（至 v1.5，已完成其中的 Steps 2、6）：**

- Step 2：plan-state.ts ✅ → 以 `plan.ts` 文件名实现（231 行 + 337 测试）
- Step 6：plan-lifecycle hook ✅ → 实现 `/go` 命令 + 八步 handoff 编排（273 行 + 398 测试）
- Step 3：project-id.ts ❌ 仍待实施
- Step 7：集成测试场景 ❌ 仍待实施

### v1.5 (2026-06-27) — P1 Steps 2 & 6 完成，设计-实现校对

**新完成的组件（自 v1.4 起）：**

| Step | 组件 | 文件 | 规模 | 测试 |
|------|------|------|------|------|
| 2 | Plan state manager | `src/core/plan.ts` | 231 行 | `plan.test.ts` 337 行 |
| 6 | Plan lifecycle hook | `src/hooks/plan-lifecycle/` | 285 行 | `hook.test.ts` 398 行 |
| — | `/go` 命令注册 | `src/index.ts` (command.execute.before) | ~40 行 | 由 hook.test.ts 间接覆盖 |

**设计-实现校对与修正：**

| # | 设计文档（v1.4 及之前） | 实际实现 | 状态 |
|---|---|---|---|
| 1 | orchestrator 命名为 "build" | 命名为 "dolphin"（`[agent.dolphin]`） | 文档需更新：design doc 中 "build" 均应理解为 "dolphin" |
| 2 | plan 文件路径 `~/.zoo/plans/<project-id>/` | `~/.zoo/plans/<sessionID>/` | project-id.ts 未实现时退化为 sessionID 子目录；`rewritePlanPath()` 已适配此模式 |
| 3 | Step 2 文件名 `plan-state.ts` | 实际为 `plan.ts` | 命名简化 |
| 4 | scaffold-plan.py / scaffold-spec.py 作为格式唯一权威 | 不存在；`templates/plan-template.md` + `spec-template.md` 替代 | 脚本未实现 |
| 5 | `task = "deny"` 显式声明 | config.toml 中隐式（未列出，框架默认 deny） | 效果等价，但设计文档描述不精确 |
| 6 | mola prompt "不允许委派子 agent" | mola.md 包含 `<Agents>` 段声明 lynx/spider 委派 | prompt 授权委派，但 config.toml 未显式 allow task——存在 prompt-config 不一致 |
| 7 | 完备性门控 §11 四个自检 + handoff 路由 | dolphin.md Phase 1 为简化 3-condition gate，无 handoff 路由 | 设计未实现 |
| 8 | `build.md` 作为 orchestrator prompt | 实际为 `dolphin.md` | 命名已对齐 agent config |
| 9 | Handoff 自动触发（chat.message hook） | 仅 `/go` 命令手动触发 | 自动 handoff 未实现 |
| 10 | config hook 注入 active-plans 概况 | 未实现 | 依赖 project-id.ts |
| 11 | 状态机校验（planning→planning-done→executing→done） | `updatePlanStatus()` 为自由字符串替换，无校验 | 合法状态校验未实现 |
| 12 | plan 文件初始状态 `status: executing`（§10.1 示例） | mola-plan skill 使用 `status: planning`，完成时设 `planning-done` | 示例应更新以匹配实际模板 |

**关于 agent 命名的说明：**

设计文档 v1.0–v1.4 中统一使用 "build" 指代 orchestrator。实际实现中 orchestrator agent 命名为 "dolphin"（`config.toml` 中 `[agent.dolphin]`）。此更改不影响架构设计——dolphin 承担的设计职责与设计文档中的 build 完全一致。本文档后续版本中的 "build" 均应理解为 "dolphin"，不再逐处替换历史章节。

**关于 plan 文件存储路径的说明：**

设计 §12 计划使用 `~/.zoo/plans/<project-id>/<slug>.md`，由 `project-id.ts`（Step 3）推导 project-id。该组件尚未实现，当前以 sessionID 作为子目录名。`rewritePlanPath()` 和 `findPlanByStatus()` 均已在 sessionID 模式下正常工作。

**关于 scaffold 脚本的说明：**

设计决策 #56（脚手架脚本作为格式唯一权威）未实施。模板文件（`plan-template.md`、`spec-template.md`）替代了脚本角色——它们同时作为文件生成模板和内联内容指引。mola-plan skill Phase 5 直接通过 `write` + `edit` 工具基于模板文件创建 plan/spec，无需经过脚本。

**P1 剩余待实施：**

| 优先级 | 组件 | 预估 |
|--------|------|------|
| P1 | Step 3: project-id.ts + `_projects.json` | ~150 行 |
| P1 | Step 7: 集成测试场景 | ~80 行 |
| P2 | 完备性门控 §11 四问版（dolphin.md 升级） | ~130 行 |
| P2 | `chat.message` hook 自动 handoff | ~30 行 |
| P2 | config hook active-plans 概况注入 | ~50 行 |
| P2 | 状态机校验 | ~30 行 |
| P2 | mola prompt-config task 权限对齐 | ~5 行 |

---

### v1.5 (2026-06-27) — P1 Steps 2 & 6 完成，设计-实现校对

**新完成的组件：**

| Step | 组件 | 文件 | 规模 | 测试 |
|------|------|------|------|------|
| 2 | Plan state manager | `src/core/plan.ts` | 231 行 | `plan.test.ts` 337 行 |
| 6 | Plan lifecycle hook | `src/hooks/plan-lifecycle/hook.ts` | 273 行 | `hook.test.ts` 398 行 |
| — | `/go` 命令 wiring | `src/index.ts` | ~40 行 | 由 hook.test.ts 间接覆盖 |
| — | barrel export | `src/hooks/plan-lifecycle/index.ts` | 12 行 | — |

**修改的设计文档章节：**

| 章节 | 修订内容 |
|------|----------|
| **文档头** | 版本号 1.3→1.5，补充 v1.5 修订摘要 |
| **§8.1** 架构图前置注 | agent 命名 "dolphin" 替代 "build"，plan 文件路径 `<sessionID>/` 替代 `<project-id>/` |
| **§8.2** 组件清单表 | 从 6 行估算表扩展为 8 行实际状态表，含文件名、实现状态、行数、测试覆盖 |
| **§13.3** 责任分离 | "Build" → "Dolphin" |
| **§14.1** 七步分解 | 更新 7 步状态：Step 2 ✅、Step 3 ❌、Step 6 ✅、Step 7 ❌；添加 agent 命名和路径偏差说明 |
| **§14.2** 每步产出 | **完全重写**：Steps 1-6 均按实际实现更新（文件名、行数、函数列表、测试覆盖）；Step 5 删除 scaffold 脚本引用、改为 template 文件；Step 6 八步 handoff 流程详述；暂缓至 P2 项新增 4 条 |
| **v1.4→v1.5** 过渡段 | "下一步" 从待实施改为已完成状态，新增 v1.5 修订条目 |

**12 项设计-实现偏差记录（详见 v1.5 修订）：**

1. orchestrator 命名：build → dolphin
2. plan 文件路径：`<project-id>/` → `<sessionID>/`（v1.6 正式采纳，非退化方案）
3. Step 2 文件名：`plan-state.ts` → `plan.ts`
4. scaffold 脚本：py 脚本 → markdown 模板文件替代
5. `task = "deny"`：设计显式 → 实现隐式（未列出）
6. mola 委派：设计不允许 → prompt 设 `<Agents>` 段 + config 未显式 allow（不一致）
7. 完备性门控：§11 四问 + handoff 路由 → dolphin.md 简化 3-condition，无 handoff 路由
8. orchestrator prompt 文件名：`build.md` → `dolphin.md`
9. handoff 触发：chat.message hook 自动 → `/go` 命令手动
10. config hook active-plans 注入：未实现（P2，扫描方案 §12.2）
11. 状态机校验：未实现（自由字符串替换）
12. plan 初始状态示例：`executing` → `planning`（匹配实际模板）

**P1 剩余待实施：** Step 6（集成测试, ~80 行）。P2 候选：完备性门控 §11 四问版、chat.message hook 自动 handoff、config hook active-plans 概况注入（扫描方案）、状态机校验、mola prompt-config task 权限对齐。

---

### v1.6 (2026-06-27) — sessionID 正式化，project-id 废弃

**决策变更：**

| 原设计（v1.5 及之前） | 新决策 | 理由 |
|---|---|---|
| plan 文件路径 `~/.zoo/plans/<project-id>/` | `~/.zoo/plans/<sessionID>/` | 零索引依赖，无需 project-id 推导，天然归属 session |
| `deriveProjectId()` + `_projects.json` | 废弃，不实现 | sessionID 方案无需映射表 |
| plan 归档（`_archived/` 子目录） | 不归档，mtime + status 过滤 | 等效效果，无路径变更风险 |
| active-plans 注入依赖 project-id | 扫描方案（遍历 + mtime + status 过滤，~40 行） | 简洁，P2 实现 |

**修改的设计文档章节：**

| 章节 | 修订内容 |
|------|----------|
| **§8.1** 前置注 | 更新为 v1.6 注——sessionID 正式方案，非退化 |
| **§8.2** 组件清单 | 移除 project-id.ts 行，注明已废弃 |
| **§12** 多 Project Plan 管理 | **完全重写** → "Plan 文件管理与中断恢复"：目录结构改为 sessionID、新增扫描方案（§12.2）、移除 `_projects.json`、移除归档概念 |
| **§14.1** | 七步 → 六步，原 Step 3（project-id.ts）移除 |
| **§14.2** | 移除原 Step 3 内容，步号重编号 3→6 |
| **§14.3** | 顺序约束更新（移除 project-id 并行分支） |
| **v1.5 修订段** | P1 剩余表更新为仅 Step 6（集成测试）；偏差 #2 修正为正式方案；偏差 #10 补充 P2 扫描方案说明 |

**决策日志新增：** #67–#70（sessionID 正式化、project-id 废弃、不归档、扫描方案）。

**P1 剩余：** Step 6（集成测试, ~80 行）。

### v1.7 (2026-06-27) — Plan progress nudge pipeline 统一

**新完成的组件：**

| 组件 | 文件 | 规模 | 测试 |
|------|------|------|------|
| Plan progress checks | `src/core/checks.ts` | 133 行 | `checks.test.ts` 7 行 |
| TODO counting | `src/core/plan.ts`（新增函数） | +32 行 | `plan.test.ts` +42 行 |
| Unified nudge constants | `src/core/prompts.ts`（重构） | +72/−22 行 | — |
| Hook refactoring | `post-task-nudge/hook.ts`, `direct-work-nudge/hook.ts` | −90/+21 行 | 已有测试更新 |

**统一内容：**
1. **格式** — 6 个 nudge 常量全部 `<internal-reminder>` 包裹，`X = Y = LOST PROGRESS` 公式结尾
2. **命名** — TODO 与 PLAN 对称：PROGRESS ↔ PROGRESS，DONE ↔ DONE，RESUME ↔ RESUME
3. **注入点** — 两个 hook（post-task、direct-work edit/write）均注入 todo + plan
4. **逻辑复用** — 两份重复的 plan 检查逻辑合并为 `checkPlanProgress()` 共享函数
5. **错误处理** — 统一 warn 级别日志，不阻断其他 nudge
6. **场景覆盖** — 补齐 TODO 全部完成时的 `TODO_RESUME_NUDGE`（原来静默跳过）；direct-work-nudge 补齐 todo 检查（原来只有 plan）

**修改的设计文档章节：**
| 章节 | 修订内容 |
|------|----------|
| §8.2 | 组件清单新增 checks.ts 行，plan.ts 行更新 |
| §8.3（新） | Plan Progress Nudge Pipeline 机制文档 |
| §14.2 Step 2 | 更新行数和新增函数 |
| §16 | 新增决策日志 #71 |

**P1 剩余：** Step 6（集成测试, ~80 行）。

---

**文档结束**

> 本文档在 plan mode 实现期间应当作为设计参考。每完成一个 Step，应回顾文档确认设计与实现一致；如果实现中发现需要修改设计，应回到本文档更新对应章节后再继续。
