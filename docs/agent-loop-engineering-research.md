# Agent 自主循环机制调研：oh-my-openagent 与 oh-my-pi

**日期:** 2026-09-23
**调研对象:**
- OMO (oh-my-openagent) @ `ba48a5d86`（2026-09-23）— OpenCode 的插件，loop 机制分布在 `packages/omo-opencode`（OpenCode 插件本体）、`packages/omo-codex`（Codex 组件）、`packages/omo-senpi`（pi 组件）中
- OMP (oh-my-pi) @ `f5328d73f2`（2026-09-23）— pi coding agent 的发行版，loop 机制直接实现在 agent 本体（`packages/coding-agent`、`packages/agent`、`packages/tui`）中

所有论断附 `文件:行号` 证据；路径相对各自仓库根目录。

---

## 目录

1. [TL;DR](#1-tldr)
2. [阅读向导：loop 机制在解决什么问题](#2-阅读向导loop-机制在解决什么问题)
3. [OMO：loop 机制版图](#3-omoloop-机制版图)
4. [OMO / ralph-loop：仓库内的未接线实现](#4-omo--ralph-loop仓库内的未接线实现)
5. [OMO / goal hook：OpenCode 内的续写循环](#5-omo--goal-hookopencode-内的续写循环)
6. [OMO / ulw-loop：跨宿主的 goal 编排组件](#6-omo--ulw-loop跨宿主的-goal-编排组件)
7. [OMO / loop 防护](#7-omo--loop-防护)
8. [OMP：loop 机制版图](#8-omploop-机制版图)
9. [OMP / autoresearch：扩展层的"虚拟循环"](#9-omp--autoresearch扩展层的虚拟循环)
10. [OMP / `/loop` 命令：预算 + shell 条件门](#10-omp--loop-命令预算--shell-条件门)
11. [OMP / loop 防护体系](#11-omp--loop-防护体系)
12. [OMP / 核心 agent-loop 与 hook 体系](#12-omp--核心-agent-loop-与-hook-体系)
13. [横向对比](#13-横向对比)
14. [设计哲学提炼](#14-设计哲学提炼)
15. [对 ZooKeeper 的启示](#15-对-zookeeper-的启示)

---

## 1. TL;DR

两个项目的 loop 机制呈现**两种不同的架构取向**：

- **OMO 的 loop 机制是一片多层组件版图**：OpenCode 内的续写循环由轻量的 **goal hook** 承担（仓库内另保留一份未接线的 ralph-loop 实现）；重型多 goal 编排是跨宿主的 **ulw-loop 组件**（Codex 插件 + Senpi 扩展），OpenCode 本体只剩一个 CLI 透传。
- **OMP 的 loop 机制围绕一条可扩展的核心 agent-loop 生长**：实验迭代循环 **autoresearch**（虚拟循环 + SQLite + MAD 置信度 + METRIC/ASI 协议）、面向用户的 **`/loop` 命令**（迭代/时长预算 + shell 条件门），以及五类**病理循环防护**（重复工具调用、advisor 循环、thinking 循环、todo 提醒自激、UI 事件循环卡顿），全部经由 hook 挂载，主循环不感知它们。
- 两个项目在防护层收敛出同一个模式：**检测 → 注入隐藏纠正消息 → 升级（abort/停止）**，并且都坚持 fail-closed——状态无法确认时宁可停循环，也不带猜测继续。

---

## 2. 阅读向导：loop 机制在解决什么问题

Coding agent 的基本运行单元是"一轮"：模型推理 → 调工具 → 观察结果 → 再推理，直到模型认为可以交付，然后**停下来等人**。真实任务（调 bug、跑实验、实现功能）往往需要几十上百轮，一次打住做不完。本文调研的 loop 机制回答的就是一个问题：**谁来、在什么时候、以什么方式把 agent 再次唤醒，以及什么时候让它真正停下。**

无论实现多复杂，每个 loop 机制都可以拆成六个部件。后文对所有机制的描述都对应这六个部件：

| 部件 | 回答的问题 | 两个仓库里的典型答案 |
|------|-----------|---------------------|
| **驱动事件** | 什么时候做"继续/停止"决策 | 宿主事件：OpenCode 的 `session.idle`、pi 的 `agent_end`/`agent_settled`、Codex 的 `Stop` hook |
| **完成/停止判定** | 凭什么认为该停了 | 文本 `<promise>` 扫描、结构化工具调用、shell 退出码、迭代/时长预算、无进展检测 |
| **续写注入** | 怎么触发下一轮 | 向会话注入一条（通常对用户隐藏的）消息，让宿主再跑一轮 |
| **状态** | 循环进度存哪、崩溃后怎么恢复 | markdown 文件、原子写 JSON、SQLite、append-only ledger |
| **上下文** | 下一轮 agent 看到什么 | 重放原始 prompt、每轮重建系统提示快照、对话自然累积 |
| **防护** | 怎么防死循环和"假装完成" | 重复调用熔断、纠正消息、独立验证者 |

后文反复出现的术语：

- **续写（continuation）**：循环机制注入的"继续工作"消息，通常带轮次编号，且对用户不可见。
- **promise 文本协议**：约定 agent 完成时输出 `<promise>DONE</promise>` 这类字面标记，由代码扫描会话记录检测。
- **虚拟循环**：没有独立的调度器/controller 进程，循环靠"事件钩子 + agent 自主调用工具"涌现出来。
- **maker/checker**：执行者（maker）不能自证完成，由独立验证者（checker）复核。
- **fail-closed**：状态无法确认时默认停止循环，而非带猜测继续。

---

## 3. OMO：loop 机制版图

| 机制 | 位置 | 说明 |
|------|------|------|
| ralph-loop | `packages/omo-opencode/src/hooks/ralph-loop/` | 代码保留，未接线 |
| goal hook | `packages/omo-opencode/src/hooks/goal/` | OpenCode 内的续写循环 |
| ulw-loop (Codex) | `packages/omo-codex/plugin/components/ulw-loop/` | 独立发布的插件组件 |
| ulw-loop (Senpi) | `packages/omo-senpi/src/components/ulw-loop/` + `ulw-execute-continuation/` + `skills/ulw-loop/` | pi 宿主扩展 |
| ulw-loop CLI 透传 | `packages/omo-opencode/src/cli/codex-ulw-loop.ts` | OpenCode 侧唯一入口 |
| 后台 agent 熔断 | `packages/omo-opencode/src/features/background-agent/loop-detector.ts` | 运行时 circuit breaker |
| kimi 提示词 guard | `packages/omo-opencode/src/agents/kimi-tool-loop-guard.ts` | 提示词级循环约束 |

`docs/manifesto.md:146-162` 把这些机制的上位目标称为 **"The Core Loop"**：Human Intent → Agent Execution → Verified Result，仅在真正失败时人工介入；并把 "Todo Continuation" 描述为"强制完成、防止 'I'm done' 谎言"的手段（`docs/manifesto.md:157`）。

---

## 4. OMO / ralph-loop：仓库内的未接线实现

### 4.1 存在但未接线

- 目录 `packages/omo-opencode/src/hooks/ralph-loop/`：29 个实现文件（2873 LOC）+ 22 个测试文件（5923 LOC）。
- 入口是 `createRalphLoopHook()`（`ralph-loop-hook.ts:44`），但**全仓库只有 barrel 导出引用它**（`hooks/index.ts:37`）；`HookNameSchema` 中只剩 `"goal"`（`config/schema/hooks.ts:28`），`create-session-hooks.ts` 中没有任何 ralph 注册；`/ralph-loop`、`/ulw-loop`、`/cancel-ralph` 命令与模板均不存在。
- `ralph_loop` 配置键是 deprecated passthrough，校验时自动迁移到 `goal.*`（`config/validate.ts:161-179`）；`default_mode.ralph_loop` 对应项名为 `default_mode.goal`（`config/schema/default-mode.ts:13`）。
- 虽未接线，它仍是一份完整、带测试的事件驱动循环实现，机制设计值得作为参考来读。

### 4.2 循环驱动机制

**触发：** `session.idle` 事件（`event-handler-impl.ts:42`），同文件处理 `session.deleted`（清状态）与 `session.error`（非 abort 错误后重试续写）；`inFlightSessions` 防重入（`event-handler-impl.ts:51`）。

**续写：** `continueSettledIteration` → `continueIteration` → `injectContinuationPrompt`，通过 `dispatchInternalPrompt`（`mode:"async"`，`queueBehavior:"defer"`，`settleMs: idleSettleMs`，`source:"ralph-loop"`）注入（`continuation-prompt-injector.ts:158-176`）。注入前从上一轮最后一条消息继承 `agent`/`model`/`tools`（`continuation-prompt-injector.ts:104-137`）。

**continuation prompt 格式**（`continuation-prompt-builder.ts:8`）：

```
[SYSTEM DIRECTIVE - RALPH LOOP {{ITERATION}}/{{MAX}}]
Continue. Output <promise>{{PROMISE}}</promise> when done.
{{PROMPT}}
```

**策略：** `strategy:"continue"` 复用原会话；`"reset"` 新建子会话并在 TUI 选中（`session-reset-strategy.ts:5-30`，`iteration-continuation.ts:36-84`）。

### 4.3 停止条件

| # | 条件 | 机制 |
|---|------|------|
| 1 | 完成 promise | 正则 `<promise>\s*DONE\s*</promise>`（`completion-promise-detector.ts:33`），同时扫 transcript 文件与 session messages，并用 `message_count_at_start` 限定扫描范围、避免把历史旧 promise 当成本轮完成（`completion-promise-detector.ts:130-133`） |
| 2 | 最大轮次 | 默认 100，ultrawork 500（`constants.ts:4-5`）→ 清状态 + toast |
| 3 | 无进展轮次 | 最近 assistant 消息 `finish==="unknown"` + 全部 token 为 0 + 无内容（`no-progress-turn-detector.ts:63-67`） |
| 4 | 会话删除 / 用户 abort | `session.deleted` 或 `MessageAbortedError`（`session-event-handler.ts:13-46`） |
| 5 | 派发/提交失败 | 清状态 + toast（`event-handler-continuation.ts:158-184`） |

### 4.4 状态与 ultrawork 验证

- 状态文件 `.omo/ralph-loop.local.md`（YAML frontmatter + body 为原始 prompt），整文件覆盖写。字段含 `iteration/max_iterations/completion_promise/verification_pending/strategy/message_count_at_start/verification_session_id` 等（`storage.ts:50-84`）。
- **ultrawork 验证阶段**：DONE 命中后把 promise 改为 `VERIFIED` 并注入验证 prompt（`loop-state-controller.ts:150-168`），要求调用 Oracle 子 agent 复核、回复以字面行 `Agent: gate-verifier` 结尾，并给出 category 回退链 `deep-high → deep-low → unspecified-high → unspecified-low`（`continuation-prompt-builder.ts:12-27`）。系统直接扫描 oracle 会话检测 `Agent: <name>` + `<promise>VERIFIED</promise>`（`oracle-verification-detector.ts:14-31`）。30 分钟无验证会话判卡死（`pending-verification-handler.ts:11`），失败则注入失败 prompt 并 iteration+1 回到开发循环（`loop-state-controller.ts:186-208`）。

---

## 5. OMO / goal hook：OpenCode 内的续写循环

`packages/omo-opencode/src/hooks/goal/`（8 个实现文件，约 595 LOC + 7 个测试文件）。与仓库内的 ralph-loop 对照，它把同一类机制做得极简：

| 维度 | ralph-loop | goal hook |
|------|-----------|-----------|
| 完成信号 | 扫描文本中的 `<promise>DONE</promise>` | agent 调用 `update_goal({status:"complete"})` 工具 |
| 状态 | 单文件 `.omo/ralph-loop.local.md`，覆盖写 | `.omo/goal/<sessionID>.json`，**原子写**（`goal/store.ts`）；另写 TUI 镜像 `.omo/ulw-loop/<sessionID>/goals.json`（`goal/controller.ts:22-45`） |
| 迭代上限 | 强制（默认 100） | 不强制；`goal.default_max_iterations` 仅为兼容 ralph-loop 保留（`config/schema/goal.ts`） |
| 用户接口 | `/ralph-loop` 命令 | `/goal <objective>` + `/goal pause\|resume\|clear`（`plugin/chat-message/loop-commands.ts:35-62`），或 `default_mode.goal` 首消息自动建 goal |
| 工具 | 无 | `create_goal` / `update_goal` / `get_goal`（`goal.enabled` 时注册） |

**驱动方式与 ralph-loop 同构**：监听 `session.idle` → `buildContinuationPrompt(goal)` → `dispatchInternalPrompt`（`settleMs:150`，`queueBehavior:"defer"`，`source:"goal:idle-continuation"`），`inFlightContinuations` 防重入；`session.deleted` 清 goal（`hooks/goal/index.ts:40-77`）。

关键差异：**完成判定从"扫文本"变成"结构化工具调用"**。promise 文本协议需要正则、扫描范围裁剪、跨 transcript/message 双通道检测；工具调用则由平台保证结构，消掉了整片检测代码（ralph-loop 里 completion-promise-detector/oracle-verification-detector/no-progress-turn-detector 合计 400+ LOC）。

---

## 6. OMO / ulw-loop：跨宿主的 goal 编排组件

重型多 goal 编排不在 OpenCode 插件本体内，而是**按宿主分别实现的组件**，共享 `.omo/ulw-loop/` 状态目录。

### 6.1 Codex 组件（`packages/omo-codex/plugin/components/ulw-loop/`）

独立发布的 npm 包（自带 CLI + hooks + skill），承载 repo-native、多 goal、证据绑定的编排：

- **CLI**：`omo-agent-toolkit ulw-loop <subcommand>`，子命令含 `create-goals / status / complete-goals / checkpoint / steer / add-goal / criteria / record-evidence / record-review-blockers`。
- **状态**：`.omo/ulw-loop/`，append-only `ledger.jsonl`，`withUlwLoopMutationLock` 跨进程串行化写。
- **hooks**（`hooks/hooks.json`）：
  - `UserPromptSubmit` — steering 注入
  - `PreToolUse create_goal` — budget guard
  - `PreToolUse spawn` — fan-out 上限 + gate-artifact preflight
  - `Stop` — **auto-resume**：满足条件时返回 `{decision:"block", reason}` 让宿主继续跑（`stop-resume-hook.ts:47-49`）
- **防护**：auto-resume 有 `RESUME_CAP = 2`（两击无进展上限）与 context-pressure 退避清单（`stop-resume-hook.ts:14-25`）；`spawn-guard.ts` 有 `DEFAULT_FANOUT_LIMIT = 24` 与 admission breaker。

### 6.2 Senpi 组件（`packages/omo-senpi/src/components/ulw-loop/`）

pi 宿主的事件驱动续写组件，注册于 `omo-senpi/src/extension/component-list.ts:41`：

- `pi.on("input")`：用户输入重置计数；检测到活跃 ulw-loop 时注入 `STEERING_REMINDER`（`index.ts:69-91`）。
- `pi.on("agent_end")`：只记录本轮（刷新 footer、跳过已达 `CONTINUATION_LIMIT = 8` 的情况）（`index.ts:93-121`）。
- `pi.on("agent_settled")`：**真正做续写决策**。代码注释解释了为什么不在 `agent_end` 决策：宿主保证 settled 时不再有自动重试、compaction 或排队的续写，晚到的 Esc 也不能再改写 payload（`index.ts:123-132`）。
- 续写投递：优先走 `idleCoordinator` 队列，否则 `pi.sendMessage(..., {triggerTurn:true, deliverAs:"followUp"})`（`index.ts:177-200`）。
- **fail-closed 会话归属**：无法证明状态属于当前会话就不续写（`session-scope.ts`，`index.ts:206-210`）。
- 状态通过 in-process SDK `#omo-agent-toolkit-sdk` 的 `agentToolkit.status()` 读取，与 Codex 侧共享磁盘格式。

同源的 `ulw-execute-continuation/`（403 LOC）是同一模式：`agent_end` 记录 + `agent_settled` 决策 + `CONTINUATION_LIMIT = 8`。

### 6.3 Skill 层（`packages/omo-senpi/skills/ulw-loop/`）

`SKILL.md` + `references/full-workflow.md` + `references/define-goal.md`，把 ulw-loop 定义为 **"goal-like loop"**：工作分解为证据绑定的 ultrawork 步骤，通过 SDK 调 `createGoals/status/completeGoals/criteria/recordEvidence/checkpoint/steer/addGoal`；强调 **maker/checker 分离**（执行委派给 subagent，验证走 reviewer），driver goal 只作指示不作 gate。

### 6.4 OpenCode 侧：只剩 CLI 透传

`packages/omo-opencode/src/cli/codex-ulw-loop.ts`：`omo ulw-loop [args...]` → 解析并 spawn Codex 侧可执行文件（本地 bin → 缓存组件 CLI → legacy），用 sentinel 环境变量 `OMO_ULW_LOOP_DELEGATED` 防委托链重入 fork-bomb（`codex-ulw-loop.ts:14-20,45`）。`docs/reference/features.md:392-394` 明确：OpenCode 内没有 `/ulw-loop` 斜杠命令，连续 goal 追求由 `/goal` 处理。

---

## 7. OMO / loop 防护

### 7.1 后台 agent 熔断器（`features/background-agent/loop-detector.ts`）

针对后台子 agent 的运行时 circuit breaker：

- 对工具名 + 排序后的输入生成签名（`loop-detector.ts:70-81`）；连续相同签名则计数（`loop-detector.ts:34-52`）。
- `consecutiveCount >= 20` 触发（`DEFAULT_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD`），或工具调用总量达 `4000`（`DEFAULT_MAX_TOOL_CALLS`），`manager.ts:1759-1799` 直接 `cancelTask`，理由为"通常意味着死循环"（`features/background-agent/constants.ts:9-11`）。

### 7.2 kimi 提示词 guard（`agents/kimi-tool-loop-guard.ts`）

同一问题的**提示词级**解法，注入 kimi agent 系统提示：

```
<tool_loop_guard>
Never call the same tool with the same arguments more than twice in a row.
If a third identical call seems necessary, stop calling tools and report the blocker...
Repeated identical tool calls are a loop signal, not persistence.
</tool_loop_guard>
```

运行时熔断（§7.1）与提示词约束（本节）并行存在——前者兜底，后者试图让模型自己别走进死循环。

---

## 8. OMP：loop 机制版图

| 机制 | 位置 | 说明 |
|------|------|------|
| autoresearch | `packages/coding-agent/src/autoresearch/`（3405 行） | 实验迭代虚拟循环 |
| `/loop` 命令 | `packages/coding-agent/src/modes/loop-limit.ts` + `loop-condition.ts` | 通用用户循环：预算 + shell 条件门 |
| 工具调用防护 | `packages/ai/src/utils/tool-call-loop-guard.ts` + `packages/coding-agent/src/session/stream-guards.ts` | 跨轮重复工具调用检测与纠正 |
| advisor 防护 | `packages/coding-agent/src/advisor/loop-guard.ts` | advisor 私有循环的同类防护 |
| thinking 防护 | `packages/ai/src/utils/thinking-loop.ts` + `session/turn-recovery.ts` | 推理循环 / Gemini 标题失控检测 |
| todo 提醒 | `packages/coding-agent/src/session/todo-tracker.ts` | 未完成 todo 的自续写，带自激抑制 |
| UI watchdog | `packages/tui/src/loop-watchdog.ts` + `packages/utils/src/loop-phase.ts` | Node/Bun 事件循环卡顿归因 |
| 核心循环 | `packages/agent/src/agent-loop.ts`（3612 行） | 主推理-工具循环 + 丰富 hook 体系 |

---

## 9. OMP / autoresearch：扩展层的"虚拟循环"

### 9.1 结构

`packages/coding-agent/src/autoresearch/` 合计 3405 行（TS 3235 + MD 170）：

| 文件 | LOC | 职责 |
|------|-----|------|
| `index.ts` | 541 | 扩展工厂：注册 4 个工具、`/autoresearch` 命令、快捷键、事件钩子 |
| `storage.ts` | 700 | SQLite 持久化（sessions/runs 两表） |
| `tools/log-experiment.ts` | 477 | 记录结果、git 提交/回滚、置信度重算 |
| `tools/run-experiment.ts` | 361 | 执行 `bash autoresearch.sh`、解析 METRIC/ASI |
| `git.ts` | 327 | `autoresearch/*` 分支管理 |
| `tools/init-experiment.ts` | 254 | 建/改 session、harness 提交、基线快照 |
| `state.ts` | 234 | 状态构建、置信度算法 |
| `helpers.ts` | 180 | METRIC/ASI 解析 |
| `tools/update-notes.ts` | 95 | 持久化 notes/ideas |
| `prompt.md` / `prompt-setup.md` / `command-resume.md` / `resume-message.md` | 170 | 两阶段系统提示与恢复模板 |

配套代码分布：dashboard 与工具渲染器在 TUI 包（`packages/tui/src/apps/autoresearch-dashboard.ts` 500 行 + `autoresearch-data.ts` + `tools/autoresearch.ts`）；git 操作经由 `pi-vcs` crate（统一 Git/Jujutsu，纯 jj 工作区直接拒绝启动，`git.ts:45`）。

### 9.2 虚拟循环：三条链路

autoresearch 没有独立 controller，循环完全挂在宿主 agent 生命周期上：

**(a) `agent_end` → 隐藏消息触发下一轮**（`index.ts:256-291`）：

```ts
api.on("agent_end", async (_event, ctx) => {
  if (!runtime.autoresearchMode) return;
  if (ctx.hasPendingMessages()) { runtime.autoResumeArmed = false; return; }
  // ... 加载 session、查 pending run、防重复（lastAutoResumePendingRunNumber）
  runtime.autoResumeArmed = false;
  api.sendMessage(
    { customType: "autoresearch-resume", content: ..., display: false, attribution: "agent" },
    { deliverAs: "nextTurn", triggerTurn: true },
  );
});
```

**(b) `before_agent_start` → 每轮重建系统提示**（`index.ts:293-416`）：重新读分支/session，把最新状态快照（baseline、best、置信度、最近 runs、pending run、notes）填进 `prompt.md` 模板返回。

**(c) 工具侧武装续写**：`init_experiment` / `run_experiment` / `log_experiment` 执行时置 `runtime.autoResumeArmed = true`，让 `agent_end` 知道该续写。

### 9.3 两阶段设计

- **Phase 1（harness 搭建，prompt-setup.md）**：agent 写 `./autoresearch.sh`——退出码表成败、打印 `METRIC <name>=<value>`、必须确定性；明确禁止创建 `autoresearch.md`、`.autoresearch/`、`autoresearch.config.json` 等一系列"自作聪明"的辅助文件。
- **Phase 2（迭代循环，prompt.md）**：改代码 → `run_experiment` → `log_experiment`（`keep/discard/crash/checks_failed`）→ 重复。scope/off-limits 路径约束 + `justification`/`flag_runs` 问责。`init_experiment` 是阶段切换点。

### 9.4 停止条件

1. 模式关闭（`runtime.autoresearchMode` 为假）。
2. 有用户待处理消息 → 让位给用户（`index.ts:262-265`）。
3. 当前 segment run 数达 `maxExperiments` → `log_experiment` 自动关模式、写 `autoresearch-control {mode:"off"}`、卸载实验工具（`tools/log-experiment.ts:301-312`）。
4. git 分支不再是 session 记录的分支 → 静默关闭（`index.ts:301-313`）。
5. `/autoresearch clear` → 重置 worktree 到基线。

### 9.5 状态、协议与 git

- **SQLite**（`bun:sqlite`）：sessions/runs 两表，WAL + `busy_timeout=5000`（issue #2421），按 repo root 编码分库（`~/.omp/autoresearch/<encoded>.db`，可用 `OMP_AUTORESEARCH_DB_DIR` 覆盖）；`status IS NULL` 表示 pending run，跑崩/中断后可据此恢复。
- **METRIC/ASI 文本协议**：`^METRIC\s+([\w.µ-]+)=(\S+)$` / `^ASI\s+([\w.-]+)=(.+)$`（`helpers.ts:11-45`），拒绝 `__proto__` 等键名。设计动机写在 prompt-setup.md：harness 用普通 shell 脚本即可产出指标，零 SDK 依赖；ASI 是不透明自由字段。运行命令固定为 `bash autoresearch.sh`，`run_experiment` 不接受任意命令——指标来源单一。
- **MAD 置信度**：`|bestKept - baseline| / MAD`（中位绝对偏差），样本 <3 或 MAD=0 返回 null；`>=2` likely real，`1~2` marginal，`<1` 噪声内（`state.ts:105-131`）。
- **git**：分支 `autoresearch/<slug>-<YYYYMMDD>`；脏工作区拒绝启动；keep → 自动提交；discard/crash → 分支上 `reset --hard HEAD` + `clean`（之前的 keep commit 不可变），不在分支上按脏路径差量回滚。

---

## 10. OMP / `/loop` 命令：预算 + shell 条件门

与 autoresearch 无关的**通用用户循环命令**：`/loop [count|duration] [--while|--until '<cmd>'] [prompt]`。

### 10.1 预算（`modes/loop-limit.ts`）

- limit 两种形态：`{kind:"iterations"}` 或 `{kind:"duration", durationMs}`；语法支持 `10`、`10m`、`1h30m`、`10 minutes`（`loop-limit.ts:82-172`）。
- 每轮 `consumeLoopLimitIteration` 递减/查 deadline（`loop-limit.ts:199-207`），另有不消费的预检 `isLoopLimitExhausted`。

### 10.2 条件门（`modes/loop-condition.ts`）

每轮迭代前运行用户给的 shell 命令，**只看退出码、忽略 stdout**。头注释（`loop-condition.ts:1-13`）写明了设计理由：`echo false` 退出码是 0——"布尔语义输出"和退出码会在同一条命令上打架，而用户随手写的谓词（`test`、`grep -q`、`git diff --quiet`）说的都是退出码。

退出码语义（`loop-condition.ts:123-165`）：

| 退出码 | `--while` | `--until` |
|--------|-----------|-----------|
| 0 | 继续 | 停止 |
| 1 | 停止 | 继续 |
| >1（127 不存在 / 126 不可执行 / 2 语法错误） | **error**：停机报错，而非当作"条件为假" | 同左 |
| 超时 | error（`loop.conditionTimeoutMs`，默认 30000，0 为无限） | 同左 |

> 关键原则：**条件命令本身坏了 ≠ 条件为假**。否则一条打错字的条件会让循环"看起来正常完成"，这正是该功能要避免的失败模式。

条件命令跑在独立 shell session key（`loop-condition:<sessionId>`），不污染 agent 的持久 shell。

### 10.3 驱动（`modes/interactive-mode.ts`）

`#runLoopIteration`（`interactive-mode.ts:2319`）：预算预检 → 条件门 `#passesLoopCondition` → 消费一次预算 → compact/reset 或提交 prompt。状态栏展示 loop 状态（`packages/tui/src/status-line/loop.ts`）。

---

## 11. OMP / loop 防护体系

五类防护，检测对象不同，统一套路：**检测 → 注入隐藏纠正消息 → 升级**。

### 11.1 跨轮重复工具调用（主 session）

- 检测器 `ToolCallLoopGuard`（`packages/ai/src/utils/tool-call-loop-guard.ts:68-108`）：对每轮工具调用做规范化（去 intent 字段、键排序）+ 排序 + JSON 哈希，连续相同计数，达阈值返回检测结果。
- 集成 `LoopGuards`（`session/stream-guards.ts:116-235`）：`agent_end`/turn-end 时 `recordTurn`，命中则压入 `customType:"tool-call-loop-redirect"` 的**隐藏 custom 消息**并持久化；文案是 `<system-interrupt reason="tool_call_loop_detected">`（`prompts/system/tool-call-loop-redirect.md`），要求换参数/换工具/收尾。
- 配置：`model.toolCallLoopGuard.enabled`（默认 true）、`.threshold`（默认 5）、`.exemptTools`。

### 11.2 advisor 私有循环（`advisor/loop-guard.ts`）

advisor 跑自己的 `Agent` 循环，不经过主 session 的 `LoopGuards`（issue #9491），需要独立防护。两个细节：

- **同一旋钮、同一文案**：复用主 session 的 `model.toolCallLoopGuard.*` 配置与同一纠正渲染——注释原话 "one knob governs both loops"、"both bounds speak with one wording"。
- **纠正消息要适配目标循环的消息转换器**：advisor 用默认 LLM 转换器，custom 消息会被丢弃，所以首次命中注入的是 `user` 角色的 synthetic 消息；仍重复才 abort（`loop-guard.ts:51-88`）。

### 11.3 thinking / 推理循环（`packages/ai/src/utils/thinking-loop.ts`）

`ThinkingLoopDetector` 四类判据（`thinking-loop.ts:132-305`）：精确后缀周期（Z-array）、近重复段落三元组聚类（Jaccard）、低信息量停顿（措辞复用但无新锚点）、尾部段落延迟 flush。流包装命中即 abort（`AIError.Flag.ThinkingLoop`）。

- **Gemini 专项**：`GeminiHeaderRunDetector` 检测"连续输出 planning 标题却从不调工具"，阈值 36（`thinking-loop.ts:307-371`）；命中后 abort + 追加 `gemini-tool-call-reminder` + `agent.continue()`。
- **重试侧**：`turn-recovery.ts:2350` 识别该 flag 后**不切换 fallback 模型**（注释引 issue #8760——推理循环不是模型问题，换模型没用），重试前注入 `thinking-loop-redirect` 隐藏消息（`turn-recovery.ts:2650-2668`）。
- 配置 `model.loopGuard.*`；环境变量 `PI_NO_THINKING_LOOP_GUARD=1` 关闭。

### 11.4 todo 提醒自续写（`session/todo-tracker.ts:205-295`）

终局 assistant 轮仍有 pending/in_progress todo 时：`reminderCount++` → 发 `todo_reminder` 事件 → 追加 `<system-reminder>` developer 消息 → `scheduleAgentContinue` 自续写。上限 `todo.remindersMax`（默认 3）。

**自激抑制**是精髓：`#reminderAwaitingProgress` 标志——上一条提醒后若 agent 没产生工具级进展（只有非 todo 的 mutating 工具成功才复位），就保持静默。否则"仅文本确认收到提醒"会触发 1/3→2/3→3/3 的空转自激（issue #2590，有回归测试）。其它抑制：用户强制 tool_choice、plan mode、等待用户回答、有 pending async wake。

### 11.5 UI 事件循环 watchdog（`packages/tui/src/loop-watchdog.ts`）

对象不是 agent 循环，而是 Node/Bun 事件循环：每 250ms 排 tick，实际触发晚于 deadline 250ms 记卡顿，日志附 `takeRecentLoopPhase()` 的**相位面包屑**归因（`loop-phase.ts` 维护进程级相位栈，要求同步 push/pop、不得跨 await）。长卡顿用 CPU 时间区分"系统休眠"与"CPU 卡死"（blockedMs > 60s 且 cpuMs < blockedMs×1% → 休眠，不误报）。思想是**归因而非泛泛报警**。

---

## 12. OMP / 核心 agent-loop 与 hook 体系

`packages/agent/src/agent-loop.ts`（3612 行）是上述一切的承载体：

- `agentLoop`（`:592`）→ `runLoop` → `runLoopBody`（`:1123`）：deadline 定时器 → steering 消息注入 →（可选）重放 `resumeTail` → **外层 while**（`getFollowUpMessages` 决定是否续轮）+ **内层 while**（工具调用 + steering）→ 每轮 `syncContextBeforeModelCall` → 转换 → `beforeModelCall` → provider 流式请求 → `executeToolCalls` → `emitTurnEnd`。
- `agentLoopContinue`（`:654`）从现有 context 继续（重试用），唯一允许的 assistant 尾是被剥离结果、待重放工具调用的 `unpairedToolCallTail`。

**`AgentLoopConfig` hook 点**（`packages/agent/src/types.ts:161-440`）——autoresearch 与全部防护都经由这些 hook 挂载，而非 fork 主循环：

| hook | 作用 |
|------|------|
| `convertToLlm` / `transformContext` / `transformProviderContext` | 请求前的上下文变换（裁剪/注入） |
| `getSteeringMessages` / `hasSteeringMessages` / `waitForSteeringMessages` | 中途用户消息注入 |
| `getFollowUpMessages` | **agent 本应停止时追加续轮消息**——`/loop`、todo 提醒等自续写的挂载点 |
| `getAsideMessages` | 步骤边界注入非中断"旁白"消息 |
| `syncContextBeforeModelCall` / `beforeModelCall` | 每模型调用前刷新上下文；后者可提前结束流而不计费 |
| `onBeforeYield` / `getToolContext` / `transformToolCallArguments` | 退出钩子 / 工具执行上下文 / 参数变换 |
| `speculativeToolExecution` / `resolveFallbackTool` | 投机执行 / 未广告工具兜底 |
| `deadline` | 墙钟截止 |

---

## 13. 横向对比

### 13.1 续写循环的实现方式

| 维度 | OMO ralph-loop（未接线） | OMO goal hook | OMP autoresearch | OMP `/loop` |
|------|----------------------|-------------|------------------|-------------|
| Controller | 插件代码（状态机 + 事件） | 插件代码（极简） | **AI agent 自身**（工具即状态机） | 宿主 mode 代码 |
| 驱动事件 | `session.idle` | `session.idle` | `agent_end` → `triggerTurn` | 每轮迭代前检查 |
| 续写注入 | `dispatchInternalPrompt`（defer + settle） | 同左 | `sendMessage`（隐藏，`nextTurn`） | 直接提交 prompt |
| 完成信号 | 文本 `<promise>DONE</promise>` | **工具调用** `update_goal(complete)` | 无显式完成；用户中断/迭代上限/分支切换 | 预算耗尽 / **shell 退出码** |
| 状态 | 单 markdown 文件 | 原子写 JSON / session | SQLite（sessions+runs） | 内存 runtime |
| 上下文传递 | 原文 prompt 重放 + 会话累积 | goal 对象 | 每轮重建系统提示（最近 3 runs + notes） | 同一会话累积 |
| 迭代上限 | 100 / 500 | 不强制 | `maxExperiments`（到限自动关模式） | count/duration 预算 |

### 13.2 防护机制对照

| 病理 | OMO | OMP |
|------|-----|-----|
| 重复工具调用 | 后台 agent 熔断（连续 20 次 / 总量 4000 → cancelTask）；kimi 提示词 guard | 主 session 阈值 5 → 隐藏纠正消息；advisor 先纠正后 abort |
| 推理/思考循环 | — | ThinkingLoopDetector（周期/近重复/低信息量）+ Gemini 标题失控专项，重试不切换模型 |
| 自续写自激 | ulw-loop：`RESUME_CAP=2` 两击上限、`CONTINUATION_LIMIT=8` | todo 提醒 `#reminderAwaitingProgress` 工具级进展门 |
| "agent 谎称完成" | ultrawork 强制 Oracle 验证（`Agent: gate-verifier` + `VERIFIED`） | autoresearch 用 METRIC 证据说话，无"完成"概念 |
| 条件判停歧义 | — | `/loop` 条件退出码 >1 判 error 而非 false |
| 事件循环卡顿 | — | watchdog + 相位面包屑 + CPU 时间区分休眠/卡死 |

---

## 14. 设计哲学提炼

### 14.1 两个项目共同遵守的原则

1. **事件驱动，且在 "settled" 事件上做决策。** OMO 用 `session.idle`（加 `settleMs` 去抖 + `queueBehavior:"defer"` 合并同边沿唤醒）；OMP/Senpi 组件明确解释了为什么续写决策放在 `agent_settled` 而非 `agent_end`——settled 时宿主保证没有未决的自动重试、compaction 或排队续写，晚到的用户中断也改不了 payload。在"半稳定"状态做决策是竞态温床。
2. **fail-closed。** 会话归属无法证明就不续写（Senpi）；状态陈旧、卡死、派发失败就停循环清状态（ralph-loop）；条件命令出错就报错停机而非当作完成（OMP `/loop`）。宁可不循环，不带猜测循环。
3. **"agent 说自己做完了"不可信，完成必须可被外部验证。** OMO 给出了两种形态：promise 文本协议把"完成"变成可被任何观察者扫描的产物，goal hook 则用平台保证结构的工具调用；ultrawork 再叠加独立 Oracle 复核（maker 不能自证完成）。OMP：autoresearch 干脆没有"完成"概念，只有 METRIC 证据和 keep/discard 记录。manifesto 称之为防 "I'm done" 谎言。
4. **纠正优于终止，终止优于失控。** 防护统一走 检测 → 隐藏纠正消息 → 升级（abort/cancel/停止）的阶梯；纠正消息要适配目标循环的消息转换器（advisor 用 user synthetic 而非 custom 消息），且多入口共用同一旋钮同一文案。

### 14.2 分歧点：controller 放在哪

- **OMO 的答案：controller 是代码。** ralph-loop/goal 由插件状态机决定何时续写、何时停止；ulw-loop 进一步把状态变成磁盘上的 ledger，agent 通过 CLI/SDK 读写，宿主重启、会话压缩后凭磁盘恢复而非重新规划。
- **OMP 的答案：controller 是 agent 自己，代码只提供工具和护栏。** autoresearch 的"循环"是 agent 在工具（init/run/log/update_notes）构成的状态机里自主行走，代码只在 `agent_end` 时推一把（triggerTurn）并在每轮重建上下文。核心 agent-loop 完全不感知 autoresearch——所有循环行为都挂在扩展/hook 层。
- 代价对照：OMO 的 promise 文本协议催生了一整片检测代码（完成检测、oracle 检测、无进展检测、扫描范围裁剪），goal hook 改用工具调用后大幅简化；OMP 的虚拟循环几乎没有调度代码，但把正确性押在 prompt 纪律（prompt.md 的行为规则）与防护网上。

### 14.3 两条值得注意的简化思路

两个仓库里并存的设计对照出两条把循环机制做薄的路径：

- **把"完成"从需要扫描推断的文本信号，变成平台保证结构的工具调用。** 同仓库对照：ralph-loop 的 promise 文本协议需要一整片检测代码（完成检测、oracle 检测、无进展检测、扫描范围裁剪，合计 400+ LOC）；goal hook 用 `update_goal({status:"complete"})` 后这层代码整个消失。ulw-loop 再进一步，把循环状态变成可跨进程恢复的 append-only 磁盘 ledger。
- **把"是否继续"的判定外包给外部谓词。** OMP 的 `/loop` 条件门用 shell 退出码作契约，循环基础设施无需理解任务语义——`bun test`、`grep -q`、`git diff --quiet` 都是现成的继续/停止判定器。

---

## 15. 对 ZooKeeper 的启示

ZooKeeper（同时适配 OpenCode 与 pi 的编排器插件）已具备引擎雏形：`onSettled` slot + 汇聚 runner（首个 wake 胜出、逐策略崩溃隔离、fail-closed）+ 预算记账 + 双宿主续写注入，唯一策略是 todo-continuation（`src/core/continuation/`、`src/hooks/todo-continuation/`）。

本调研的结论已转化为设计决策，完整方案见 `docs/loop-engine-design.md`。各模式的取舍：

**已采用：**

1. **settled 事件驱动续写**（OMO goal / Senpi ulw-loop / OMP 共同原则）：在宿主"彻底安静"的事件上做续写决策，加防重入——ZooKeeper 双宿主适配已对齐。
2. **fail-closed 与联锁强制**：预算上限由引擎执行而非策略自觉；信息不足时倾向沉默。
3. **沉默可解释**：每次不唤醒都有机器可读原因（引擎原因与策略原因分层）。
4. **进展门抑制自激**（OMP todo-tracker）：但定位为**策略的观测输入**而非引擎强制门——等待外部事件的循环不应被进展门挡死（第一性原理推导，见设计文档 §3）。

**暂缓（待引擎迁移完成后重审）：**

5. **结构化完成信号**（OMO goal hook：工具调用优于文本扫描）：作为未来 debug 循环的退出机制候选。
6. **重复工具调用熔断**（OMO loop-detector / OMP ToolCallLoopGuard）： ZooKeeper 的 subagent 调度在进程内，暂无同等失控面，第二个 controller 出现时重审。
7. **磁盘 ledger 恢复**（OMO ulw-loop）：当前额度状态为内存级，暂无跨进程恢复需求。

**明确不采用：** ralph-loop 的 promise 文本协议 + 扫描检测层——goal hook 的工具调用方案在同一仓库内展示了更简的替代；autoresearch 的完整实验框架（SQLite + MAD + git 分支）对编排场景过重，其 METRIC/ASI"零依赖文本协议"思想可按需取用。

---

## 附录：关键证据索引

**OMO（oh-my-openagent）**

| 主题 | 位置 |
|------|------|
| ralph-loop 入口/事件分发 | `packages/omo-opencode/src/hooks/ralph-loop/ralph-loop-hook.ts:44`、`event-handler-impl.ts:42,51,65` |
| 续写注入与上下文继承 | `.../ralph-loop/continuation-prompt-injector.ts:104-137,158-176` |
| 完成/无进展/Oracle 检测 | `.../ralph-loop/completion-promise-detector.ts:33,130-133`、`no-progress-turn-detector.ts:63-67`、`oracle-verification-detector.ts:14-31` |
| 验证卡死与失败重启 | `.../ralph-loop/pending-verification-handler.ts:11`、`loop-state-controller.ts:150-168,186-208` |
| ralph-loop 未接线证据 | `config/schema/hooks.ts:28`（仅 goal）、`hooks/index.ts:37`（仅 barrel）、`config/validate.ts:161-179`（迁移） |
| goal hook | `packages/omo-opencode/src/hooks/goal/index.ts:40-77`、`goal/store.ts`、`goal/controller.ts:22-45` |
| goal 命令 | `packages/omo-opencode/src/plugin/chat-message/loop-commands.ts:8,35-76` |
| ulw-loop Codex | `packages/omo-codex/plugin/components/ulw-loop/`（`stop-resume-hook.ts:14-49`、`spawn-guard.ts`） |
| ulw-loop Senpi | `packages/omo-senpi/src/components/ulw-loop/index.ts:69-210`（决策 123-155、fail-closed 206-210） |
| ulw-loop 透传 | `packages/omo-opencode/src/cli/codex-ulw-loop.ts:14-70` |
| 后台熔断 | `packages/omo-opencode/src/features/background-agent/loop-detector.ts:34-98`、`constants.ts:9-11`、`manager.ts:1759-1799` |
| 设计哲学 | `docs/manifesto.md:146-162`、`docs/reference/features.md:392-394` |

**OMP（oh-my-pi）**

| 主题 | 位置 |
|------|------|
| autoresearch 虚拟循环 | `packages/coding-agent/src/autoresearch/index.ts:256-291`（agent_end）、293-416（before_agent_start） |
| 停止条件 | `autoresearch/index.ts:261-265,301-313`、`tools/log-experiment.ts:301-312` |
| SQLite | `autoresearch/storage.ts:17-27,192-253,574-582` |
| MAD 置信度 | `autoresearch/state.ts:105-131` |
| METRIC/ASI | `autoresearch/helpers.ts:4-45` |
| git 策略 | `autoresearch/git.ts:6,36-91,187`、`tools/log-experiment.ts:214-228,299-343` |
| `/loop` 预算/条件 | `packages/coding-agent/src/modes/loop-limit.ts:33-224`、`loop-condition.ts:1-13,92-167`、`interactive-mode.ts:2319-2365` |
| 工具调用防护 | `packages/ai/src/utils/tool-call-loop-guard.ts:68-108`、`session/stream-guards.ts:116-235`、`advisor/loop-guard.ts:31-113` |
| thinking 防护 | `packages/ai/src/utils/thinking-loop.ts:132-512`、`session/turn-recovery.ts:2350-2353,2650-2668` |
| todo 自续写 | `session/todo-tracker.ts:71,108-115,205-295` |
| watchdog | `packages/tui/src/loop-watchdog.ts:57-146`、`packages/utils/src/loop-phase.ts:26-50` |
| 核心循环与 hooks | `packages/agent/src/agent-loop.ts:592-683,1123-1237`、`packages/agent/src/types.ts:161-440` |
| 防护配置 | `config/settings-schema.ts:1350-1414,1967-1981,4176-4199` |
