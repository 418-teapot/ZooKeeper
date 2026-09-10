# ZooKeeper 自建 Todo 工具调研报告

> 调研日期：2026-08-13
> 更新：2026-09-06 源码核实 oh-my-pi（todo.ts 1273 行 / todo-tracker.ts 399 行 / todo.md 44 行）与 pi 示例（todo.ts 297 行），修正动画范围、守卫数量等转述误差，新增 4.5 TUI 呈现设计
> 更新：2026-09-10 参数形状决策改写——从 `{op, entries[]}` 批量信封改为扁平字段、一次调用一个 op（见 4.6），原子性语义随之从"同 op 批量整批原子"改为"单 op 单次调用原子"
> 更新：2026-09-10 清单字段改名 `items` → `tasks`（见 4.6.2）——实测调用方反复把清单写成标量字段 `task`（同工具内高频合法字段成了错误吸引子，干净上下文的首次调用即错），改复数 `tasks` 与"task 管单个、tasks 管清单"的直觉对齐；`items` 就此退役、不再被接受，与任意未知字段同等拒绝。本工具与 oh-my-pi 的字段名自此不同（见 4.6.6）
> 关联文档：[pi-subagent.md](pi-subagent.md)、[todo-nudge-research.md](todo-nudge-research.md)

## 1. 背景与动机

### 1.1 触发点：OpenCode v2 删除 todo 工具

OpenCode v2 分支（`~/Code/Agent/opencode2`）通过 `7feefb697f refactor: remove todo tool (#35989)`（2026-07-09）整体移除 todo 功能：todowrite 工具、session todo 服务、schema、HTTP 路由、SDK 方法、全部 UI 渲染，250 个文件。删除理由从代码面可推断为：

- 功能横跨 schema + SQLite 表 + 事件 + HTTP 路由 + TUI + 4 份模型 prompt，表面巨大，但**状态机完全在 prompt 层**（"exactly one in_progress" 代码零校验），代码只是哑存储；
- todoread 已于 2026-03 作死代码删除（`77fc88c8ad`），证明模型侧价值趋零——模型靠自己 todowrite 回显的全量 JSON 自持状态；
- v2 把"分步规划+逐步勾选"纪律搬回系统 prompt，工具本身无不可替代逻辑。

### 1.2 对 ZooKeeper 的现实影响

ZooKeeper 当前依赖宿主 todo 的链路：

- `src/core/client/todo.ts:43-67` `getTodoState` 调 v1 SDK 的 `client.session.todo()`（GET `/session/{id}/todo`，读 SQLite TodoTable）；
- `src/core/checks.ts:117-149` `checkTodoProgress` 消费 todo 状态生成三种 nudge（`TODO_PROGRESS_NUDGE` / `TODO_DONE_NUDGE` / `TODO_RESUME_NUDGE`，定义在 `src/core/prompts.ts:115-147`），挂接在 post-task-nudge hook（task() 返回后校验）；
- 防护已存在：`checks.ts:124` `typeof client.session?.todo !== "function"` 时静默返回 null——**v2 下 SDK 方法不存在会抛 TypeError，但防护使 todo nudge 静默失效，plan nudge 不受影响**（plan 机制走 `.zoo/plans/` 文件系统，完全独立）。

即：v2 迁移后 ZooKeeper 不会崩，但**静默丢失 todo 进度感知能力**。且 v1 宿主的 todo 只有"读"通道对插件开放（SDK 无 todowrite 写方法），ZooKeeper 无法借助宿主 todo 做更多编排。自建 todo 工具同时解决"v2 断供"和"能力封顶"两个问题。

### 1.3 用户侧判断

todo 的"好用"已被多轮调研定位：80% 来自 prompt 工程（工具描述手册 + few-shot + 人可见 UI），而非工具本身逻辑。这意味着自建成本低、收益确定——核心资产是 prompt 纪律与一个薄状态机。

## 2. 参照系：三种 todo 设计

### 2.1 OpenCode v1：极薄"哑存储 + prompt 纪律"

- 数据模型：扁平 `{content, status, priority}`，4 态（pending/in_progress/completed/cancelled），SQLite 存储；
- 更新语义：单工具 `todowrite`，参数只有一层批量数组 `{todos: [{content, status, priority}, ...]}`，**全量替换**（session/todo.ts:33 先 delete 全表再 insert）——无 op 分支、无增量操作，调用面最简单（也就最不易调错）；
- 模型交互：无 todoread，靠写回回显自持状态，无任何自动注入；
- 权限：`always: ["*"]` 批准一次全程免问；子代理默认 deny（"parent-owned bookkeeping"）；
- UI：TUI 侧边栏（todo.updated 事件驱动），全 completed 时整块隐藏。

### 2.2 oh-my-pi：深度制度化的"编排记账本"（1273 行 todo.ts + 399 行 tracker）

**设计哲学四个支柱：**

1. **content 字符串作标识、禁止 ID**——"todo 是给模型自己看的便签，不是给程序索引的数据库"。模型传 `task-\d+` 会收到显式纠错回退到"看上一次结果"；重复 content 在 init/append 前置拒绝（重复即不可寻址）；5-10 词限制保证逐字可复述。
2. **block 语义 = 卡在不可自主推进的外部依赖**——与终结态正交；blocked 不计入收尾提醒；"能自己解阻就该 append 解阻任务而不是 block"。
3. **init 逐条承诺纪律（`<critical>` 块）**——用户列举的多步计划 MUST 逐条 init，"NEVER summarize into fewer tasks, sample 'the important ones', or track from memory"。
4. **todo 调用不许独占一轮**——"Batch with real work: init with first reads/edits"，solo todo turn 浪费一次模型往返。

**架构要点：**

- 分 phase 5 态（pending/in_progress/completed/abandoned/blocked+blocker 原因），9 个 op 增量更新（init/start/done/drop/rm/block/unblock/append/view）；
- **参数形状是扁平的**：`{op, list?, task?, phase?, items?, reason?}`——除 op 外只有 5 个可选参数字段，全部直接放在顶层，没有批量信封数组；一次调用只描述一次状态迁移；
- 单个 op 内部是原子的：`append`/`init` 的 items 先整批校验再变更（todo.ts:410-424、438-455），任一条目非法则该次调用整体不落库（execute 层同样整批回滚 previousPhases，todo.ts:884-891）；
- `normalizeInProgressTask`：多 in_progress 只留第一个，无 in_progress 自动提升最早 pending（todo.ts:146-161）；
- TodoTool 声明 `concurrency = "exclusive"`、`lenientArgValidation = true`，缺 op 时 `inferTodoOp` 从参数形状推断（todo.ts:567-595）；纠偏靠三层防线——`lenientArgValidation`（宽松参数校验，不合规不直接抛错）+ `inferTodoOp`（op 推断）+ 工具描述里 8 条内联示例；**注意 `lenientArgValidation` 与 schema 的 `examples` 字段都是 oh-my-pi fork 私有的，上游 pi 不存在**；
- 持久化 = toolResult `details.phases` 快照进 session JSONL + `user_todo_edit` 自定义条目（用户编辑最高权威）；**恢复 = 从 transcript 倒序取最新快照，不重放 op 历史**（todo.ts:177-202：先认 `user_todo_edit` 条目，回退到最近一条成功 todo toolResult 的 details.phases）；内存态只是缓存，6 个时机 syncFromBranch 重建；
- 模型引导三件套集中在 `session/todo-tracker.ts`（399 行 TodoTracker 类），宿主接线在 agent-session.ts：
  - **eager prelude**（todo-tracker.ts:133-172）：三档 `default`（不产 prelude）/ `preferred`（软提醒，无 tool_choice）/ `always`（模板 forced 分支 "You MUST call todo first"+ `buildNamedToolChoice` 强制首轮 tool_choice）。强制按 provider 分形：anthropic/bedrock `{type:"tool"}`、openai 系 `{type:"function"}`、google 系 `"required"`（退化为强制任意工具，语义已偏）。**只对带真实 prompt 的首轮生效**——转录已有 user 消息、`?`/`!` 结尾、plan mode、prewalk handoff 均跳过；post-compaction 重建只发 reminder 不强制；
  - **checkCompletion 停手清点**（todo-tracker.ts:204-290）：**9 个守卫**——user-force 工具轮 / plan mode / 提醒后无进展防轰炸 / reminders 或 enabled 关闭 / 达 remindersMax（默认 3）/ 无 phases / 无 pending+in_progress / 等用户回答 / async job 在飞。触发后发 `role:"developer"` 的 `<system-reminder>` 并 `scheduleAgentContinue`；防轰炸窗在任意工具结果到达时即解除；
  - **takeMidRunNudge 中途纠偏**（todo-tracker.ts:296-321）：只统计成功的 mutating 工具（`{bash, eval, edit, write, ast_edit}`），**任何一次 todo 调用把计数清零**（mark-sweep：模型有在记账就不烦它）；阈值 12、每 prompt 周期最多 2 次、LLM 调用前 injection-time 求值（调用前刚勾选 todo 则本轮不注入）；
- UI：粘性 HUD（`TodoHudContainer extends AnchoredLiveContainer`，interactive-mode.ts:417，挂在 transcript 之外、编辑器上方常驻；终端 <18 行降级为单行 compact status）+ 瞬态渲染器共享同一折叠视口策略（`selectCollapsedTodos`，todo.ts:332-344；HUD 活跃任务 cap=5 + 后续阶段 cap 4；#5873 在源码 5 处显式标注）；完成划线动画（2 hold + 12 reveal = 14 帧 × 65ms，todo.ts:989-991 + tool-execution.ts:657-682）**只在瞬态工具卡片播放，HUD 完成行为静态 `chalk.strikethrough`**（interactive-mode.ts:2412）；`/todo` 命令全家（13 子命令含 $EDITOR Markdown 往返，blocker 藏 HTML 注释，todo.ts:642-647）；
- 编排联动：subagent 完成自动勾选匹配描述的父 todo（归一化+双向子串、最小 6 字符重叠；blocked 纳入——完成即解阻信号；failed/aborted 不勾）；prewalk 门控（提交 todo 后才切便宜模型）；
- 用户手动清空时注入 "Do NOT recreate or re-populate"（issue #5258）阻断模型下一轮重建——`buildSystemReminder` 两档文案（清空档/移除档，todo-command-controller.ts:121-139），`role:"developer"` 消息双写 agent + sessionManager；
- 权限：todo 声明 read tier（todo.ts:800，三种 approval 模式默认全 auto-approve，**无 per-op 分档**），用户可经通用 `tools.approval.<tool>` 覆盖；**subagent 默认剥离 todo**（task/executor.ts:3500-3511，注释原文 "parent-owned bookkeeping"，prewalk 手off 例外——子会话需自建清单后交接）；
- 工具描述手册 `prompts/tools/todo.md` **恰好 44 行**，结构：Operations（9-op 表）/ Anatomy（task content 5-10 词、what not how；phase 短名词短语，NEVER 前缀 `1.`/`A)`/`Phase 1:`）/ Rules（完成立即 done；"NEVER make a todo call the turn's only tool call"；丢文本用 view 取、"NEVER guess from memory"）/ `<critical>`（用户列举的多步计划 MUST 逐条 init，"NEVER summarize into fewer tasks, sample 'the important ones', or track from memory"）。

### 2.3 pi 官方示例：`examples/extensions/todo.ts`

pi 宿主自带一个完整的 todo 扩展示例（297 行），证明了关键模式：

- **状态存 toolResult details**——"State is stored in tool result details…when you branch, the todo state is automatically correct"（todo.ts:8-11），分支/恢复天然正确（注意：docs/extensions.md:2949 表格称该示例用 `appendEntry`，系文档勘误，实际实现是 details 内嵌状态）；
- session_start/session_tree 时从 `ctx.sessionManager.getBranch()` 重建状态；
- registerTool + renderCall/renderResult + registerCommand(`/todos`) + `ctx.ui.custom()` 全屏组件。

**pi 无内置 todo 工具**（内置仅 bash/edit/find/grep/ls/powershell/read/write 等 9 个），todo 仅以扩展示例形式存在。pi 扩展的 TUI 可视化通道全景（类型定义在 `src/core/extensions/types.ts` 的 ExtensionUIContext，L133-307）：renderCall/renderResult 逐槽位覆盖默认渲染；**`ui.setWidget(key, content, {placement: "aboveEditor"|"belowEditor"})` 编辑器上下常驻 widget**（字符串数组或组件工厂，string-array 形式截断到 MAX_WIDGET_LINES=10；官方 tui.md Pattern 5 注明 "Good for todo lists, progress"）；`ctx.ui.custom()` 全屏或 `{overlay: true}` 浮层；`setStatus` footer 单行、`setHeader/setFooter` 整条替换；pi-tui 自带 `HStack`/`VStack`/`Box` 布局组件（packages/tui/src/components/）。**无侧栏 API**——布局是纵向五层（transcript/status/widgets/editor/footer）。

这是 ZooKeeper pi 侧实现的最小参照蓝本；oh-my-pi 是完整度参照蓝本。

## 3. 双宿主可行性（已验证）

### 3.1 OpenCode v1 ✅

与 ZooKeeper 现有 compress/decompress 工具完全同一条路：

- `Hooks.tool` 映射注册（`packages/plugin/src/index.ts:226-228`）+ `tool()` 工厂（`tool.ts:45-54`）；
- ToolContext 提供 `sessionID`/`agent`/`directory`/`ask()`；
- 注册表合并 `tool/registry.ts:194-199`；primary 可见性走 `experimental.primary_tools`（ZooKeeper 已在 compose-opencode.ts:173-197 使用）；
- 持久化先例：pruning 状态写 `~/.zoo/storage/{sessionId}.json`（marks.ts:483）。

### 3.2 OpenCode v2 ✅（需重写插件入口）

- v2 插件只接受两种形状：`Plugin.define({id, effect})`（Effect API）或 `{id, setup}`（Promise API）（supervisor.ts:18-33,103）——v1 形状不兼容；
- 工具注册：`ctx.tool.transform(draft => draft.add(Tool.Info))`，与内置 read/write/subagent 同一通道（promise.ts:227-242 / host.ts:303-313）；
- 差异：v2 无 `experimental.primary_tools`（可见性靠 permission/policy）；Tool.Context 无 `directory`/`ask`；
- **注意：ZooKeeper 目前尚未支持 v2 宿主**，v2 适配是独立课题，todo 工具只需保证核心逻辑宿主无关，v2 适配层届时补。

### 3.3 pi ✅（四项能力全部可行）

| 能力 | 结论 | 关键证据 |
|---|---|---|
| 工具注册 | ✅ | `ExtensionAPI.registerTool`（types.ts:1251-1253），官方示例 todo.ts:136 |
| 会话状态 | ✅ | 读：`ctx.sessionManager.getBranch()`；写：toolResult details / `pi.appendEntry()` |
| 持久化 | ✅ | details 自动进 transcript（不进 LLM context）；CustomEntry "Persist extension state across session reloads"；任意文件写入 |
| TUI 呈现 | ✅ | renderCall/renderResult 逐槽位覆盖；`ctx.ui.custom()` 全屏/overlay；`setWidget` 编辑器上下常驻（10 行上限）；`setStatus` footer；无侧栏 API |

pi 侧缺 oh-my-pi 的宿主级能力：无 approval 分档、无 `lenientArgValidation`、无 schema `examples` 字段（后两者均为 oh-my-pi fork 私有，上游 pi 不提供）、无 TodoTracker 宿主集成（可用 ZooKeeper 已注册的 `before_agent_start`/`tool_result`/`context` 事件近似）、无 `scheduleAgentContinue` 等价物。

上游 pi 能提供的相关机制只有一条：**参数校验错误以 tool result 的形式回流给模型**（不中断会话），因此错误消息本身就是纠偏通道。曾考虑的 `prepareArguments` shim 已在 4.6 的决策中放弃——扁平形状 + 运行时按字段形状推断 op 已覆盖 `lenientArgValidation` + `inferTodoOp` 想解决的问题，不需要额外的参数改写钩子。

## 4. ZooKeeper 自建 todo 工具设计

### 4.1 架构：核心状态机宿主无关 + 薄适配层

复用 ZooKeeper 既有架构分层（core 纯逻辑 / hooks 薄适配 / 双入口）：

```
src/core/todo/
├── types.ts        # TodoItem/TodoPhase/TodoStatus 类型（纯类型，零 import）
├── state.ts        # 状态机：9 op apply、normalizeInProgressTask、整批回滚原语、
│                   #   去重、content 匹配（照抄 oh-my-pi 纯逻辑 ~500 行，改写成 zoo 风格；
│                   #   applyEntries 仍收数组，但工具层每次只传一条，见 4.6）
├── markdown.ts     # phasesToMarkdown/markdownToPhases（状态标记 + blocker HTML 注释）
├── summary.ts      # formatSummary（模型回显文本）
└── store.ts        # 快照持久化抽象：append/read latest snapshot（宿主无关接口）

src/hooks/todo-tool/    # OpenCode 工具适配器（Hooks.tool + tool() 工厂）
src/pi.ts               # pi 侧 registerTool（复用 core/todo，适配 TypeBox schema）
```

**关键架构决策：状态存哪里？**

两个宿主的最佳实践一致指向 **toolResult details 快照**（pi 官方示例模式 + oh-my-pi 主通道）：

- 每次 todo execute 把完整 phases 放进返回的 details，随 toolResult 消息持久化；
- 恢复 = 从会话消息倒序找最新 todo toolResult 的 details（OpenCode 侧经 client.session.messages 读，pi 侧经 ctx.sessionManager.getBranch()）；
- 优点：分支/恢复天然正确、不进 LLM context、无额外文件管理；
- 备选：`~/.zoo/storage/todo-{sessionId}.json` 文件（pruning 先例）——实现更简单但分支语义错误（分支后两个分支共享一份 todo）。**推荐 details 快照，文件作为 fallback**。

### 4.2 数据模型与 op 集：照抄 oh-my-pi，砍掉编排联动

采用 oh-my-pi 的完整模型（分 phase 5 态、9 op、content 寻址、单 in_progress 自动提升、单 op 单次调用原子），理由：

- 这些是**纯逻辑零宿主依赖**（oh-my-pi todo.ts 中约 500 行可直接改写），已被生产验证；
- content 寻址 + 5-10 词 + 禁 ID 是最防幻觉的设计，opencode v1 的全量替换在**更新能力**上落于下风（其调用面简单的优势由 4.6 的扁平形状吸收，见 4.6.6）；
- blocked/abandoned 语义对编排器场景（等 subagent、等用户）有直接价值；
- op 词表与参数字段名沿用 oh-my-pi 的扁平形状（见 4.6），已验证的调用形式不必重新发明。

**原子性语义：单 op 单次调用原子**——一次调用只承载一个 op，出错时该次调用对状态零改动（core 返回输入状态、不落快照），错误原因逐条报回。"同一次调用里批量勾完多个任务"的能力不再提供，批量意图改由"发多条调用"表达。

**暂不做**（依赖宿主深度集成，超出现有通道）：subagent 完成自动勾选（除宿主集成难度外，归一化+双向子串模糊匹配改父级状态有 false positive 风险——若做，联动只应做 UI 点亮提示、不做状态变更）、prewalk 门控、粘性 HUD（OpenCode 插件无 TUI 槽位；pi 侧经 setWidget 双列 widget 实现，设计见 4.5）。

### 4.3 模型引导：ZooKeeper 现有事件通道已够用

| oh-my-pi 机制 | ZooKeeper 对应通道 | 现状 |
|---|---|---|
| 工具描述手册（todo.md 44 行） | 工具 description 字段 + `before_agent_start` prompt 注入 | 可直接移植文案；description 另附 9 条内联示例（每 op 一条最小合法调用，见 4.6.4） |
| eager prelude（首轮建议建 todo） | `before_agent_start` 每轮注入（已注册） | 可实现 preferred 档；always 档的强制 tool_choice 两宿主均无公开 API，放弃 |
| checkCompletion 停手清点 | OpenCode：`stop`/`idle` 类事件 + client 读消息；pi：`agent_end` 事件 | 需新增 hook 单元，跳过条件照抄（等用户回答/提醒后无进展/max 上限） |
| takeMidRunNudge 中途纠偏 | ZooKeeper 已有 `tool_result`/`afterExec` 通道 + direct-work-nudge 先例 | 可实现：计数成功 mutating 工具 ≥12 且期间无 todo 调用则注入 aside |
| 用户手动清空 "Do NOT recreate" | 斜杠命令单元（commands/ 先例：go/dcp） | `/ztodo` 命令 + reminder 注入 |

checkCompletion 和 mid-run nudge 是 oh-my-pi 调研中定位的"低成本高收益"机制，且全部可在 ZooKeeper 现有 compose 单元架构内实现（新增 hook 单元进 registry.ts，profile 门控）。

### 4.4 与既有机制的关系

- **plan 文件（.zoo/plans/）**：持久化的批准方案文档，与 todo（执行中细分清单）分工不变；plan checkbox 纪律保留。todo 工具就位后，`buildPlanReference` 的 "Update the plan's TODO checkboxes" 纪律可与 todo 工具并存（plan=跨会话方案，todo=会话内执行）。
- **getTodoState/checkTodoProgress**：改造为读**自建 todo 状态**（details 快照或 store），不再依赖宿主 `session.todo`——v1/v2/pi 三端统一，同时解决 v2 断供。
- **permission**：config.toml 声明各 agent 对 todo 工具的 permission（subagent 默认 deny "parent-owned bookkeeping"），install.py 编译进双宿主配置——与现有 deny 机制完全一致。

### 4.5 TUI 呈现设计（2026-09-06 讨论定稿）

**形态：pi 侧 `zoo` widget 内双列并排——左 subagent（fleet）右 todo**，不开新 widget key（`onTerminalInput` 是单例监听，单组件内分发更简单；总高度一笔预算统一分配）。

- **布局**：widget 工厂返回 `HStack([fleetCol, todoCol])`（pi-tui 现成组件），中间 `│` 分隔；宽度 fleet 55% / todo 45%（todo content 限 5-10 词，窄列天然适配）；**终端 <100 列降级为 VStack 纵向堆叠**（fleet 在上、todo 在下，各 cap 4 行）；**布局决策属 pi 宿主约束，不进 core**（评审后决定：P5 接线时在 pi 适配层实现，core 只保留视图投影策略），宽窄两形态共享同一套行渲染函数；
- **高度**：两列各自 cap 7 行窗口，整高 ≤8 行（并排取 max 而非求和，两列常显，不需要展开/收起状态机）；折叠态保留 1 行双列摘要（各列 = 计数 + 当前活跃项名，空列显示占位 `代理 —` 保持列结构稳定）；两列都空时整行隐藏不占高度；
- **键位**：`tab` 左右切焦点（焦点列标题反色），`↑↓/jk` 只作用焦点列，`esc` 折叠为摘要行；沿用 fleet 现有守卫——编辑器非空时 collapsed 不抢键（widget.ts:29-33）；
- **数据流**：实时 = `tool_result` 事件识别 `toolName === "todo"` 读 details 刷新；恢复 = `session_start`/`session_tree` 从 `sessionManager.getBranch()` 倒序扫最新 todo details（与官方 todo.ts 示例、fleet 历史重扫 pi.ts:1325-1359 同一模式）；details → 视图模型为 core 纯函数，双宿主共享。

**显示效果（定稿稿）：**

展开（宽终端 ≥100 列，双列并排；`●` 按语义着色，spinner 逐帧转）：

```
▾ 代理 1/3                  │ ▾ 待办 3/7
⠋ beaver 实现状态机 · 12k  │ ● 核实 oh-my-pi 实现      （绿 + 划线）
○ lynx 调研 TUI            │ ⠋ 实现核心状态机           （黄）
                           │ ○ OpenCode 工具适配        （dim）
                           │ ● 等用户确认 UI 方案       （黄，blocked）
                           │ ○ pi 工具适配
                           │ +2
```

折叠（1 行，双列各压成摘要）：

```
▸ 代理 1/3 ⠋ beaver 实现状态机 │ ▸ 待办 3/7 ⠋ 实现核心状态机
```

窄终端降级（<100 列，VStack 纵向堆叠，fleet 在上、todo 在下，行数预算由适配层给）：

```
▾ 代理 1/3
⠋ beaver 实现状态机 · 12k
○ lynx 调研 TUI
▾ 待办 3/7
● 核实 oh-my-pi 实现      （绿 + 划线）
⠋ 实现核心状态机
○ OpenCode 工具适配
+3
```

**统一符号词汇（glyph = 语义，与所属列无关；core 共享常量，渲染函数从表取符号，禁止散落硬编码）：**

| 语义 | 表达 |
|---|---|
| 结构（折叠/展开） | `▸` / `▾`，仅列标题前缀 |
| 活跃（in_progress = running） | spinner 动画字符，warning 黄 |
| 等待（pending = queued） | `○`，dim |
| 完成（completed = done） | `●` 绿色（todo 侧附加划线） |
| 失败（error） | `■` 红色 |
| 取消/放弃（aborted = abandoned） | `■` 灰色 |
| 阻塞（blocked，todo 专有） | `●` 黄色静止（与 spinner 靠静/动区分） |

规则：结构符号与状态符号是两个不相交集，每个符号在全 widget 只有唯一含义；语义全走颜色通道（复用 fleet 的 `hueToPiColor`，widget.ts:269），完成划线动画与 spinner 共用 fleet 现有 150ms 刷新时钟（widget.ts:35），无需新增定时器；禁用 emoji（双宽度破坏 `truncateToWidth` 列对齐）；计数一律 `完成/总数`，溢出 `+N`，附属信息 `·` 分隔，选择/焦点用 selectedBg 背景带表达（不用 SGR 7 反色——会翻转行内语义色），不新增符号。

**OpenCode 侧**：`ZookeeperPanel`（src/adapters/opencode/tui/index.tsx，sidebar_content 槽位）加一个 todo 可折叠 section，与现有 4 个 section 同构；数据通道宿主现成（`api.state.session.todo(sessionID)` + `todo.updated` 事件），自建 todo 落地后切换为读 details 快照；行内布局注意 opentui 当前版本 three-child flex 不可用（index.tsx 注释明示）。**v2 侧**：TUI 槽位 API 待调研，视图模型宿主无关，届时只补渲染适配。

### 4.6 参数形状：扁平字段 + 一次调用一个 op（2026-09-10 决策）

本节记录一次**被生产证据推翻的设计**，是 todo 工具能否被模型稳定调起的关键。

#### 4.6.1 为什么推翻 `{op, entries[]}` 信封

第一版参数形状是 `{op, entries[]}`：`entries` 是一个判别联合数组，同一次调用可携带多条同 op 条目（换取"同 op 批量整批原子"）。落地后模型调用**连续失败 9 次**，失败方式高度一致——漏传 `entries` 信封（把 `task`/`items` 直接平铺到顶层），重试时仍犯同一个错。

失效机理不是文档不清楚，而是**生成式模式锁定**：上下文里一旦出现自己犯过的错误样本，模型会把它当 few-shot 继续强化；抽象的错误描述（"缺少 entries 字段"）无法打断这个循环，同一轮内的重试只会复制同一个错。能打破循环的是**结构性变化**，不是更详细的说明。

于是把参数形状本身换掉：扁平字段、一次调用只有一个 op。"信封"这个概念不再存在，也就无从漏传。

#### 4.6.2 schema 形状与字段规则

```
{ op, list?, tasks?, phase?, task?, reason? }
```

除 `op` 外只有 5 个可选参数字段，全部平铺在顶层，没有任何数组信封。每个 op 只接受自己那一份字段：

| op | 接受的顶层字段 | 最小合法调用 |
|---|---|---|
| init | `list` **或** `tasks`（可配 `phase`），二者互斥 | `{"op":"init","list":[{"phase":"实现","tasks":["改 schema"]}]}` |
| start | `task` | `{"op":"start","task":"改 schema"}` |
| done | `task` | `{"op":"done","task":"改 schema"}` |
| drop | `task` \| `phase` 恰好其一 | `{"op":"drop","task":"改 schema"}` |
| rm | `task` | `{"op":"rm","task":"改 schema"}` |
| block | `task` \| `phase` 恰好其一 + `reason` | `{"op":"block","task":"改 schema","reason":"等用户确认方案"}` |
| unblock | `task` \| `phase` 恰好其一 | `{"op":"unblock","task":"改 schema"}` |
| append | `phase` + `tasks` | `{"op":"append","phase":"实现","tasks":["补文档"]}` |
| view | 不带任何字段 | `{"op":"view"}` |

字段规则：

- **单复数按意图分职**：`task`（单数）永远指向一个任务，`tasks`（复数）只出现在意图天然复数的 op（`init` 建清单、`append` 追加任务），二者永不同时属于同一个 op。清单字段最初拼作 `items`，因调用方反复把它误写成 `task`（复数 `items` 与单数 `task` 之间没有形态上的对应关系），2026-09-10 改名 `tasks`；批量语义仍由"发多条调用"承担，清单字段本身仍只是一份扁平数组，不是信封。
- **每个 op 各自持有字段白名单**，不只拒绝未知字段：一个对本 op 无意义的字段若被忽略，`done`/`rm` 就成了"无目标"，而 core 把无目标读作"全部任务"——打错一个字段就能清空整个清单。爆炸半径在参数边界收口。
- **三个破坏性 op 中，`done`/`rm` 只接受 `task`**：收到批量形状的字段（`tasks`/`list`）时，纠偏文案指向“拆成多条调用”，而不是指向一个会放大爆炸半径的字段。`drop` 例外地接受 `phase`：分界线是记录是否保留——drop 记为 abandoned（记录可观测），整阶段放弃是真实的单一意图；rm 是抯除记录（不可逆），批量抯除没有正当意图场景，必须逐条点名。
- **状态变更在工具内部串行**（store 自带的 promise 链闸门，见 `core/sequencer`）：宿主默认并发一轮内的多个工具调用，并发 todo 会对状态缓存丢更新、写出分叉快照。不用 `executionMode: "sequential"` 声明——pi 的批次调度是“任一 sequential 则整批串行”，该声明会把同批次的无关工具（如并行 subagent 派发）一起拖慢；互斥收进工具内部后保护粒度等于资源粒度。

#### 4.6.3 分层校验：schema 管形式，运行时管意义

- JSON Schema 只能表达"这 6 个字段的类型"，表达不了"`init` 的 `list` 与 `tasks` 二选一""`block` 的 `task`/`phase` 恰好其一"这类跨字段约束，两宿主也不会为它报错；
- 所以这些约束全部放在 execute 入口的参数解析里，与类型错误共用同一条失败通道——模型收到的都是一条带示例的 todo 参数错误，不需要区分两种报错风格；
- `op` 在 schema 层同样可选（`required: []`）：schema 若把 op 标为必填，缺 op 的调用在宿主校验层就被泛化错误拒掉，运行时的形状推断兜底（见 4.6.5）将永远不可达——所以 schema 全可选，运行时校验权威；
- 宿主反馈机制：上游 pi 把参数校验错误作为 tool result 回流模型（不中断会话），因此**错误消息本身就是纠偏通道**，内容质量直接决定能否一次转正（不需 `prepareArguments` shim，理由见 3.3）。

#### 4.6.4 错误消息原则：每条附一段该 op 的最小合法 JSON

所有拒绝路径（未知字段、跨字段冲突、缺失参数、字段类型/空值错误、op 词表外）都强制带一段可直接照抄的正确参数示例（`OP_EXAMPLE`），无例外：

- "规则不配示例"已在本次故障中被证伪——面对已经在错的模型，抽象描述无法纠偏，具体样本才能；
- 示例文本与校验路径共用同一常量：工具 description 里的 9 条示例（每个 op 一条）与错误消息尾注**一字不差**，不会两处维护、慢慢漂移；
- 示例尾部不写解释性散文，只写可执行参数，避免模型把说明当参数的一部分。

工具 description 中的示例同时起到 oh-my-pi 那三层防线中 `examples` 内联样本的作用（上游 pi 无此字段，只能进文案）。

#### 4.6.5 缺 `op` 时的形状推断

只在形状无歧义时推断，否则拒绝并列出词表：

| 字段形状 | 推断为 |
|---|---|
| 含 `list` | `init` |
| 含 `tasks` + 含 `phase` | `append` |
| 含 `tasks`、不含 `phase` | `init` |
| 其余（无 `op` 也无可识别字段） | 拒绝，错误消息展开全部 9 个 op |

显式 `op` 优先且永不事后质疑（不做"看起来不像这个 op"的二次猜测）。

#### 4.6.6 三家对比结论

| | OpenCode `todowrite` | oh-my-pi `todo` | 本工具 `todo` |
|---|---|---|---|
| 参数形状 | 单层 `{todos:[...]}` | 扁平 `{op, list?, task?, phase?, items?, reason?}` | 扁平 `{op, list?, task?, phase?, tasks?, reason?}`（同构，仅清单字段改名 `tasks`） |
| 更新语义 | 全量替换，零分支 | 9 op 增量 | 9 op 增量 |
| 一次调用 | 写完整清单 | 一个 op（op 内可含多个字段） | 一个 op（op 内最多一份清单类字段） |
| 原子性 | 天然（写入即替换） | 单 op 内整批校验，任一条非法则不落库 | 单 op 单次调用原子，出错时输入状态原样返回 |
| 参数容错 | 无需（无分支） | 三层：`lenientArgValidation` + `inferTodoOp` + 8 条内联示例 | 扁平形状消灭信封 + 形状推断 + 每条错误附最小合法示例 + description 每 op 一条示例 |
| 误调风险 | 无参数风险，但无增量能力（记不住全量就丢历史） | 生产验证 | 同样依赖扁平形状，额外把爆炸半径收到参数边界 |

结论：OpenCode 的全量替换是**最不易调错但能力封顶**的一端（模型必须自己持住全量清单，无增量、无阻塞语义）；oh-my-pi 的扁平单 op 形状是**同宗 9 op 语义已被生产验证过的调用面**，本工具直接对齐其形状而不发明新语法；本工具在其上额外补齐两项：错误消息逐条附可照抄示例、按 op 收紧字段白名单。

#### 4.6.7 历史决策记录：已被取代的 `{op, entries[]}`

保留备查：首版选择 `{op, entries[]}`（entries 为判别联合数组）是为了拿住"同 op 批量整批原子"——一次勾完多个已完成任务，要么全成要么全滚。该能力已随本次改写**主动放弃**：core 的 `applyEntries` 仍接受条目数组、仍保留整批回滚原语，但工具层恒传单条，对外不暴露批量入口。代价是"勾 5 个已完成"从 1 次调用变成 5 次，收益是消除一类高频、不自愈的调用失败。

### 4.7 工具命名与词汇

吸取 opencode task→subagent 改名教训（"task" 一词在 v1 承载 5 种语义）：ZooKeeper 已有 `task()` 委派概念（prompt 层），todo 工具应避开 `task` 词根。工具名定为 `todo`（`op` 参数区分动作），todo item 的存储字段用 `content` 不用 `task`/`id`。

与 4.6 的衔接：扁平参数里确实有一个叫 `task` 的入参字段，但它指的是"待寻址任务的 content 原文"（标识符的值），不是另一种实体；批量清单字段 `tasks` 与之同词根（清单内容本来就是任务），单/复数按意图分职、永不同属一个 op，因此仍不构成第二套词汇。

## 5. 分期路线

| 阶段 | 内容 | 依据 |
|---|---|---|
| P0 | `src/core/todo/` 纯逻辑（状态机 + markdown + summary + 单测） | 零宿主依赖，可独立验证 |
| P1 | OpenCode 侧工具注册 + details 快照持久化 + 恢复 | 与 compress/decompress 同路，风险最低 |
| P2 | pi 侧 registerTool 适配（TypeBox schema：op 枚举 + 5 个可选平铺字段，不用 prepareArguments） | 官方 todo.ts 示例蓝本 + 4.6 扁平形状 |
| P3 | checkCompletion 停手清点 + mid-run nudge（新 hook 单元） | 现有事件通道可实现 |
| P4 | getTodoState/checkTodoProgress 切换到自建状态源 | 解除 v2 断供隐患 |
| P5（可选） | pi 侧 widget todo 列（4.5 设计）+ `/ztodo` 命令 + eager preferred 注入 | 增强项 |

P0-P2 是"MVP：双宿主可用的 todo 工具"；P3-P4 是"编排闭环"；P5 是体验增强。v2 宿主适配不在本路线内（独立课题），届时只需补 v2 工具适配层。

## 6. 风险与开放问题

1. **details 快照在 OpenCode v1 的读取成本**：恢复需经 `client.session.messages` 拉全量消息倒序扫描——长会话下每次会话开始扫一次可接受（pruning 已有类似模式），但需实测性能。
2. **双写一致性**：若用户同时在用宿主 v1 内置 todowrite（dolphin 主 agent 默认有此工具）和 zoo todo 工具，两套状态并存会产生混乱。需要在 config.toml deny 掉内置 todowrite（zoo profile 下），让 zoo todo 成为唯一工具。
3. **subagent 默认 deny 的实现**：OpenCode 侧 subagent permission 由宿主 deriveSubagentSessionPermission 推导，zoo todo 作为插件工具是否在 deny 推导范围内需在 P1 验证；pi 侧暂无委派工具，暂无此问题。
4. **prompt 文案移植的版权/风格**：oh-my-pi 的 todo.md 文案精炼但应改写为 zoo 风格（注释英文、描述"是什么"），不逐字照抄。
5. **eager always 档（强制 tool_choice）两宿主均无公开 API**，确认放弃；preferred 档（注入提醒）已足够覆盖主要场景。
6. **参数形状是易退化的维度**：4.6 的失败记录说明，一旦上下文中累积了错误调用样本，模型会自我强化该错误，光改 description 文案救不回来。因此后续维护的约束是：不在扁平形状上重新引入数组信封或复数目标字段（包括以"兼容旧调用"名义）；新增 op 时 `OP_EXAMPLE` / 字段白名单 / description 示例三处必须同步，否则新 op 没有纠偏示例可用。

## 7. 结论

- **可行性**：双宿主（OpenCode v1/v2、pi）均验证可注册自定义工具，pi 侧官方有完整 todo 扩展示例；状态持久化经 toolResult details 快照天然解决分支/恢复问题。
- **参数形状**：扁平字段 + 单 op 单次调用，已取代首版的 `{op, entries[]}` 信封——后者因模型漏传信封连续失败 9 次（生成式模式锁定，光改文案纠不回来），详见 4.6。
- **设计蓝本**：状态机与 op 集照抄 oh-my-pi 纯逻辑（约 500 行零依赖代码），参数形状照抄其扁平设计（六个顶层字段、一次调用一个 op，见 4.6；清单字段本工具改名 `tasks`，其余同名），模型引导三件套用 ZooKeeper 现有事件通道近似，砍掉依赖宿主深度集成的编排联动。
- **必要性**：v2 断供使 getTodoState 链路静默失效（P4 必须做）；且宿主 todo 对插件只读，自建是编排闭环（委派勾选、停手清点）的唯一途径。
- **成本估算**：P0-P2（MVP）约 800-1000 行（含测试），P3-P4 约 300-400 行；核心风险在 P1 的 OpenCode details 读取与 subagent deny 验证。
- **TUI 方案**：pi 侧 widget 双列并排（左 fleet 右 todo）定稿（4.5），与 fleet 共享色彩/符号词汇和渲染管线；OpenCode 侧栏加 section 的数据通道现成；TUI 总量可控，不复刻 oh-my-pi 的 HUD 全家桶。
