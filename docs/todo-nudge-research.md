# Todo 机制调研：oh-my-openagent / oh-my-opencode-slim / oh-my-pi 与 ZooKeeper 现状

**版本:** 2.0（完全重写，替代 2026-06 的 1.0 版）
**日期:** 2026-09-16
**调研对象 HEAD:** oh-my-openagent（包名 oh-my-opencode v5.0.0-beta.65）、oh-my-opencode-slim `3013dc25`、oh-my-pi（pi-mono fork）、ZooKeeper 当前工作区

---

## 目录

1. [总览](#1-总览)
2. [oh-my-openagent 的实现](#2-oh-my-openagent-的实现)
3. [oh-my-opencode-slim 的实现](#3-oh-my-opencode-slim-的实现)
4. [oh-my-pi 的实现](#4-oh-my-pi-的实现)
5. [三方对比](#5-三方对比)
6. [ZooKeeper 现状](#6-zookeeper-现状)
7. [缺口对照](#7-缺口对照)

---

## 1. 总览

三个项目对"todo 行为塑形"的切入点完全不同：

| 维度 | oh-my-openagent | oh-my-opencode-slim | oh-my-pi |
|---|---|---|---|
| 定位 | OpenCode 插件（包名 oh-my-opencode） | OpenCode 插件 | pi-mono 的 fork，完整 agent 产品 |
| todo 数据模型 | 宿主 OpenCode 的 todo（4 状态） | 宿主 OpenCode 的 todo（4 状态） | **自有 todo 工具**（5 状态 + 阶段分组，9 操作） |
| 自动续跑 | `todo-continuation-enforcer` + atlas + goal + senpi 四条链 | `orchestrator-wake` 一条链 | `TodoTracker.checkCompletion` 内建于会话 |
| 续跑触发 | `session.idle` 事件 | `session.idle` / `session.status` 事件 + 5 分钟定时器 | 助手回合终止时同步检查 |
| 停滞/失败保护 | 停滞 3 次停、连败 5 次停、指数退避冷却 | 指纹不变 2 次停 | 提醒上限 3 次（可配） |
| todo 卫生 | 压缩保活、描述覆写、读取拦截、格式校验、通知门控 | 无独立卫生机制 | 中途 nudge、prewalk 门、失败提醒 |
| 委派后提醒 | atlas verification reminder（`tool.execute.after` 的 `task`） | 无 | 无（子代理不持有 todo） |
| 配置哲学 | blacklist（`disabled_hooks`，全默认启用） | 单开关段 `backgroundJobs.orchestratorWake` | settings 4 个 `todo.*` 键 |

---

## 2. oh-my-openagent 的实现

代码在 `packages/omo-opencode/`（OpenCode 侧）与 `packages/omo-senpi/`（pi 侧组件包）。todo 机制共有四条自动续跑链 + 六类卫生机制。

### 2.1 自动续跑主链：`todo-continuation-enforcer`

**位置:** `packages/omo-opencode/src/hooks/todo-continuation-enforcer/`（14 个生产文件）

**触发:** 挂载 OpenCode 全局 `event` hook（`event-hook-dispatcher.ts:45`），`handler.ts` 路由：

- `session.error`（`handler.ts:76-117`）：识别 abort（`wasCancelled`）、token-limit、不可重试错误
- `session.idle`（`handler.ts:119-132`）→ `handleSessionIdle()`
- `session.compacted` → 武装 compaction guard；`session.deleted` → 清状态
- 其它事件（`message.updated` / `tool.execute.*`）→ 跟踪"注入后是否有回应"

**判定门控**（`idle-event.ts`，按顺序全部通过才注入）：

| 步骤 | 位置 | 条件 |
|---|---|---|
| 早退 | `idle-event.ts:42-70` | 全部完成 / 恢复中 / 被取消 / token-limit / 不可恢复错误 |
| abort 窗口 | `idle-event.ts:72-80` | abort 后 3000ms 内不注入 |
| 后台任务 | `idle-event.ts:82-90` | 有 running/pending 后台任务则跳过 |
| 消息检查 | `idle-event.ts:92-115` | 最后消息被 abort、有未回答的 question 工具调用 |
| todo 判定 | `idle-event.ts:117-139` | `client.session.todo()`；空列表或无未完成 → 不注入 |
| 失败计数 | `idle-event.ts:146-158` | 连败 ≥ 5 停止（5 分钟窗口后清零） |
| 冷却 | `idle-event.ts:160-165` | `5000ms * 2^min(failures,5)` 指数退避 |
| agent 跳过 | `idle-event.ts:203-215` | 跳过 `["prometheus","compaction","plan"]` |
| 用户停止 | `idle-event.ts:217-220` | `/stop-continuation` 命令守卫 |
| 停滞 | `idle-event.ts:222-237` | 停滞计数 ≥ 3 停止；`continuationBlockReason` 暂停 |
| 倒计时 | `idle-event.ts:238-248` | TUI toast 倒计时 2 秒 |

**未完成判定**（`todo.ts:3-10`）——`completed` / `cancelled` / `blocked` / `deleted` 之外都算未完成：

```ts
export function getIncompleteCount(todos: Todo[]): number {
  return todos.filter(
    (todo) =>
      todo.status !== "completed"
      && todo.status !== "cancelled"
      && todo.status !== "blocked"
      && todo.status !== "deleted",
  ).length
}
```

**停滞判定**（`stagnation-detection.ts:6-35` + `session-state.ts:116-199`）：进度定义为"未完成数减少 / 完成数增加 / todo 快照变化"，快照只比较 `{id → status}`（内容/优先级变化不算进度）；连续 3 次注入无进度即停止。注入后若"助手有回应但 todo 无进展"置 `continuationBlockReason="directive-response"`，窗口内出现真实用户消息置 `"user-interruption"`，两者都暂停续跑直到真实进展。

**注入前再校验**（`continuation-injection.ts:111-199`）：重新读 todo 确认仍有未完成、agent 不在跳过列表、有写权限（`edit`/`write` 非 deny）、无后台任务、未被取消。

**注入的 prompt 原文**（`constants.ts:7-14` + 动态后缀 `continuation-injection.ts:168-175`）：

```
[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your
  completion claim. Critically re-examine each todo item from a skeptical
  perspective, verify the work was actually done correctly, and update the
  todo list accordingly.

[Status: 3/7 completed, 4 remaining]

Remaining tasks:
- [pending] ...
- [in_progress] ...
```

### 2.2 续跑链二：atlas（boulder/计划文件）

**位置:** `packages/omo-opencode/src/hooks/atlas/`。同为 `session.idle`，但面向"计划文件驱动"的 boulder 工作模式（与 enforcer 按会话类型分流）。常量：`CONTINUATION_COOLDOWN_MS=5000`、`MAX_CONSECUTIVE_PROMPT_FAILURES=10`。

**注入文本原文**（`atlas/system-reminder-templates.ts:25-35`）：

```
[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]

You have an active work plan with incomplete tasks. Continue working.

RULES:
- **FIRST**: Read the plan file NOW. If the last completed task is still
  unchecked, mark it `- [x]` IMMEDIATELY before anything else
- Proceed without asking for permission
- Use the notepad at .omo/notepads/{PLAN_NAME}/ to record learnings
- Do not stop until all tasks are complete
- If a task is blocked by missing external input, unavailable credentials,
  access limits, or a decision only the user can make, you MUST edit the
  plan file in this turn and change that task's checkbox from `- [ ]` to
  `- [~]` before moving on
- A text-only explanation of a blocker is NOT progress. The `- [~]`
  checkbox edit is mandatory and must happen via a real file-editing tool call
```

### 2.3 续跑链三：goal hook（opt-in）

**位置:** `packages/omo-opencode/src/hooks/goal/`。默认关闭，需 `goal.enabled: true`；`default_mode.goal: true` 会从首条主会话消息自动建 goal。`session.idle` 续跑，注入 `"Continue working toward the active thread goal."` + `<untrusted_objective>` + 时间/token 用量 + 完成前审计要求（`goal/prompt.ts:3-31`）。

### 2.4 pi 侧续跑：senpi `ulw-execute-continuation`

**位置:** `packages/omo-senpi/src/components/ulw-execute-continuation/`。

- **触发:** pi 的 `agent_settled` 事件（`index.ts:75-133`），判定基于 `agent_end` 记录与 `findContinuableBoulderWork()`
- **终止条件:** `blockedBy !== null`（终态）；连续续跑 ≥ 8 次（`CONTINUATION_LIMIT`）；签名未变（防重复注入）
- **投递:** 经 `idle-injection-coordinator.ts` 协调——多个来源的注入请求按 `SOURCE_RANK` 排序合并，"N ready → 1 injection"

**注入文本**（`index.ts:178-211`）：

```
<omo-senpi-ulw-execute-continuation>
You are mid-flight on a ulw-execute work plan; this turn is an automatic
continuation. Do NOT ask whether to continue — the contract is
auto-continue until every top-level checkbox is `- [x]`.
...
- Remaining top-level checkboxes: {remaining} of {total}
- [Status: {completed}/{total}, next: {nextLabel}]
...
</omo-senpi-ulw-execute-continuation>
```

### 2.5 pi 侧提醒：`todo-fanout-reminder`

**位置:** `omo-senpi/src/components/todo-fanout-reminder/`。`tool_result` 事件、仅 `todo` 工具的 `init`/`append` op 触发，每会话一次，flag `omo-senpi-todo-fanout-reminder-disabled` 可关。

**注入文本原文**（`reminder.ts:1-9`）：

```
<system-reminder>
ultrawork mode is active and this session just started its todo list.
Before working any todo:
1. SIZE the work: weigh the todo count, each task's scope, and the total effort.
2. COMPUTE the fan-out decision: delegate to parallel subagents only when
   the parallelism gain beats spawn and coordination overhead - independent
   parts with disjoint write scopes fan out, interdependent or trivial
   parts do not.
3. TELL the user the decision either way: ... Never delegate silently and
   never grind through a fan-out-shaped task silently.
4. KEEP the todo list fresh: mark start/done the instant each task
   transitions, append newly discovered steps the moment they surface,
   drop abandoned ones. A stale todo list is a defect.
</system-reminder>
```

### 2.6 卫生机制一：`compaction-todo-preserver`（压缩保活）

**位置:** `packages/omo-opencode/src/hooks/compaction-todo-preserver/hook.ts`（245 行）。

- **capture:** `experimental.session.compacting`（压缩前）快照 todo
- **restore:** `session.compacted` 事件后用 `Todo.update` 写回
- **保留逻辑**（`hook.ts:40-61`）：只保留"详细 todo"——Atlas 的两条 bootstrap todo（`orchestrate-plan` / `pass-final-wave`）不算详细；空快照与纯 bootstrap 快照被丢弃；当前列表为空或仅为 bootstrap 且快照含详细 todo 时才覆盖恢复
- **晚到防护:** 压缩后才到达的 `todowrite` 若又写回纯 bootstrap 列表，则用恢复快照替换其工具参数（`tool.execute.before`，`hook.ts:214-242`）

### 2.7 卫生机制二：`todo-description-override`（工具描述覆写）

**位置:** `hooks/todo-description-override/description.ts:1-38`。`tool.definition` hook 命中 `todowrite` 时覆写其 description，注入写作规范：

```
Each todo title MUST encode four elements: WHERE, WHY, HOW, and EXPECTED RESULT.
Format: "[WHERE] [HOW] to [WHY] - expect [RESULT]"
## Granularity Rules
Each todo MUST be a single atomic action completable in 1-3 tool calls.
## Task Management
- One in_progress at a time. Complete it before starting the next.
- Mark completed immediately after finishing each item.
- Skip this tool for single trivial tasks (one-step, obvious action).
```

### 2.8 卫生机制三：`tasks-todowrite-disabler`（读取拦截）

**位置:** `hooks/tasks-todowrite-disabler/`。`tool.execute.before` 拦截；仅当 `experimental.task_system` 开启时生效，拦截 `TodoRead` 并抛错，引导改用 Task 系列工具。`TodoWrite` 故意不拦——它是保持 todo 面板同步的唯一路径（issue #3764）。

### 2.9 卫生机制四：`plan-format-validator`（计划格式校验）

**位置:** `hooks/plan-format-validator/hook.ts`。`tool.execute.before` 拦截 `Write`/`Edit`，用正则校验计划文件的复选框格式（`HEADING_TODOS` / `TOPLEVEL_CHECKBOX` / `TODO_TASK` / `FINAL_WAVE_TASK`），与 `getPlanProgress()` 解析计数对比，并规范化 `**Effort:**` 字段。

### 2.10 卫生机制五：`session-todo-status`（通知门控）

**位置:** `hooks/session-todo-status.ts:12-30`。`hasIncompleteTodos()` 判定（`completed`/`cancelled` 之外即未完成）；消费者 `session-notification.ts` 默认 `skipIfIncompleteTodos: true`——**还有未完成 todo 就不发"会话完成"通知**。

### 2.11 委派后验证提醒

**位置:** `atlas/tool-execute-after-subagent-completion.ts:100-118`。`tool.execute.after` 的 `task()` 返回且无 boulder state 时追加 `<system-reminder>`，核心步骤：

```
**STEP 5: CHECK YOUR PROGRESS DIRECTLY (EVERY TIME - NO EXCEPTIONS)**
Do NOT rely on memory or cached state. Run `todoread` NOW ...
**STEP 6: UPDATE TODO STATUS (IMMEDIATELY)**
RIGHT NOW - Do not delay. Verification passed → Mark IMMEDIATELY.
1. Run `todoread` to see your todo list
2. Mark the completed task as `completed` using `todowrite`
**DO THIS BEFORE ANYTHING ELSE. Unmarked = Untracked = Lost progress.**
...
**NO TODO = NO TRACKING = INCOMPLETE WORK. Use todowrite aggressively.**
```

boulder 模式下的 `buildCompletionGate()` 要求先 `Edit` 计划文件复选框再 `Read` 复核："你的完成在复选框被标记前不被记录"。

### 2.12 配置开关

| 开关 | 默认 |
|---|---|
| `disabled_hooks: string[]`（blacklist，所有 hook 统一开关） | 全部启用 |
| `experimental.task_system` | 关闭（disabler 不生效） |
| `goal.enabled` | 关闭（opt-in） |
| enforcer `skipAgents` 构造参数 | `["prometheus","compaction","plan"]` |
| `/stop-continuation` 运行时命令 | — |
| `notification.skipIfIncompleteTodos` | `true` |

---

## 3. oh-my-opencode-slim 的实现

HEAD `3013dc25`。现行 todo 机制只有一条主链 `orchestrator-wake` + system prompt 规则；不存在委派后 todo 提醒，也不存在独立的卫生 hook。

### 3.1 `orchestrator-wake`（todo 门控的周期唤醒）

**位置:** `src/hooks/orchestrator-wake/index.ts`（1717 行）+ `wake-gate.ts`（进程级单飞门，`globalThis[Symbol.for(...)]` 存储，`MAX_TRACKED_SESSIONS=256`）。

**触发:** OpenCode `event` hook（`src/index.ts:1504` 转发）：

```ts
// index.ts:480-499
function isIdleEvent(type, properties) {
  return type === 'session.idle' ||
    (type === 'session.status' && properties?.status?.type === 'idle');
}
```

- idle → `beginContinuousIdle()` 启动计时器（默认连续空闲 5 分钟后评估）
- busy → 结束 idle spell（wake 自身引发的 busy 保留 cap，外部 busy 重置 cap）
- `permission.asked` / `question.asked` → 抑制；`chat.message` hook 观察真实用户活动重新武装 cap
- 会话资格：`shouldManageSession` = 会话 agent 为 `orchestrator`（`src/index.ts:704-705`）

**判定:** 计时器到点后 `evaluate()`（`index.ts:1183`）→ `readHostSnapshot()` 并发调三个 SDK API（`index.ts:895-900`）：

```ts
const [todoResponse, childrenResponse, statusResponse] = await Promise.all([
  sessionSdk.todo({ path: { id: sessionID }, ... }),
  sessionSdk.children({ ... }),
  sessionSdk.status({ ... }),
]);
```

未完成判定（`index.ts:340-359`）：仅 `pending` / `in_progress` 算未完成。checkpoint 分类（`classifyTodoSnapshot`，`index.ts:1114-1127`）：父会话活跃 → 不唤醒；有活跃子会话 → 延后；无未完成 todo → 不唤醒；否则 `wake`。

**上限:** 指纹不变连续达到 `ORCHESTRATOR_WAKE_UNCHANGED_CAP = 2` 即停止（`index.ts:82,1243-1250`）——比 omo 的停滞-3 更保守。

**注入文本原文（三选一）**（`index.ts:51-79`）：

```ts
// v1 todo 模式
export const ORCHESTRATOR_WAKE_TEXT =
  '<system-reminder>\nFinish any incomplete TODOs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

// v2 children 模式
export const ORCHESTRATOR_CHILDREN_WAKE_TEXT =
  '<system-reminder>\nCheck on unfinished background child sessions and unreconciled jobs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

// stopped-job 恢复
export const ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT =
  '<system-reminder>\nA background job stopped without a terminal result. Consult the Background Job Board, recover or reroute the work as needed, and do not wait for that job as if it were still running. Do not respond to this reminder.\n</system-reminder>';
```

投递：`sessionSdk.promptAsync` 注入 internal-initiator 文本 part（v2 额外 `delivery: 'queue'`）。

**配置**（`src/config/schema.ts:239-268`）：

| 键 | 默认 |
|---|---|
| `backgroundJobs.orchestratorWake.enabled` | `true` |
| `backgroundJobs.orchestratorWake.intervalMs` | `300000`（下限 60s） |
| `backgroundJobs.orchestratorWake.mode` | `"auto"`（另可选 `"todo"` / `"children"`） |

### 3.2 System prompt 规则：Todo Continuity

**位置:** `src/agents/orchestrator.ts:217-220`，经 `experimental.chat.system.transform` 注入：

```
### Todo Continuity
- When the user adds a new task while a todo list exists, append the new task
  to the end of the existing todo list instead of replacing the list.
- Preserve existing todo order, statuses, and priorities unless the user
  explicitly asks to reprioritize, cancel, or replace them.
- Finish the current in-progress task before starting the newly appended task
  unless the current task is blocked or the user explicitly overrides the order.
```

另有条件段落 "End Turn After Background Tasks"（`orchestrator.ts:244-252`）明示 "wake scheduler resumes you"——prompt 与唤醒机制互相知情。

### 3.3 其它

- **deepwork todo 同步:** `src/skills/deepwork/SKILL.md:79-80`——每个 phase 开始前用该 phase 的交付 todo 替换整个 todo 列表
- **`todowrite` 权限:** `src/config/schema.ts:37` per-agent `ask|allow|deny`，通用工具权限声明
- **明确没有:** 委派后 todo 提醒（`rg -i todo src/hooks/post-file-tool-nudge/` 等为空）、压缩保活、工具描述覆写

---

## 4. oh-my-pi 的实现

`badlogic/pi-mono` 的 fork，是完整 agent 产品（自带 TUI、31 内置工具、Rust core），不是插件。todo 机制全部在 `packages/coding-agent/`（TS），crates/ 与 python/ 无 todo 逻辑。**它是三者中唯一自建 todo 工具与数据模型的项目。**

### 4.1 `todo` 工具与数据模型

**位置:** `packages/coding-agent/src/tools/todo.ts`（1365 行）。官方文档 `docs/tools/todo.md`。

**数据模型**（`todo.ts:21-35`）：

```ts
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
TodoItem { content: string; status: TodoStatus; blocker?: string }
TodoPhase { name: string; tasks: TodoItem[] }
```

- **单一 op 模型:** 一次调用只执行一个 op：`init | start | done | rm | drop | block | unblock | append | view`（`todo.ts:24`）
- **自动晋升**（`todo.ts:160-181` `normalizeInProgressTask`）：多个 `in_progress` 时只保留第一个，其余降级 `pending`；没有 `in_progress` 时自动把第一个 `pending` 晋升。blocked 任务永不自动晋升
- **持久化:** transcript 即事实来源——从分支记录的 tool-result details 中最后一个非 `view` 的 `todo` 结果重建状态（`todo.ts:284` `getLatestTodoPhasesFromEntries`）；不写任何文件
- **子代理隔离:** 子代理不继承父会话 todo（`task/executor.ts:3841-3844`）
- **开关门控:** `tools/index.ts:652-653`——`todo.enabled` 设置 + 会话状态双重门控注册

**工具描述**（`prompts/tools/todo.md` 渲染注入）规定：任务用逐字内容字符串、禁止自动生成 ID（无 `task-1`）；`NEVER make a todo call the turn's only tool call`（todo 调用必须与实质工具调用同行）。

### 4.2 `TodoTracker`（会话级进度管理）

**位置:** `packages/coding-agent/src/session/todo-tracker.ts`（399 行）。类 docstring："Owns canonical todo state, eager preludes, and completion reminders."

| 方法 | 触发时机 | 作用 |
|---|---|---|
| `syncFromBranch()` | 会话启动 / resume / rewind / fork / compact | 从分支重建 phases |
| `onToolResult()` | 每次 toolResult | `todo` 调用归零计数；变更型工具（bash/eval/edit/write/ast_edit）成功 +1 |
| `createEagerTodoPrelude()` | 首条用户消息（或 compaction 后） | 生成 eager prelude + 可选强制 toolChoice |
| `checkCompletion()` | 助手回合**终止**时 | 有未完成 todo → 注入提醒并 `scheduleAgentContinue` |
| `takeMidRunNudge()` | 运行中 aside 注入点 | 中途提醒 |

**自动续跑**（`todo-tracker.ts:204-291` `checkCompletion`）：守卫条件——用户强制停止、plan mode、已注入待进展、提醒次数达上限、等待用户回答（`isAwaitingUserAnswer`，识别问句线索，含非 ASCII 问号）、有 pending async wake。

**中途 nudge**（`todo-tracker.ts:296-324`）：自上次 todo 调用起变更型工具成功 ≥ 12 次（`MID_RUN_NUDGE_MUTATION_THRESHOLD`）且本轮 nudge < 2 次时触发。

**prewalk 门**（`session/prewalk.ts:105-181`）：prewalk 场景下未观察到成功的 `todo` 调用就不放行实际编辑动作——强制"先建 todo 再动手"。

### 4.3 注入文本原文

**eager prelude**（`prompts/system/eager-todo.md`，`forced` 仅在 `todo.eager === "always"` 时）：

```
<system-reminder>
Before substantive work, create a phased todo.
You MUST call `todo` first in this turn.
You MUST initialize the todo list with a single `init` op.
...
</system-reminder>
```

**停止时未完成提醒 + 续跑**（`todo-tracker.ts:264-271`）：

```
<system-reminder>
You stopped with {N} incomplete todo item(s):
- <phase>
  - <task>

Please continue working on these tasks or mark them complete if finished.
(Reminder {count}/{max})
</system-reminder>
```

**中途 nudge**（`prompts/system/mid-run-todo-nudge.md`）：

```
<system-reminder>
{N} todo item(s) still open. If you finished a task since last `todo`
update, mark it done now so progress stays visible; otherwise keep working.
</system-reminder>
```

**todo 调用失败提醒**（`agent-session.ts:3360-3367`）：

```
<system-reminder>
todo failed, so todo progress is not visible to the user.
Failure: ...
Fix the todo payload and call todo again before continuing.
</system-reminder>
```

**用户手改 todo 提醒**（`modes/controllers/todo-command-controller.ts:121-131`）：`"The user manually modified the todo list ({action})."`；删除时附加 `"Do NOT recreate or re-populate it unless the user explicitly asks…"`。

**系统提示词批处理规则**（`prompts/system/system-prompt.md:199-200`）：

```
- Update todos; skip trivial requests.
- Todo calls NEVER alone: batch each with turn's real calls (`init` with
  first reads/edits; `done` with next action/final verification).
  Todo-only assistant turn wastes round trip.
```

### 4.4 配置开关（`config/settings-schema.ts`）

| 键 | 默认 | 说明 |
|---|---|---|
| `todo.enabled` | `true` | todo 工具总开关 |
| `todo.reminders` | `true` | 停止前提醒完成 todo |
| `todo.remindersMax` | `3` | 提醒次数上限（可选 1/2/3/5） |
| `todo.eager` | `"default"` | `default`=不自动建 / `preferred`=首条消息建议 / `always`=强制 |
| `tasks.todoClearDelay` | `60`（秒） | 完成/放弃的 todo 从 widget 移除的延迟（仅显示层） |

### 4.5 TUI

- **Sticky HUD:** `modes/interactive-mode.ts:432` `TodoHudContainer`，可见性持久化于 transcript 自定义条目
- **`/todo` 命令:** 支持 `edit/copy/expand/collapse/export/import/append/start/done/drop/rm`（`slash-commands/helpers/todo.ts:119-131`）

---

## 5. 三方对比

### 5.1 机制覆盖矩阵

| 机制 | omo | slim | oh-my-pi |
|---|---|---|---|
| 空闲检测自动续跑 | ✅ 4 条链 | ✅ 1 条链 | ✅ 回合终止内建 |
| 续跑停滞/失败保护 | 停滞3 + 连败5 + 指数退避 | 指纹不变2次 | 提醒上限3次 |
| 用户取消尊重 | abort 窗口 + `/stop-continuation` | 外部 busy 重置 cap | 用户强制停止检测 |
| 等待用户回答检测 | pending question 工具 | `permission.asked` 抑制 | 问句线索识别 |
| 压缩后 todo 保活 | ✅ 快照恢复 + 晚到防护 | ❌ | ✅ transcript 重建（天然免疫） |
| 委派后 todo 提醒 | ✅ verification reminder | ❌ | ❌ |
| todo 写作规范注入 | ✅ 工具描述覆写 | prompt 规则（追加不替换） | ✅ 工具描述 + system prompt |
| 中途（turn 内）nudge | ❌ | ❌ | ✅ 变更计数 ≥12 |
| 强制先建 todo | ❌ | ❌ | ✅ eager prelude + prewalk 门 |
| todo 失败可见性 | ❌ | ❌ | ✅ 失败提醒 |
| 完成通知门控 | ✅ 有未完成不发完成通知 | ❌ | — |
| 注入合并协调 | senpi idle-injection-coordinator | 单来源无需 | 单来源无需 |

### 5.2 设计差异分析

**续跑判定的数据源分歧。** omo 与 slim 都从宿主 API 实时读（`client.session.todo` / SDK 三并发）；oh-my-pi 从 transcript 重建——压缩、fork、重启后状态天然一致，不需要 omo 那种专门的压缩保活 hook。transcript-as-truth 是用数据模型设计消除一整类同步 bug。

**"未完成"的定义分歧。** omo 把 `blocked` 也算完成（不再续跑）；slim 只认 `pending`/`in_progress`；oh-my-pi 的 `blocked` 任务永不自动晋升且不触发续跑。被阻塞任务是否应阻止 agent 停下，三家答案不同。

**防失控的分层。** omo 最厚：abort 窗口 → 冷却退避 → 连败上限 → 停滞检测 → 回合边界暂停 → 运行时停止命令，共六层。slim 只用"指纹不变 2 次"一层但间隔拉到 5 分钟。oh-my-pi 用提醒次数上限。共同结论：**无上限的自动续跑不可接受**，区别只在预算花在哪。

**prompt 与机制互知。** slim 的 system prompt 明示 "wake scheduler resumes you"，让模型敢在后台任务后结束回合；omo 的续跑 prompt 明示"系统在质疑你的完成声明"。提醒文本都假设模型会对抗——用对抗性措辞（"PROBABLY LYING"、"questioning your completion claim"）而非礼貌请求。

**粒度规范。** omo 用 `tool.definition` 覆写把写作规范（WHERE/WHY/HOW/RESULT、1-3 工具调用可完成）钉进工具描述本身，比 system prompt 更靠近行为发生点；oh-my-pi 则在工具描述里禁止"todo-only 回合"以省 round trip。

---

## 6. ZooKeeper 现状

ZooKeeper 已有自己的 todo 工具（pi 侧）与委派后提醒（双宿主），但没有自动续跑与主动卫生机制。

### 6.1 `todo` 工具（pi-only）

**位置:** `src/tools/todo.ts`（673 行）+ 状态机域 `src/core/todo/`（types / apply / store / nudge / serialize / view / summary / normalize，8 个模块 + 测试）。

- **数据模型与 oh-my-pi 对齐:** 五状态（`pending | in_progress | completed | abandoned | blocked`）+ 阶段分组（`src/core/todo/types.ts:13-25`）；九操作 `init | start | done | rm | drop | block | unblock | append | view`；任务以逐字 content 为身份键
- **单 op 单调用:** 一次调用一次状态迁移；无目标的 `done`/`drop`/`rm` 在工具边界被禁止，必须显式指定对象（`src/tools/todo.ts` 头部 docstring）
- **transcript 即事实来源:** 成功的变更调用把 `{op, phases}` 快照写进 tool-result details，重启/分支/压缩后由 `store.restoreFromHistory` 精确重建；内存 store 只是缓存；读写经 `store.serialize` 串行化门（`src/core/todo/store.ts`）
- **fail-closed 注册:** 宿主不提供 `todoStore` + `toolHost` 时工具不注册——OpenCode 上没有此工具，pi 上由 `src/pi.ts:901` 创建 per-session store（`config.toml` 的 `[zoo.mode.*].tools` 声明启用）

### 6.2 委派后提醒：`post-subagent-nudge`（双宿主）

**位置:** `src/hooks/post-subagent-nudge/hook.ts` + `src/core/checks.ts` + `src/core/todo/nudge.ts`。

**触发:** `subagent` 工具的 afterExec——OpenCode 走 `tool.execute.after`，pi 走 `tool_result` handler（compose 驱动，`src/registry.ts:159` 注册）。

**注入三段：**

1. **`VERIFY_REMINDER`**（`src/core/prompts.ts:61`）：对抗性验证提醒（"THE SUBAGENT JUST CLAIMED THIS TASK IS DONE. THEY ARE PROBABLY LYING."），要求读代码、跑检查、过门禁后才推进
2. **todo 三档提醒**——`decideTodoNudge` 纯函数（`src/core/todo/nudge.ts:42-68`）：
   - 空列表 → 不提醒
   - 无 active（全 completed/abandoned/blocked）→ `TODO_RESUME_NUDGE`
   - 恰好 1 in_progress + 0 pending → `TODO_DONE_NUDGE`
   - 其它 → `TODO_PROGRESS_NUDGE`（"UNMARKED TODO = UNTRACKED WORK = LOST PROGRESS"）
3. **plan 提醒**——`checkPlanProgress`（`src/core/checks.ts:52-98`）扫 `.zoo/plans/` 下 executing/done 计划，报进度或提示恢复

**todo 读取端口:** `resolveTodoSource`（`src/core/client/todo.ts:86-98`）唯一决定读取后端——host 注入的 store 优先，否则 `client.session.todo`（OpenCode），都没有则 fail-closed 跳过 todo 提醒（验证提醒与 plan 提醒不受影响）。pi 侧 client 为 `{}`，走 transcript store。

### 6.3 pi 侧 todo 视图

`src/pi.ts:1123-1140` `refreshTodoView`：从 per-session store 刷新 fleet widget 的 todo 缓存并触发重渲染，读失败保留上次良好视图。

### 6.4 没有的机制

- **自动续跑:** 无 `session.idle` / `agent_settled` 监听，agent 停下即停下
- **eager prelude / prewalk 门:** 不主动催建 todo，靠 system prompt 软指令
- **中途 nudge:** turn 内无 todo  freshness 检查
- **工具描述覆写 / 写作规范注入:** todo 工具描述是静态的
- **完成通知门控:** 无会话完成通知机制

---

## 7. 缺口对照

| 能力 | 外部最佳实现 | ZooKeeper 现状 | 差距 |
|---|---|---|---|
| todo 工具与状态模型 | oh-my-pi（transcript-as-truth） | 已对齐（pi 侧） | 无 |
| 委派后 todo 提醒 | omo verification reminder | 已有（三档 + VERIFY_REMINDER） | 无 |
| 自动续跑 | omo enforcer（六层防失控）/ oh-my-pi checkCompletion | 无 | **有** |
| 续跑防失控 | omo 停滞3+连败5+退避 | — | 随续跑引入 |
| 压缩保活 | omo preserver | transcript 恢复天然免疫（pi）；OpenCode 侧无 | 低 |
| 中途 nudge | oh-my-pi（变更≥12） | 无 | 中 |
| 写作规范注入 | omo 工具描述覆写 | 无 | 低 |
| eager prelude | oh-my-pi（todo.eager 三档） | 无 | 中 |
| 注入协调器 | senpi idle-injection-coordinator | 无（单来源） | 暂不需要 |

**若引入自动续跑，可复用的外部经验（按优先级）：**

1. **判定即读取**（三家一致）：续跑判定必须实时读 todo 状态，不信任模型的完成声明；ZooKeeper 的 `TodoSource` 端口已具备该能力
2. **防失控底线**：停滞检测（omo 的快照比较只认 `{id → status}` 变化）+ 次数上限 + 用户取消尊重（abort 窗口 / 问句检测）三者缺一不可
3. **prompt 与机制互知**（slim）：system prompt 告诉模型"停下会被唤醒"，避免模型为逃避续跑而不敢结束回合
4. **注入文本带状态摘要**（omo/senpi）：`[Status: 3/7 completed]` + 剩余任务列表，让续跑回合免于重新 `view`
5. **blocked 的语义要先定**：三家对"blocked 是否阻止停止"答案不一，ZooKeeper 的 `decideTodoNudge` 目前把 blocked 归为非 active，续跑设计需显式选择
