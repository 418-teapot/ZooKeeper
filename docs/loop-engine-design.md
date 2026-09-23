# Loop 引擎设计：外层控制环内核 + 可插拔策略

**日期:** 2026-09-23
**状态:** 已确认（grill 逐项决策 + first-principles 推导，方案经用户接受）
**前置文档:** `docs/agent-loop-engineering-research.md`（OMO/OMP loop 机制调研）

---

## 目录

1. [背景](#1-背景)
2. [本质回答（第一性原理）](#2-本质回答第一性原理)
3. [架构：引擎 = 执行器 + 安全联锁，策略 = 控制律](#3-架构引擎--执行器--安全联锁策略--控制律)
4. [重构内容（与现状的差异）](#4-重构内容与现状的差异)
5. [决策记录](#5-决策记录)
6. [实施计划](#6-实施计划)
7. [明确不做](#7-明确不做)
8. [暂缓项（未来决策点）](#8-暂缓项未来决策点)

---

## 1. 背景

ZooKeeper 已有 continuation 基础设施（`src/core/continuation/` + `src/hooks/todo-continuation/` + 双宿主适配）：

- **已通用（引擎级）**：`onSettled` slot 与 verdict 汇聚 runner（`src/core/continuation/runner.ts:30-61`，首个 wake 胜出、逐 handler 崩溃隔离、fail-closed）、`Decision`/`SilenceReason`/`StopCause` 词汇、`Budget` 与预算记账、宿主工具词汇抽象（`WorkVocabulary`，core 不硬编码工具名）、双宿主续写注入通道。
- **与 todo 策略耦合**：`decide` 入参直接是 `TodoItemView[]`（`src/core/continuation/decide.ts:299`）、wake 文案与 todo 结构绑定、cause/budget 门靠策略自觉检查、预算记账在双宿主各有一份平行 Map。

本文档记录把原 `core/continuation` 泛化为通用 loop 引擎的设计（最终模块名 `src/core/loop/`）。设计目标：未来每种自主循环（debug、research 等）是一个**可插拔策略（controller）**，引擎内核只有一份。

## 2. 本质回答（第一性原理）

> 一个 agent 工作若干轮后会停下。需要一个东西，在合适的时机让它继续，在合适的时机让它真正停下，且永远不失控。

**输入：**
1. 一个事实——"agent 彻底停稳了"（不是中途、不是被打断、不是在等用户回答）；
2. 可查询的世界状态（停下前发生了什么、进展如何）；
3. 一个额度——允许自动唤醒多少次。

**输出：** 二元的——唤醒（附一段交给 agent 的文字），或沉默（附一个机器可读的原因）。

**必须恒成立（不变量）：**

1. 唤醒只发生在彻底停稳之后——半稳定状态做决策必然与宿主的重试/压缩/排队竞态；
2. 自动唤醒次数有上界，且上界的执行**不依赖任何策略的自觉**——否则失控只是时间问题；
3. 信息不足时倾向沉默——错误的沉默用户可手动继续，错误的唤醒制造垃圾轮次；
4. 每次沉默都有机器可读的原因，否则系统无法观测和调试；
5. 唤醒文字由"知道为什么唤醒"的一方构造——引擎不知道，策略知道；
6. 一个策略的崩溃不波及其他策略，且崩溃表现为沉默而非唤醒。

## 3. 架构：引擎 = 执行器 + 安全联锁，策略 = 控制律

控制工程语言：**联锁（interlock）是不依赖控制律正确性、独立起作用的硬约束**。按不变量 1、2，"停稳才动作"与"额度上限"是联锁，归引擎；其余判断归策略。

**关键推论：`progress` 不是一道门，是一个观测事实。** 它是世界状态的一部分，作为输入交给策略，由策略自行决定是否使用（等待外部事件的循环就不该被进展门挡死）。现状 `SettledInput.progress` 本来就是作为输入传递的——`decide` 把它当门用只是 todo 策略自己的选择。

### 3.1 引擎职责（core/loop）

1. **停稳过滤**：未停稳（`awaiting-input`/`aborted`）时不询问任何策略，记 `not-settled`；
2. **额度联锁**：按 (session, 策略) 分账；某策略额度用尽则记 `budget-exhausted`（带策略名）并跳过该策略，后续策略仍可胜出；额度状态由引擎持有，暴露 record/reset/used；
3. **询问**：把 `{sessionID, observations}` 逐个交给已注册策略，逐策略崩溃隔离；
4. **汇聚**：首个 `wake` 胜出，返回胜出策略名与文本；
5. **执行**：宿主在派发前调 `record` 扣额度（先记账后派发），再投递 wake 文本；
6. **观测**：引擎原因与策略原因都记入日志。

### 3.2 策略职责（controller）

- 输入：`{sessionID, observations}`——`cause` 和 `budget` 从策略视野中消失（引擎保证只在停稳且有额度时来问）；
- 输出：`wake(text)` / `silence(策略自有原因)`；
- **声明自己的预算**：贡献携带 `maxWakes`——额度上限是策略的参数（它决定该策略多执着），策略自己读取自己的配置；配置缺失/无效则该策略不贡献（fail-closed 落在贡献级）；
- 自由使用观测事实（含 `progress`），自由读取自己的数据源。

### 3.3 适配层职责（opencode/pi，不变）

把宿主事件翻译为"停稳/未停稳"、身份门禁、采集观测事实（mutating 工具词汇由宿主注入）、在各自重置点调用引擎的额度重置、投递 wake 文本。

### 3.4 所有权三角

| 层 | 拥有 |
|------|------|
| 引擎（core/loop） | 执行与记账：停稳联锁、按策略分账的预算联锁、汇聚、崩溃隔离 |
| 策略（hooks/*） | 配置与判断：`maxWakes`、自己的门、wake 文案 |
| 宿主（opencode/pi） | 事件翻译、观测采集、投递、重置时机 |

> 纠偏记录：初版把预算配置（`max_reminders`）作为引擎构造参数，用户指出这是所有权倒置——额度上限是策略的参数（对照 OMP todo-reminder 的 `remindersMax` 属于 todo-tracker 自己的配置），引擎只负责**执行**上限，不拥有配置。曾考虑把预算状态退回宿主，最终确认状态归引擎是对的（控制器拥有自己的记忆）；宿主持有的只是重置时机的知识。

### 3.5 对照检查（first-principles 验收）

| 检查项 | 结果 |
|--------|------|
| 引入了本质回答没有的依赖？ | 无——反而删掉了策略对 cause/budget 的依赖 |
| 允许了本质回答禁止的状态？ | 无——联锁从"靠策略自觉"变为"引擎强制执行"，收紧了不变量 1、2 |
| 丢掉了本质回答要求的性质？ | 沉默可解释性保留（双层原因都进日志）；行为等价性除 §4.3 两处日志语义外不变 |

## 4. 重构内容（与现状的差异）

### 4.1 decide.ts 拆解

- cause 门（`not-settled`）与 budget 门（`budget-exhausted`）从 `decide` 上移为引擎联锁；
- todo 专属门（`empty`/`no-active`/`no-progress`）+ `CONTINUATION_PROMPT` + `renderContinuation` 迁入 `src/hooks/todo-continuation/`；
- `Decision`/`SilenceReason` 分层：引擎沉默原因（`not-settled`/`budget-exhausted`）与策略沉默原因（策略自定义词汇）。

### 4.2 预算记账与配置所有权

- 删除双宿主平行的 `continuationUsed` / `remindersUsed` Map，额度状态移入引擎，按 (session, 策略) 分账；
- 引擎暴露记账与重置接口；opencode 的真实用户消息回显区分、pi 的 `before_agent_start`/`session_start` 重置点与 `REMINDER_SESSIONS_CAP` LRU 淘汰语义随记账迁入；
- **配置归策略**：`[zoo.continuation].max_reminders` 是 todo 策略的参数（名称不变），经 `deps.continuationConfig` 注入，由 todo-continuation 单元读取并声明为贡献的 `maxWakes`；宿主不再用该配置构造引擎，引擎构造条件变为「有策略贡献」。

### 4.3 行为差异（如实记录，均已接受）

1. 现状 budget 门排在所有策略门之后；重构后联锁先于策略——**任何**额度耗尽的 settle（无论 todo 列表状态与进展如何）日志原因都是 `budget-exhausted`，而原门序下可能记录为 `empty`/`no-active`/`no-progress`（wake/silence 行为同为不唤醒，且真因更准确）；
2. 策略不再能看到 `awaiting-input`/`aborted`——这两种情况本就不该自动续写，询问无意义；
3. `budget-exhausted` 逐策略记录（带策略名）并跳过该策略，后续策略仍可胜出；宿主 settle 事件注册条件从「配置存在」变为「有策略贡献」。

## 5. 决策记录

| # | 决策 | 结论 |
|---|------|------|
| 1 | 目标架构 | 单一 loop 引擎 + 可插拔 policy/仪表，引擎与首个 controller 同建 |
| 2 | 首个新 controller | ~~autodebug~~ → **用户修订：暂缓，先完成引擎抽取与 todo 迁移** |
| 3 | guard 门分配 | ~~三选项~~ → **被第一性原理方案取代**：联锁（停稳+额度）归引擎强制，progress 定位为观测输入而非门 |
| 4 | 第一性原理方案 | 已接受（§2 本质回答 + §3 架构 + §3.5 检查） |
| 5 | 词汇分层 | 引擎面改 loop 词汇（`core/loop`、`LoopEngine`、日志 channel、pi customType `zoo-loop-wake`）；用户面/策略面保留 continuation（`[zoo.continuation]`、`todo-continuation` hook） |
| 6 | 预算配置所有权 | **用户纠偏**：额度上限归策略（贡献携带 `maxWakes`），引擎只执行不持有配置；曾考虑预算状态退回宿主，确认状态归引擎正确 |

## 6. 实施计划

1. **引擎**：重构 `src/core/continuation/`——runner 加联锁（停稳过滤 + 额度检查/记账/重置接口），`decide.ts` 拆解，策略贡献类型简化为 `{sessionID, observations} → Decision`；
2. **策略**：`src/hooks/todo-continuation/` 收编 todo 门与 wake 文案；
3. **适配层**：`src/opencode.ts` / `src/pi.ts` 删除平行预算记账，改调引擎接口；事件翻译、门禁、观测采集、投递不变；
4. **测试**：更新 `decide`/`runner`/双宿主 continuation 测试，验证行为等价（除 §4.3 两处）；
5. **验证**：`./check.sh` + `./test.sh` 全绿。

## 7. 明确不做

- 不新增 controller（autodebug、research 均暂缓）；
- 不改配置项名称、不改 wake 文案、不改汇聚语义（首个 wake 胜出）。

~~不做 per-controller 预算~~——已被决策 6 解除：`maxWakes` 按策略声明、按 (session, 策略) 分账的结构已落地。

## 8. 暂缓项（未来决策点）

引擎迁移完成后、引入第二个 controller 时需要重新打开的决策：

- **autodebug 生命周期**：显式激活 + 状态落盘 / todo 标签 / 隐式推断——讨论中止于此，推荐方向是显式激活（fail-closed），未决；
- **autodebug 与 todo-continuation 的本质区别**：todo 回答"还剩什么工作"，debug 循环状态回答"假设追踪到哪、试过什么、怎么算修好"；
- **多 controller 仲裁**：当前为首个 wake 胜出 + 逐策略预算跳过，多 controller 并存时的优先级语义需重审；
- **结构化完成信号**（OMO goal hook 教训：工具调用优于文本扫描）：作为 autodebug 的退出机制候选。
