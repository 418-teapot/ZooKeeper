# ZooKeeper Plan Mode: 完整设计文档

**Version: 1.0 — Date: 2026-06-23 — Classification: 设计方案**

> **前置阅读**: [`plan-mode-research.md`](./plan-mode-research.md) 覆盖 6 月 10 日的早期调研（plan mode 检测与切换机制）。本文档是该调研的**深化版本**：在调研 omo/slim/omp 的基础上加入 ECC，并深入探索了 session reuse、handoff、unreconciled 等具体机制，最终敲定了 ZooKeeper Plan Mode 的完整架构设计。

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
11. [意图门 (IntentGate)](#11-意图门-intentgate)
12. [多 Project Plan 管理](#12-多-project-plan-管理)
13. [权限与工具控制](#13-权限与工具控制)
14. [实施路径](#14-实施路径)
15. [未来演进](#15-未来演进)
16. [决策日志](#16-决策日志)
17. [参考资料](#17-参考资料)

---

## 1. 执行摘要

本文档记录了对 **oh-my-openagent (omo)**、**oh-my-opencode-slim (slim)**、**oh-my-pi (omp)**、**ECC** 四个 OpenCode 生态项目的深度调研，并基于调研结果敲定了 ZooKeeper Plan Mode 的完整架构设计。

**关键发现**:

1. **编排质量上限不在 subagent 能力，而在任务分解精准度** —— Plan Mode 是 ZooKeeper 当前最大杠杆点
2. **四个项目用完全不同的方式解决"追踪并行任务"**，但核心思想趋同：外挂 LLM 的短期记忆，用结构化状态呈现
3. **Plan 不应该是 primary agent** —— 现在做 Resume，未来加 Handoff 是正确顺序
4. **ZooKeeper 已有 session reuse 基础设施**（OpenCode 原生 `task_id`），缺的是 prompt 纪律 + 自动追踪 + plan 文件持久化

**最终设计要点**:

- **Plan 作为 subagent**（不是 skill，不是 primary），通过 `task()` 派生
- **Plan 文件存储于 `~/.zoo/plans/<project-id>/<slug>-<YYYYMMDD>.md`** —— 用户级集中管理，按 git remote / basename 推导 project-id
- **TOML frontmatter + markdown body + checkboxes** —— 状态字段（`planning`/`planning-done`/`executing`/`done`）+ TODOs 列表
- **Session resume 模式，透明显示 + 自动执行** —— 用户能看到续期信息，但无需操作
- **静态 deny 权限**: plan agent 禁止 `edit`/`write`/`task`，允许 `read`/`grep`/`glob`/`bash`（bash 靠 prompt 约束只跑诊断命令）
- **Plan 文件由 orchestrator 代理写**，plan agent 只输出 markdown 文本
- **意图门三层混合判定**: 关键词 hard rules + 文件数 + LLM 兜底（输出 reasoning 便于用户纠正）
- **未来为 Handoff 和 BackgroundManager 预留扩展点**

**实施路径**: 7 步，约 1000+ 行代码，分布在 7 个组件。

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
  ├── 写 .omo/plans/<slug>.md（TOML frontmatter + markdown checkbox）
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

### 5.6 关键局限

OpenCode 的 session 绑定一个 agent 配置。要在同一 session 里切换 agent 需要：
1. 动态修改 system prompt（OpenCode 不一定原生支持）
2. **通过 slash command 重新路由 agent**（omo 用的方式）
3. 完全重建 session（丢失对话历史）

ZooKeeper 当前没有 handoff 基础设施。这是 P1 特性的**真实工程成本**。

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

**本质**: 两者对应不同的**对话强度**维度：

| 复杂度 | 对话强度 | 谁做规划 | 用什么机制 |
|---|---|---|---|
| **trivial** | none | orchestrator 自己（脑内规划） | 都不用 |
| **standard** | low（1-2 个澄清问题） | plan agent（subagent，被 task() 派出） | **Resume** |
| **complex** | high（反复辩论、权衡、迭代） | plan agent（变成 primary） | **Handoff** |

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

### 7.4 最终决策: 分层策略

```
P0 (现在做): Resume only
  ├── plan agent 作为 subagent
  ├── 意图门: trivial/standard 走 resume
  └── 用 session reuse 让 plan agent 能续期、回答澄清问题

P1 (未来加): Complex + Handoff
  ├── 新增 plan-primary agent（不是 subagent）
  ├── 意图门: complex 触发 plan phase，session 动态切 prompt
  ├── $start-work 命令或自动触发执行 handoff
  └── executor agent 接管（Atlas-style）
```

**现在的设计为 handoff 预留了口子**：
- **Plan 文件位置** —— `~/.zoo/plans/` 中 plan agent 和 executor 都能读
- **Plan 状态机** —— `planning-done` 状态就是 handoff 触发点
- **`active_sessions`** —— handoff 时把 session ID 加入此列表
- **意图门 + reasoning 输出** —— 已经为 complex → handoff 留了判定路径

---

## 8. 最终设计方案

### 8.1 整体架构

```
┌─────────────────────────────────────────────┐
│  用户层                                      │
│  └─ 单一入口 orchestrator                    │
└─────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  意图门 (IntentGate, orchestrator prompt)    │
│  └─ trivial / standard / complex 分支        │
└─────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  Plan Agent (subagent, task() 派生)          │
│  └─ 探索代码库 (read/grep/glob/bash)         │
│  └─ 用户问答 (via session resume)            │
│  └─ 输出 markdown 文本（不写文件）            │
└─────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  状态层                                      │
│  ├── 文件: ~/.zoo/plans/<slug>.md            │
│  │     TOML frontmatter + markdown body      │
│  │     status / active_sessions / project    │
│  │                                           │
│  └── 内存: PlanSessionTracker (TS 单例)      │
│        Map<sessionId, SessionRecord>         │
│        (未来升级为 BackgroundManager)        │
└─────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  注入层 (system prompt 动态段)               │
│  └─ config hook 注入: active plan + reusable │
└─────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  实现层                                      │
│  ├─ standard: orchestrator 委派 general/etc  │
│  └─ complex: 多 subagent（串行，未来并行）    │
│  └─ 通过 session resume 续期失败任务         │
└─────────────────────────────────────────────┘
```

### 8.2 组件清单

| 组件 | 文件位置 | 职责 | 行数估算 |
|---|---|---|---|
| Plan agent prompt | `core/prompts/plan.md` | subagent prompt，工具受限、结构化输出 | ~150 |
| Plan state manager | `src/core/plan-state.ts` | 读写 plan 文件、解析 frontmatter、状态机 | ~200 |
| Plan session tracker | `src/core/session-tracker.ts` | 内存单例，追踪 active + reusable sessions | ~150 |
| Orchestrator 意图门 | `core/prompts/orchestrator.md` | 新增章节：trivial/standard/complex 判定 + plan 调用纪律 | ~80 |
| System prompt 动态段 | `src/core/prompts.ts` | 注入 active plan + reusable sessions | ~100 |
| Plan lifecycle hook | `src/hooks/plan-lifecycle/index.ts` | 注入 hook + plan 文件状态更新 hook | ~300 |
| Session resume 提示 | `src/hooks/task-resume-info/` 新增 | 每次 task() 后追加续期提示到 system prompt | ~50 |

**总计**: ~1030 行代码，7 个组件。

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
|---|---|---|
| `planning` | plan agent 正在探索/问答/生成 plan | plan agent（通过输出）→ orchestrator 代理写文件 |
| `planning-done` | plan 已就绪，等 orchestrator 读 | plan agent 输出 `ready` → orchestrator 写文件 |
| `executing` | orchestrator 开始委派实现 subagent | orchestrator（委派第一个 subagent 时） |
| `done` | 所有 TODO 完成 + 验证通过 | orchestrator（最后一个 checkbox 勾完后） |

### 9.2 Plan 迭代

**原地更新**: 同一文件，多次修改（planning-done → planning 回退是允许的）。

**不做版本化**: 历史靠 git 跟踪（虽然 `~/.zoo/plans/` 默认 gitignore，用户可以手动 init git 仓库备份）。

### 9.3 Plan 废弃

**直接删除**: 用户说"算了，不做这个"时，orchestrator 直接删除 plan 文件。不 archive，不 abandoned 状态。

### 9.4 Unreconciled 生命周期

1. plan agent 完成规划，输出 `status: ready` + markdown
2. orchestrator 代理写 plan 文件，写入 `status: planning-done`
3. orchestrator session.idle 时（或委派第一个实现 subagent 时）→ plan hook 自动把 `planning-done` 改为 `executing`
4. 如果用户在 executing 前就要求修改 plan，orchestrator 手动把状态改回 `planning`

**session.idle 自动解除** 的关键：参考 slim 的 `reconcileInjectedTerminalJobs` 触发时机。在 plan 场景下，orchestrator 读完 plan 文件（或委派第一个实现 subagent）时自然进入 idle，hook 检测到 planning-done → 自动转 executing。

---

## 10. Plan 文件结构

### 10.1 完整示例

`.zoo/plans/auth-middleware-20260115.md`:

```toml
+++
status = "executing"
slug = "auth-middleware-20260115"
project_root = "/home/cambricon/Agent/ZooKeeper"
created_at = "2026-01-15T10:23:45"
updated_at = "2026-01-15T10:28:12"
active_sessions = ["ses_abc123"]
+++

# Auth Middleware

## Context
为现有 API 路由添加 JWT 验证中间件。现有代码在 `src/server/routes.ts`，
需要插入到路由注册前。需要考虑 access token + refresh token 两种场景。

## Approach
1. 创建 `src/server/middleware/auth.ts` 实现验证逻辑
2. 修改 `src/server/routes.ts` 在敏感路由前挂上中间件
3. 添加对 expired token 的 401 响应

## Critical Files
- `src/server/routes.ts` (现有路由定义，必须插入中间件)
- `src/server/types.ts` (需要扩展 RequestWithAuth 类型)
- `tests/server/auth.test.ts` (不存在，需要新建)

## Verification
- 跑 `ts-node tests/server/auth.test.ts` 验证验证逻辑
- 跑现有测试套件确保无回归
- 测试 expired/invalid/malformed 三种 token 的 401 响应

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

## 11. 意图门 (IntentGate)

### 11.1 三层混合判定

```markdown
### Hard Rules (优先判断)
触发词（关键词）:
- force complex: "先别动手"、"规划一下"、"plan mode"、"我们讨论一下"、"对比方案"
- force trivial: "直接改"、"小修改"、"typo"、"改个错别字"

文件数规则:
- 1 个文件 + < 20 行改动 → trivial
- 2-3 个文件 OR 跨目录 → standard
- 4+ 文件 OR 跨模块 → complex

### LLM 兜底 (灰色地带)
上面 hard rules 都不匹配时，orchestrator 自主判断:
  - 任务涉及架构决策？→ 倾向 complex
  - 任务有明显固定 pattern？→ 倾向 trivial
  - 任务需要理解多个上下文？→ 倾向 standard
  - 显式输出 reasoning: "判断为 standard: 涉及 2 个文件，无架构影响"
```

### 11.2 输出 reasoning

orchestrator 判断意图后，先在输出里声明判断：

```
[判断: standard 复杂度 — 涉及 2 个文件 + 1 个跨目录修改，无架构影响]

好的，我先派 plan agent 探索一下现状...
```

用户看到 reasoning 后，如果有异议可以说"这其实是 complex，好好规划一下"——orchestrator 会重新判断。

### 11.3 工作流分支

| 判定结果 | 行为 |
|---|---|
| trivial | orchestrator 直接委派 general，不需要 plan 文件 |
| standard | orchestrator 调 plan agent（session 续期模式），生成 plan 文件，然后委派实现 |
| complex | （P1 阶段: handoff 给 plan-primary agent；现阶段: 走 standard 流程） |

---

## 12. 多 Project Plan 管理

### 12.1 目录结构

```
~/.zoo/plans/
├── ZooKeeper/                          # 按 project-id 分子目录
│   ├── auth-middleware-20260115.md
│   ├── refactor-logging-20260120.md
│   └── add-wiki-query-20260123.md
├── oh-my-openagent/
│   └── fix-sisyphus-prompt-20260118.md
└── _projects.json                      # 主索引文件
```

### 12.2 project-id 推导

```typescript
function deriveProjectId(): string {
  // 1. 尝试 git remote
  const remote = tryGetGitRemote()  // e.g. "git@github.com:foo/ZooKeeper.git"
  let id = remote?.match(/\/([^/]+?)(?:\.git)?$/)?.[1]
       ?? path.basename(cwd)
  id = sanitizeSlug(id)  // kebab-case, 去特殊字符

  // 2. 检查 ~/.zoo/plans/<id>/ 是否关联当前 cwd
  if (isCollision(id)) {
    id = `${id}-${hash8(cwd)}`  // 8 位 cwd 哈希，稳定且短
  }
  return id
}
```

优先级: **git remote repo name → basename fallback → 冲突时加 8 位 cwd 哈希**

### 12.3 `_projects.json` 索引

```json
{
  "ZooKeeper": {
    "project_root": "/home/cambricon/Agent/ZooKeeper",
    "first_seen": "2026-01-15",
    "plan_count": 3,
    "last_active": "2026-01-23"
  },
  "oh-my-openagent": {
    "project_root": "/home/cambricon/Agent/oh-my-openagent",
    "first_seen": "2026-01-15",
    "plan_count": 1,
    "last_active": "2026-01-18"
  }
}
```

**用途**:
- 用户删除/重命名项目目录时，plan 文件不会变孤立
- 未来 `zfind` 风格 CLI 工具可直接查"有哪些 plan 是某个项目的"
- 冲突检测基于此映射

### 12.4 CWD 自动过滤

orchestrator 启动时:
1. 计算 project-id（git remote / basename）
2. 扫描 `~/.zoo/plans/<project-id>/`
3. 解析每个 plan 的 frontmatter
4. 过滤 `status != done` 的 plan
5. 注入到 system prompt 动态段

**用户感知**:
```
用户: "继续上次那个 auth 的工作"
  orchestrator 自动找到 project-root 匹配的 plan，resume
```

### 12.5 多 plan 并存

✅ 支持。`active_sessions` frontmatter 字段 + in-memory active_plan_id 指针。

用户可显式切换: "我现在要做的是重构日志的那个 plan，不是 auth middleware 的" —— orchestrator 自然语言理解即可切换 active plan。

已完成（`status: done`）的 plan 自动归档：移到 `~/.zoo/plans/<project-id>/_archived/` 子目录（用户无感）。

### 12.6 中断恢复

**新 session 启动时**，system prompt 动态段**自动注入**所有 active plan 的概况:

```
[ZooKeeper Active Plans]
  auth-middleware-20260115 [executing] — 5 tasks (3 done, 2 pending)
    Last session: ses_abc123 (reusable)
  refactor-logging-20260120 [planning] — 刚讨论完方案，未开始执行
```

用户自然知道当前有哪些 active plan，可以继续或切换。

---

## 13. 权限与工具控制

### 13.1 Plan agent 工具权限

**静态 deny list**（在 `config.toml` 中声明，install 时编译到 OpenCode 配置）:

```toml
[agent.plan.permission]
edit = "deny"
write = "deny"
task = "deny"
# 允许: read, grep, glob, bash (bash 由 prompt 约束只跑诊断命令)
```

**为什么静态 deny list**:
- ZooKeeper 的 `config.toml` 已有每个 agent 的 permission deny 列表
- 这是最合适的 place，install 时一次性编译，运行时零开销
- plan 文件写入由 orchestrator 代理 —— 单一责任

### 13.2 Bash 的 prompt 约束

Plan agent 的 prompt 包含:

```
Bash Usage Rules:
- 仅允许跑诊断命令（test/lint/type-check/grep/find/git log/git diff）
- 禁止任何 mutating 命令（git commit/push、install、build 等）
- 如果用户要求跑 mutating 命令，回复:
  "Bash 在 plan mode 只允许诊断命令。如需执行，请在 plan 文件 TODOs 中列为执行任务。"
```

### 13.3 Plan 文件写入的责任分离

| 角色 | 职责 |
|---|---|
| Plan agent | 输出 markdown 文本（不碰文件系统）|
| Orchestrator | 把 plan markdown 写入 `~/.zoo/plans/<slug>.md`，更新 `_projects.json` |

**为什么这样**:
- plan agent 完全只读，权限最简单
- orchestrator 负责所有状态管理（frontmatter、status、active sessions）
- plan 文件写入失败可在 orchestrator 层重试

---

## 14. 实施路径

### 14.1 七步分解

```
Step 1. core/prompts/plan.md                     — plan agent prompt
Step 2. config.toml + install.py                 — plan agent 注册 + deny 权限
Step 3. src/core/plan-state.ts                   — plan 文件解析/写入/状态机
Step 4. src/core/session-tracker.ts              — unreconciled + reusable session
Step 5. src/core/project-id.ts + _projects.json  — 项目 ID 推导 + 索引管理
Step 6. core/prompts/orchestrator.md             — 加意图门章节 + plan 相关纪律
Step 7. src/hooks/plan-lifecycle/index.ts        — 注入动态段 + task 输出追加续期提示
```

### 14.2 每步的具体产出

**Step 1: plan agent prompt** (~150 行)
- 角色定义 + 工具列表（read/grep/glob/bash）
- 5 阶段工作流（Understand/Explore/Clarify/Design/Produce）
- 结构化输出规范（Context/Approach/Critical Files/Verification/Risks/TODOs/Metadata）
- Bash 诊断约束
- 不能 spawn subagent，不能 task()

**Step 2: config.toml + install.py** (~50 行)
- `[agent.plan]` 块：mode=subagent，deny edit/write/task
- install.py 编译逻辑（沿用现有模式）

**Step 3: plan-state.ts** (~200 行)
- 纯逻辑模块（零 OpenCode 依赖，可被 TS 运行时 import）
- 函数: readPlan(slug), writePlan(slug, content, metadata), updateStatus(slug, newStatus)
- TOML frontmatter 解析（用 gray-matter 或类似库）
- 状态机校验: planning → planning-done → executing → done

**Step 4: session-tracker.ts** (~150 行)
- 单例内存 tracker
- 接口: register(sessionId, agent, slug), updateStatus, getReusables(agentType), getAllActive
- 未来升级为 BackgroundManager 时扩展为: run/resume/cancel/collect

**Step 5: project-id.ts + _projects.json** (~150 行)
- deriveProjectId() 函数: git remote → basename → 冲突 hash
- loadProjectsIndex() / saveProjectsIndex()
- isProjectMapped(projectRoot) + registerProject(projectRoot)

**Step 6: orchestrator.md 意图门章节** (~80 行)
- Plan Mode Workflow 章节
- Hard rules（关键词 + 文件数）
- LLM 兜底判定 + reasoning 输出要求
- Session 续期纪律（参考 omo Sisyphus 的"Session Continuity"章节）
- Plan 调用的 prompt 模板

**Step 7: plan-lifecycle hook** (~300 行)
- `config` hook: 在新 session 启动时注入系统级 active-plans 概况
- `tool.execute.after` hook: task() 后追加 `to continue: task(task_id="ses_...")`
- `session.idle` hook: 检测 planning-done 状态触发自动转 executing
- System prompt 动态段注入（参考 slim 的 `experimental.chat.messages.transform`）

### 14.3 顺序约束

```
Step 1 + 2 (并行) → Step 3 → Step 4 → Step 5 → Step 6 → Step 7

理由:
- Step 1/2 是基础设施，可先做
- Step 3 依赖 step 1 的输出格式约定
- Step 4 依赖 step 3 的 slug 结构
- Step 5 依赖 step 3 的 plan 路径
- Step 6 依赖 step 3-5 的接口
- Step 7 依赖前面全部
```

### 14.4 验证策略

每个 Step 完成后:
- `./check.sh` 过 lint
- `./test.sh` 过现有测试
- dry-run 跑一个真实场景（用 `runner.py --dry-run`）

Step 7 完成后集成测试:
- trivial 任务（typo 修复）→ 不应触发 plan
- standard 任务（加个功能）→ 应触发 plan + resume
- 中断恢复（关闭 OpenCode，开新 session）→ 应自动注入 active plan

---

## 15. 未来演进

### 15.1 P1: Complex Plan + Handoff

在 P0 稳定后:

```
P1 新增:
├── plan-primary agent (mode=primary，可切换)
├── executor agent (Atlas-style, mode=primary)
├── /start-work 命令触发 handoff
├── session prompt 动态切换机制
└── complex 场景的意图门 → handoff
```

**关键前置准备**（P0 已做的）:
- Plan 文件位置 `~/.zoo/plans/`（handoff 时 plan agent 和 executor 都能读）
- Plan 状态机（`planning-done` 状态是 handoff 触发点）
- active_sessions frontmatter 字段（handoff 时把 session ID 加入）

### 15.2 P2: BackgroundManager 升级

P0 的 `PlanSessionTracker` 接口预留了升级为 BackgroundManager:

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
| 1 | Plan 作为什么实现 | **agent**（subagent，task() 派生） | skill 会污染 orchestrator context；agent 提供干净分离 |
| 2 | Plan 文件位置 | `~/.zoo/plans/<project-id>/<slug>-<YYYYMMDD>.md` | 用户级集中管理，按项目子目录分组 |
| 3 | project-id 推导 | git remote → basename → +hash8 冲突 | git remote 是真正的项目标识符 |
| 4 | 索引文件 | `~/.zoo/plans/_projects.json` | 用户删除/重命名项目时 plan 不变孤立 |
| 5 | Plan 格式 | TOML frontmatter + markdown body + checkboxes | 状态在 frontmatter，人类可读 body |
| 6 | Git 管理 | 天然 gitignore（用户级） | 与 omo/slim/omp 一致 |
| 7 | 输出协议 | 结构化 markdown sections | 4 个项目都用 markdown 不用 JSON |
| 8 | Session resume | 透明显示 + 自动执行 | 用户可见但无需操作，omo 已验证可行 |
| 9 | Unreconciled | 显式检测 + session.idle 自动解除 | slim 的精巧设计，plan→实现解耦的关键 |
| 10 | 多 plan | ✅ 支持 + active_plan_id 指针 + 自动归档 | omo/ECC 验证可行 |
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
| 22 | Plan 文件写入者 | orchestrator 代理写 | plan agent 完全只读，单一责任 |
| 23 | Plan 执行期间可用 subagent | general + explore + spider | 灵活，TODOs 里可注明推荐 |
| 24 | 未来扩展性 | PlanSessionTracker 接口为 BackgroundManager 预留方法 | 升级不改现有调用方 |

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

**文档结束**

> 本文档在 plan mode 实现期间应当作为设计参考。每完成一个 Step，应回顾文档确认设计与实现一致；如果实现中发现需要修改设计，应回到本文档更新对应章节后再继续。
