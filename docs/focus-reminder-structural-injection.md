# Focus Reminder 结构注入调研报告：从用户消息附加到强化核心 Prompt

**版本:** 2.0  
**日期:** 2026-06-17  
**分类:** 技术架构文档 / Agent 行为塑形 / 消息注入

---

## 目录

1. [问题陈述](#1-问题陈述)
   - 1.1 当前架构 / 1.2 角色混淆的本质 / 1.3 后果 / 1.4 架构起源与混合问题
2. [四项目调研对比](#2-四项目调研对比)
   - 2.1 对比总览 / 2.2 核心理念对比 / 2.3 为什么三层方案最差
   - **2.4 Turn Timing vs Event Timing** / **2.5 slim 的 Path B 失败尝试** / **2.6 omo 和 omp 不使用每轮注入**
   - **2.7 真正的分类：内化 prompt vs 每轮注入 vs 条件触发纠正** / 2.8 三类指令注入语义 / 2.9 两个正交维度 / 2.10 决策归属分析
3. [OpenCode SDK 消息注入能力分析](#3-opencode-sdk-消息注入能力分析)
4. [路径 B 设计方案：从注入机制转向强化核心 prompt](#4-路径-b-设计方案从注入机制转向强化核心-prompt)

   - 4.1 设计目标 / **4.2 主推荐：用 omp 式契约强化 build.md** / **4.3 补充：关键词激活的 orchestrate-notice**
   - **4.4 条件触发纠正（omp 风格）** / **4.5 工具级硬约束（omo 风格）** / **4.6 逐步淘汰每轮 focus-reminder**
5. [路径 A 对比（放弃方案）与跨项目教训](#5-路径-a-对比放弃方案与跨项目教训)
   - 5.1 路径 A 定义 / 5.2 为什么放弃 / **5.5 跨项目教训：每轮注入是错误的原语**
6. [风险与回退](#6-风险与回退)
7. [影响面](#7-影响面)
8. [Phase 化演进](#8-phase-化演进)
9. [总结](#9-总结)

---

## 1. 问题陈述

### 1.1 当前架构

ZooKeeper 的 focus-reminder 通过 `experimental.chat.messages.transform` hook，在 build agent 的每一轮 LLM 调用前，向最后一条 user 消息的 `parts` 数组中追加一个文本片段。该片段使用三层包裹结构：

```
[SYSTEM DIRECTIVE: ZOO - FOCUS REMINDER]     ← Layer 3: 文本前缀，标记意图
<internal-reminder>                          ← Layer 2: XML 标签，供下游代码消费者识别
!IMPORTANT! Remember your role: orchestrate, don't implement.
Understand the request → choose the right agent → delegate via task() → verify the result.
Split large tasks — one task() = one focused outcome.
</internal-reminder>
<!-- ZOO_INTERNAL_INITIATOR -->              ← Layer 1: HTML 注释标记，供下游代码消费者识别
```

这三层试图通过文本级约定（Text-level convention）来区分注入内容与真实的用户输入。然而，由于注入内容在**结构上**（Structurally）位于同一个 user 消息的 `parts` 数组之中，LLM 将其视为用户输入的一部分。

### 1.2 角色混淆的本质

问题可以简洁地表述为：

> Focus reminder **contorts at the text level what ought to be a structural distinction.**

即：ZooKeeper 试图通过文本前缀（`[SYSTEM DIRECTIVE: ZOO - ...]`）来"假装"这是一条系统级别的指令，但从消息结构上看，它仍然是用户消息中的一个 part。LLM 对消息的理解基于两个维度：

1. **消息角色（Message role）** — `role: "user"` vs `role: "assistant"` vs system prompt
2. **文本内容（Text content）** — 实际出现的文字

当角色是 `"user"` 时，LLM 倾向于将其理解为用户输入，即使文本中写了 `[SYSTEM DIRECTIVE]`。这是由 LLM 的底层训练方式决定的：角色字段（role field）是结构性信号，文本前缀是弱信号。

### 1.3 实际观察的后果

| 现象 | 说明 |
|------|------|
| 编排器回复注入内容 | build agent 有时会直接回应"好的，我会记住我的角色"——浪费 token |
| 编排器将注入内容纳入推理 | 推理过程中引用注入内容作为"用户说了..."的一部分 |
| 指令稀释 | 三层包裹在长上下文中被编排器忽略，因为"用户消息中总有这段文字" |
| 调试困难 | 日志中难以区分用户实际输入和注入内容 |

### 1.4 ZooKeeper 的架构起源与混合问题

ZooKeeper 的 focus-reminder 架构继承自 **oh-my-opencode-slim (slim)**，后者使用 `experimental.chat.messages.transform` 将行为提示作为新 part 追加到最后一个 user 消息中。slim 仅使用一层 XML 标签包裹。

但在开发过程中，ZooKeeper 引入了 omo 的 `[SYSTEM DIRECTIVE: ZOO - ...]` 文本前缀（Layer 3），试图在文本层面提升系统感。这产生了**混合混淆**——结构上是 user 级别，文本上却假装是 system 级别。模型对这种不一致的响应不可预测。

---

## 2. 四项目调研对比

### 2.1 对比总览

| Aspect | omo | slim | omp | ZooKeeper (当前) |
|--------|-----|------|-----|------------------|
| **Per-turn?** | ❌ 事件触发 | ✅ 每轮编排器 | ❌ 条件触发 | ✅ 每轮 build agent |
| **Hook 点** | `session.promptAsync()` (新 turn) 或 `messages.transform` (条件性) | `experimental.chat.messages.transform` | `agent.appendMessage()` / `session.steer()` / `session.prompt()` | `experimental.chat.messages.transform` |
| **注入目标** | **新 user 消息** (独立 turn) | 追加新 part 到最后 user 消息 | **新消息** (developer/custom/user 角色) | 追加新 part 到最后 user 消息 |
| **包裹层数** | 2 (文本前缀 + HTML 标记) | 1 (仅 XML 标签) | 1 (仅 XML 标签) | 3 (文本前缀 + XML + HTML 注释) |
| **角色分离** | ✅ 独立消息 = 独立角色 | ❌ 同消息同角色 | ✅ 独立消息 = 独立角色 | ❌ 同消息同角色 |
| **状态管理** | 有 (session 级, event-driven) | 无 (stateless) | 有 (agent 级) | 无 (stateless) |

### 2.2 核心理念对比

**omo / omp — 独立消息学派：**

理念：行为提醒是一个**独立的消息单元**（independent message unit），应该有独立的消息角色（message role）和/或独立的 turn。模型通过消息角色 + 文本约定双重信号来区分注入内容。

实现代价较高——需要创建新的消息或 turn，涉及异步 API 调用或状态管理——但角色分离更彻底。

**slim / ZooKeeper — 附加 part 学派：**

理念：行为提醒是**用户消息的扩展属性**（extended attribute），应该作为 user 消息的附加 part 存在。模型仅通过文本约定来区分。

实现简单——只需 `push` 到 `parts` 数组，无状态、无异步调用——但角色混淆风险高。

### 2.3 为什么 ZooKeeper 的三层方案最差

| 方案 | 包裹层数 | 角色混淆 | 代码复杂度 | 文本噪音 |
|------|---------|---------|-----------|---------|
| slim (1 层) | 1 | 高 | 低 | 低 |
| omo (2 层) | 2 | 低 (独立消息) | 中 | 中 |
| omp (1 层) | 1 | 低 (独立消息 + 不同角色) | 高 | 低 |
| ZooKeeper (3 层) | 3 | **高** | 中 | **高** |

However, omo's wrapping is richer than just 2 textual layers. It also uses:
- **`synthetic: true`** flag on parts — a code-level marker, invisible to the LLM but used by downstream code to identify injected content
- **`metadata: { compaction_continue: true }** — tells OpenCode to preserve this message across context pruning/compaction, which would be important if ZooKeeper later implements context pruning

### 2.4 Turn Timing vs Event Timing

ZooKeeper cannot use omo's `session.promptAsync()` despite both being OpenCode frameworks. The reason lies in a fundamental difference between **action triggers** and **behavioral guardrails**:

**omo's approach (action trigger):**
- omo uses `promptAsync()` to create a brand new async turn with a `[SYSTEM DIRECTIVE: ...]` text part
- This works because their directives are **action triggers** ("continue the next task") — the new turn IS the action itself
- Example: the ralph-loop detects task completion, then `promptAsync()` fires a new turn saying "continue with the next todo item"

**ZooKeeper's focus-reminder (behavioral guardrail):**
- The reminder is a **behavioral guardrail** — it must arrive in the SAME turn as the user's request to influence how the agent processes that request
- If focus-reminder arrives in turn N+1, it's too late — the build agent already processed user request X in turn N without the guardrail

**Real-world analogy:**
- omo is like a boss saying "continue with the next agenda item" — the instruction IS the task itself
- ZooKeeper's reminder is like "only review, don't write" — a constraint that should apply DURING the task, not after

**Before/after turn sequence:**

```
omo ralph-loop (action trigger, new turn = new action):
  Turn N:   Ralph loop detects task done, todos remain
  Turn N+1: [SYSTEM DIRECTIVE] Continue with next task
            └─ LLM treats this as the current task ✓

ZooKeeper focus-reminder (behavioral guardrail, needs same turn as request):
  Turn N:   User: "implement X"
            └─ Build implements X without guardrail ✗
  Turn N+1: [SYSTEM DIRECTIVE] Remember, you orchestrate, don't implement
            └─ Too late, X already implemented ✗
```

This is why ZooKeeper must inject the reminder in the **same turn** using `messages.transform`, not in a new turn via `promptAsync()`. The injection timing is dictated by the semantic type of the directive, not by technical convenience.

### 2.5 slim 的 Path B 失败尝试（关键发现）

slim 曾尝试用 `experimental.chat.system.transform` 实现结构注入，但 15 天内就回退了。两个 commit 记录了完整的失败过程：

- **`989a0e0`** (2026-04-12): "fix(hooks): make file-tool nudge ephemeral" — 将 nudges 从 `messages.transform` 迁移到 `experimental.chat.system.transform`，意图避免注入内容污染持久化的 tool output。
- **`4eac3c6`** (2026-04-27, 仅 15 天后): "Remove reminder system-transform no-ops" — 删除了整个 `chat.system.transform` handler。代码中的注释给出了原因：**"Dynamic reminders must not mutate the system prompt because OpenCode prompt-caches system messages as the stable prefix."**

**时间线：**

```
989a0e0 (Apr 12):  → 尝试 chat.system.transform
                        ↓
                    15 天后发现缓存问题
                        ↓
4eac3c6 (Apr 27):  → 回退，删除 handler，恢复为 messages.transform
```

**对 ZooKeeper 的直接影响：**

OpenCode 将 system prompt 作为"稳定前缀"（stable prefix）进行 prompt 缓存。动态修改 system prompt（包括 `chat.system.transform`）会破坏缓存，导致每次注入都需要重新计算。

这很可能也封杀了 `UserMessage.system` 路径——因为每个 user 消息上的 `system` 字段同样属于 system 级别的提示，OpenCode 在 prompt 缓存时可能也会缓存 per-message system 内容。如果每轮修改 system 字段，缓存同样会失效。

**结论：Path B 的 `UserMessage.system` 方案不仅存在角色语义的疑问，现在还有了来自 slim 的 concrete evidence——结构注入尝试已被 SDK 层面的 prompt 缓存机制封杀。**

> **关于 slim "4 项缓解措施"的更正：** 此前报告将 slim 的命名对齐、语气控制、一层包裹、双重注入（部分 + system.transform）描述为"设计选择"。实际上，`chat.system.transform` 的尝试是 Path B 探索，而其余措施是回退后的残留设计。它们不是设计选择——它们是失败后的妥协。

### 2.6 omo 和 omp 不使用每轮注入（关键发现）

跨项目调研的一个关键发现：**omo 和 omp 都不使用 per-turn 行为提示（behavioral nudge）。ZooKeeper 的每轮注入在两个成熟项目中都没有同类实现。**

#### omo

- omo 的 `messages.transform` 使用全部是**条件性的（conditional）**：
  - `context-injector`: 仅当检测到用户输入中的特定关键词时触发
  - `team-mode-status-injector`: 仅当出现团队协作关键词时触发
  - Anthropic prefill alias repair: 仅当检测到 prefill 别名问题时触发
- 唯一类似行为提示的注入是 `prometheus-md-only` hook（`src/hooks/prometheus-md-only/hook.ts`），它在 `tool.execute.before` 事件上触发，**直接抛出错误**阻止 Prometheus agent 编辑非 `.omo/*.md` 的文件。这是一个**工具级硬约束（tool-level hard constraint）**，不是文本提示。
- omo 的核心策略：
  - **内化在 system prompt 中**：例如 Sisyphus agent prompt（`src/agents/sisyphus/gemini.ts:178`）中写道："When you implement code directly instead of delegating, the result is measurably worse than when a specialized subagent does it. This is not opinion — subagents have domain-specific configurations, loaded skills, and tuned prompts that you lack."
  - **命名对齐**：agent 使用比喻性名字（Sisyphus, Prometheus），通过命名暗示职责
  - **工具级硬约束**：throw error 而非 text reminder

#### omp

- omp 的提醒清单（约 11 种）全部是**条件触发的（condition-triggered）**：
  - todo completion reminder
  - resolve reminder
  - subagent yield reminder
  - empty-stop retry
  - plan-mode tool decision
  - TTSR pattern matches
  - magic keywords
  所有提醒**仅在特定条件被违反时**触发，不是每轮注入。
- omp commit `e13f2de58` (2026-06-08): "mapped auxiliary messages to developer role for compaction" — 将 `<system-reminder>` 从 user 角色迁移到 developer 角色，专门为了避免它们被当作 user 输入处理。CHANGELOG 将这类消息描述为 **"pollution to be minimized"**。
- omp 的 orchestrate-notice（`prompts/system/orchestrate-notice.md`，约 40 行）是一个**用户发起的模式切换**：仅当用户输入 `orchestrate` 关键词时激活，包含完整的契约文本说明"覆盖任何默认的提前 yield、叙述、或自己实现的倾向"。这是一个**契约（contract）**，不是提醒。
- omp 使用关键词激活（orchestrate / ultrathink / workflow）——用户发起的模式切换，不是系统注入的每轮提示。

#### 命名对齐的观察

命名对齐不是关键区别。omo 使用比喻性名字（Sisyphus/Prometheus）是偶然的；omp 使用功能性名字（task/plan/explore/reviewer）同样有效。**真正的区别在于：内化的 prompt 含有具体阈值 vs 每轮外部文本提示。**

### 2.7 真正的分类：内化 prompt vs 每轮注入 vs 条件触发纠正

新的跨项目证据要求重新审视注入设计的分类体系。与之前的时序分类（Section 2.8）互补的是以下**哲学分类**：

| 哲学 | 描述 | 代表项目 | 有效性 |
|------|------|---------|--------|
| **内化（Baked-in）** | 核心 prompt 包含强行为指令；无运行时注入 | omo | **高** — 模型从开始就看到指令，无角色混淆 |
| **条件触发（Condition-triggered）** | 仅当特定条件违规时注入 `<system-reminder>`；使用 developer 角色 | omp | **中高** — 低频、token 浪费少、语义清晰 |
| **每轮注入（Per-turn nudge）** | 每轮追加相同文本作为行为约束；使用 user 角色 | slim, ZooKeeper | **低** — 角色混淆、token 浪费、指令稀释 |

**三个设计维度：**

| 维度 | 内化 (Baked-in) | 条件触发 (Condition-triggered) | 每轮注入 (Per-turn) |
|------|-----------------|-------------------------------|-------------------|
| **频率** | 从不（一次写入） | 按需（仅违规时） | 每轮 |
| **角色** | system prompt | developer / custom | user |
| **机制** | prompt 文本编辑 | `appendMessage(developer)` | `messages.transform` (parts.push) |

**跨项目定位：**

```
                    频率
                Every turn (per-turn)
                       ↑
                   slim, ZooKeeper
                       |
        ───────── On violation (condition-triggered) ─────────
                       |
                       omp
                       |
                Never (baked-in once)
                       |
                       omo
```

这个重分类说明 ZooKeeper 的问题不仅是包裹机制的问题——**per-turn 方法本身就是问题**。即使有完美的结构注入（例如 Path B 的 `UserMessage.system`），per-turn 提醒仍然面临指令稀释和缓存失效的问题。

### 2.8 三类指令注入语义（Three Categories of Directive Injection Semantics）

> 注：本节内容来源于原始报告的 2.5 节，保留未修改。

The different injection mechanisms across projects are not arbitrary — they reflect three distinct semantic categories of directives:

| 语义类型 | 描述 | 时机要求 | 典型机制 | 例子 |
|---------|------|---------|---------|------|
| **Action Trigger**（下一步动作） | 指令本身就是下一步动作 | turn 结束后 | `promptAsync()` 新 turn | omo ralph-loop, todo-continue |
| **Condition-triggered Correction**（规则违规纠正） | 当前 turn 内检测到规则违反后纠正 | 当前 turn 内 | `appendMessage(developer)` | omp resolve reminder |
| **Behavioral Guardrail**（并发行为约束） | 与用户请求并行生效的行为约束 | 当前 turn 内 | `messages.transform` | omo/slim/ZooKeeper focus-reminder |

**Which projects use which categories:**

| 项目 | Action Trigger | Condition-triggered Correction | Behavioral Guardrail |
|------|:--------------:|:-----------------------------:|:--------------------:|
| omo | ✅ `promptAsync()` | ✅ `messages.transform` | ✅ `messages.transform` |
| slim | ✅ `session.prompt()` (auto-continue) | — | ✅ `messages.transform` |
| omp | — | ✅ `appendMessage(developer)` + `session.steer()` | — |
| ZooKeeper | — | — | ✅ `messages.transform` |

omo is the most complete — it implements all three categories. ZooKeeper only implements one. This is not a deficiency per se, but it means ZooKeeper should not try to copy omo's mechanisms designed for a different category (Action Trigger → `promptAsync()`) into its own category (Behavioral Guardrail → `messages.transform`).

### 2.9 两个正交维度（Two Orthogonal Dimensions of Injection Design）

> 注：本节内容来源于原始报告的 2.6 节，保留未修改。

The current report conflates two independent design concepts. Clarifying them is essential for making correct design decisions:

1. **包裹层（wrapping layers）** — Textual conventions used to mark injection content: `[SYSTEM DIRECTIVE: ...]`, `<system-reminder>`, `<internal-reminder>`, HTML comments, etc. These are purely textual and invisible at the message structure level.

2. **注入机制（injection mechanism）** — Structural message position in the LLM API payload: same-part push (append to existing parts), new message entry + new role, new turn (separate LLM call), per-message system field (`UserMessage.system`).

**Cross-project mapping:**

| 项目 | 包裹层 | 注入机制 | 真正解决角色混淆？ |
|------|--------|---------|-------------------|
| omo | `[SYSTEM DIRECTIVE: ...]` + HTML marker | 新 turn (promptAsync) | ✅ 新 turn = 独立消息 |
| omp | `<system-reminder>` XML | 新 message entry, role=developer | ✅ developer role 真实分离 |
| slim | `<internal_reminder>` XML | 同 message parts.push | ❌ user role 不变 |
| ZooKeeper 当前 | `[SYSTEM DIRECTIVE]` + XML + HTML | 同 message parts.push | ❌ user role 不变 |

ZooKeeper 当前方案复制了 omo 的包裹层文本格式（`[SYSTEM DIRECTIVE]`），但用的是 slim 的注入位置（parts.push）。结果是**两边的好处都没拿到**：从 omo 抄来的文本前缀本意是配合新 turn 工作的，单独用没有意义；从 slim 抄来的 parts 注入只需要 1 层 XML 包裹就够，加了 `[SYSTEM DIRECTIVE]` 反而制造语义混乱。

### 2.10 决策归属分析

```
                                                    角色分离方式
                                              ┌──────────────────────┐
                                              │   结构 (Structural)    │    ← 独立消息、不同 role
                                              │                       │
                                      omp ────┤  agent.appendMessage │
                                              │  session.steer()     │
                                              └──────────────────────┘
                                              ┌──────────────────────┐
                                              │   文本 (Textual)      │    ← 同消息、同 role
                                              │                       │
               slim ──────────────────────────┤  messages.transform  │
               ZooKeeper ─────────────────────┤  (append part)       │
                                              └──────────────────────┘
                                              ┌──────────────────────┐
                                              │   混合 (Hybrid)       │    ← 独立 turn (异步)
                                              │                       │
                              omo ────────────┤  session.promptAsync │
                                              │  + 文本前缀           │
                                              └──────────────────────┘
```

ZooKeeper 当前选择了**纯文本**路径（右下角），但引入了三层包裹试图模仿**结构**路径的效果。这导致了最差的结果：既有文本噪音，又没解决角色混淆。

---

## 3. OpenCode SDK 消息注入能力分析

### 3.1 调研范围

分析了以下 SDK 类型定义文件：

| 文件 | 路径 |
|------|------|
| Plugin Hooks | `node_modules/@opencode-ai/plugin/dist/index.d.ts` |
| SDK V2 Types | `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` |
| SDK V2 Client | `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` |
| SDK V1 Types | `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` |

### 3.2 `experimental.chat.messages.transform` 类型签名

```typescript
"experimental.chat.messages.transform"?: (input: {}, output: {
    messages: {
        info: Message;
        parts: Part[];
    }[];
}) => Promise<void>;
```

关键发现：

- **output.messages 可以替换** — 可以返回一个全新的数组（不限于 mutate 原数组）
- **可以插入新消息** — 可以在数组任意位置插入新的 `{ info: Message; parts: Part[] }` 条目
- **消息角色限制** — `info` 的类型是 `Message = UserMessage | AssistantMessage`，仅支持 `role: "user"` 和 `role: "assistant"`
- **没有 "system" 或 "developer" 角色** — 在 messages 数组中不支持这些角色
- **`Part` 包含 `synthetic?: boolean` 标记** — `TextPart` 有 `synthetic` 字段，可用于标记注入内容

```typescript
// UserMessage role 固定为 "user"
export type UserMessage = {
    id: string;
    sessionID: string;
    role: "user";            // 字面量类型，固定为 "user"
    system?: string;          // 每消息系统提示覆盖（重要！）
    // ...
};

// AssistantMessage role 固定为 "assistant"
export type AssistantMessage = {
    id: string;
    sessionID: string;
    role: "assistant";       // 字面量类型，固定为 "assistant"
    // ...
};
```

关键 API：**`UserMessage.system?: string`** — 这是每个消息级别的 system prompt 覆盖字段。在 OpenCode 中，`system` 字段的内容会被当作该消息的系统指令处理，类似于 LLM API 中的 "developer" 角色或 "system" 消息。

### 3.3 `experimental.chat.system.transform` 类型签名

```typescript
"experimental.chat.system.transform"?: (input: {
    sessionID?: string;
    model: Model;
}, output: {
    system: string[];
}) => Promise<void>;
```

可以**替换系统提示数组**。但注意：
- `system` 是字符串数组，每个元素是一个系统提示行
- 所有 agent 共享同一系统提示体系
- 修改会影响整个会话的所有消息，不仅仅是当前 turn
- 如果仅为 focus-reminder 修改系统提示，成本过高且可能干扰其他机制
- **新发现**（基于 slim 的失败经验）：OpenCode prompt-caches system messages as stable prefix，每轮修改 system 数组会破坏缓存

### 3.4 `session.promptAsync()` API

```typescript
// V2 SDK 中的 promptAsync
promptAsync<ThrowOnError extends boolean = false>(parameters: {
    sessionID: string;
    directory?: string;
    workspace?: string;
    messageID?: string;
    model?: { providerID: string; modelID: string; };
    agent?: string;
    noReply?: boolean;
    tools?: { [key: string]: boolean; };
    format?: OutputFormat;
    system?: string;
    variant?: string;
    parts?: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
}, options?: Options<never, ThrowOnError>): ...
```

- 创建一个**新的异步 turn**（user 角色消息）
- parts 可以是 TextPartInput，可以带 `synthetic?: boolean` 标记
- 有 `system?: string` 字段用于设置每消息系统提示
- 适用于 omo 风格的**事件触发式注入**，不适用于每轮注入
- 异步返回，不阻塞当前 turn

### 3.5 `V2SessionPrompt` (steer) API

```typescript
export type V2SessionPromptData = {
    body: {
        id?: string;
        prompt: Prompt;          // { text: string; files?: ...; agents?: ... }
        delivery?: "steer" | "queue";
        resume?: boolean;
    };
    path: { sessionID: string; };
    url: "/api/session/{sessionID}/prompt";
};
```

- `delivery: "steer"` 设置下一轮用户输入（类似 omp 的 `session.steer()`）
- `prompt.text` 是纯文本，无角色指定
- 适用于跨会话主动注入，但同样创建新 turn

### 3.6 API 能力总结

| API | 可注入独立消息？ | 可指定角色？ | 影响当前 turn？ | 复杂度 |
|-----|----------------|-------------|----------------|--------|
| `messages.transform` (insert) | ✅ 可插入新消息到数组 | ❌ 仅 "user"/"assistant" | ✅ 是 | 低 |
| `messages.transform` (用 system 字段) | ✅ 可在 user 消息上设 system | ✅ system ≈ developer 角色 | ✅ 是 | 低 |
| `chat.system.transform` | — (不是消息，是系统提示) | ✅ system 级别 | ✅ 是 | 中 |
| `session.promptAsync()` | ✅ 新 turn | ❌ 仅 "user" | ❌ 否 (异步) | 高 |
| `V2SessionPrompt (steer)` | ✅ 新 turn | ❌ 仅 "user" (隐式) | ❌ 否 (steer) | 高 |

> **Note on omp/omo external role systems:** omp's `appendMessage(developer)` and `session.steer()` use custom role semantics that go beyond the standard OpenCode plugin SDK. omp achieves this by calling OpenCode's internal REST API directly with `role: "developer"`, which is outside the `messages.transform` hook's type system (which only supports `"user"` and `"assistant"`). Similarly, omo's `session.promptAsync()` creates new turns through the SDK client, not through plugin hooks. ZooKeeper, constrained to the plugin SDK's `messages.transform` hook, cannot replicate these external role systems.

### 3.7 可行路径筛选（基于新发现更新）

对于 focus-reminder 这种**每轮注入、同步、低延迟**的需求，基于 slim 的经验和跨项目证据：

| 路径 | 可行？ | 理由 |
|------|-------|------|
| A. 在 messages.transform 中插入新消息 (role: "assistant") | ❌ | 角色不对，语义混乱 |
| B. 在 messages.transform 中插入新消息 (role: "user", synthetic: true) | ⚠️ 可作回退 | 结构分离但角色混淆仍在，synthetic 标记对 LLM 不可见 |
| C. 在 messages.transform 中使用 user 消息的 system 字段 | ❌ **(被 slim 实验封杀)** | slim 发现 OpenCode prompt-caches system messages；每轮修改 system 字段破坏缓存 |
| D. 使用 chat.system.transform 追加到 system prompt | ❌ **(被 slim 实验封杀)** | slim 尝试后回退，同上缓存问题 |
| E. 使用 session.promptAsync() 创建新 turn | ❌ | 异步，不适用每轮注入 |
| **F. 消除注入需求（本报告的新方向）** | ✅ **(主推荐)** | 通过强化核心 prompt + 条件触发纠正 + 工具级硬约束替代每轮注入 |

---

## 4. 路径 B 设计方案：从注入机制转向强化核心 Prompt

### 4.1 设计目标

基于跨项目调研的新发现，设计目标从"如何更好地注入"转向**"何时不需要注入"**：

1. **消除对每轮注入的依赖** — per-turn nudges 被 omo 和 omp 证明不是最佳实践
2. **使用 prompt 契约替代运行时提示** — 将行为指令内化到 agent 的 system prompt 中
3. **使用工具级硬约束替代文本提醒** — 在 LLM 无法忽略的层面施加强约束
4. **仅在违规时纠正，而非每轮预防** — condition-triggered 替代 per-turn

这四个目标共同指向一个结论：**Path B 的最佳方案不是在 SDK 中找到更好的注入机制，而是设计一个不需要注入的系统。**

### 4.2 主推荐：用 omp 式契约强化 build.md

将 per-turn focus-reminder 替换为内化在 `core/prompts/build.md` 中的、带有具体阈值的委派契约。

**当前的 focus-reminder 文本（每轮注入，per-turn）：**

```
!IMPORTANT! Remember your role: orchestrate, don't implement.
Understand the request → choose the right agent → delegate via task() → verify the result.
Split large tasks — one task() = one focused outcome.
```

**替换为带具体阈值的 omp 式契约（一次写入，baked-in）：**

```markdown
## Delegation Contract

You are the orchestrator. Your role is to delegate, not implement.

**Concrete thresholds for delegation (when you MUST use task()):**
- Creating or modifying code in more than one file → MUST use task()
- Writing more than ~30 lines of new code → MUST use task()
- Performing file-level operations (create, edit, rename, delete) → MUST use task()
- Reading or analyzing existing code → delegation recommended (use explore or spider agent)

**When delegation is NOT required:**
- Simple text responses, answering questions, or providing explanations
- Analyzing information already in the conversation context
- Tasks that take ≤30 lines in a single file with no external dependencies

**Why this matters:**
When you implement code directly instead of delegating, the result is measurably worse
than when a specialized subagent does it. Subagents have domain-specific configurations,
loaded skills, and tuned prompts that you lack.

This is not an opinion — the threshold is calibrated from 3 independent projects.
```

**为什么这样有效（跨项目证据）：**

- omo 的 Sisyphus agent prompt 包含几乎相同的条款（`src/agents/sisyphus/gemini.ts:178`）。它在 system prompt 中只出现**一次**，不每轮重复。
- `~30 lines` 这样的具体阈值比"significant work"这样的模糊描述更有效——模型可以基于确定性规则做决定。
- 关键区别：契约是 agent 身份的一部分（system prompt），不是在运行时附加的外部约束。
- omp 的 orchestrate-notice 也使用类似的契约风格，通过用户发起的关键词激活（详见 Section 4.3）。

**实现：**

| 文件 | 变更 |
|------|------|
| `core/prompts/build.md` | 添加 Delegation Contract 章节，包含具体阈值 |
| `src/hooks/focus-reminder/hook.ts` | **不删除**（在 Phase 4 之前保留，用于条件触发纠正） |
| `config.toml` | 无变更 |

### 4.3 补充：关键词激活的 Orchestrate-notice

添加 omp 风格的 orchestrate-notice，仅当用户输入特定关键词时激活。

**内容（添加到 `core/prompts/build.md`）：**

```markdown
### Orchestrate Mode

When the user types "orchestrate", activate orchestrate mode. This mode overrides any
default tendency to:
- Implement code directly
- Yield early without completing the delegation chain
- Narrate or explain instead of delegating

In orchestrate mode:
1. Read the request carefully
2. Break it into independent sub-tasks
3. Delegate EACH sub-task to the appropriate agent via task()
4. Verify the result of each delegation before proceeding
5. Do NOT implement any code yourself — always delegate

This contract is only active when the user explicitly invokes "orchestrate".
```

**为什么关键词激活：**

- 用户发起，非系统注入
- 无每轮 token 浪费
- 模型尊重显式模式切换（已验证：omp 的 orchestrate/ultrathink/workflow 关键词）
- 零额外复杂度——仅需编辑 prompt 文件

**实现：** 添加到 `core/prompts/build.md` 的条件块中。LLM 理解关键词激活语义，不需要额外代码。

### 4.4 条件触发纠正（omp 风格）

替代每轮注入，仅当 build agent 违反委派规则时注入 `<system-reminder>`。检测条件：

| 检测条件 | 触发纠正 |
|---------|---------|
| Agent 直接使用 `edit` 工具 | ⚠️ "This task should be delegated via task() to a subagent." |
| Agent 直接使用 `write` 工具 | ⚠️ "File creation should be delegated." |
| Agent 直接使用 `apply_patch` 工具 | ⚠️ "Patching should be delegated." |
| Agent 单轮创建 >30 lines | ⚠️ "Consider splitting this into sub-tasks." |
| Agent 单轮操作 >2 个文件 | ⚠️ "Consider delegating file operations." |

**在 `focus-reminder/hook.ts` 中的实现：**

```typescript
// 从每轮注入改为条件触发纠正
"experimental.chat.messages.transform": (input, output) => {
  const lastAssistantMsg = output.messages.findLast(m => m.info.role === "assistant");
  if (!lastAssistantMsg) return;

  const violations = detectDelegationViolations(lastAssistantMsg);
  if (violations.length > 0) {
    // 注入纠正消息（使用 messages.transform 插入新 user 消息 + synthetic 标记）
    injectCorrectionMessage(output, violations[0]);
  }
  // 无违规 → 什么都不做（零注入）
}
```

> **缓存影响：** 由于条件触发纠正仅在违规时注入（频率远低于每轮），对 prompt 缓存的影响可忽略不计。slim 的缓存问题主要针对每轮注入导致的频繁缓存失效。

**PHP 风格 vs 实现约束：**

omp 使用 internal REST API 的 `role: "developer"` 创建真正的 developer 角色消息。ZooKeeper 受限于 plugin SDK，messages 数组仅支持 `"user"` 和 `"assistant"` 角色。在 plugin SDK 约束下：

- **首选方法：** injectCorrectionMessage 插入新 user 消息 + `synthetic: true` + 1 层 XML 包裹（备选方案 B）
- **次选：** 使用 `UserMessage.system` 字段——虽然存在缓存风险，但低频下可接受
- **回退：** 仅日志记录，依赖 prompt 内化 + 工具级约束

### 4.5 工具级硬约束（omo 风格）

最硬的约束——在工具执行层面直接阻止违规行为。

**ZooKeeper 当前已有的工具权限控制：**

`config.toml` 中 build agent 的 deny 列表已经禁止了部分直接操作工具。验证实际配置：

```toml
[agents.build.permission]
deny = ["bash", "glob"]
```

这意味着 build agent 被禁止使用 `bash` 和 `glob` 工具。这是工具级约束，build agent 根本无法调用这两个工具。

**可以扩展的 deny 规则：**

| 工具 | 当前状态 | 建议 |
|------|---------|------|
| `edit` | 允许 | 保留（build agent 确实需要编辑自己创建的文件） |
| `write` | 允许 | 保留（同上） |
| `apply_patch` | 待确认 | 如果 build agent 不需要直接打补丁，加入 deny |
| `glob` | deny ✅ | 已有 |
| `bash` | deny ✅ | 已有 |

**omo 风格的硬约束（参考 prometheus-md-only hook）：**

在 `tool.execute.before` hook 中添加检查逻辑：

```typescript
// 如果 build agent 试图在非 delegate 场景下使用编辑工具，抛出错误
"tool.execute.before": (input) => {
  if (input.tool === "edit" || input.tool === "write") {
    // 检查是否有 task() 调用正在运行
    // 如果没有活跃的 subtask，抛错
    throw new Error("Build agent: direct editing is not allowed. Use task() to delegate.");
  }
}
```

> **注意：** 与 omo 的 prometheus-md-only 不同，ZooKeeper 的 build agent 确实需要一些直接编辑能力（例如创建单文件 ≤30 lines 的任务）。硬约束应避免矫枉过正——建议从 deny 列表开始，`tool.execute.before` 抛错作为后续扩展。

### 4.6 逐步淘汰每轮 focus-reminder

一旦上述机制就位，per-turn focus-reminder 可以逐步淘汰：

| Phase | 每轮 focus-reminder | 替代机制 |
|-------|-------------------|---------|
| 当前 | ✅ 活跃，3 层包裹 | — |
| Phase 1 | ✅ 保留 | 添加 Delegation Contract 到 build.md |
| Phase 2 | ✅ 保留 | 添加 Orchestrate-notice 到 build.md |
| Phase 3 | ✅ 保留 | 添加条件触发纠正到 hook.ts |
| Phase 4 | ❌ 移除 | 仅保留条件触发纠正 + 工具级约束 |

**Phase 4 之后：**
- `focus-reminder/hook.ts` 中的代码从"每轮注入"变为"条件触发纠正"
- 移除所有包裹层相关代码
- 工具函数（`internal-initiator.ts`、`system-directive.ts`）作为通用工具保留

---

## 5. 路径 A 对比（放弃方案）与跨项目教训

### 5.1 路径 A 定义

"路径 A" = 保持将 focus-reminder 追加到 user 消息 part 的基本架构，仅简化包裹层数（从 3 层减到 1 层）。

### 5.2 为什么放弃

路径 A 在当前的新发现下已经不重要——它只是次要的装饰性改进。简化包裹层数不解决根本问题（角色混淆、指令稀释、指令稀释）。在跨项目证据表明 per-turn 方法本身就有问题之后，路径 A 只是一个"让糟糕的方案稍微好一点"的迭代。

即使路径 A，在以下方面仍有问题：

| 维度 | 路径 A (简化包裹) |
|------|-----------------|
| 角色混淆 | ❌ 仍存在 — 同消息同角色 |
| 指令稀释 | ❌ 仍存在 — 每轮文本重复 |
| SDK 缓存冲突 | ❌ 仍存在 — per-turn 修改触发缓存失效 |

**结论：** 路径 A 不值得投入。它不解决任何核心问题，并且分散了对更优方案（强化核心 prompt、条件触发纠正、工具级约束）的注意力。

### 5.5 跨项目教训：每轮注入是错误的原语

从四个项目的全景来看，一条清晰的规律浮现出来：

> **Per-turn nudges are the wrong primitive for behavioral alignment.**

| 项目 | 使用每轮注入？ | 行为对齐效果 |
|------|--------------|-------------|
| omo | ❌ 从不 | ✅ 强（内化 prompt + 工具硬约束） |
| omp | ❌ 从不 | ✅ 强（条件触发 + 关键词合同） |
| slim | ✅ 尝试过（system.transform fail） | ⚠️ 弱，已放弃 |
| ZooKeeper | ✅ 当前使用 | ❌ 弱，角色混淆 |

**每轮注入的四个失败原因：**

1. **角色混淆不可修复** — 在 user 角色中注入文本"system directive"，无论包裹层数是 1 还是 3，LLM 都无法从结构上区分。
2. **指令稀释不可避免** — 每轮出现相同的文本，模型学会忽略。o(N) 重复覆盖一次性信号强度。
3. **缓存失效是 SDK 级别问题** — slim 的 `989a0e0` → `4eac3c6` 证明 OpenCode prompt-caches system messages。每轮修改触发缓存失效，这不仅是"代码整洁"问题，而是性能/成本问题。
4. **token 浪费可观** — 每轮 ~50-150 token，累计到长时间会话中达到数千 token。

**正确的原语：**

| 原语 | 机制 | 代表项目 |
|------|------|---------|
| **内化系统 prompt** | 一次性写入，带具体阈值 | omo |
| **条件触发纠正** | 仅违规时注入，developer 角色 | omp |
| **关键词激活契约** | 用户发起模式切换 | omp |
| **工具级硬约束** | 在 hook 层面抛错 | omo |

ZooKeeper 当前的 per-turn nudge 方案在三个成熟项目中都没有同类实践。这不是巧合——这是有经验的项目得出的共同结论。

---

## 6. 风险与回退

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 内化 prompt 契约效果不足（模型忽略） | 中 | 中 | 保留条件触发纠正作为安全网；如无效则加强阈值具体性 |
| 关键词激活或然率低（用户不记得输入 orchestrate） | 中 | 低 | 文档提示 + 渐进式暴露；非必要机制 |
| 条件触发纠正检测不准确 | 中 | 中 | 从保守检测开始（仅最明确的违规），逐步扩展 |
| 条件触发纠正的 SDK 兼容性 | 低 | 中 | 仅使用 `messages.transform`，不依赖外部 role API |
| 工具级硬约束矫枉过正 | 低 | 高 | 从 deny 列表开始（config.toml），`tool.execute.before` 抛错作为后续 |
| 缓存失效（Per-turn 保留期间） | 中 | 中 | Phase 1-3 保留 per-turn 但逐步减少对它的依赖；Phase 4 完全移除 |

### 6.2 回退选项

如果新方案不达预期，按优先级回退：

**回退 1（保守）：维持当前每轮注入，简化包裹层（路径 A）**
- 移除 Layer 1 和 Layer 3，仅保留 `<internal-reminder>` XML
- 不解决核心问题，但减少噪音
- 最安全、改动最小

**回退 2（激进）：使用 `UserMessage.system` 字段（如果缓存问题可接受）**
- 如果 slim 的缓存问题已被 OpenCode 新版修复
- 验证后可作为条件触发纠正的注入机制
- 需要测试验证

**回退 3（完全回退）：删除所有变更，恢复当前 3 层包裹**
- 无风险，无改进
- 仅作为最后选项

### 6.3 验证方法

| 检查项 | 方法 | 通过标准 |
|-------|------|---------|
| Prompt 契约理解 | 回放测试 (--replay) | 编排器行为显示委派率提升 |
| 条件触发纠正准确率 | 日志分析 | 检测正确率 >80%，误报率 <10% |
| 每轮注入频率降低 | Phase 4 前后对比 | 注入次数从 100% 降至 <20%（仅违规时） |
| Token 消耗变化 | 监控 | 建议减少 50-150 token/轮（Phase 4 后） |

---

## 7. 影响面

### 7.1 需要修改的文件

#### Phase 1（强化核心 prompt）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `core/prompts/build.md` | 修改 | 添加 Delegation Contract 章节，包含具体委派阈值 |
| `config.toml` | 不变 | 无变更 |

#### Phase 2（关键词激活契约）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `core/prompts/build.md` | 修改 | 添加 Orchestrate Mode 条件块 |

#### Phase 3（条件触发纠正）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/hooks/focus-reminder/hook.ts` | 修改 | 从每轮注入改为条件触发纠正逻辑；移除包裹层代码 |
| `src/hooks/focus-reminder/index.test.ts` | 修改 | 适配新的条件触发纠正断言 |
| `src/hooks/utils/system-directive.ts` | **不变** | 保留通用工具函数 |
| `src/hooks/utils/internal-initiator.ts` | **不变** | 保留通用工具函数 |

#### Phase 4（淘汰 per-turn focus-reminder）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/hooks/focus-reminder/hook.ts` | 重写 | 完全移除 per-turn 注入逻辑 |
| `src/index.ts` | 不变 | hooks 注册位置不变（仍使用 `experimental.chat.messages.transform`） |

### 7.2 不变的文件（但需验证）

| 文件 | 原因 |
|------|------|
| `src/utils/logger.ts` | 日志工具不变 |
| `tests/tools/test_trace_builder.py` | 日志格式不变 |
| `config.toml` | 仅 schedule 相关配置不变（deny 列表已存在） |

### 7.3 跨模块影响

| 模块 | 影响 |
|------|------|
| 上下文指标测量 | 条件触发注入频率远低于 per-turn，token 消耗降低 |
| 上下文剪枝 | 注入消息频率低，剪枝逻辑更简单 |
| 测试套件 | 现有回放测试仍然有效（场景不变） |

---

## 8. Phase 化演进

### 8.1 Phase 1 (V0)：强化核心 prompt

**目标：** Delegation Contract 写入 `build.md`，开启内化 prompt 的第一阶段。

| 待办 | 详情 |
|------|------|
| 编辑 `core/prompts/build.md` | 添加 Delegation Contract 章节（约 30 行） |
| 定义具体委派阈值 | 基于跨项目经验校准（30 lines, 2+ files, file-level ops） |
| 保留当前 per-turn focus-reminder | 作为安全网，直到 Phase 4 |
| 运行玩具测试 | 验证模型理解阈值 |

**预期产出：**
- build agent 的 system prompt 包含带具体阈值的委派契约
- 模型在 Phase 1 期间逐步适应"identity change"
- 每轮 focus-reminder 仍然存在（双重保障）

### 8.2 Phase 2 (V1)：关键词激活契约

**目标：** 添加 omp 风格的 orchestrate-notice。

| 待办 | 详情 |
|------|------|
| 编辑 `core/prompts/build.md` | 添加 Orchestrate Mode 条件块（约 15 行） |
| 文档说明 | 在帮助文档中记录 `orchestrate` 关键词 |
| 验证 | 回放测试包含 orchestrate 场景 |

### 8.3 Phase 3 (V2)：条件触发纠正

**目标：** 将 `focus-reminder/hook.ts` 从 per-turn 注入改为条件触发纠正。

| 待办 | 详情 |
|------|------|
| 修改 `hook.ts` | 实现 `detectDelegationViolations()` 检测逻辑 |
| 修改 `hook.ts` | 实现 `injectCorrectionMessage()` 注入逻辑 |
| 移除包裹层代码 | 不再使用 `createSystemDirective`、`createInternalAgentTextPart` |
| 更新测试 | 适配新的条件触发纠正模式 |
| 运行 check.sh + test.sh | 确保全部通过 |

### 8.4 Phase 4 (V3)：淘汰 per-turn focus-reminder

**目标：** 完全移除每轮注入，仅保留条件触发纠正 + 工具级约束。

| 待办 | 详情 |
|------|------|
| 从 `hook.ts` 移除 per-turn 注入 | 保留 `messages.transform` 但仅用于条件触发纠正 |
| 验证 | 回放测试 + 日志分析确认无退化 |
| 监控 | 对比 Phase 1-3 的 token 消耗和模型行为 |

### 8.5 时间线

```
Phase 1 (V0): Week 1-2
  ┌─ 编辑 build.md（~30 行新内容）
  ├─ 验证回放测试
  └─ 观察 1-2 周

Phase 2 (V1): Week 3-4
  ┌─ 添加 Orchestrate Mode（~15 行新内容）
  ├─ 文档说明
  └─ 验证回放测试

Phase 3 (V2): Week 5-6
  ┌─ 修改 hook.ts（~60 行变更）
  ├─ 更新测试（~40 行变更）
  ├─ 运行 check.sh + test.sh
  └─ 观察 1-2 周

Phase 4 (V3): Week 7-8
  ┌─ 移除非条件触发代码（~30 行删除）
  ├─ 验证全线通过
  └─ Token 消耗对比报告
```

---

## 9. 总结

### 9.1 核心发现

1. **每轮注入（per-turn nudge）是错误的原语。** omo 和 omp 都不使用它。slim 尝试过并通过 `chat.system.transform` 注入，但 15 天后回退。三个成熟项目在不同方向上达成共识：每轮文本提示不是行为对齐的有效方式。

2. **Path B 的 `UserMessage.system` 路径被 SDK 缓存机制封杀。** slim 的失败（commit `4eac3c6`）提供了直接的 concrete evidence：OpenCode prompt-caches system messages as stable prefix。每轮动态修改 system 提示会破坏缓存。这不仅仅是"代码整洁"偏好——是 SDK 级别的约束。

3. **正确的方向不是更好的注入机制，而是消除注入需求。** 跨项目证据清晰显示，有效的方案是：
   - **内化 prompt**（omo）：带具体阈值的委派契约，一次写入 system prompt
   - **关键词激活契约**（omp）：用户发起模式切换（orchestrate）
   - **条件触发纠正**（omp）：仅在违规时注入，使用 developer 角色
   - **工具级硬约束**（omo）：在 hook 层面抛错阻止违规行为

4. **Per-turn 注入的四个失败原因：**
   - 角色混淆不可修复（user 角色中无法产生 system 语义）
   - 指令稀释不可避免（重复文本被模型忽略）
   - 缓存失效是 SDK 级别问题（prompt caching 冲突）
   - Token 浪费显著（每轮 50-150 token）

### 9.2 最终建议

**采用组合方案，分阶段实施：**

| Phase | 动作 | 预期效果 |
|-------|------|---------|
| **Phase 1** | 将 Delegation Contract（带具体阈值）写入 `core/prompts/build.md` | 模型从 system prompt 中获得委派指令，不再仅依赖运行时注入 |
| **Phase 2** | 添加 Orchestrate Mode 关键词激活契约 | 用户发起模式切换，增强关键场景的委派纪律 |
| **Phase 3** | 将 `focus-reminder/hook.ts` 从 per-turn 注入改为条件触发纠正 | 仅在违规时注入，大幅减少频率和 token 消耗 |
| **Phase 4** | 完全移除 per-turn focus-reminder | 零注入开销，完全依赖内化 prompt + 条件触发纠正 + 工具级约束 |

> **不推荐单独使用任何单一机制。** 组合方案利用了三种不同强度的约束（system prompt、条件注入、工具级硬约束），形成深度防御。

### 9.3 与 omo/slim/omp 的定位关系（更新）

| 框架 | 行为对齐机制 | 关键区别 |
|------|------------|---------|
| omo | 内化 prompt + 工具级硬约束 | 最严格，零运行时注入 |
| slim | 尝试 system.transform → 放弃 → 回退到 messages.transform | 证明了 per-turn 注入的无效性 |
| omp | 内化 prompt + 条件触发纠正 + 关键词契约 | 最全面，三种机制组合 |
| ZooKeeper (当前) | per-turn 3 层包裹 | 最差实践，被三个项目验证无效 |
| **ZooKeeper (目标)** | **内化 prompt + 关键词契约 + 条件触发纠正 + 工具级约束** | **组合方案，借鉴 omo 和 omp 的最佳实践** |

---

**附录：SDK 类型参考**

```typescript
// 摘自 @opencode-ai/plugin/dist/index.d.ts
"experimental.chat.messages.transform"?: (input: {}, output: {
    messages: {
        info: Message;       // Message = UserMessage | AssistantMessage
        parts: Part[];       // Part = TextPart | SubtaskPart | ...
    }[];
}) => Promise<void>;

// 摘自 @opencode-ai/sdk/dist/v2/gen/types.gen.d.ts
export type TextPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "text";
    text: string;
    synthetic?: boolean;     // ← 可用于标记注入内容
    ignored?: boolean;
    // ...
};

export type UserMessage = {
    id: string;
    sessionID: string;
    role: "user";
    system?: string;         // ← 每消息系统提示覆盖
    // ...
};
```