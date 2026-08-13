# Subagent 机制横向对比：oh-my-pi / pi-subagents / opencode v1 / opencode v2

**版本:** 1.0
**日期:** 2026-08-13
**分类:** 技术调研报告
**调研对象:** `~/Code/Agent/{oh-my-pi, pi-subagents, opencode, opencode2}`（opencode2 为 anomalyco/opencode 的 v2 重构分支）

---

## 目录

1. [概述](#1-概述)
2. [项目身份与定位](#2-项目身份与定位)
3. [Subagent 机制六维对比](#3-subagent-机制六维对比)
   - 3.1 [定义与声明](#31-定义与声明)
   - 3.2 [发现与注册](#32-发现与注册)
   - 3.3 [调用与委派](#33-调用与委派)
   - 3.4 [上下文隔离](#34-上下文隔离)
   - 3.5 [权限与工具限制](#35-权限与工具限制)
   - 3.6 [结果返回](#36-结果返回)
4. [设计哲学](#4-设计哲学)
5. [架构分层](#5-架构分层)
6. [主 agent 的实现与主/子差异](#6-主-agent-的实现与主子差异)
7. [pi 宿主的多主 agent 能力与 prompt 替换](#7-pi-宿主的多主-agent-能力与-prompt-替换)
8. [关键实现取舍选编](#8-关键实现取舍选编)
9. [对 ZooKeeper 的启示](#9-对-zookeeper-的启示)

---

## 1. 概述

本报告综合对四个 AI coding agent 项目 subagent 子系统的五轮源码调研，覆盖三个层面：

- **机制层**：subagent 从定义 → 注册 → 调用 → 执行 → 返回结果的完整链路
- **设计层**：各项目的设计哲学、架构分层与关键实现取舍（含原文引述与动机证据）
- **对照层**：主 agent（primary/orchestrator）的实现方式及其与 subagent 的差异

所有结论均经源码抽查验证（文件+行号+关键片段）。调研中发现并修正了两处先入为主的错误认知（见 §3.5 pi-subagents 的 ask 仲裁、§7 pi 的 prompt 替换能力）。

## 2. 项目身份与定位

| 项目 | 身份 | subagent 执行载体 | 委派工具 |
|---|---|---|---|
| **oh-my-pi** | pi 宿主的深度定制发行版（OMP） | 进程内独立 `AgentSession` | `task` |
| **pi-subagents** | pi 宿主的扩展（extension） | **独立 OS 子进程**（`pi --mode json -p`） | `subagent` |
| **opencode** | anomalyco/opencode v1.18.18 主线 | 进程内子 session（Effect job） | `task` |
| **opencode2** | 同仓库的 **v2 重构分支**（非独立项目） | 同 v1（plugin 化） | `subagent` |

关键身份判定：opencode 与 opencode2 是**同一 remote 的两条开发线**（`git@github.com:anomalyco/opencode.git`，前者 v1.18.18 `cc4b456129`，后者 v2 分支 `56973e0ca4`），架构差异巨大（v1 单包 `packages/opencode`；v2 拆为 `packages/schema` + `packages/ai` + `packages/core` 的 effect/Schema 驱动架构）。

## 3. Subagent 机制六维对比

### 3.1 定义与声明

四个项目**殊途同归地选择了 Markdown + YAML frontmatter** 作为用户自定义 agent 的格式（opencode 另有代码常量内置 agent）：

| 项目 | 内置 agent | 用户 agent 位置 | 判别字段 |
|---|---|---|---|
| oh-my-pi | 7 个（scout/designer/reviewer/...），构建时嵌入（`task/agents.ts:45-76`） | `~/.omp/agent/agents/*.md`、`.omp/agents/*.md` | frontmatter `tools:`/`spawns:` 白名单 |
| pi-subagents | 6 个（scout/oracle/researcher/worker/reviewer/delegate），`agents/*.md` | `~/.agents/`、`~/.pi/agent/agents/`、项目 `.agents/`、npm 包 | frontmatter `systemPromptMode`/`permissions` |
| opencode v1 | 代码常量 `general`/`explore`（`agent/agent.ts:140-265`） | `~/.config/opencode/agents/`、`.opencode/agents/` 或 opencode.json `agent` 键 | `mode: subagent` |
| opencode v2 | plugin 注入 `general`/`explore`（`plugin/agent.ts:104-141`） | 同 v1（`{agent,agents}/**/*.md`，config/plugin/agent.ts:20-26） | schema 层 `mode: Schema.Literals(["subagent","primary","all"])` |

frontmatter 的 body 即 system prompt——这是四个项目一致的约定。

### 3.2 发现与注册

- **oh-my-pi**：`discoverAgents()`（task/discovery.ts:70-138）按 project > user > 扩展 > bundled 优先级扫描，按 name 去重（高优先级覆盖），带按 cwd 缓存的快照。
- **pi-subagents**：`discoverAgents()`（src/agents/agents.ts:1742-1796）扫内置/用户/项目/npm 包四源，冲突按 project > user > package > builtin 解析；settings.json 的 `agentOverrides` 可覆盖内置 agent；**每次 subagent 调用时重新发现**。
- **opencode v1**：启动时合并内置常量 + 用户配置进内存 map（agent.ts:267-294）；可用 subagent 名单按 `permission.task` 过滤后**静态注入 task 工具描述**（tool/registry.ts:260-273）。
- **opencode v2**：plugin pre/post 编排加载（plugin/internal.ts:197-232）；名单改为 **context hook 每次请求动态注入**工具描述（subagent.ts:247-271）——"可见子代理集合 = 当前 agent 权限 × 已注册集合"的运行时函数，配置热加载后自动反映。

### 3.3 调用与委派

统一模式：orchestrator 模型调用委派工具 → 权限/深度预检 → 创建子执行单元 → 驱动至完成。

- **oh-my-pi**：`task` 工具（task/index.ts:674）→ 批量 preflight（任一失败整体不启动）→ 会话级 Semaphore 限并发 → `runStructuredSubagent` → `runSubprocess`。
- **pi-subagents**：`subagent` 工具（extension/index.ts:570-612）→ `runSync` → **spawn 全新 `pi --mode json -p <task>` 子进程**（execution.ts:482-488）。
- **opencode v1**：`task` 工具（tool/task.ts:92）→ 深度检查（默认 1）→ `ctx.ask` 权限询问 → `sessions.create({parentID, permission})` → background job 包装。
- **opencode v2**：`subagent` 工具（tool/plugin/subagent.ts:121）→ 深度检查 → `permission.assert({action: "subagent"})` → `session.create({parentID})` → `job.start`。

防递归手段各有侧重：oh-my-pi 用 `maxRecursionDepth` + `spawns` 白名单 + 自递归阻断；opencode v1 默认 deny 子会话的 `task`/`todowrite`；v2 靠深度限制 + 内置 subagent 显式 `deny subagent`；pi-subagents 用深度检查 + capability ceiling + 子进程边界指令。

### 3.4 上下文隔离

| 项目 | 隔离模型 | 上下文继承 |
|---|---|---|
| oh-my-pi | 进程内全新 AgentSession（新 SessionManager/JSONL，无历史） | 显式 `context` 参数 + 可选 git worktree 文件系统隔离 |
| pi-subagents | **OS 进程级隔离** | **fork 模式**：`createBranchedSession` 从父会话 leaf 真实分叉（fork-context.ts:180）；或 fresh 全新会话 |
| opencode v1 | 独立 session（独立消息流，parentID 仅导航） | 无继承；`task_id` 可复用同一子会话续跑 |
| opencode v2 | 同 v1 | 无继承；续跑未移植（`origin/subagent-session-id` 分支未合入） |

pi-subagents 的 fork 是独有设计：oracle.md:30 点出其价值——"exploit your clean forked context to spot things the main agent may have missed due to **context rot**"。fork 时会剔除不可重放的 provider 签名 thinking block（fork-context.ts:73-84）。

### 3.5 权限与工具限制

**四种权限哲学**：

1. **oh-my-pi — 静态白名单 + 集中预检**：frontmatter `tools:`/`spawns:` 白名单；所有策略判定集中在 `resolveEffectiveSubagentPolicy`（structured-subagent.ts:245-327），失败在任何子进程启动前抛出（fail-fast）。"授权在父、执行在子"：每次 task 调用即授权边界，子代理强制 yolo（headless 无审批 UI，executor.ts:897）。

2. **pi-subagents — 三层 defense in depth**：`--tools` 启动参数白名单（OS 边界）→ capability ceiling 父子求交、单调向下传播（策略边界）→ `PERMISSION_POLICY_ENV` 传入子进程内 `tool_call` 钩子执行 allow/ask/deny（运行时边界）。**注意**：`ask` 由子进程内 watchdog 的**单次 LLM 仲裁器**裁决（fail-closed，watchdog.md:162 明确 "it does not notify the parent agent"），而非转发父会话批准；父会话决策通道是独立的 `contact_supervisor`，两者刻意分离。

3. **opencode v1 — 声明式 Ruleset（last-match-wins）**：会话携带权限快照；创建子会话时 `deriveSubagentSessionPermission`（subagent-permissions.ts:14-27）**继承父 deny + external_directory 规则、不继承 allow**——"父不能授予子能力，子能力由自己的 agent 决定"。DeniedError 把规则原文回喂模型（"规则即对话"）。双闸门：全 deny 的工具从模型可见性中隐藏（省 token），细粒度 pattern 运行时逐次求值（强制层）。

4. **opencode v2 — agent 自我治理**：session 不再携带权限字段，运行时从 `session.agent` 解析（permission.ts:155-160），未知 agent fail-closed（permission.ts:18）。**父权限继承尚未移植**（subagent.ts:174-175 TODO；修复在 `origin/subagent-permission-inheritance` 分支未合入）。

### 3.6 结果返回

契约强度从弱到强：

| 项目 | 返回通道 | 契约强度 |
|---|---|---|
| opencode v1/v2 | 子会话最后一条 assistant 文本（前台 tool result；后台 synthetic `<task>`/`<subagent>` 消息注入父会话） | 弱（靠文本约定） |
| pi-subagents | 子进程 stdout JSONL 事件流逐行解析取最终输出 + 可选输出文件落盘（可回放可审计） | 中 |
| oh-my-pi | **强制 `yield` 工具** + output schema 三层闭环 | 强（schema 编译进工具参数） |

oh-my-pi 的 yield 机制是最强契约：outputSchema 直接编译进 yield 工具的 parameters（yield.ts:154-193），模型在严格模式下**根本发不出不符合 schema 的结构**；还支持增量 yield（`type: string[]` 按 section 累积，发现一个 bug 就交付一段）。文本输出降级为显式 opt-in 逃生门（`type: string` + 省略 data）。

## 4. 设计哲学

### oh-my-pi：「受管工作单元 + 类型化结果契约」

README.md:165 的三个否定句即三条哲学：**"No prose to parse, no merge conflicts between siblings, no orphaned edits"**——结果不靠解析文本、并发不靠锁文件、修改不靠信任自觉。

- "Subagents start blank" 是并行安全的先决条件：fan-out 的 N 个 worker 互不污染才能安全并发改同一仓库。
- 子代理不做过程汇报、不维护 todo（executor.ts:3198 剥掉 todo 工具："Todos are parent-owned bookkeeping"），只对终态 yield 负责——进度/编排是父的职责。
- 结果同时落盘为可寻址产物（`agent://<id>`），不止是工具返回值，还是可续跑、可被人类接管的持久资产。

### pi-subagents：「进程边界即信任边界」

- 子代理 = 全新 OS 进程：能力在进程边界收缩、崩溃/超时三阶段终止不拖累父、模型/工具可异构。代价是父子通信必须走进程外通道（intercom fs 目录契约、64 KiB 消息上限）。
- capability ceiling 的诚实安全模型：只能向下压不能向上抬，多源求交单调传播；文档刻意声明 "this is a same-process policy boundary, **not a sandbox**"。
- intercom 通信纪律：只用于"升级决策"（need_decision），不用于 routine handoff——"Keep coordination traffic tight and purposeful"。

### opencode v1：「委派 = 带权限快照的子会话（job）」

- 权限从 boolean tools 配置演化为声明式 ruleset：last-match-wins + 参数级 pattern（`bash: {"git push": "deny"}`），同一语法天然覆盖 MCP/自定义工具——新工具无需新代码即被治理。
- **一切 LLM 调用都是 agent 运行**：compaction/title/summary 等内部功能也建模为 hidden agent，共享同一注册表、权限引擎、观测管道。
- task 权限治理的是"模型自主委派"，**用户 @mention 永远豁免**（"只约束模型不约束用户"）。

### opencode v2：「schema 单一事实来源 + agent 自我治理」

- packages/schema 抽离（commit 516cfe4e09）：公共类型/事件契约归 schema，运行时归 core。
- 权限从"写时物化"（v1 spawn 时推导写入 session，曾反复打安全补丁）改为"读时解析"（session 只留 agent 指针）。
- subagent 变成与 read/shell 完全同构的普通插件（奠基提交称为 "safe subagent slice"——建立在 drain-to-quiescence 会话原语之上）。
- v2 未完成度：权限继承、`task_id` 续跑都悬在未合入分支；job 注册表明确非持久化。属于"功能可用、连续性承诺保守"的中期状态。

## 5. 架构分层

```
oh-my-pi（进程内会话模型）
  wire 层 task/index.ts（参数修复/描述渲染/信号量/结果渲染）
  → 策略装配 structured-subagent.ts（全量 preflight + 隔离编排）
  → 执行层 executor.ts 3500 行七阶段（模型解析→工具面→会话→monitor→
    driveSessionToYield→finalize→清理）
  → 支撑层 discovery/worktree/registry + 纯逻辑层（yield-assembly/spawn-policy）

pi-subagents（子进程模型，前后台共享内核）
  extension/（宿主边界）→ runs/foreground|background（同步/异步执行域）
  → runs/shared/（协议与策略内核：child-protocol/pi-args/permissions/
    capability-ceiling/tool-budget，前后台共用避免行为漂移）
  → 子侧 subagent-prompt-runtime.ts（注入每个子进程的镜像扩展）
  父子对称：同一份代码经 PI_SUBAGENT_CHILD=1 env 决定角色

opencode v1（Effect 服务层）
  Agent.Service（注册表）/ Session.Service（CRUD+SQLite）/
  SessionPrompt.Service（runLoop 编排核心）/ Permission.Service（ask 挂起）/
  BackgroundJob.Service（subagent 统一为 job 抽象）
  多入口（@mention/slash command/LLM 自主）收敛到同一 TaskTool.execute

opencode v2（plugin 化分层）
  packages/schema（类型/事件契约，零逻辑）
  → packages/ai（LLM 传输）→ packages/plugin（插件 API）
  → packages/core（state.ts 可重放 transform 引擎 + plugin pre/post 编排
    + session runner/coordinator）
```

## 6. 主 agent 的实现与主/子差异

**四个项目共享同一设计模式：主 agent 与 subagent 共享同一套执行引擎，差异只在配置与驱动方式。**

### oh-my-pi：主 agent 是硬编码的 "Main"

- `MAIN_AGENT_ID = "Main"`（agent-registry.ts:15），无 frontmatter、不可替换，仅可定制（SYSTEM.md/--system-prompt/personality）。
- 主/子共用同一 `AgentSession` 类、同一构造点（sdk.ts:3359）、同一 `agent.prompt → agentLoop` 循环。
- 分叉：主用 250 行完整 harness prompt + 全量工具 + **TUI 人工审批**；子用 63 行 subagent prompt + frontmatter 白名单 + 强制 yield + yolo；主由 TUI REPL 驱动，子由 `driveSessionToYield` 驱动。

### pi-subagents：主 agent 就是 pi 本体，一个 env 决定角色

- 主 agent = pi 二进制本身，无 agent frontmatter 概念。
- `PI_SUBAGENT_CHILD=1` 是分叉总开关：主会话里扩展全量注册（subagent 工具、15 个 slash 命令）；子进程里扩展自禁（index.ts:343），改为注入 runtime 扩展读 env 决定行为。
- 编排知识经 skill 注入主会话（`skills/pi-subagents/SKILL.md` "for the main parent orchestrator only"）；子进程侧 runtime 剥掉该 skill 并前置 "You are a child subagent, not the parent orchestrator" 边界指令。
- 权限不对称：主会话无仲裁（信任门 + 用户在场中断）；子进程内有 LLM watchdog 仲裁 + 工具预算。

### opencode v1：主 agent 是声明式表中的 primary

- build/plan 与 general/explore 同在 agent.ts:140-265 一张表，唯一判别字段是 `mode`。
- mode 判别点遍布入口层：Tab 列表过滤（local.tsx:78）、`--agent` 拒绝 subagent（run.ts:610）、default_agent 拒绝（agent.ts:333）、task 工具列表只收非 primary。
- 主/子跑**同一个 runLoop**（prompt.ts:1081-1341），结束条件相同（finish reason 非 tool-calls 且无挂起 tool call）；**没有 yield 类工具**。
- Tab 切换 = 同一会话原地换 agent（setAgentModel），历史保留，权限/prompt/模型全换。

### opencode v2：共享程度最高，"主 agent 只是 mode 字段"

- 共享同一个 agent 数据模型、权限引擎、context 组装路径、驱动循环（Coordinator drain-to-quiescence）。
- build 之所以是主 agent 仅由三件事决定：`mode: "primary"` + 默认选择规则 + 权限宽松（schema 默认 allow-*）。**没有任何独立执行路径**。
- 分叉仅三处：会话结构（parentID 判别联合）、subagent 工具拒绝 primary 作目标、UI/默认选择的 selectable 过滤。

### 主/子差异总表

| 维度 | oh-my-pi | pi-subagents | opencode v1 | opencode v2 |
|---|---|---|---|---|
| 主 agent 定义 | 硬编码 "Main" | pi 本体 | 声明式表 primary | 同 v1（schema+plugin） |
| 主/子同构性 | 同类不同配置 | 同二进制 env 分角色 | 同表同 runLoop | 同一切仅 mode 字段 |
| 主 agent 编排知识 | 主 prompt 内嵌 | skill 注入 | task 工具描述 | 工具描述动态注入 |
| 主 agent 审批 | TUI 人工审批 | 用户在场中断 | Permission.ask 挂起 | 同 v1 |
| 主 agent 结束条件 | 模型产出最终文本 | 用户退出/单发跑完 | finish reason | drain-to-quiescence |

## 7. pi 宿主的多主 agent 能力与 prompt 替换

调研中修正了两处关于 pi 的错误认知：

### 7.1 pi 不内置多主 agent，但非硬性限制

- `AgentSession` 持有唯一 `Agent` 实例；pi 无 opencode 意义的 agent/mode 概念（"agent" 指配置目录，`--mode` 指输出格式）。
- Tab 键是自动补全（keybindings.ts:233），无任何键绑定到角色切换。
- 但扩展层积木齐全：`before_agent_start` 每轮可改写 prompt + `setActiveTools`/`setModel` + `registerCommand/Shortcut`。examples 里 `preset.ts`（plan/implement 预置 + Ctrl+Shift+U）与 `plan-mode/`（只读模式 + Ctrl+Alt+P）合起来功能上等价 opencode 的 build/plan，只是需手动安装且各自为政。

### 7.2 pi 可以整体替换主 agent 的 prompt（修正前一轮错误结论）

两条真替换路径（经源码核实）：

1. **静态**：`--system-prompt`/SYSTEM.md → `customPrompt` 存在时内置模板路径**整个跳过**（system-prompt.ts:46-72），只保留 append 段 + project context + skills + cwd。
2. **动态**：`before_agent_start` 返回 `systemPrompt` → `_systemPromptOverride` **整体替换**（agent-session.ts:1254-1256），每轮触发一次。

pi 与 opencode 的真实差距不在 prompt 替换能力，而在：无多 agent 注册表（扩展需自己维护角色状态）、无内置切换 UI、工具/权限不随角色绑定（需分别调多个 API 拼装）。

## 8. 关键实现取舍选编

**T1. oh-my-pi 选进程内会话而非子进程**：子代理直接复用父的 MCP 连接、模型注册表、LSP、ArtifactManager、OTEL span（传对象即可，子进程需序列化整套协议）；代价是崩溃不隔离，用严格的 finally 清理链 + park 语义补偿。

**T2. oh-my-pi 的 quiescence barrier**："run 的终结条件 = 异步树上无未决工作且 yield 是最新的，而不是模型说完了"。后台 job 晚到的结果使旧 yield 失效（yieldInvalidatedByAsync），绝不把过时 payload 当最终报告。

**T3. oh-my-pi 的 provider 级信号量按请求持锁**（不按 agent 生命周期）：否则宽度超过上限的 spawn 树必然死锁（父持锁等子、子等锁，issue #3749）。

**T4. pi-subagents 的防 EDR 设计**：task 文本走 `@task.md` 文件投递而非 argv（端点保护扫描长自然语言 argv 会 SIGKILL）；对"零活动 SIGKILL"重试 3 次但故意 fail-closed（有任何输出痕迹就不重试）。

**T5. pi-subagents 的 fork 上下文卫生**：剔除带 provider 签名的 thinking block（无法在子会话重放），anthropic API 时 fork 强制 `thinking: off`；`alignForkedSessionCwd` 防止 fork 会话恢复到父的 cwd。

**T6. opencode v1 的 job 注册表刻意不持久化**（background-job.ts:113-119）："process restart loses status... Persisted observation needs a separate durable ownership slice rather than pretending this registry has those semantics"——恢复能力靠会话持久化而非 job 状态。

**T7. opencode v2 砍掉 task_id 续跑的设计立场**：specs/v2/session.md:86-90 明确自动续跑"requires a separate design covering provider-dispatch ambiguity, tool idempotency, retry budgets"——把复用子会话视为需显式设计的能力而非免费参数，先守住 fresh context 纪律。

## 9. 对 ZooKeeper 的启示

1. **主/子共享执行引擎、靠配置分叉**是四个项目的共识。ZooKeeper 的单元化 compose（profile 选择启用单元）与 opencode2 的 plugin pre/post 编排同构，路线正确。

2. **编排边界的强制方式**三种各有代表：oh-my-pi 靠工具面裁剪、pi-subagents 靠进程隔离 + env 角色、opencode 靠权限规则。ZooKeeper 的"静态配置 deny + prompt 注入"双通道正是 oh-my-pi（工具面）+ opencode（权限规则）的混合。

3. **结果契约强度**：oh-my-pi 证明把协议编译进工具 schema 比写在 prompt 里可靠——ZooKeeper 的 SUMMARY/CONTEXT/ACCEPTANCE 委派格式是同构思想的 prompt 层实现，未来可考虑工具 schema 化。

4. **pi 宿主能力上限比预期高**：profile 切换时可以经 `before_agent_start` **整体替换** dolphin 的 system prompt（agent-session.ts:1254-1256），当前 compose-pi 用 prepend 是实现选择而非宿主限制。

5. **连续性承诺是最难做对的部分**：opencode v2 的权限继承与续跑至今悬在未合入分支，其 specs 明确把恢复列为需显式设计的能力。ZooKeeper 若规划会话恢复/续跑，应在设计初期显式决策（provider-dispatch 歧义、工具幂等、重试预算），而非事后补。

6. **fail-closed 哲学一致**：pi-subagents 的 watchdog 仲裁、opencode v2 的 missingAgentPermissions、ZooKeeper 的 null profile 全失效，都是"缺信息时拒绝而非放行"的同一原则。

---

## 附：调研方法与证据说明

本报告由五轮调研综合而成：① oh-my-pi/pi-subagents 机制调研；② opencode v1/v2 机制调研；③ 四项目设计哲学与架构深挖；④ 四项目主 agent 实现调研；⑤ pi 多主 agent 能力与 prompt 替换专项查证（修正了前轮两处错误结论）。每轮结论的关键引述均经编排器直接 grep/read 抽查验证（如 README.md:165、watchdog.md:162、agent-session.ts:1254-1256、keybindings.ts:233、task.txt:16、permission.ts:18 等）。详细文件:行号证据分散在各章节正文中。
