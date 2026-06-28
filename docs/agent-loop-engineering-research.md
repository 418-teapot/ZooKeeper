> Path note (2026-06-28): prompt files have since moved to src/agents/<name>.ts; paths below reflect the pre-refactor layout.

# Agent 自主循环机制调研：Ralph Loop vs Auto Research

**版本:** 1.0  
**日期:** 2026-06-22  
**分类:** 技术调研报告  
**调研对象:** OMO (oh-my-openagent) Ralph Loop、OMP (oh-my-pi/oh-my-opencode) Auto Research

---

## 目录

1. [概述](#1-概述)
2. [业界背景：Loop Engineering](#2-业界背景loop-engineering)
3. [Ralph Loop 机制详解 (OMO)](#3-ralph-loop-机制详解-omo)
4. [Auto Research 机制详解 (OMP)](#4-auto-research-机制详解-omp)
5. [横向对比](#5-横向对比)
6. [ZooKeeper 当前状态与差距分析](#6-zookeeper-当前状态与差距分析)
7. [可借鉴的设计模式](#7-可借鉴的设计模式)
8. [演进路径](#8-演进路径)

---

## 1. 概述

### 1.1 核心发现

Ralph Loop (OMO) 和 Auto Research (OMP) 本质上是同一个架构模式的不同实现：

```
loop controller (AI)  →  stateless executor (AI)  →  循环基础设施  →  下一个 turn
```

两者的区别仅在于 controller 的身份（插件代码 vs agent 自身）和用户可见性。

### 1.2 项目定位

| 项目 | 运行在 | 与 OpenCode 关系 | 循环模块 |
|------|--------|-----------------|---------|
| **OMO** (oh-my-openagent) | OpenCode 插件 | 插件，深度集成 | `src/hooks/ralph-loop/` (~1687 LOC, 23 个文件) |
| **OMP** (oh-my-pi) | Pi 自身代码（fork/演进） | 独立产品 | `packages/coding-agent/src/autoresearch/` (~4131 LOC, 5 个 prompt 文件) |
| **ZooKeeper** | OpenCode 插件 | 插件，中等集成 | 无自主循环，仅 prompt 指令 |

### 1.3 ZooKeeper 的 debug 循环困境

ZooKeeper 的 build agent 在调试 bug 时，当前依赖 prompt 指令中的"if failed, repeat"维持循环。实践中 build 在一轮委派-验证后倾向于停下来总结，用户需要反复提醒继续。这是结构性问题——缺少 hook 层面的自动续写机制，光改 prompt 绕不过去。

---

## 2. 业界背景：Loop Engineering

### 2.1 定义

Loop Engineering 是设计、构建和优化 AI Agent 中"感知→推理→行动→观察"迭代循环的工程实践。核心思想：不再让 LLM 一次生成最终输出（zero-shot），而是通过多轮迭代逐步提升输出质量。

Andrew Ng (2024.3) 的关键数据：GPT-3.5 zero-shot 在 HumanEval 上正确率 48.1%，包裹在 agent loop 中的 GPT-3.5 达到 **95.1%**，远超 GPT-4 zero-shot 的 67.0%。

### 2.2 四种核心模式（Andrew Ng 框架）

| 模式 | 核心机制 | 成熟度 | 代表作 |
|------|---------|--------|--------|
| **Reflection** | LLM 检查自己的输出→改进→重写→再检查 | 高 | Reflexion (91% pass@1)、Self-Refine |
| **Tool-Use** | LLM 生成工具调用→执行→观察结果→决定下一步 | 高 | Gorilla、OpenAI function calling |
| **Planning** | LLM 自主分解任务→多步计划→逐步执行→动态调整 | 中 | ReAct、HuggingGPT |
| **Multi-Agent** | 多个 agent 不同角色→分工协作→讨论审查→综合 | 中 | AutoGen、CrewAI、ChatDev |

### 2.3 三个项目对应的模式

| 项目 | 主模式 | 辅模式 |
|------|--------|--------|
| Ralph Loop | Reflection | ReAct（推理与行动交叉） |
| Auto Research | Planning + Tool-Use | Evaluator-Optimizer |
| ZooKeeper Build Debug | Multi-Agent | Planning（Build 分析决策，General/Explore 执行） |

### 2.4 Anthropic 的工程原则

> "Start simple, add complexity only when it demonstrably improves outcomes."

关键建议：从简单的 Reflection/Tool-Use 开始（可靠），逐步引入 Planning/Multi-Agent（强大但不可预测），每次增加复杂度前必须用评估数据证明其价值。ACI (Agent-Computer Interface) 设计——工具的设计甚至比 agent 本身的 prompt 更重要。

---

## 3. Ralph Loop 机制详解 (OMO)

### 3.1 文件结构

所有核心代码位于 `oh-my-openagent/src/hooks/ralph-loop/`，共 23 个文件，~1687 LOC。

| 文件 | 职责 |
|------|------|
| `ralph-loop-hook.ts` | 入口；暴露 `startLoop` / `resumeLoop` / `cancelLoop` / `getState` |
| `loop-state-controller.ts` | 状态 CRUD：`startLoop`、`cancelLoop`、`incrementIteration`、持久化 |
| `event-handler-impl.ts` | 事件路由主干（`session.idle`、`session.deleted`、`session.error`） |
| `event-handler-idle.ts` | **核心循环驱动**：`handleIdleEvent()` → 完成检测 → 无进展 → 最大迭代 → 续写 |
| `event-handler-continuation.ts` | `continueSettledIteration()` — 稳定后、构建 continuation prompt、调度 |
| `event-handler-completion.ts` | `<promise>DONE</promise>` 检测 |
| `completion-promise-detector.ts` | 扫描 session 抄本 + session 消息 API |
| `completion-handler.ts` | 完成时逻辑；ultrawork 模式过渡到验证阶段 |
| `continuation-prompt-builder.ts` | 为下一轮构建 continuation prompt |
| `continuation-prompt-injector.ts` | 通过 `dispatchInternalPrompt()`（OpenCode `promptAsync`）注入 |
| `iteration-continuation.ts` | continue vs reset 策略；创建子 session 或重入同一 session |
| `storage.ts` | 读写 `.omo/ralph-loop.local.md`（YAML frontmatter 状态文件） |
| `types.ts` | `RalphLoopState`、`IterationCommitExpectation`、`RalphLoopOptions` |
| `constants.ts` | `DEFAULT_MAX_ITERATIONS=100`、`ULTRAWORK_MAX_ITERATIONS=500` |
| `no-progress-turn-detector.ts` | 检测 token 为零且 finish="unknown" 的 assistant turn |
| `oracle-verification-detector.ts` | 检测来自 "oracle" agent 的 `<promise>VERIFIED</promise>` |
| `with-timeout.ts` | 通用 API 超时包装（默认 5000ms） |

命令集成：
- `src/features/builtin-commands/templates/ralph-loop.ts` — 斜杠命令模板
- `src/plugin/chat-message/loop-commands.ts` — 运行时桥接

### 3.2 循环驱动机制

核心：**`session.idle` 事件驱动**。

```
用户输入 "/ralph-loop "Build API""
    │
    ▼
loop-commands.ts → startLoop(sessionID, prompt, options)
    │
    ▼
loop-state-controller.ts → writeState() → .omo/ralph-loop.local.md
    │
    ▼
releasePromptAsyncReservation() → 确保 promptAsync 可触发
    │
    ▼
═══ 循环开始 ═══
    │
    │  Agent 工作 (编辑代码、运行测试等)
    │
    ▼
session.idle 事件触发
    │
    ▼
event-handler-idle.ts → handleIdleEvent()
    │
    ├─ 1. 检查 state.active（不活跃 → 返回）
    ├─ 2. 检查活跃后台任务（有 → 跳过）
    ├─ 3. 检查 session 是否匹配循环状态
    ├─ 4. 去重合成空闲事件
    ├─ 5. 完成检测（completion-promise-detector）
    │     → <promise>DONE</promise> → completion-handler 处理
    ├─ 6. 无进展检测（no-progress-turn-detector）
    │     → token=0 + finish="unknown" → clearState() + toast
    ├─ 7. 最大迭代检测
    │     → iteration >= max_iterations → clearState() + toast
    │
    └─ 8. 继续循环 → continueSettledIteration()
          │
          ▼
    event-handler-continuation.ts → continueSettledIteration()
          │
          ├─ sleep(150ms) → 去抖动
          ├─ 重新读取状态（可能在窗口期内改变）
          ├─ 重新检查完成 + 无进展
          │
          ▼
    iteration-continuation.ts → continueIteration()
          │
          ├─ "continue" 策略（默认）:
          │     → injectContinuationPrompt() 到同一 session
          │
          └─ "reset" 策略:
                → createIterationSession() → 新建子 session
                → injectContinuationPrompt() 到新 session
                → selectSessionInTui() → 切换 UI
                → loopState.setSessionID() → 更新状态
          │
          ▼
    incrementIteration() → 更新状态文件 + 计数器
    showIterationToast() → "Iteration 3/100"
    │
    ▼
═══ 等待下一次 session.idle（重复循环）═══
```

### 3.3 停止条件

| # | 条件 | 检测位置 | 机制 |
|---|------|---------|------|
| 1 | Agent 输出 `<promise>DONE</promise>` | `completion-promise-detector.ts` | 扫描抄本文件 + session 消息 API |
| 2 | 最大轮次 | `event-handler-idle.ts` | `iteration >= max_iterations`（默认 100） |
| 3 | 无进展 | `no-progress-turn-detector.ts` | token 全部为零 + `finish="unknown"` + 无内容 |
| 4 | 用户取消 | `/cancel-ralph` 命令 | `cancelLoop()` → `clearState()` |
| 5 | 用户中止 | `session-event-handler.ts` | `MessageAbortedError` → `clear()` |
| 6 | 调度失败 | `event-handler-continuation.ts` | `injectContinuationPrompt()` 返回 `"rejected"` |
| 7 | Session 删除 | `session-event-handler.ts` | `session.deleted` → `clearState()` |

### 3.4 上下文传递

每次轮次注入的 continuation prompt 格式：

```
[RALPH LOOP {iteration}/{max}]
Continue. Output <promise>{promise}</promise> when done.
{original prompt}
```

**关键发现：没有压缩/摘要机制。** 原始 prompt 逐字存储在状态文件中，每轮全文重放。"continue" 策略下，对话历史在 session 中自然累积。

### 3.5 状态管理

**存储位置：** `.omo/ralph-loop.local.md`（项目 `.omo/` 目录，已 gitignore）

**格式：** 带 YAML frontmatter 的 markdown

```markdown
---
active: true
iteration: 3
max_iterations: 100
completion_promise: "DONE"
initial_completion_promise: "DONE"
started_at: "2026-06-22T10:00:00.000Z"
session_id: "ses_abc123"
ultrawork: false
strategy: "continue"
message_count_at_start: 5
---
Build a REST API with authentication
```

**状态字段（`RalphLoopState`）：**

| 字段 | 类型 | 用途 |
|------|------|------|
| `active` | boolean | 循环是否活跃 |
| `iteration` | number | 当前轮次（1-based） |
| `max_iterations` | number | 最大轮次（默认 100，ultrawork 500） |
| `completion_promise` | string | 当前要检测的 promise（可能是 DONE 或 VERIFIED） |
| `prompt` | string | 原始任务 prompt |
| `session_id` | string | 当前绑定的 session |
| `started_at` | string (ISO) | 当前轮次开始时间 |
| `ultrawork` | boolean | 是否为 ultrawork 模式 |
| `verification_pending` | boolean | 是否在等待 Oracle 验证 |
| `strategy` | "reset" \| "continue" | 轮次策略 |

**故障恢复：**
- `loop-session-recovery.ts` 跟踪恢复中的 session（窗口 5000ms）
- `session-event-handler.ts` 在 `session.deleted` 或 `MessageAbortedError` 时清理
- 状态文件提供崩溃恢复：`active=true` 且 session 存在 → 可用 `/ralph-loop "continue"` 恢复

### 3.6 Controller-Executor 交互

Controller 和 Executor 之间是**纯事件驱动**的，没有直接调用：

```
Controller (状态 + 决策)                    Executor (AI Session)
     │                                            │
     │  startLoop(sessionID, prompt)               │
     │  → 写状态文件                                │
     │  → 释放 promptAsync 锁                      │
     │                                            │
     │         session.idle ───────────────────────│
     │                                            │
     │  handleIdleEvent()                          │
     │  → 检测完成 / 无进展 / 最大轮次               │
     │                                            │
     │  continueSettledIteration()                  │
     │    → buildContinuationPrompt()               │
     │    → injectContinuationPrompt()              │
     │      → dispatchInternalPrompt() ─────────────│
     │                                            │
     │         session.idle (again) ───────────────│
     │                                            │
     │  (重复循环)                                   │
```

**汇报是隐式的：** Controller 通过扫描 session 消息和抄本检测 agent 的输出（`<promise>DONE</promise>` 或零 token 的 assistant turn）。

### 3.7 UltraWork 模式（自动验证）

双重阶段循环：

**阶段 1：开发循环**
```
轮次 1..N → agent 工作 → 直到 <promise>DONE</promise>
```

**阶段 2：验证**
```
completion-handler → markVerificationPending()
  → 注入 ULTRAWORK_VERIFICATION_PROMPT
  → agent 调用 Oracle subagent (task(subagent_type="oracle", ...))
  → Oracle 返回 <promise>VERIFIED</promise> 或失败
```

- **Oracle 通过** → `clear()` → 循环结束（toast："JUST ULW ULW!"）
- **Oracle 未通过** → 注入 `ULTRAWORK_VERIFICATION_FAILED_PROMPT` → `incrementIteration()` → 回到阶段 1
- **30 分钟超时** → 处理卡住的 Oracle 调度

### 3.8 用户可见性

| 事件 | Toast 标题 | 消息 |
|------|-----------|------|
| 轮次开始 | `Ralph Loop` | `Iteration 3/100` |
| 完成 | `Ralph Loop Complete!` | `Task completed after 3 iteration(s)` |
| 最大轮次 | `Ralph Loop Stopped` | `Max iterations (100) reached` |
| 无进展 | `Ralph Loop Stopped` | `Last assistant turn made no model progress` |
| 调度失败 | `Ralph Loop Failed` | `Dispatch rejected: ...` |
| UltraWork 完成 | `ULTRAWORK LOOP COMPLETE!` | `JUST ULW ULW!` |
| UltraWork 验证 | `ULTRAWORK LOOP` | `Oracle verification is now required.` |

### 3.9 Prompt 指令

Agent 行为的规则来自两个地方：

**命令模板**（`src/features/builtin-commands/templates/ralph-loop.ts`）：
- 持续处理任务
- 完全完成时输出 `<promise>DONE</promise>`
- 不输出 promise 则循环自动注入续写 prompt
- 每次轮次应取得有意义的进展
- 卡住时尝试不同方法

**运行时 continuation prompt**（`continuation-prompt-builder.ts`）：
```
[RALPH LOOP {iteration}/{max}] Continue. Output <promise>{promise}</promise> when done.
```

---

## 4. Auto Research 机制详解 (OMP)

### 4.1 文件结构

核心代码在 `oh-my-pi/packages/coding-agent/src/autoresearch/`，~4131 LOC + 4 个 prompt markdown 文件。

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 536 | 主入口 — 注册扩展、事件监听、命令、prompt 注入 |
| `state.ts` | 273 | 状态管理 — 创建/克隆/重建实验状态、置信度计算 |
| `types.ts` | 168 | 类型定义 |
| `storage.ts` | 699 | 持久化 — Bun:SQLite，存储 session/run |
| `dashboard.ts` | 436 | 用户可见性 — TUI Widget + Overlay |
| `git.ts` | 319 | Git 分支管理 — 自动 `autoresearch/*` 分支、dirty path 检测 |
| `helpers.ts` | 218 | 工具函数 — METRIC/ASI 解析 |
| `tools/init-experiment.ts` | 272 | 初始化实验 |
| `tools/run-experiment.ts` | 407 | 运行 benchmark |
| `tools/log-experiment.ts` | 524 | 记录实验结果（含 git keep/discard） |
| `tools/update-notes.ts` | 109 | 更新 session 笔记 |
| `prompt.md` | 103 | Phase 2 迭代循环行为规则 |
| `prompt-setup.md` | 43 | Phase 1 Harness 设置规则 |
| `resume-message.md` | 10 | 自动恢复消息模板 |
| `command-resume.md` | 14 | 命令恢复消息模板 |

### 4.2 循环驱动机制

核心设计：**不是由 controller 主动驱动，而是由事件钩子 + AI agent 自主行为共同实现的"虚拟循环"。**

```
用户输入 "/autoresearch optimize sort"
    │
    ▼
/autoresearch 命令处理:
    1. 创建 autoresearch/<goal>-<date> 分支
    2. 设置 mode=on
    3. 注册 4 个实验工具
    4. 发送用户消息触发 AI 开始工作
    │
    ▼
═══ Phase 1: Harness 设置 ═══
    │
    │  before_agent_start hook → 注入 prompt-setup.md
    │  Agent: 读源码 → 写 autoresearch.sh → 验证 → init_experiment
    │
    ▼
═══ Phase 2: 迭代循环 ═══
    │
    │  before_agent_start hook → 注入 prompt.md (含完整状态上下文)
    │  Agent: 改代码 → run_experiment → log_experiment (keep/discard/crash)
    │
    ▼
agent_end hook:
    │
    ├─ autoresearchMode === true?
    ├─ 无 pending 用户消息?
    ├─ 存在 pending run 或 autoResumeArmed?
    ├─ 没有重复恢复 (lastAutoResumePendingRunNumber anti-dup)?
    │
    └─ 全部满足 → 发送 autoresearch-resume 消息:
          customType: "autoresearch-resume"
          deliverAs: "nextTurn"
          triggerTurn: true        ← 触发新一轮 AI 推理
          display: false           ← 不暴露给用户
    │
    ▼
下一轮 before_agent_start: 注入 prompt.md (含更新的状态)
    │
    ▼
Agent 继续迭代...
```

### 4.3 停止条件

| # | 条件 | 检测位置 |
|---|------|---------|
| 1 | 用户中断 | `hasPendingMessages() === true` → autoResumeArmed 置 false |
| 2 | 达到 max_iterations | `log_experiment` 中检查并自动关闭 mode |
| 3 | 用户手动 `/autoresearch off` | 命令处理器 |
| 4 | 用户切换到非 autoresearch 分支 | `before_agent_start` 检测分支不匹配 |
| 5 | 无 pending run 且无 autoResumeArmed | `agent_end` 直接 return |

### 4.4 上下文传递

**核心机制：SQLite 持久化 + `before_agent_start` 的 system prompt 注入。**

每次 AI 推理前，`before_agent_start` 注入的内容：

```
{base_system_prompt}

## Autoresearch Mode
Primary goal: {goal}
Current segment: {N} runs  {kept} kept  {discarded}  {crashed}
Baseline: {metric}
Best: {best_metric} ({delta}%)  conf {confidence}

### Recent runs:
- run #N: keep 42.0ms — inline cache
  ASI: hypothesis=cache hit rate improved
- run #N+1: discard 44.0ms — too conservative
  ASI: rollback_reason=perf regression

{notes}
```

**数据压缩策略：**
- `recent_results` 只返回最近 3 次运行（不是全部历史）
- `unjustified_runs` 最多 3 个
- 运行输出截断：4KB / 10 行
- ASI 摘要限制 220 字符
- **无主动 token 压缩或摘要**——通过 SQLite 持久化，prompt 只注入最相关的快照

### 4.5 状态管理

**两种存储：**

**① 运行时状态（RuntimeStore）— `state.ts`**

```typescript
interface ExperimentState {
  results: ExperimentResult[];     // 所有 logged run
  bestMetric: number | null;       // 基线指标
  bestDirection: MetricDirection;  // "lower" | "higher"
  metricName: string; metricUnit: string;
  secondaryMetrics: MetricDef[];
  currentSegment: number;
  maxExperiments: number | null;
  confidence: number | null;       // MAD-based
  scopePaths: string[];            // 允许修改路径
  offLimits: string[];             // 禁止修改路径
  constraints: string[];
  notes: string;                   // 持久化笔记
  branch: string | null;
  baselineCommit: string | null;
  sessionId: number | null;
}
```

**② 持久化存储（SQLite）— `storage.ts`**

两个核心表：

- **`sessions`** — 每个实验会话（id, name, goal, primary_metric, direction, branch, baseline_commit, scope, off_limits, notes, current_segment, max_iterations, ...）
- **`runs`** — 每次运行（id, session_id, segment, command, exit_code, parsed_metrics, parsed_asi, status, description, commit_hash, scope_deviations, flagged, ...）

路径：`~/.omp/autoresearch/<project-key>.db`

### 4.6 MAD-Based 置信度算法

```
Confidence = |bestKept - baseline| / MAD

其中:
  MAD = median(|xi - median(x)|)  对当前 segment 中所有非 flagged、metric > 0 的 run
  bestKept = 当前 segment 中 kept 且非 flagged 的最佳指标值
  baseline = 当前 segment 中第一个 kept 且非 flagged 的指标值
```

**算法步骤：**
1. 过滤当前 segment 中 `metric > 0` 且非 flagged 的 run
2. 样本数 < 3 → 返回 `null`（数据不足）
3. 计算 `median`（有序中位数）
4. 计算 `MAD` = median of absolute deviations from median
5. `MAD === 0` → 返回 `null`（无噪声信息）
6. `bestKept === baseline` → 返回 `null`
7. 返回 `|bestKept - baseline| / MAD`

**置信度解读：** `conf >= 2.0` → likely real | `1.0 ~ 2.0` → marginal | `< 1.0` → within noise floor

MAD 相比标准差对异常值更鲁棒——单个极端值不会大幅膨胀噪声底限。

### 4.7 Segment 模型

用 segment 将迭代分组，每个 segment 有独立基线。当 benchmark 本身需要更改时（添加新测试用例、切换 workload），bump segment 可以捕获新基线并归档旧结果。历史数据保留但不影响当前分析。

### 4.8 METRIC / ASI 协议

基于标准输出的文本协议，无库依赖：

```bash
$ bash autoresearch.sh
Running benchmark...
METRIC latency_ms=42.5
METRIC throughput=1500
ASI hypothesis=prefetch improves throughput
ASI next_action_hint=try doubling buffer size
```

- `METRIC name=value` — agent 的 benchmark 输出指标
- `ASI key=value` — 自由格式结构化元数据（支持嵌套 JSON），无预定义 schema

### 4.9 Git 分支策略

分支命名：`autoresearch/{slugified-goal}-{yyyymmdd}`（冲突时加 `-2`, `-3` 后缀）

| 操作 | 在 autoresearch 分支 | 不在 |
|------|---------------------|------|
| **keep** | `git add` → `git commit` | 跳过 auto-commit + warning |
| **discard** | `git reset --hard HEAD` + `git clean` | `git restore` + `fs.rmSync`（选择性） |

**关键安全保证：** autoresearch 分支上的 `discard` 只回滚本次迭代的未 commit 更改——之前的 keep commit 不可变。

### 4.10 用户可见性

四种展示层级：

**① Collapsed Line（默认）：**
```
autoresearch 5 runs 2 kept +3 archived 1 crash | baseline 42ms | best 38ms (-9.5%) | ctrl+x expand
```

**② 运行中：**
```
autoresearch running... | reduce-edit-benchmark-runtime-variance | bash autoresearch.sh
```

**③ Expanded（`Ctrl+X`）：**
```
autoresearch: optimize-sort --------- ctrl+x collapse  ctrl+shift+x overlay
Current segment: 5 runs  3 kept  1 discarded  1 crash
Baseline: 42.00ms (#1)
Best: 38.00ms (#5) -9.5%  conf 3.2x
#    commit     metric      status    description
────────────────────────────────────────────────
1    a1b2c3d4e  42.00ms     keep      baseline
5    e5f6g7h8i  38.00ms     keep      inline cache
```

**④ Overlay（`Ctrl+Shift+X`，全屏可滚动，vim 导航 j/k/g/G）**

---

## 5. 横向对比

### 5.1 架构总览

| 维度 | Ralph Loop (OMO) | Auto Research (OMP) | ZooKeeper Build |
|------|-----------------|---------------------|----------------|
| **运行身份** | OpenCode 插件 | Pi 自身代码 | OpenCode 插件 |
| **Controller** | 插件代码（TypeScript） | AI agent 自身 | Build (AI) |
| **Executor** | Agent session | AI agent（通过 4 个工具） | General / Explore (subagent) |
| **循环驱动** | `session.idle` 事件 | `agent_end` → `triggerTurn` | 对话流中手动委派（prompt 指令） |
| **上下文管理** | 无压缩，每轮重放 prompt + 对话累积 | SQLite + 只注入最近 3 次结果 + notes | Build 自记在对话历史中 |
| **状态持久化** | YAML frontmatter markdown | SQLite（sessions + runs 表） | 无（对话历史） |
| **停止条件** | `<promise>DONE</promise>` + 最大轮次 + 无进展 | 用户中断 + max_iterations | Build 判断"修好了" |
| **用户可见性** | Toast 通知 | TUI Widget + Ctrl+X 面板 | 对话流中可见 |
| **验证机制** | Ultrawork: Oracle agent 验证 | log_experiment: keep/discard/crash | VERIFY_REMINDER (post-task-nudge hook) |
| **代码量** | ~1687 LOC | ~4131 LOC | n/a（无专门模块） |

### 5.2 循环驱动机制对比

```
Ralph Loop (OMO):
  session.idle (事件)
    → handleIdleEvent() (插件代码检测完成状态)
    → injectContinuationPrompt() (注入续写)
    → agent 继续 (无需人工介入)

Auto Research (OMP):
  agent_end (事件)
    → 检查条件 (pending run? autoResumeArmed?)
    → sendMessage({ triggerTurn: true }) (触发新一轮)
    → before_agent_start (注入更新后的 prompt)
    → AI 继续 (无需人工介入)

ZooKeeper Build (当前):
  task() 返回 (tool result)
    → VERIFY_REMINDER (hook 注入验证提示)
    → Build 验证 → 分析 → 决定是否继续
    → [无自动续写] → 循环在此停止，等待用户提示
```

### 5.3 上下文传递对比

| 机制 | Ralph Loop | Auto Research | ZooKeeper |
|------|-----------|---------------|-----------|
| **持久化** | `.omo/ralph-loop.local.md` | SQLite (`~/.omp/autoresearch/*.db`) | 无 |
| **注入时机** | `dispatchInternalPrompt()` | `before_agent_start` | 无（一次性 config hook） |
| **注入内容** | 原始 prompt + 轮次号 | 结构化状态（baseline、recent、notes、pending run） | 无 |
| **压缩策略** | 无（对话自然累积） | 最近 3 runs +ASI 摘要 220 字符 | 无 |
| **跨对话** | 状态文件可恢复 | SQLite 跨对话 | 不支持 |

### 5.4 关键设计决策对比

| 决策点 | Ralph Loop | Auto Research |
|--------|-----------|---------------|
| **循环策略** | "continue" or "reset"（重置 session 上下文） | 虚拟循环（同一 turn，sendMessage 触发新一轮） |
| **完成信号** | `<promise>DONE</promise>` 文本协议 | `log_experiment` 工具返回 + 置信度 |
| **验证** | Oracle agent（ultrawork 模式） | Agent 自己 keep/discard/crash |
| **防重复** | 无（session.idle 去重合并） | `lastAutoResumePendingRunNumber` |
| **最大轮次** | 100（ultrawork 500） | 通过 `init_experiment max_iterations` 设置 |
| **分支隔离** | 无 | `autoresearch/{slug}-{date}` |
| **Git 集成** | 无 | 自动 commit on keep，reset on discard |

### 5.5 平台能力对比

| OpenCode 插件能力 | OMO | ZooKeeper | 备注 |
|------------------|-----|-----------|------|
| `session.idle` 监听 | ✅ | ❌（未使用） | OMO 用此驱动 ralph loop |
| `session.deleted` 监听 | ✅ | ❌（未使用） | OMO 用此清理状态 |
| `dispatchInternalPrompt` | ✅ | ❓ 待验证 | OMO 用此注入 continuation prompt |
| Hook 注册 | ✅ 55 hooks | ✅ 多个 hooks | ZooKeeper 已有 hook 架构 |
| 自定义工具 | ✅ | ❌ | OMO 注册了 ralph-loop 命令 |
| Toast 通知 | ✅ | ❌ | OMO 展示循环进度 |

---

## 6. ZooKeeper 当前状态与差距分析

### 6.1 ZooKeeper 的 debug 循环现状

Build 在调 bug 时的循环：

```
Build 分析 → task(General, 指令) → General 执行 → 返回结果
    │
    ▼
VERIFY_REMINDER 注入 → Build 读取变更 → 分析结果
    │
    ├─ 修好了 → 总结给用户
    └─ 没修好 → [没有机制推回循环] → build 倾向于停下
```

**问题：** `post-task-nudge` 的 `VERIFY_REMINDER` 让 build 验证，但只验证不续写。prompt 里写的"if failed, repeat"是建议而非约束。

### 6.2 结构性差距

| 差距 | 影响 | 根因 |
|------|------|------|
| **无自动续写** | build 一轮后停下来等用户 | 没有 `session.idle` 或其他续写事件 |
| **无结构化上下文注入** | build 靠对话记忆，多轮后上下文模糊 | 没有每 turn 的 prompt 注入能力 |
| **无状态持久化** | 对话结束后调试历史丢失 | 无 SQLite / 无 session entry 写入 |
| **无无进展检测** | build 可能卡住或重复同样的失败操作 | 只有 prompt 级别的反模式提醒 |
| **无完成信号协议** | general 的返回格式不统一 | 无结构化返回约定 |

### 6.3 平台能力勘误

之前文档 `wiki/raw/2026-06-19-autoresearch-design.md` §19.3 说"ZooKeeper 插件无法监听事件"是**不准确的**。

| API | OMO 使用 | ZooKeeper 能否用 |
|-----|---------|-----------------|
| `session.idle` | ✅ 驱动 ralph loop | ✅ 可用（OpenCode 插件 API） |
| `session.deleted` | ✅ 清理状态 | ✅ 可用 |
| `dispatchInternalPrompt` | ✅ 注入 continuation prompt | ❓ 待验证具体 API 名称 |
| `promptAsync` | ✅ 调度下一轮 | ❓ 待验证 |

ZooKeeper 当前 hooks 体系已经使用了多个 hooks（`task-prompt`、`post-task-nudge`、`direct-work-nudge`、`context-metrics`），说明插件架构本身支持事件驱动。差距不是"能不能监听"，而是"还没用到这些事件"。

---

## 7. 可借鉴的设计模式

### 7.1 结构化调试上下文（来自 Auto Research）

**机制：** `before_agent_start` 每轮注入完整状态快照（baseline、recent results、notes、pending run）。

**借鉴方式：** Build 每次委派 General 时，维护一个"调试笔记"：

```
## 调试笔记
当前假设: ...
之前尝试:
- #1: 修改 X → 失败（原因 Y）
- #2: 修改 Z → 失败（原因 W）
本轮目标: ...
```

作为 CONTEXT 传给下一次委派的 General，替代在对话历史中散落的分析。

**实现难度：** 低。不需要改平台，Build 在对话中自己维护。

### 7.2 无进展检测（来自 Ralph Loop）

**机制：** `no-progress-turn-detector.ts` 检测 token=0 + `finish="unknown"` 的 assistant turn，出现则停止循环。

**借鉴方式：** 在 build.md 或 post-task-nudge 中加一个规则：

> If General has been delegated 2+ times with the same instruction and the result is identical, STOP. Switch to a different approach, delegate to explore for more investigation, or ask the user for clarification.

**实现难度：** 低。prompt 层面即可。

### 7.3 完成信号协议（来自 Ralph Loop）

**机制：** `<promise>DONE</promise>` 文本协议，controller 扫描抄本检测。

**借鉴方式：** General 在修复后输出结构化验证报告：

```
FIX_REPORT:
- hypothesis: ...
- change: ...
- verification: PASS/FAIL
- evidence: ...
```

Build 解析此格式，比自由文本输出更可靠。

**实现难度：** 中。需要修改 `general.md` 加输出约定。

### 7.4 Notes / Playbook 持久化（来自 Auto Research）

**机制：** `update_notes` 工具让 agent 跨迭代维护持久化笔记，每轮自动注入 prompt。

**借鉴方式：** Build 维护一个"调试 playbook"：

- 记录哪些方法有效、哪些无效
- 每次委派前更新 playbook
- 作为 CONTEXT 传给下一次委派

**实现难度：** 低。Build 在对话中自行管理。

---

## 8. 演进路径

### 8.1 阶段规划

| 阶段 | 内容 | 依赖 | 优先级 |
|------|------|------|--------|
| **Phase 0: Prompt 强化** | build.md 路由表 + checklist + anti-patterns（已完成） | 无 | ✅ done |
| **Phase 1: Hook 硬约束** | `post-task-nudge` 加续写提示：验证失败时自动追加"Analyze and delegate next step" | 改 hook 代码 | 高 |
| **Phase 2: 结构化报告** | `general.md` 加 FIX_REPORT 输出约定 + Build 解析 | 改 prompt | 中 |
| **Phase 3: 调试笔记** | `build.md` 加调试 playbook 指令 | 改 prompt | 中 |
| **Phase 4: session.idle 驱动** | 用 `session.idle` 事件实现自动续写，对齐 ralph loop 模式 | 验证 OpenCode 插件 API | 高（长期） |
| **Phase 5: 状态持久化** | SQLite 存储调试会话（类似 autoresearch 的 sessions/runs 表） | 新模块 | 低 |

### 8.2 Phase 1 详细设计：post-task-nudge 续写

**目标：** 在 `VERIFY_REMINDER` 之后，如果 General 的任务是 debug 类型且验证结果未知，追加续写提示。

```typescript
// post-task-nudge/hook.ts — 扩展 VERIFY_REMINDER

const DEBUG_CONTINUE_PROMPT =
  "**DEBUGGING LOOP: DO NOT STOP HERE.**\n" +
  "\n" +
  "If the fix did not resolve the issue:\n" +
  "- Analyze what went wrong (read General's output carefully)\n" +
  "- Update your debugging notes\n" +
  "- Delegate the next focused instruction to General\n" +
  "\n" +
  "Do NOT summarize or yield. You are in a debug cycle — " +
  "continue until the issue is resolved or you need to ask the user.";
```

**注入条件：**
- 任务目标是 diagnosis 类型
- 或 session 中有 in_progress todo 项
- 或 General 的任务描述包含 debug / fix / bug 关键词

### 8.3 Phase 4 详细设计：session.idle 驱动

参考 OMO 的 ralph loop，ZooKeeper 可以：

1. 在 `config.ts` 注册 `session.idle` hook
2. 维护一个轻量的状态文件（`.zoo/debug-loop.local.md`）
3. 检测到 build agent 的 session idle 且有活跃的 debug loop 时，通过 `dispatchInternalPrompt` 注入续写提示
4. 使用 `<promise>FIXED</promise>` 作为完成信号
5. 最大轮次 = 10（debug 场景比 autoresearch 短得多）

**关键前提：** 需要验证 ZooKeeper 的 OpenCode 插件是否能使用 `session.idle` 事件和 `promptAsync` / `dispatchInternalPrompt` API。

### 8.4 关键决策点

| 决策 | 选项 | 建议 |
|------|------|------|
| **先做什么** | prompt 改动 vs hook 改动 | 先做 Phase 1（hook），prompt 已足够 |
| **自动续写 vs 用户控制** | 完全自动 vs 用户确认 | debug 场景用半自动：续写提示注入，但允许用户介入 |
| **状态持久化** | 对话历史 vs 文件 vs SQLite | Phase 1-3 用对话历史，Phase 4+ 考虑文件 |
| **完成信号** | 自然语言 vs 结构化标签 | 结构化标签（`<promise>FIXED</promise>`），更可靠 |

---

## 附录 A: 关键代码片段

### Ralph Loop 核心驱动 (event-handler-idle.ts)

```typescript
// event-handler-idle.ts — 简化
async function handleIdleEvent(state: RalphLoopState) {
  if (!state.active) return;
  if (hasActiveBackgroundTasks()) return;
  if (!sessionMatchesLoop(state.sessionID)) return;

  // 去重快速连续的空闲事件（合成空闲）
  if (isDuplicateSyntheticIdle()) return;

  // 1. 完成检测
  const completed = await detectCompletionPromise(state.completionPromise);
  if (completed) {
    await handleCompletion(state);  // 清除状态或进入验证阶段
    return;
  }

  // 2. 无进展检测
  const noProgress = await detectNoProgressTurn();
  if (noProgress) {
    clearState();
    showToast("Ralph Loop Stopped", "Last assistant turn made no model progress");
    return;
  }

  // 3. 最大迭代
  if (state.iteration >= state.max_iterations) {
    clearState();
    showToast("Ralph Loop Stopped", `Max iterations (${state.max_iterations}) reached`);
    return;
  }

  // 4. 继续循环
  await continueSettledIteration(state);
}
```

### Auto Research 自动恢复 (index.ts agent_end)

```typescript
// index.ts:257-292 — agent_end hook
api.on("agent_end", async (_event, ctx) => {
  const runtime = getRuntime(ctx);

  if (!runtime.autoresearchMode) return;        // 条件 1
  if (ctx.hasPendingMessages()) {                // 条件 2
    runtime.autoResumeArmed = false;
    return;
  }

  const { session } = await loadActiveSession(ctx);
  const storage = session ? await openAutoresearchStorageIfExists(ctx.cwd) : null;
  const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
  const pendingRun = pendingRow ? pendingRunSummaryFromRow(pendingRow) : null;

  // 条件 3 + 4
  const shouldResumePendingRun =
    pendingRun !== null && runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber;
  if (!shouldResumePendingRun && !runtime.autoResumeArmed) return;

  // 触发续写
  runtime.autoResumeArmed = false;
  api.sendMessage({
    customType: "autoresearch-resume",
    content: render(resumeMessageTemplate, { has_pending_run: Boolean(pendingRun) }),
    display: false,
    attribution: "agent",
  }, { deliverAs: "nextTurn", triggerTurn: true });
});
```

### MAD 置信度计算 (state.ts)

```typescript
// state.ts:144-170 — computeConfidence
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const current = currentResults(results, segment)
    .filter(r => !r.flagged && r.metric > 0);

  if (current.length < 3) return null;  // 数据不足

  const values = current.map(r => r.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map(v => Math.abs(v - median)));
  if (mad === 0) return null;  // 无噪声信息

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of current) {
    if (r.status !== "keep" || r.metric <= 0) continue;
    if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
      bestKept = r.metric;
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  return Math.abs(bestKept - baseline) / mad;
}
```

---

## 附录 B: ZooKeeper build.md 中与循环相关的当前指令

修改后的 `core/prompts/build.md` Diagnosis 路由行：

```
| Diagnosis | "Why does X fail?", "Debug Y" | Delegate explore → synthesize findings
  → delegate general (build/run/report per step) → you analyze output → if failed, repeat.
  You do NOT run builds, logs, or commands yourself. |
```

Anti-Patterns 中新增条目：

```
- **Self-service debugging:** during diagnosis, diving into source files, running builds,
  printing logs, or writing comparison scripts yourself. Your job is to analyze (reason
  about patterns, logs, and outputs). Delegate codebase exploration to `explore`, delegate
  execution to `general` per step.
```

这些是 prompt 层面的约束，无平台层强制。
