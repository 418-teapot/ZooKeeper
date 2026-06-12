# Todo Nudge 机制调研报告：编排器中的进度跟踪与行为引导

**版本:** 1.0  
**日期:** 2026-06-10  
**分类:** 技术架构文档 / Agent 行为塑形

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [问题定义](#2-问题定义)
3. [调研方法](#3-调研方法)
4. [oh-my-openagent 的实现](#4-oh-my-openagent-的实现)
5. [oh-my-opencode-slim 的实现](#5-oh-my-opencode-slim-的实现)
6. [机制分类与全景对比](#6-机制分类与全景对比)
7. [关键设计差异分析](#7-关键设计差异分析)
8. [ZooKeeper 的方案设计](#8-zookeeper-的方案设计)
9. [已知 Gap 与权衡](#9-已知-gap-与权衡)
10. [实施计划](#10-实施计划)
11. [总结](#11-总结)

---

## 1. 背景与动机

### 1.1 核心问题

在多 Agent 编排系统中，编排器（Orchestrator）将任务委托给子 Agent 执行。但编排器本身面临一个**进度跟踪困境**：

```
用户：实现 X 功能并添加集成测试

编排器创建 todo list：
  □ 实现 X 功能
  □ 添加集成测试

编排器委派子 Agent：
  task("实现 X 功能...")

子 Agent 完成 → 返回结果

编排器此时应该做什么？
  ① 验证子 Agent 的工作（build/test/lint）
  ② 标记第一个 todo 完成
  ③ 开始第二个 todo
```

实际观察发现，编排器经常在步骤 ① 上花费精力，但**忘记步骤 ②**，导致：
- todo list 状态过时
- 编排器可能重复执行已完成的任务
- 用户界面显示的进度与实际不符
- 编排器在任务切换时产生混乱

### 1.2 为什么这是个问题

**认知负荷视角**：编排器需要同时维护多个状态——当前验证结果、子 Agent 的 session ID、下一个任务的上下文、todo 的当前状态。LLM 容易在状态切换时丢失某个维度。

**行为惯性视角**：验证子 Agent 的工作是一个"显式"动作（运行测试命令），而标记 todo 是一个"显式但容易遗忘"的动作。LLM 倾向于完成当前正在做的事（验证），然后直接进入下一个委派，跳过"收尾"动作。

**进度可见性视角**：todo list 是用户观察编排器工作状态的主要入口。如果 todo 状态过时，用户对系统的信任度下降。

### 1.3 ZooKeeper 的现状

当前 ZooKeeper 的 build agent 在以下方面依赖"软指令"（prompt 中的文字描述）来引导编排器行为：

**build.md 第 16-23 行的 verify-iterate section**：
```
== Verify-Iterate Pattern (CRITICAL) ==
After subagent code changes, you MUST verify: build, tests, lint. If verification fails, resume the same subagent via task_id...

NO exceptions. Common rationalizations that are WRONG:
- "It's just a one-liner" — one-liners break builds
- "The subagent already tested it" — you must verify independently
- "The change is trivial" — trivial changes still need verification
- "Time pressure" — verification is faster than debugging a broken deploy
```

这个 section 要求编排器在委派后验证，但没有提及 todo 状态更新。且它作为静态 prompt 的一部分**每轮注入**，token 效率不高且容易在长会话中被 agent 忽略。

**build.md 第 1-14 行的角色定义**：
```
You are an orchestrator — a conductor, not a musician. You DELEGATE, VERIFY, and ITERATE.
```

这定义了编排器的职责，但缺乏"进度跟踪"这一维度的行为引导。

### 1.4 调研目标

在 `docs/agent-framework-comparison.md` 中提到，oh-my-openagent 和 oh-my-opencode-slim 都有关于 todo 的 hook。本次调研的目标是：

1. 研究业界成熟的 todo 提醒机制
2. 理解不同设计的取舍和风险
3. 为 ZooKeeper 设计一套适合的方案

---

## 2. 问题定义

将"编排器维护 todo 状态"这个需求拆解为具体场景：

### 2.1 场景 A：子 Agent 任务完成

```
时序：
  t0: build 调 task() → 委派子 Agent
  t1: 子 Agent 返回结果
  t2: build 验证结果（run build/test）
  t3: build 应该标记 todo 完成 ← 这里经常遗漏

问题：如何在 t1 后提醒 build 更新 todo？
```

### 2.2 场景 B：编排器直接编辑源码

```
时序：
  t0: build 判断"这个改动很小，自己改"
  t1: build 调 edit/write 修改了某个 src 文件
  t2: build 应该意识到违规 + 更新 todo
  t3: 或者更好的是撤销改动并重新委派

问题：如何识别 build 违规并提醒？违规后 todo 状态是否应该更新？
```

### 2.3 场景 C：编排器做完一轮工作

```
时序：
  t0: build 完成第一个 todo
  t1: todowrite 标记完成
  t2: build 开始思考下一步
  t3: build 调 bash 跑测试验证
  t4: build 调 read 看结果
  t5: 验证通过后，build 应该准备委派下一个 todo

问题：从 t1 到 t5，build 可能在多个工具调用中"迷失"，是否需要持续提醒？
```

### 2.4 场景 D：编排器在 todo 未完成时停止

```
时序：
  t0: build 完成了大部分 todo
  t1: build 认为"已经足够好了"，停止工作
  t2: 但实际上还有 2 个 todo 未完成

问题：如何检测并强制编排器继续？
```

---

## 3. 调研方法

### 3.1 调研对象

| 框架 | Todo 相关机制数 | 代码规模 |
|------|--------------|---------|
| **oh-my-openagent (OMO)** | 2 个独立机制 | Continuation Enforcer ~2061 行，Verification Reminder ~50 行 |
| **oh-my-opencode-slim (slim)** | 2 个独立机制 | todo-hygiene ~879 行，auto-continuation ~200 行 |

### 3.2 分析维度

1. **触发时机**：什么时候注入提醒？
2. **注入点**：在哪里注入？（工具输出 / 用户消息 / 系统消息）
3. **状态管理**：是否追踪 session 状态？
4. **文案风格**：温和引导还是强硬命令？
5. **覆盖场景**：能解决哪些场景？遗漏哪些？
6. **实现成本**：代码量、依赖的 API、复杂度

---

## 4. oh-my-openagent 的实现

### 4.1 Todo Continuation Enforcer

**位置**：`src/hooks/todo-continuation-enforcer/`  
**规模**：14 个文件，~2061 行代码  
**Hook 点**：`event` (`session.idle` / `session.error` / `session.compacted` / `session.deleted`)

#### 核心机制

```
event hook (session.idle)
  │
  ├─ Check: session 是否 idle + 有未完成 todos?
  │    └─ 否 → return
  │
  ├─ Check: last assistant message 是否问题?
  │    └─ 是 → return (等用户回答)
  │
  ├─ Check: 是否达到 maxContinuations 上限?
  │    └─ 是 → return
  │
  ├─ Check: 是否在 abort 抑制窗内?
  │    └─ 是 → return
  │
  ├─ Check: 是否有 pending injection?
  │    └─ 是 → return
  │
  ↓ 全部通过

Phase 1: 倒计时通知 (noReply=true)
  ┌─────────────────────────────────────────────┐
  │ ⎔ Auto-continue: 3 incomplete todos         │
  │   remaining — resuming in 3s — Esc×2 to     │
  │   cancel                                    │
  └─────────────────────────────────────────────┘
       ⋮ (3 秒)
Phase 2: 实际注入
  session.prompt() {
    text: "Incomplete tasks remain in your todo list.
           Continue working on the next pending task.
           - Proceed without asking for permission
           - Mark each task complete when finished
           - Do not stop until all tasks are done
           - If you believe all work is already complete,
             the system is questioning your completion claim.
             Critically re-examine each todo item from a
             skeptical perspective, verify the work was
             actually done correctly, and update the todo
             list accordingly."
  }
```

#### 关键代码

**constants.ts** — 提醒文案：
```typescript
export const CONTINUATION_PROMPT = `Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your
  completion claim. Critically re-examine each todo item from a skeptical
  perspective, verify the work was actually done correctly, and update the
  todo list accordingly.`;
```

**session-state.ts** — 状态管理：
```typescript
declare function setInterval(callback: () => void, delay?: number): TimerHandle

const SESSION_STATE_TTL_MS = 10 * 60 * 1000  // 10 分钟
const SESSION_STATE_PRUNE_INTERVAL_MS = 2 * 60 * 1000  // 每 2 分钟清理

function startPruneInterval(): void {
  setInterval(() => {
    const now = Date.now()
    for (const [sessionID, tracked] of sessions.entries()) {
      if (now - tracked.lastAccessedAt > SESSION_STATE_TTL_MS) {
        sessions.delete(sessionID)
      }
    }
  }, SESSION_STATE_PRUNE_INTERVAL_MS)
}
```

**handler.ts** — 事件处理：
```typescript
if (eventType === "session.deleted") {
  sessionStateStore.cleanup(sessionID)
}
```

#### 设计特点

1. **强硬语气**："the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective"
2. **自动触发**：不需要用户手动启用
3. **状态追踪**：记录已续接次数，防止无限循环
4. **安全门控**：5 个条件全部通过才触发
5. **可中断**：用户按 Esc×2 可取消
6. **Session TTL**：10 分钟后自动清理状态
7. **注入点**：`session.prompt()` — 在 session 级别注入，agent 无法拒绝

#### 解决的问题

- **场景 D**：编排器在 todo 未完成时停止
- 当 build agent "认为完成了"就停止，Continuation Enforcer 会强制它继续

#### 不解决的问题

- **场景 A**：子 Agent 任务完成后，如何立即提醒更新 todo？（依赖 Continuation Enforcer 兜底，但响应时间长）
- **场景 B**：编排器违规直接编辑后的提醒（不解决 todo 状态）
- **场景 C**：编排器在多个工具调用中迷失（只在 idle 时触发）

#### 实现代价

- **高代码量**：~2061 行，14 个文件
- **状态管理**：需要追踪续接次数、abort 窗、pending 状态
- **依赖多个 API**：`session.todo()`、`session.messages()`、`session.prompt()`

---

### 4.2 Standalone Verification Reminder

**位置**：`src/hooks/atlas/system-reminder-templates.ts`  
**规模**：~50 行（纯字符串模板）  
**Hook 点**：`tool.execute.after` (当 tool === "task" 时触发)

#### 核心机制

```
build 调 task()
  └─ general 返回结果

tool.execute.after (当 Atlas 检测到 task() 执行后)
  ↓
注入 StandaloneVerificationReminder 到 toolOutput.output
  ┌─────────────────────────────────────────────┐
  │ ---                                         │
  │ **VERIFICATION_REMINDER**                   │
  │                                             │
  │ **THE SUBAGENT JUST CLAIMED THIS TASK IS    │
  │ DONE. THEY ARE PROBABLY LYING.**            │
  │                                             │
  │ ...（Phase 1-4 的详细验证流程）              │
  │                                             │
  │ **STEP 5: CHECK YOUR PROGRESS DIRECTLY      │
  │ (EVERY TIME - NO EXCEPTIONS)**              │
  │ Do NOT rely on memory. Run `todoread` NOW.  │
  │                                             │
  │ **STEP 6: UPDATE TODO STATUS (IMMEDIATELY)**│
  │ RIGHT NOW - Do not delay.                   │
  │ Verification passed → Mark IMMEDIATELY.     │
  │                                             │
  │ **NO TODO = NO TRACKING = INCOMPLETE WORK.**│
  │ Use todowrite aggressively.                 │
  │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
  └─────────────────────────────────────────────┘
```

#### 关键代码

**system-reminder-templates.ts**：
```typescript
export const VERIFICATION_REMINDER = `**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE. THEY ARE PROBABLY LYING.**

Subagents say "done" when code has errors, tests pass trivially, logic is wrong,
or they quietly added features nobody asked for. This happens EVERY TIME.
Assume the work is broken until YOU prove otherwise.

---

**PHASE 1: READ THE CODE FIRST (before running anything)**
...

**PHASE 2: RUN AUTOMATED CHECKS**
...

**PHASE 3: HANDS-ON QA (MANDATORY for user-facing changes)**
...

**PHASE 4: GATE DECISION**
...`;
```

```typescript
export function buildStandaloneVerificationReminder(sessionId: string): string {
  return `
---

${buildVerificationReminder(sessionId)}

**STEP 5: CHECK YOUR PROGRESS DIRECTLY (EVERY TIME - NO EXCEPTIONS)**

Do NOT rely on memory or cached state. Run \`todoread\` NOW to see exact current state.
Count pending vs completed tasks. This is your ground truth for what comes next.

**STEP 6: UPDATE TODO STATUS (IMMEDIATELY)**

RIGHT NOW - Do not delay. Verification passed → Mark IMMEDIATELY.

1. Run \`todoread\` to see your todo list
2. Mark the completed task as \`completed\` using \`todowrite\`

**DO THIS BEFORE ANYTHING ELSE. Unmarked = Untracked = Lost progress.**

**STEP 7: EXECUTE QA TASKS (IF ANY)**
...

**STEP 8: PROCEED TO NEXT PENDING TASK**
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**NO TODO = NO TRACKING = INCOMPLETE WORK. Use todowrite aggressively.**`;
}
```

**tool-execute-after-subagent-completion.ts**（简化版）：
```typescript
export async function handleSubagentCompletionAfter(input) {
  if (input.toolInput.tool !== "task") return;

  // 检查是否 orchestrator session
  if (!(await resolveIsCallerOrchestrator(input.toolInput.sessionID))) return;

  // 注入 verification reminder
  input.toolOutput.output += `\n<system-reminder>\n${buildStandaloneVerificationReminder(
    resolvePreferredSessionId(preferredSessionId),
  )}\n</system-reminder>`;
}
```

#### 设计特点

1. **强硬语气**："THEY ARE PROBABLY LYING"、"THIS HAPPENS EVERY TIME"、"Assume the work is broken until YOU prove otherwise"
2. **反谄媚**：直接质疑子 Agent 的可靠性，强制编排器自己验证
3. **详细步骤**：Phase 1-4 的验证流程 + Step 5-8 的 todo 更新流程
4. **一次性注入**：只在 task() 返回时注入一次
5. **无状态**：不追踪 session 状态
6. **注入点**：`toolOutput.output` — 追加在子 Agent 返回结果后
7. **约 80 行**：整个 Phase 1-4 + Step 5-8 很长

#### 对比 Continuation Enforcer

| 维度 | Continuation Enforcer | Verification Reminder |
|------|----------------------|----------------------|
| **解决的问题** | 编排器在 todo 未完成时停止 | 编排器相信子 Agent 的完成声明 |
| **触发时机** | session 空闲时 | task() 工具返回时 |
| **Hook 点** | `event (session.idle)` | `tool.execute.after` |
| **频率** | 低频（只在空闲时触发） | 中/高频（每次 task() 返回） |
| **状态管理** | 有状态（续接次数、TTL） | 无状态 |
| **代码量** | ~2061 行 | ~50 行 |
| **注入点** | `session.prompt()` | `toolOutput.output` |
| **是否可被编排器拒绝** | 不可拒绝（session 级） | 可以被忽略（只是提示） |
| **包含 todo 更新指令** | ✅ | ✅ |

#### 解决的问题

- **场景 A**：子 Agent 任务完成后，立即提醒验证 + 更新 todo
- 在 task() 返回时一次性提供完整的验证流程和 todo 更新指令

#### 不解决的问题

- **场景 B**：编排器违规直接编辑（需要 Direct Work Reminder，见 4.3）
- **场景 C**：编排器跑完 bash/read 验证后更新 todo（Verification Reminder 已经附着在 task() 返回上，编排器看到验证流程时已经包含 todo 更新指令）
- **场景 D**：编排器在 todo 未完成时停止（依赖 Continuation Enforcer 兜底）

---

### 4.3 DIRECT_WORK_REMINDER

**位置**：`src/hooks/atlas/tool-execute-after-direct-work.ts`  
**规模**：~40 行  
**Hook 点**：`tool.execute.after` (当 tool 是 edit/write 时)

#### 核心机制

```
build 调 edit("src/app.ts", ...)
  └─ edit 返回成功

tool.execute.after (Atlas 检测)
  └─ 工具是 edit/write
  └─ 路径不在 exclude 列表中（排除 .opencode/、tests/scenarios/）
  ↓
注入 DIRECT_WORK_REMINDER 到 toolOutput.output
  ┌─────────────────────────────────────────────┐
  │ **DELEGATION REQUIRED** — You just edited   │
  │ a source file directly.                     │
  │                                             │
  │ Did you ACTUALLY need to be the one doing   │
  │ that?                                       │
  │                                             │
  │ - Tiny verification fix during subagent     │
  │   review → fine, continue.                  │
  │ - Anything else → **you violated            │
  │   orchestrator protocol.**                  │
  │                                             │
  │ **Atlas does not implement. Atlas           │
  │ orchestrates.**                             │
  └─────────────────────────────────────────────┘
```

#### 关键代码

```typescript
const ALLOWED_PATH_PATTERNS = [
  /\.opencode\//,       // opencode config
  /tests\/scenarios\//, // test scenarios
];

export async function handleDirectWorkToolAfter(input) {
  const toolName = input.toolInput.tool;
  if (toolName !== "edit" && toolName !== "write") return false;

  const filePath = input.toolOutput.metadata?.filePath ?? ...;

  // 允许配置路径
  if (ALLOWED_PATH_PATTERNS.some(p => p.test(filePath))) return false;

  input.toolOutput.output += DIRECT_WORK_REMINDER;
  return true;
}
```

#### 设计特点

1. **强硬但保留例外**：允许"小型验证修正"，但禁止其他
2. **自我评估**：引导编排器自己判断是否违规
3. **允许 edit/write**：不在权限层禁止，因为 Atlas 偶尔需要验证修正
4. **路径排除**：配置文件和测试场景文件允许编辑

#### 解决的问题

- **场景 B**：编排器违规直接编辑
- 在违规发生时立即警告编排器
- 不解决 todo 状态问题（这是 gap）

---

## 5. oh-my-opencode-slim 的实现

### 5.1 Auto-continuation

**位置**：`src/hooks/todo-auto-continuation`  
**规模**：~879 行  
**Hook 点**：`event (session.idle)` + `command.execute.before (/auto-continue)`

#### 核心机制

```
与 OMO 的 Continuation Enforcer 类似，但是:

1. opt-in 默认关闭
   - 需要通过 /auto-continue 命令启用
   - 或通过 auto_continue 工具让 LLM 自动开启

2. 6 重门控（全部通过才触发）
   ① enabled === true
   ② 有未完成 todos (session.todo() API)
   ③ last assistant message 不是问句
   ④ 续接次数 < maxContinuations (默认 5)
   ⑤ 不在 abort 抑制窗 (5s)
   ⑥ 无 pending timer

3. 可配置
   - maxContinuations: 最多连续自动续接次数
   - cooldownMs: 倒计时毫秒
   - autoEnable: 是否根据 todo 数量自动启用
   - autoEnableThreshold: todo 数量阈值

4. 两阶段注入
   - Phase 1: 倒计时通知 (noReply=true)
   - Phase 2: 3s 后 session.prompt() 注入 continuation prompt

5. 文案温和
   "... if you need to ask a question or make a deliberate pause, ask the
   user directly. Otherwise, proceed without confirmation."
```

#### 关键代码

**index.ts**：
```typescript
const CONTINUATION_PROMPT =
  '[Auto-continue: enabled - there are incomplete todos remaining. Continue with the next uncompleted item. Press Esc to cancel. If you need to ask a question or make a deliberate pause, ask the user directly. Otherwise, proceed without confirmation.]';

// 6 重门控
if (!state.enabled) return;
if (!hasIncompleteTodos) return;
if (lastAssistantIsQuestion) return;
if (consecutiveContinuations >= maxContinuations) return;
if (inAbortSuppression) return;
if (pendingTimer) return;  // 已有等待注入的 reminder
```

#### 与 OMO Continuation Enforcer 的对比

| 维度 | OMO | slim |
|------|-----|------|
| **启用方式** | 默认启用 | opt-in 默认关闭 |
| **门控数量** | 5 重 | 6 重 |
| **状态管理复杂度** | 高（14 文件，~2061 行） | 低（单文件，~879 行） |
| **可中断性** | Esc×2 | Esc 取消 |
| **连续次数限制** | 是（maxContinuations） | 是（maxContinuations） |
| **文案语气** | 强硬 | 温和 |
| **Session TTL** | 10 分钟自动清理 | 无（session 级 state） |

#### 解决的问题

- **场景 D**：编排器在 todo 未完成时停止
- 与 OMO 相同，但更可控（opt-in + 可配置）

---

### 5.2 Todo Hygiene

**位置**：`src/hooks/todo-hygiene`  
**规模**：~207 行  
**Hook 点**：`tool.execute.after (todowrite → 任意非 IGNORE 工具)` + `messages.transform (注入)`

#### 核心机制

```
build 调 todowrite
  └─ arming: sessionID 进入 "armed" 集合

build 调任意工具（非 read/glob/grep）
  └─ checking: sessionID 在 armed 集合中
  └─ inject: 将 todo nudge 注入

build 再次调 todowrite
  └─ 重置 armed 状态（新的 cycle 开始）
```

#### 状态机

```typescript
type TodoState = "idle" | "armed" | "fired";

interface SessionState {
  state: TodoState;
  lastArmedAt: number;  // 最后一次 arm 的时间
}
```

#### 注入点选择

slim 使用 `messages.transform` 而不是 `tool.execute.after`，原因是：

```
tool.execute.after (todowrite arm):
  todo-hygiene: armed = true
  return

tool.execute.after (edit call):
  todo-hygiene: 检查 armed，如果是则注入到 toolOutput.output
  return

问题：toolOutput.output 会被 compaction 吞掉

messages.transform (每次 LLM turn 前):
  if sessionID 在 armed 集合中:
    在最后一条 user message 注入 todo nudge
    (重写而非追加，天然去重)
  return

优势：reminder 永远可见，不会被 compaction 吞掉
```

#### 两种 reminder 文案

```typescript
// General reminder（多个未完成任务）
const GENERAL_REMINDER = `
TODO: You modified files but didn't update the todo list.
Use todowrite to mark the current status of your task.
`；

// Final active reminder（只剩最后一个 in_progress，没有 pending）
const FINAL_ACTIVE_REMINDER = `
TODO: Your active task is still in_progress.
If you're finishing the work, mark it completed.
If you're starting new work, mark it pending.
`;
```

#### 关键代码

**index.ts**：
```typescript
const TODO_TOOLS = new Set(["todowrite", "todoread"]);
const IGNORE_TOOLS = new Set(["read", "glob", "grep", "bash"]);

export function createTodoHygieneHook(): HookHandlers {
  const armedSessions = new Map<string, SessionState>();

  return {
    "tool.execute.after": async (input, output) => {
      const toolName = input.tool.toLowerCase();

      // todowrite: arm 状态
      if (TODO_TOOLS.has(toolName)) {
        armedSessions.set(input.sessionID, {
          state: "armed",
          lastArmedAt: Date.now(),
        });
        return;
      }

      // 非 ignored 工具：检查并 fire
      if (!IGNORE_TOOLS.has(toolName)) {
        const session = armedSessions.get(input.sessionID);
        if (session?.state === "armed") {
          session.state = "fired";  // 一次性消费
        }
      }
    },

    "messages.transform": async (output) => {
      if (!output.messages?.length) return;

      const lastUserMessage = output.messages.findLast(
        m => m.info.role === "user"
      );

      if (!lastUserMessage) return;

      const sessionId = lastUserMessage.info.id;
      const session = armedSessions.get(sessionId);

      if (!session || session.state !== "fired") return;

      // 获取 todo 状态
      const todos = await ctx.client.session.todo({ path: { id: sessionId } });

      const inProgressCount = todos.filter(t => t.status === "in_progress").length;
      const pendingCount = todos.filter(t => t.status === "pending").length;
      const isFinalActive = inProgressCount === 1 && pendingCount === 0;

      const reminder = isFinalActive ? FINAL_ACTIVE_REMINDER : GENERAL_REMINDER;

      // 注入到 user message（重写而非追加）
      lastUserMessage.parts.push({
        type: "text",
        text: `<system-reminder type="todo-hygiene">${reminder}</system-reminder>`,
      });

      // 清理状态
      armedSessions.delete(sessionId);
    },

    "session.deleted": async (input) => {
      armedSessions.delete(input.sessionID);
    },
  };
}
```

#### 设计特点

1. **状态机**：追踪 armed/fired/idle 状态
2. **持久 reminder**：reminder 在整个 turn 内一直存在，直到下一次 todowrite 或 session.deleted
3. **注入点**：`messages.transform` — 每 turn 在 user message 注入（不是 `tool.execute.after`）
4. **天然去重**：重写而非追加
5. **API 调用**：`session.todo()` 获取精确状态
6. **Session 清理**：监听 `session.deleted` 清理事态

#### 解决的问题

- **场景 C**：编排器在多个工具调用中迷失
- 当编排器刚调过 todowrite，后续做其他工作时，每次 LLM turn 都给一个 gentle reminder

#### 不解决的问题

- **场景 A**：子 Agent 任务完成（不是 todowrite 触发的状态机）
- **场景 B**：编排器违规直接编辑（违规路径不在 todowrite 的 armed 状态中）
- **场景 D**：编排器在 todo 未完成时停止（依赖 auto-continuation 兜底）

---

## 6. 机制分类与全景对比

### 6.1 按问题分类

| 场景 | OMO 解决方案 | slim 解决方案 | 触发机制 |
|------|------------|-------------|---------|
| **A. 子 Agent 任务完成** | Verification Reminder | todo-hygiene（不直接，但 task() 返回后会做其他工具调用） | task() 返回 / 任意工具返回 |
| **B. 编排器违规直接编辑** | Direct Work Reminder (无 todo 提醒) | post-file-tool-nudge（含 Read） | edit/write 返回 |
| **C. 编排器做完一轮工作** | Continuation Enforcer（延迟纠正） | todo-hygiene（持续提醒） | session.idle / 任意工具返回 |
| **D. 编排器在 todo 未完成时停止** | Continuation Enforcer | Auto-continuation | session.idle |

### 6.2 按注入点分类

| 注入点 | 代表机制 | 优势 | 风险 |
|--------|---------|------|------|
| `toolOutput.output` | Verification Reminder, Direct Work Reminder | 简单，不污染用户消息 | 可能被 compaction 吞掉 |
| `session.prompt()` | Continuation Enforcer, Auto-continuation | 不可拒绝，强制编排器行为 | 可能被 agent 忽略（只是 prompt） |
| `messages.transform` (user message) | todo-hygiene, phase-reminder | 每 turn 重写，天然去重 | 需要新 hook 点 + 状态管理 |

### 6.3 按状态管理分类

| 状态量 | 代表机制 | 代码复杂度 |
|--------|---------|-----------|
| **无状态** | Verification Reminder (~50 行), Direct Work Reminder (~40 行), phase-reminder (~90 行) | 低 |
| **轻状态** | todo-hygiene (~207 行) | 中 |
| **重状态** | Continuation Enforcer (~2061 行), Auto-continuation (~879 行) | 高 |

### 6.4 全景机制表

将所有发现的机制放在一起：

| # | 机制 | 来自 | 解决的问题 | Hook 点 | 状态管理 | 代码量 |
|---|------|------|-----------|---------|---------|--------|
| 1 | Continuation Enforcer | OMO | D (idle) | `event (session.idle)` | 重（TTL、续接次数） | ~2061 |
| 2 | Standalone Verification Reminder | OMO | A (验证 + todo) | `tool.execute.after (task)` | 无 | ~50 |
| 3 | DIRECT_WORK_REMINDER | OMO | B (违规) | `tool.execute.after (edit/write)` | 无 | ~40 |
| 4 | Auto-continuation | slim | D (idle) | `event (session.idle)` + `command.execute.before` | 重（6 重门控） | ~879 |
| 5 | Todo Hygiene | slim | C (做完工作后 todo) | `tool.execute.after (todowrite)` + `messages.transform` | 中（armed/fired） | ~207 |
| 6 | Phase Reminder | slim | 委派流程提示 | `messages.transform` | 无 | ~92 |

---

## 7. 关键设计差异分析

### 7.1 注入点哲学

**OMO 的选择：`toolOutput.output`**

```
优势:
  - 简单：直接追加字符串
  - 不污染用户消息（用户看不到）
  - 符合"工具输出是 agent 的内部信息"原则

风险:
  - compaction 会压缩旧的 toolOutput
  - 如果编排器做了很多工具调用，早期的 reminder 可能被压缩
  - 编排器可能在长会话中"忘记"早期看到的提醒
```

**slim 的选择：`messages.transform` (user message)**

```
优势:
  - 每 turn 重写：reminder 永远可见
  - 天然去重：多次工具调用只保留一份 reminder
  - 编排器每次决策都能看到提醒
  - 不会被 compaction 吞掉（因为是 user message 的一部分）

风险:
  - 需要新的 hook 点（messages.transform）
  - 需要状态管理（armed/fired）
  - 污染用户消息（用户可以在聊天界面看到）
  - 代码复杂度中等
```

**ZooKeeper 的选择**：

基于"声明式、可预测、轻量"的设计哲学，选择 **OMO 风格的 `toolOutput.output`**，因为：
- 保持简单（无状态）
- 不引入新的 hook 点依赖（messages.transform）
- 与现有的 `tool.execute.after` handler 链兼容
- 如果 reminder 被 compaction 吞掉，后续的 Continuation Enforcer（P1）会兜底

### 7.2 状态管理哲学

**OMO**：为每个需要追踪的机制都建立完整的状态管理系统
- Continuation Enforcer: 14 文件，~2061 行，TTL、续接次数、abort 抑制窗
- 好处：完整覆盖各种边界情况
- 代价：维护成本高，状态可能泄漏

**slim**：每个机制尽量精简状态
- todo-hygiene: ~207 行，armed/fired 状态机
- auto-continuation: ~879 行，复用 session 级 state
- 好处：代码量适中
- 代价：边界情况可能漏掉

**ZooKeeper**：无状态优先
- 每个机制尽量无状态
- 如果必须有状态，使用 session 级 Map + 监听 `session.deleted` 清理
- 好处：代码量小，bug 少
- 代价：某些边界情况无法覆盖（如 compaction 吞掉 reminder）

### 7.3 Orchestrator 直接 edit 的处理

**OMO (Atlas)**：
- 允许 edit/write（权限层不禁止）
- 事后警告：注入 DIRECT_WORK_REMINDER
- 允许"小型验证修正"，但禁止其他
- Atlas 偶尔需要编辑 `.omo/` 下的 plan 文件

**slim (orchestrator)**：
- 允许 edit/write（orchestrator 本身可以做实现工作）
- post-file-tool-nudge 在 Read/Write 后注入 workflow reminder
- 不限制"违规"，而是持续提醒委派流程

**ZooKeeper (build)**：
- 选择 OMO 风格（允许 edit/write，hook 层警告违规）
- build agent 与 OMO Atlas 角色类似（"conductor, not musician"）
- 配置路径（`.opencode/`, `tests/scenarios/`) 允许编辑

### 7.4 文案风格

**OMO**：强硬、质疑、命令式
```
"THEY ARE PROBABLY LYING"
"NO EXCEPTIONS"
"DO THIS BEFORE ANYTHING ELSE"
"the system is questioning your completion claim"
```

**slim**：温和、陈述、鼓励式
```
"if the active task changed or finished, update the todo list"
"if you need to ask a question... ask the user directly"
"Proceed without confirmation."
```

**ZooKeeper 的选择**：强硬风格（OMO 风格）
- "THE SUBAGENT JUST CLAIMED THIS TASK IS DONE. THEY ARE PROBABLY LYING."
- "DELEGATION REQUIRED — You just edited a source file directly."
- "!IMPORTANT! Remember your role: orchestrate, don't implement."
- 强硬语气在长会话中更容易"穿透" LLM 的行为惯性

---

## 8. ZooKeeper 的方案设计

### 8.1 总体架构

四个机制，分两个优先级：

```
P0 (本次实现):
  ┌─────────────────────────────────────────┐
  │ 1. Post-task Nudge    ✅ 已实现          │  解决 A (子 Agent 完成后)
  │ 2. Direct Work Reminder ✅ 已实现        │  解决 B (违规编辑)
  │ 3. Focus Reminder     ✅ 已实现          │  解决每 turn 委派提示
  └─────────────────────────────────────────┘

P1 (后续):
  ┌─────────────────────────────────────────┐
  │ 4. Idle Continuation  ❌ 未实现 (P1)    │  解决 D (idle 时强制续接)
  └─────────────────────────────────────────┘
```

### 8.2 机制 1: Post-task Nudge ✅ 已实现

**位置**: `src/hooks/post-task-nudge/`  
**触发条件**: `tool === "task"`
**作用**: 从 build.md 拆出 verify-iterate section，在 task() 返回时注入 verify + todo nudge
**Hook 点**: `tool.execute.after`

#### 设计决策

1. **合并 verify-iterate 和 todo nudge**: 子 Agent 完成后既需要验证也需要更新 todo，合并为一个 nudge
2. **API 查询 todo 状态**: 区分 general / final_active reminder
3. **注入到 toolOutput.output**: 与 OMO 一致，不污染 user message

#### 代码设计

```typescript
// src/hooks/post-task-nudge/hook.ts

const VERIFY_REMINDER = `
**VERIFY NOW — NO EXCEPTIONS**

Run build, tests, and lint to verify the subagent's work.
- "The subagent already tested it" — you must verify independently
- "It's just a one-liner" — one-liners break builds
- "The change is trivial" — trivial changes still need verification
- If verification fails: resume the same task_id to fix it
`;

const TODO_GENERAL = `
**TODO UPDATE REQUIRED — DO THIS NOW**

A subagent just completed work. Before proceeding, mark finished items as
\`completed\` and set the next item to \`in_progress\`.
Unmarked = Untracked = Lost progress.
`;

const TODO_FINAL_ACTIVE = `
**TODO UPDATE REQUIRED — LAST TASK STILL in_progress**

1 task remains \`in_progress\`, 0 \`pending\`. A subagent just finished work.
Mark it \`completed\` now, or move unfinished items back to \`pending\`.
Stale status = Invisible work = Forgotten work.
`;

export async function nudgePostTask(
  ctx: any,
  input: { tool: string; sessionID: string },
  output: { output?: string },
): Promise<void> {
  const tool = input.tool.toLowerCase();
  if (tool !== "task") return;
  if (!output.output) return;

  // 注入 verify reminder
  output.output += VERIFY_REMINDER;

  // 查询 todo 状态（API），判断 general / final_active
  let todos: Array<{ status: string }> = [];
  try {
    const response = await ctx.client.session.todo({ path: { id: input.sessionID } });
    todos = response.data?.todos || [];
  } catch {
    // todo API 失败不影响 verify reminder
  }

  const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  const isFinalActive = inProgressCount === 1 && pendingCount === 0;

  const todoReminder = isFinalActive ? TODO_FINAL_ACTIVE : TODO_GENERAL;
  output.output += todoReminder;
}
```

#### build.md 变更

删除第 16-17 行（verify-iterate section）：

```toml
# 删除的内容：
== Verify-Iterate Pattern (CRITICAL) ==
After subagent code changes, you MUST verify: build, tests, lint. If verification fails, resume the same subagent via task_id with the error output and correction facts (max 5 rounds). Stop when it passes, or report to the user on max iterations / repeated errors.
```

#### 测试矩阵

| 场景 | 期望行为 |
|------|---------|
| task() 返回 + todos 有多个 in_progress | 注入 verify + TODO_GENERAL |
| task() 返回 + todos 有 1 个 in_progress, 0 pending | 注入 verify + TODO_FINAL_ACTIVE |
| task() 返回 + todos 全部 completed | 注入 verify，跳过 todo nudge |
| task() 返回 + API 失败 | 注入 verify + TODO_GENERAL（fallback） |
| 非 task() 工具 | 不注入 |
| output.output 为 null | 不注入 |
| 连续两次 task() 调用 | 每次都注入（无状态，不去重） |

---

### 8.3 机制 2: Direct Work Reminder ✅ 已实现

**位置**: `src/hooks/direct-work-nudge/`  
**触发条件**: `tool === ("edit" | "write")` 且路径不在排除列表
**作用**: 警告编排器违规直接编辑
**Hook 点**: `tool.execute.after`

#### 设计决策

1. **允许 edit/write**：不在权限层禁止，因为 build agent 偶尔需要验证修正
2. **路径排除**：配置文件和测试场景路径允许编辑
3. **不合并 todo nudge**：OMO 风格的 Direct Work Reminder 不包含 todo 提醒（todo 问题由 Idle Continuation 兜底）

#### 代码设计

```typescript
// src/hooks/direct-work-reminder/hook.ts

const ALLOWED_PATH_PATTERNS = [
  /\.opencode\//,       // opencode config
  /tests\/scenarios\//, // test scenarios
];

const DIRECT_WORK_REMINDER = `
**DELEGATION REQUIRED** — You just edited a source file directly.

Did you ACTUALLY need to be the one doing that?

- Tiny verification fix during subagent review → fine, continue.
- Anything else → **you violated orchestrator protocol.**
  Revert the change and delegate it via \`task()\`.

**Build does not implement. Build orchestrates.**
`;

export function remindDirectWork(
  _ctx: any,
  input: { tool: string; sessionID: string },
  output: { output?: string; metadata?: { filePath?: string } },
): void {
  const tool = input.tool.toLowerCase();
  if (tool !== "edit" && tool !== "write") return;
  if (!output.output) return;

  const filePath = output.metadata?.filePath || "";

  if (ALLOWED_PATH_PATTERNS.some((p) => p.test(filePath))) return;

  output.output += DIRECT_WORK_REMINDER;
}
```

#### 测试矩阵

| 场景 | 期望行为 |
|------|---------|
| edit() 编辑 `.opencode/config.json` | 不注入（路径排除） |
| edit() 编辑 `tests/scenarios/build-delegate.json` | 不注入（路径排除） |
| edit() 编辑 `src/app.py` | 注入违规提醒 |
| write() 创建 `src/utils.py` | 注入违规提醒 |
| 非 edit/write 工具 | 不注入 |
| output.output 为 null | 不注入 |

---

### 8.4 机制 3: Focus Reminder ✅ 已实现（原名 Phase Reminder）

**位置**: `src/hooks/focus-reminder/`
**触发条件**: 每 LLM turn（`experimental.chat.messages.transform` hook）
**作用**: 在最后一条 user message 注入委派流程提示
**Hook 点**: `experimental.chat.messages.transform`

> **实现说明**: 实现时更名为 **Focus Reminder**（语义更准确：提醒保持聚焦，避免与"phase"概念混淆）。Agent 名称通过 `lastUserMsg.info.agent` 读取，不存在时 fallback 到 `client.getSession(sessionId)`。实现为无状态，每 turn 重新注入自然去重。

#### 设计决策

1. **仅 build agent**：其他 agent（explore/general/spider）不需要委派提示
2. **每 turn 注入一次**：不是每次工具调用后都注入
3. **天然去重**：重写而非追加，防止多次注入累积
4. **温和但明确**：3 行简洁的委派流程提示

#### 代码设计

```typescript
// src/hooks/phase-reminder/hook.ts

const PHASE_REMINDER = `
!IMPORTANT! Remember your role: orchestrate, don't implement.
Understand the request → choose the right agent → delegate via task()
→ verify the result.
If delegating, launch the specialist in this turn !END!
`;

export function injectPhaseReminder(
  _ctx: any,
  input: { event: Message },
): void {
  if (!input.event.messages?.length) return;

  // 找到最后一条 user message
  const lastUserMessage = input.event.messages.findLast(
    (m) => m.role === "user"
  );

  if (!lastUserMessage) return;

  // 检查 agent 是否是 build（编排器）
  const agentName = lastUserMessage.agent;
  if (agentName !== "build") return;

  // 注入 reminder（重写最后一条 user message 的 content）
  lastUserMessage.content = `!INTERNAL_REMINDER!\n${PHASE_REMINDER}\n\n${lastUserMessage.content}`;
}
```

#### 测试矩阵

| 场景 | 期望行为 |
|------|---------|
| 每 LLM turn + agent=build | 注入 reminder |
| agent=general/explore/spider | 不注入 |
| 无 user message | 不注入 |
| 连续 10 次 LLM turn | 每次注入一次，但每次都重写（天然去重） |

---

### 8.5 机制 4: Idle Continuation (P1) ❌ 未实现

**触发条件**: `session.idle`（编排器空闲）
**作用**: 当编排器在 todo 未完成时停止，强制续接
**Hook 点**: `event (session.idle)` + `command.execute.before (/auto-continue)`

#### 设计决策

1. **opt-in 默认关闭**：借鉴 slim，让用户决定是否需要自动续接
2. **6 重门控**：enabled + incomplete todos + 非问句 + 次数上限 + abort 窗 + 无 pending timer
3. **3s 倒计时**：给用户取消的机会
4. **强硬语气**：借鉴 OMO

#### API 依赖

- `session.todo()` 获取 todo 列表
- `session.messages()` 检查最后消息
- `session.prompt()` 注入续接 prompt

#### 实现时机

P1，本次不实现。原因：

1. **复杂度高**：需要状态管理、timer、session 级状态追踪
2. **opt-in 机制**：需要 `/auto-continue` 命令和 `auto_continue` 工具
3. **依赖前三个机制先稳定**：如果 build agent 频繁在 todo 未完成时停止，再考虑实现

#### 代码量预估

~350 行 hook + ~500 行测试

---

### 8.6 共享模块 ✅ 已实现

**位置**: `src/hooks/shared/todo-nudge.ts`

为了在机制 1 和 2 中复用 todo 查询逻辑，引入共享模块：

```typescript
// src/hooks/shared/todo-nudge.ts

import type { OpenCodePluginContext } from "@opencode-ai/plugin";

export interface TodoItem {
  status: "in_progress" | "pending" | "completed";
}

export async function getTodoState(
  ctx: OpenCodePluginContext,
  sessionID: string,
): Promise<{ todos: TodoItem[]; inProgressCount: number; pendingCount: number }> {
  const response = await ctx.client.session.todo({ path: { id: sessionID } });
  const todos = response.data?.todos || [];
  const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  return { todos, inProgressCount, pendingCount };
}

export const TODO_GENERAL = `
**TODO UPDATE REQUIRED — DO THIS NOW**
A subagent just completed work. Before proceeding, mark finished items as
\`completed\` and set the next item to \`in_progress\`.
Unmarked = Untracked = Lost progress.
`;

export const TODO_FINAL_ACTIVE = `
**TODO UPDATE REQUIRED — LAST TASK STILL in_progress**
1 task remains \`in_progress\`, 0 \`pending\`. A subagent just finished work.
Mark it \`completed\` now, or move unfinished items back to \`pending\`.
Stale status = Invisible work = Forgotten work.
`;
```

---

### 8.7 src/index.ts 变更 ✅ 已实现

当前 `src/index.ts` 已注册以下 handler 链（含全部三个 P0 机制）：

```typescript
// tool.execute.after hook (tool-output 注入：Mechanism 1 + 2)
const handlers = [
  (i, o) => nudgeTaskOutput(i, o, limits),   // task prompt nudge
  recoverJsonError,                            // JSON error recovery
  nudgeDirectWork,                             // Mechanism 2
  (i, o) => nudgePostTask(client, i, o),      // Mechanism 1
];

// experimental.chat.messages.transform hook (user-message 注入：Mechanism 3)
await injectFocusReminder(client, output);    // Focus Reminder
```

---

## 9. 已知 Gap 与权衡

### 9.1 Gap: 编排器做完 bash/read 验证后的 todo 提醒

**场景**：

```
build 调 todowrite (标记 in_progress)
build 调 task() 委派子 Agent
  └─ ✅ 子 Agent 返回，注入 post-task nudge (含 verify + todo)
build 调 bash 跑验证命令
  └─ ❌ 没有 todo 提醒
build 调 read 看验证结果
  └─ ❌ 没有 todo 提醒
build 验证通过，应该标记 todo 完成
  └─ ❌ 编排器可能忘了 todo 状态
```

**slim 的解法**：todo-hygiene 状态机，todowrite arm + 任意工具 fire

**OMO 的解法**：不处理，依赖 Continuation Enforcer 延迟纠正

**ZooKeeper 的选择（P0）**：不处理，依赖 P1 的 Idle Continuation 兜底

### 9.2 权衡：状态管理 vs. 无状态

**选择无状态的代价**：

- reminder 可能被 compaction 吞掉（OMO 风格的问题）
- 某些边界情况无法覆盖（编排器跑 bash/read 后迷失）

**选择无状态的收益**：

- 代码量小（~295 行 hook vs slim 的 ~1178 行 = todo-hygiene + auto-continuation）
- bug 风险低（状态可能泄漏）
- 符合 ZooKeeper "轻量"的设计哲学

### 9.3 权衡：messages.transform vs. tool-output

**选择 tool-output 的代价**：

- reminder 可能不持久（compaction 后消失）
- 编排器可能在长会话中"忘记"早期看到的提醒

**选择 tool-output 的收益**：

- 不需要新的 hook 点（messages.transform）
- 不引入新的状态管理
- 与现有的 handler 链兼容

**Phase Reminder 例外**：

- Phase Reminder 使用 `messages.transform` 注入 user message
- 因为是每 turn 注入（天然去重），所以即使使用 messages.transform 也不需要状态管理
- 与 post-task / direct-work 的工具输出注入形成互补

### 9.4 待观测的行为模式

实施 P0 后，需要观测以下行为模式，作为是否实施 P1 的依据：

```
观测点:
  - build agent 在 todo 未完成时停止的比例
  - build agent 违规编辑源文件的频率
  - build agent 在 todo 更新上的遗漏率

决策逻辑:
  - 如果 build agent 频繁在 todo 未完成时停止 → 优先实施 P1 (Idle Continuation)
  - 如果 build agent 违规编辑频率高 → 考虑权限层禁止 edit/write
  - 如果 todo 更新遗漏率高 → 考虑引入 slim 风格的 todo-hygiene
```

---

## 10. 实施计划

### 10.1 P0 文件清单

| 文件 | 操作 | 行数 (hook/test) |
|------|------|----------------|
| `core/prompts/build.md` | 删除 verify-iterate section (-8 行) ✅ | — |
| `src/hooks/shared/todo-nudge.ts` | **新建** ✅ | 40 / — |
| `src/hooks/post-task-nudge/hook.ts` | **新建** ✅ | 80 / 300 |
| `src/hooks/post-task-nudge/index.ts` | **新建** ✅ | 5 / — |
| `src/hooks/direct-work-nudge/hook.ts` | **新建** ✅ | 50 / 200 |
| `src/hooks/direct-work-nudge/index.ts` | **新建** ✅ | 5 / — |
| `src/hooks/focus-reminder/hook.ts` | **新建** ✅（原名 phase-reminder） | 90 / 150 |
| `src/hooks/focus-reminder/index.ts` | **新建** ✅（原名 phase-reminder） | 5 / — |
| `src/index.ts` | 修改 ✅ | 20 / — |
| **总计** | | ~295 / ~650 |

### 10.2 P0 实施顺序

```
Phase 1: 基础设施
  ✅ 已实现 — 创建 shared/todo-nudge.ts (TODO_GENERAL, TODO_FINAL_ACTIVE, getTodoState)
  ✅ 已实现 — 修改 src/index.ts (handler 链支持 async、支持 ctx 传递)

Phase 2: 机制 3 - Focus Reminder (messages.transform 注入)
  ✅ 已实现 — 创建 src/hooks/focus-reminder/（实现时更名）
  ✅ 已实现 — 在 src/index.ts 注册 experimental.chat.messages.transform hook
  ✅ 已实现 — 验证：每次 LLM turn 都注入 reminder（仅 build agent）

Phase 3: 机制 2 - Direct Work Reminder
  ✅ 已实现 — 创建 src/hooks/direct-work-nudge/
  ✅ 已实现 — 在 src/index.ts 注册 tool.execute.after hook
  ✅ 已实现 — 验证：非配置路径的 edit/write 注入违规提醒

Phase 4: 机制 1 - Post-task Nudge
  ✅ 已实现 — 创建 src/hooks/post-task-nudge/
  ✅ 已实现 — 修改 build.md 删除 verify-iterate section
  ✅ 已实现 — 在 src/index.ts 注册 tool.execute.after hook
  ✅ 已实现 — 验证：task() 返回后注入 verify + todo nudge
```

### 10.3 验证方法

```bash
# 单元测试
./test.sh

# Lint + format
./check.sh

# 端到端测试（需要真实 LLM）
# 观察 build agent 的实际行为：
#   - 是否在 task() 后验证
#   - 是否在 task() 后更新 todo
#   - 是否避免违规编辑源文件
```

### 10.4 P1 待办 ❌ 未实现

```
□ 机制 4: Idle Continuation
   - 实现 /auto-continue 命令
   - 实现 auto_continue 工具（LLM 自动开启）
   - 6 重门控
   - 3s 倒计时 + Esc 取消
   - 续接次数限制
   - abort 抑制窗
   - session 级状态管理
   - Session TTL 清理
   - 测试：各种边界情况

预估代码量：~350 行 hook + ~500 行测试
```

---

## 11. 总结

### 11.1 核心发现

**三家对比**：

| 框架 | Todo 相关机制数 | 代码规模 | 注入点风格 | 状态管理 |
|------|--------------|---------|-----------|---------|
| OMO | 3 个 | ~2150 行 | `toolOutput.output` | 重（TTL、续接次数） |
| slim | 3 个 | ~1178 行 | `messages.transform` | 中（armed/fired） |
| ZooKeeper (P0) | 3 个 | ~295 行 | 混合（`toolOutput` + `messages.transform`） | 无 |

### 11.2 设计原则

ZooKeeper 方案遵循以下原则：

1. **无状态优先**：每个机制尽量无状态，减少 bug 风险
2. **强硬语气**：借鉴 OMO 的质疑式提醒（"THEY ARE PROBABLY LYING"）
3. **混合注入点**：
   - 工作类提醒（verify、违规警告）注入 `toolOutput.output`
   - 流程类提醒（委派提示）注入 `messages.transform` (user message)
4. **分层保护**：
   - P0：主动提醒（task 后、违规时、每 turn）
   - P1：被动兜底（idle 时强制续接）

### 11.3 与 build.md 的关系

| build.md 现有段落 | 处理方式 |
|-----------------|---------|
| 身份声明 ("You are an orchestrator") | **保留** (每轮静态注入) |
| 委派规则 ("What you MUST delegate") | **保留** (每轮静态注入) |
| 验证迭代 ("Verify-Iterate Pattern") | **已移出** ✅ — 改为 `tool.execute.after` 中 post-task nudge 按需注入 |
| CONTEXT 约束 ("Why CONTEXT must stay focused") | **保留** (每轮静态注入，帮助 task 格式正确) |
| Examples | **保留** (每轮静态注入，减少 token 浪费) |
| Subagent output | **保留** (每轮静态注入) |

### 11.4 与业界对齐

| 机制 | OMO | slim | ZooKeeper |
|------|-----|------|-----------|
| 任务完成 → 验证+todo | ✅ | (通过 hygiene 间接) | ✅ post-task nudge **已实现** |
| 违规编辑 → 警告 | ✅ | ✅ | ✅ direct-work reminder **已实现** |
| 每 turn → 委派提示 | ❌ | ✅ phase-reminder | ✅ focus-reminder **已实现** |
| 任务完成 → todo 更新 | (通过 Idle Enf. 兜底) | ✅ todo-hygiene | (通过 Idle Cont. P1) |
| idle → 强制续接 | ✅ Continuation Enf. | ✅ Auto-continuation | ✅ Idle Continuation (P1 **未实现**) |

### 11.5 未来方向

1. **P1 Idle Continuation**：如果观测到 build agent 频繁在 todo 未完成时停止，实施 opt-in 的 idle 续接机制
2. **进一步观察**：如果 todo 更新遗漏率高，考虑引入 slim 风格的 todo-hygiene 状态机
3. **文案优化**：根据实际行为观察调整提醒文案的语气和措辞
4. **权限层控制**：如果违规编辑频率高，考虑在 config.toml 中禁止编排器 edit/write
