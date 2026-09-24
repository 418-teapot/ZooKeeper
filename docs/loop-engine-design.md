# Loop 引擎设计：外层控制环内核 + 可插拔策略

**日期:** 2026-09-24（全文重写，替代 2026-09-23 初版）
**状态:** 已落地（`611ce51 refactor(loop): extract loop engine with strategy-owned budgets`）
**前置文档:** `docs/agent-loop-engineering-research.md`（OMO/OMP loop 机制调研，本文档的结论证据库）

> 初版写于引擎迁移之前，混合了"现状描述、重构计划、行为差异"三类内容；迁移已全部完成，本文档重写为一篇描述**现状与设计理由**的设计文档。初版的迁移计划、行为差异记录不再保留，不变量、所有权划分与决策理由全部继承并更新。

---

## 目录

1. [要解决什么问题](#1-要解决什么问题)
2. [设计哲学](#2-设计哲学)
3. [架构总览](#3-架构总览)
4. [引擎（core/loop）](#4-引擎coreloop)
5. [策略：以 todo-continuation 为例](#5-策略以-todo-continuation-为例)
6. [宿主适配层](#6-宿主适配层)
7. [关键决策与理由](#7-关键决策与理由)
8. [可观测性与测试](#8-可观测性与测试)
9. [暂缓项与未来决策点](#9-暂缓项与未来决策点)

---

## 1. 要解决什么问题

Coding agent 的基本运行单元是"一轮"：模型推理 → 调工具 → 观察结果 → 再推理，直到模型认为可以交付，然后**停下来等人**。真实任务往往需要几十上百轮，一次打住做不完。于是一类**自主循环**机制出现了：todo 续写（有未完成项就继续）、goal 追求（目标未达成就继续）、autodebug（没修好就继续）、autoresearch（实验没收敛就继续）……它们形态各异，但共享同一个控制问题：

> 谁来、在什么时候、以什么方式把 agent 再次驱动起来，以及什么时候让它真正停下——且永远不失控。

这正是控制工程里的**外层控制环**：agent 自身的"推理 → 工具 → 观察"是内环，Loop 引擎是套在外面的外环——内环停下后，由外环决定再次驱动它，还是让整个循环真正收敛。

ZooKeeper 把这个共享的控制问题做成一个**通用引擎 + 可插拔策略**：引擎只有一份（`src/core/loop/`），承载所有循环共用的联锁、汇聚与记账；每种自主循环是一个可插拔策略（`src/hooks/*` 下的一个单元），自带终止判断与驱动文案。目前唯一的策略是 **todo-continuation**：会话停稳时若 todo 列表还有未完成项，就把 agent 再次驱动起来。

外环的驱动载体是向会话注入一段"继续工作"的文字（续写）——但这是**执行手段，不是引擎要解决的问题**。引擎要解决的是循环的控制问题：何时继续、何时停止、如何不失控。OMO/OMP 调研（见前置文档）表明，goal hook、ulw-loop、autoresearch 等形态各异的循环最终都收敛到同一载体（settled 事件 + 注入消息），这正说明控制问题才是公共内核。

### 词汇表

| 词 | 含义 |
|----|------|
| **内环 / 外环** | 内环 = agent 自身的"推理 → 工具 → 观察"循环；外环 = 本引擎，在内环停下后决定再次驱动还是真正停止 |
| **停稳（settled）** | agent 彻底停稳：不是中途、不是被打断、不是在等用户回答。宿主保证此刻不再有自动重试、压缩或排队的续写 |
| **策略（strategy）** | 一个可插拔控制器，对应一种自主循环，判断"这次停稳该不该再次驱动"，并给出唤醒文字或沉默原因 |
| **联锁（interlock）** | 不依赖策略正确性、由引擎独立起作用的硬约束（停稳才动作、额度上限） |
| **唤醒（wake）/ 续写（continuation）** | 外环的驱动动作：向会话注入一段"继续工作"的消息，触发宿主再跑一轮内环。是执行手段，不是控制问题本身 |
| **沉默（silence）** | 引擎/策略决定不唤醒，附一个机器可读原因进日志 |
| **额度（budget）** | 按 (会话, 策略) 分账的自动唤醒次数上限 |

---

## 2. 设计哲学

### 2.1 第一性原理：本质回答

把问题剥到最简，引擎的输入输出与不变量如下。

**输入：**

1. 一个事实——"agent 彻底停稳了"；
2. 可查询的世界状态（停下前发生了什么、进展如何）；
3. 一个额度——允许自动唤醒多少次。

**输出：** 二元的——唤醒（附一段交给 agent 的文字），或沉默（附一个机器可读的原因）。

**必须恒成立的不变量：**

1. 唤醒只发生在彻底停稳之后——半稳定状态做决策必然与宿主的重试/压缩/排队竞态；
2. 自动唤醒次数有上界，且上界的执行**不依赖任何策略的自觉**——否则失控只是时间问题；
3. 信息不足时倾向沉默——错误的沉默用户可手动继续，错误的唤醒制造垃圾轮次；
4. 每次沉默都有机器可读的原因，否则系统无法观测和调试；
5. 唤醒文字由"知道为什么唤醒"的一方构造——引擎不知道，策略知道；
6. 一个策略的崩溃不波及其他策略，且崩溃表现为沉默而非唤醒。

### 2.2 控制论视角：联锁与控制律

用控制工程的语言：**联锁是不依赖控制律正确性、独立起作用的硬约束**。按不变量 1、2，"停稳才动作"与"额度上限"是联锁，归引擎；其余一切判断（该不该唤醒、唤醒说什么）是控制律，归策略。

这个划分不是审美偏好，而是被"被控对象的性质"逼出来的：

- Kubernetes 的 reconcile loop 可以**可证明收敛**，因为它的执行器是确定且幂等的——调一次 API 创建一个 Pod，调十次还是那一个 Pod；
- LLM 执行器是随机、非幂等的——同一份输入，这一轮和下一轮的输出可能不同。**Agent 循环至今无法证明收敛**，这不是工程水平的差距，而是被控对象性质的鸿沟。

推论：既然任何策略都不能保证自己收敛，"循环不失控"就不能押在策略的正确性上。额度上限必须由引擎强制执行——这正是联锁存在的理论根据。引擎对策略的态度与 K8s admission controller 对执行器的态度相同：**不要相信执行器**。

### 2.3 与 Kubernetes 控制循环的对照

K8s 把控制论带进了软件工程：`Desired State → Observe → Compare → Act → Repeat`。我们的引擎与它在结构上同构，但有三处关键取舍是**代价结构不同**决定的：

| K8s controller | Loop 引擎 | 差异原因 |
|----------------|-----------|----------|
| 水平触发：不信任事件流，周期性 resync，每轮重读 etcd | **边沿触发 + 水平观测**：settled 事件只做"入队触发器"，决策依据是可重新观测的世界状态（todo 列表等持久状态），不是事件载荷 | K8s reconcile 廉价幂等；我们的每次唤醒消耗一轮真实 agent 推理。错过事件最坏是沉默（fail-closed，用户可手动继续），不需要 resync |
| 期望状态被数学化（`actual == desired`，一行判定收敛） | 策略自行定义终止条件；todo 策略能成立，恰因其终止条件天然机器可判（无 active todo = 收敛） | "完成"的形式化（Goal/Evaluation）是 agent 循环的真正上限，见 §9 |
| controller 无状态，状态在 etcd | 引擎持有预算状态（内存）；策略判断所需的世界状态都在宿主侧可重新查询，不依赖对话历史 | "Agent 会忘，仓库不会忘"：策略的输入是可重新观测的事实，不是易失的对话记忆 |

### 2.4 fail-closed

贯穿全栈的总原则：**状态无法确认时宁可停循环，也不带猜测继续。** 具体落点：

- 宿主 transcript 不可读 → 不上报 settle，记 `cause_unobservable`（opencode.ts）；
- 配置缺失或非法 → 策略不贡献、引擎不构建，整个功能静默关闭；
- 策略崩溃 → 记日志、表现为沉默，波及其他策略为零；
- 引擎返回 `null`（沉默）→ 宿主不得自行编造唤醒。

---

## 3. 架构总览

```
宿主事件（session.idle / agent_end）
        │  适配层：翻译为 SettleRequest { sessionID, cause, progress }
        ▼
┌─ 引擎（src/core/loop/）──────────────────────────┐
│ 联锁 1: cause ≠ settled → 沉默(not-settled)      │
│ 联锁 2: 逐策略额度检查 → 跳过(budget-exhausted)  │
│ 询问: 逐个调用策略 handle({sessionID, progress}) │
│ 汇聚: 首个 wake 胜出；崩溃隔离；全沉默 → null    │
└──────────────────────────────────────────────────┘
        │  Wake { name, text } 或 null
        ▼
适配层：先 record 记账 → 投递 wake 文本到会话
```

### 所有权三角

| 层 | 拥有 | 不拥有 |
|----|------|--------|
| **引擎**（`src/core/loop/`） | 执行与记账：停稳联锁、按策略分账的额度联锁、汇聚、崩溃隔离、预算状态 | 任何配置、任何任务语义、唤醒文案 |
| **策略**（`src/hooks/*`） | 配置与判断：自己的 `maxWakes`、自己的门、wake 文案、自己的沉默词汇 | cause 与预算（引擎保证只在停稳且有额度时来问） |
| **宿主适配**（`src/opencode.ts` / `src/pi.ts`） | 事件翻译、观测采集、身份门禁、投递通道、额度重置时机 | 判断逻辑、预算状态 |

---

## 4. 引擎（core/loop）

引擎约 200 行，全部职责在 `src/core/loop/engine.ts`；`turn.ts` 是纯事实助手（`StopCause`、`resolveWorkActions`、`isAwaitingUserAnswer`），策略契约类型定义在 `src/core/slots.ts:517-565`。

### 4.1 接口

```ts
// 构造：策略贡献即全部输入，引擎不接收任何配置
createLoopEngine(contributions: SettledContribution[], options?: { cap?, store? }): LoopEngine

interface LoopEngine {
  run(request: SettleRequest): Promise<Wake | null>;  // 判断一次停稳
  record(sessionID, name): void;   // 唤醒投递前记账（先记账后派发）
  reset(sessionID): void;          // 真实用户回合/会话重启时重置额度
  used(sessionID, name): number;   // 读取已用额度（日志用）
}
```

- `SettleRequest { sessionID, cause: StopCause, progress: boolean }`——宿主上报的停稳事实；`StopCause = "settled" | "awaiting-input" | "aborted"`（`turn.ts:19`）。
- `Wake { name, text }`——胜出策略名 + 唤醒文字。宿主需要名字来把这次唤醒记到对应策略的账上。
- 构造时拒绝重名策略：策略名是预算账户键，重名会让一个策略的唤醒消耗另一个策略的额度（`engine.ts:161-167`）。
- `cap` 是可选的会话数上限：Map 按插入序迭代，超额时淘汰最旧会话——为不发射"会话删除"事件的宿主（pi）提供的廉价 LRU 兜底（`engine.ts:67-80`）。

### 4.2 判定顺序与汇聚语义

`run()` 的固定顺序（`engine.ts:167-200`）：

1. **停稳联锁**：`cause !== "settled"` → 记 `not-settled`，返回 `null`，**不询问任何策略**；
2. **逐策略额度联锁**：按注册顺序遍历，某策略已用额度 ≥ 其 `maxWakes` → 记 `budget-exhausted`（带策略名），**跳过该策略**，后续策略仍可胜出；
3. **询问与汇聚**：逐个 `await handle(input)`，首个 `wake` 直接胜出返回；每个策略的沉默记 `settle_silent`；
4. **崩溃隔离**：策略抛错记 `handler_crashed`（error 级）后继续下一策略——崩溃表现为沉默而非唤醒。

联锁先于策略门是有意为之：额度耗尽的停稳，无论 todo 列表状态如何，日志真因都是 `budget-exhausted`，而不是被策略门（`empty`/`no-progress` 等）掩盖。

### 4.3 沉默原因词汇分层

- **引擎面**：`EngineSilenceReason = "not-settled" | "budget-exhausted"`（`engine.ts:37`）——引擎只认识自己的词汇；
- **策略面**：`Decision<R extends string = string>` 泛型让每个策略钉住自己的沉默词汇（`engine.ts:48-51`）。

每次不唤醒都有机器可读原因且归属明确（引擎原因 or 哪个策略的哪个门），这是不变量 4 的落地。

---

## 5. 策略：以 todo-continuation 为例

### 5.1 策略契约

```ts
// src/core/slots.ts
interface SettledInput {              // 策略视野：停稳事实，无 cause 无预算
  sessionID: string;
  progress: boolean;                  // 本轮是否有 mutating 工作（观测事实）
}

interface SettledContribution {
  name: string;                       // 日志标签 + 预算账户键
  maxWakes: number;                   // 每会话唤醒上限，策略自己声明
  handle(input: SettledInput): Promise<Decision>;
}
```

要点：

- **`maxWakes` 是策略的参数**，随贡献一起声明。额度上限表达的是"这个策略该多执着"，只有策略自己知道；引擎只执行上限，不持有配置（决策 D5，见 §7）。
- **`progress` 是观测事实，不是门**。它是世界状态的一部分，作为输入交给策略自行决定是否使用——等待外部事件的循环就不该被进展门挡死。todo 策略把它当门用，只是 todo 策略自己的选择。
- **策略拿不到 cause 和预算**：引擎保证只在停稳且有额度时来问，策略视野里这两样东西干脆不存在（`SettledInput` 没有对应字段），从类型上消除了"策略自觉检查"的依赖。

### 5.2 todo-continuation 的判断逻辑

`src/hooks/todo-continuation/decide.ts:104-118`，纯函数，门顺序固定：

```
任务列表为空            → silence("empty")
无 active 项            → silence("no-active")     // active = pending | in_progress
本轮无 mutating 进展    → silence("no-progress")   // 自激抑制：纯文本确认不算进展
否则                    → wake(renderContinuation(tasks))
```

- `no-progress` 门防的是**自激**：agent 只用文字"确认收到提醒"而不做实际工作时，不允许 1/3→2/3→3/3 空转烧完额度（omp todo-tracker 的同款教训，见其 issue #2590）。
- wake 文案 = 固定对抗式指令 `CONTINUATION_PROMPT` + 当前任务快照（`[Status: X/Y completed, Z remaining]` + 逐条状态），由策略构造（不变量 5）。
- 任务来源：`resolveTodoSource` 优先读宿主 todoStore，其次有 `session.todo` 能力的 client，都没有则视为空列表 → `empty` 沉默。

### 5.3 fail-closed 落在贡献级

`src/hooks/todo-continuation/index.ts:56-75`：`[zoo.continuation].max_reminders` 缺失或非法时，该单元贡献**空槽**（`onSettled: []`）→ 宿主看到无策略贡献 → 不构建引擎 → 整个功能静默关闭。链条上没有任何环节"带着猜测继续运行"。

---

## 6. 宿主适配层

适配层把两个宿主（OpenCode / pi）的事件与能力翻译为引擎的统一词汇。两宿主的共同职责：

1. **事件翻译**：把宿主的"agent 停了"事件推导为 `StopCause`；
2. **观测采集**：把本轮工具调用归约为 `progress` 布尔——mutating 工具调用（`bash`/`edit`/`write`，词汇由宿主注入）或委派给 executor 子代理（无 edit 权限的 agent）算进展；
3. **身份门禁**：只有编排主会话的停稳才进入循环；
4. **额度重置**：真实用户回合开始 = 新的工作意图，额度归零重新计；
5. **投递**：`engine.record` 先记账，再投递 wake 文本——投递失败不会变成无界重试。

### 双宿主差异

| 维度 | OpenCode（`src/opencode.ts`） | pi（`src/pi.ts`） |
|------|------------------------------|-------------------|
| 驱动事件 | `session.idle` | `agent_end`（事件仅在有策略贡献时注册） |
| cause 推导 | `abortedSessions` → `lastAssistantAborted` → 未回答的问题 → 否则 settled；transcript 不可读则不上报（记 `cause_unobservable`） | `stopReason === "aborted"` → aborted；`uiPromptDepth>0 \|\| awaitingUser \|\| askUnanswered` → awaiting-input |
| 身份门禁 | `resolveAgent(sessionID) !== "dolphin"` 直接返回 | subagent 身份记 `settle_skipped` 跳过 |
| 额度重置时机 | 真实用户 `message.updated`（排除注入 echo 与 synthetic）+ `session.deleted` | `before_agent_start` + `session_start`；无会话删除事件，靠 `cap=100` LRU 淘汰兜底 |
| 投递通道 | `client.session.promptAsync`（agent=dolphin）；注入 echo 按 message id 识别 | `sendMessage({ customType: "zoo-loop-wake", display: true }, { deliverAs: "followUp", triggerTurn: true })` |

---

## 7. 关键决策与理由

| # | 决策 | 理由 |
|---|------|------|
| D1 | 单一通用引擎 + 可插拔策略，引擎与首个策略（todo-continuation）同建 | 每种自主循环共享同一组联锁与汇聚语义；只有一份引擎内核，策略即插即用 |
| D2 | 联锁（停稳+额度）归引擎强制，判断归策略 | §2.2：LLM 执行器不可证收敛，不失控不能押在策略正确性上 |
| D3 | `progress` 是观测输入，不是引擎强制的门 | 等待外部事件的循环不该被进展门挡死；是否使用由策略自定 |
| D4 | 词汇分层：引擎面用 loop 词汇（`core/loop`、customType `zoo-loop-wake`），用户面/策略面保留 continuation（`[zoo.continuation]`、`todo-continuation`） | 引擎是通用机制，continuation 是首个策略的用户语义；改名不改变用户契约 |
| D5 | 额度上限归策略（贡献携带 `maxWakes`），引擎只执行不持有配置 | 初版曾把 `max_reminders` 作为引擎构造参数，是**所有权倒置**：上限是策略的参数（对照 omp todo-reminder 的 `remindersMax` 属于 todo-tracker 自己的配置）。配置缺失 → 策略不贡献（fail-closed 落在贡献级） |
| D6 | 预算状态归引擎，重置时机归宿主 | 曾考虑把预算状态退回宿主；控制器拥有自己的记忆才是对的（状态归引擎），宿主持有的只是"什么时候该重新开始"的知识（重置时机） |
| D7 | 汇聚语义：首个 wake 胜出 + 逐策略预算跳过 | 当前只有一个策略，简单语义足够；多策略并存时的仲裁语义是暂缓项（§9） |
| D8 | 完成信号方向：结构化工具调用优于文本扫描 | OMO 同仓库对照：ralph-loop 的 `<promise>` 文本协议催生了 400+ 行检测代码，goal hook 改用 `update_goal(complete)` 工具调用后整片消失。未来策略的退出机制按此方向设计 |
| D9 | 边沿触发 + fail-closed，不引入 K8s 式周期 resync | 每次唤醒消耗真实推理轮次，代价结构与 K8s 不同；错过事件最坏是沉默，用户可手动继续（§2.3） |

---

## 8. 可观测性与测试

### 日志

| channel | 事件 | 含义 |
|---------|------|------|
| `loop` | `settle_interlock` | 引擎联锁拦截（`not-settled` / `budget-exhausted`，后者带策略名） |
| `loop` | `settle_silent` | 某策略沉默（带策略自有原因） |
| `loop` | `settle_skipped` | 宿主身份门禁跳过（pi） |
| `plugin` | `handler_crashed` | 策略崩溃（error 级，已被隔离） |
| — | `cause_unobservable` | 宿主 transcript 不可读，fail-closed 不上报（opencode） |

任何一次"不唤醒"都能从日志回答"为什么"：先查引擎联锁，再查策略门。

### 测试布局

| 文件 | 覆盖 |
|------|------|
| `src/core/loop/engine.test.ts` | 联锁顺序、重名拒绝、首个 wake 胜出、崩溃隔离、按策略分账、cap 淘汰 |
| `src/core/loop/turn.test.ts` | `resolveWorkActions`（executor/只读/未知 agent）、`isAwaitingUserAnswer` |
| `src/hooks/todo-continuation/decide.test.ts` | 门顺序、wake 文案、纯函数性 |
| `src/hooks/todo-continuation/index.test.ts` | `maxWakes` 声明、缺配置不贡献 |
| `src/opencode.loop.test.ts` / `src/pi.loop.test.ts` | 双宿主端到端：唤醒、门禁、进展观测、预算/echo/重置 |

引擎级联锁在 core 层测，策略单元测试不重复覆盖（分层测试，见 `index.test.ts` 头注释）。

---

## 9. 暂缓项与未来决策点

引入第二个 controller 时需要重新打开的决策。Kubernetes 二十年经验给出的指引是：**真正的上限不在循环机制，而在 Goal 与 Evaluation 的形式化**（`Control = Goal − Observed State`；测不出 observed state，控制就不存在）。以下暂缓项按此优先级排序。

### 9.1 autodebug：从 Goal/Evaluation 切入，而非从循环机制切入

- **首要设计问题不是"怎么循环"，而是"怎么算修好"的形式化判定。** todo 策略能成立，恰恰因为终止条件天然机器可判（无 active todo = 收敛）；debug 循环的状态要回答"假设追踪到哪、试过什么、怎么算修好"，难点全在 Evaluation。
- **结构化完成信号（工具调用）是退出机制候选，优先级升权。** Agent 循环的两种经典死法——"修好了继续修直到修坏"和"没修好谎称完成"——都是 Evaluation 失败。退出信号必须是平台保证结构的工具调用（如"指定失败测试转绿"），不能是文本扫描（决策 D8）。
- **生命周期**：显式激活 + 状态落盘 / todo 标签 / 隐式推断——推荐方向是显式激活（fail-closed），未决。

### 9.2 多策略仲裁：优先所有权分区，其次才是优先级

当前语义是"首个 wake 胜出 + 逐策略跳过"（决策 D7）。K8s 的参考答案不是优先级，而是**所有权分区**：controller 之间不仲裁，各自拥有自己的资源，靠目标正交避免 reconcile storm。第二个策略出现时，先问"两个策略的目标空间能否正交分区"（todo 拥有"任务列表未完成"，debug 拥有"假设未排除"），再决定是否真需要优先级语义。

### 9.3 节奏联锁（退避）

预算是**总量上界**，不防**热循环**——8 次额度在 10 秒内烧完同样是失控。对照：K8s 的 requeue + 指数退避；ulw-loop 的 `RESUME_CAP=2` 两击无进展上限与 context-pressure 退避清单。第二个策略出现时评估是否在引擎层面加最小唤醒间隔/退避联锁（廉价硬约束，单策略现状下风险低，暂不引入）。

### 9.4 预算状态落盘

当前额度状态在引擎内存中，宿主重启即丢。对照：K8s controller 把观测写回 status 子资源作为下一轮 reconcile 的起点（"没有 status 的 controller 是半成品"）；ulw-loop 的 append-only 磁盘 ledger 支持跨进程恢复。出现"宿主重启后循环需继续"的真实需求时重审。

### 9.5 重复工具调用熔断

OMO 后台 agent 熔断器（连续 20 次同签名调用 cancelTask）与 OMP ToolCallLoopGuard（阈值 5 → 隐藏纠正消息 → abort）防的是"agent 在单轮内死循环调工具"。ZooKeeper 的子代理调度在进程内，暂无同等失控面；第二个 controller 或后台 agent 能力引入时重审。
