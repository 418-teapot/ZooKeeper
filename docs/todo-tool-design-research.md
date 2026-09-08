# ZooKeeper 自建 Todo 工具调研报告

> 调研日期：2026-08-13
> 更新：2026-09-06 源码核实 oh-my-pi（todo.ts 1273 行 / todo-tracker.ts 399 行 / todo.md 44 行）与 pi 示例（todo.ts 297 行），修正动画范围、守卫数量等转述误差，新增 4.5 TUI 呈现设计
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
- 更新语义：单工具 `todowrite`，**全量替换**（session/todo.ts:33 先 delete 全表再 insert）；
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
- 批量原子性分两层：execute 层整批任一错误回滚 previousPhases 不落库（todo.ts:884-891）；单 op 内（append/init）也先整批校验再变更（todo.ts:410-424、438-455）；
- `normalizeInProgressTask`：多 in_progress 只留第一个，无 in_progress 自动提升最早 pending（todo.ts:146-161）；
- TodoTool 声明 `concurrency = "exclusive"`、`lenientArgValidation = true`，缺 op 时 `inferTodoOp` 从参数形状推断（todo.ts:567-595）；
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

pi 侧缺 oh-my-pi 的宿主级能力：无 approval 分档、无 `lenientArgValidation`（用 `prepareArguments` shim 或 schema 可选 op + execute 内推断替代）、无 TodoTracker 宿主集成（可用 ZooKeeper 已注册的 `before_agent_start`/`tool_result`/`context` 事件近似）、无 `scheduleAgentContinue` 等价物。

## 4. ZooKeeper 自建 todo 工具设计

### 4.1 架构：核心状态机宿主无关 + 薄适配层

复用 ZooKeeper 既有架构分层（core 纯逻辑 / hooks 薄适配 / 双入口）：

```
src/core/todo/
├── types.ts        # TodoItem/TodoPhase/TodoStatus 类型（纯类型，零 import）
├── state.ts        # 状态机：9 op apply、normalizeInProgressTask、批量原子性、
│                   #   去重、content 匹配（照抄 oh-my-pi 纯逻辑 ~500 行，改写成 zoo 风格）
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

采用 oh-my-pi 的完整模型（分 phase 5 态、9 op、content 寻址、单 in_progress 自动提升、批量原子），理由：

- 这些是**纯逻辑零宿主依赖**（oh-my-pi todo.ts 中约 500 行可直接改写），已被生产验证；
- content 寻址 + 5-10 词 + 禁 ID 是最防幻觉的设计，opencode v1 的扁平全量替换在对比中全面落于下风；
- blocked/abandoned 语义对编排器场景（等 subagent、等用户）有直接价值。

**暂不做**（依赖宿主深度集成，超出现有通道）：subagent 完成自动勾选（除宿主集成难度外，归一化+双向子串模糊匹配改父级状态有 false positive 风险——若做，联动只应做 UI 点亮提示、不做状态变更）、prewalk 门控、粘性 HUD（OpenCode 插件无 TUI 槽位；pi 侧经 setWidget 双列 widget 实现，设计见 4.5）。

### 4.3 模型引导：ZooKeeper 现有事件通道已够用

| oh-my-pi 机制 | ZooKeeper 对应通道 | 现状 |
|---|---|---|
| 工具描述手册（todo.md 44 行） | 工具 description 字段 + `before_agent_start` prompt 注入 | 可直接移植文案 |
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

### 4.6 工具命名与词汇

吸取 opencode task→subagent 改名教训（"task" 一词在 v1 承载 5 种语义）：ZooKeeper 已有 `task()` 委派概念（prompt 层），todo 工具应避开 `task` 词根。建议工具名 `todo`（op 参数区分动作），todo item 的字段用 `content` 不用 `task`/`id`。

## 5. 分期路线

| 阶段 | 内容 | 依据 |
|---|---|---|
| P0 | `src/core/todo/` 纯逻辑（状态机 + markdown + summary + 单测） | 零宿主依赖，可独立验证 |
| P1 | OpenCode 侧工具注册 + details 快照持久化 + 恢复 | 与 compress/decompress 同路，风险最低 |
| P2 | pi 侧 registerTool 适配（TypeBox schema + prepareArguments 容错） | 官方 todo.ts 示例蓝本 |
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

## 7. 结论

- **可行性**：双宿主（OpenCode v1/v2、pi）均验证可注册自定义工具，pi 侧官方有完整 todo 扩展示例；状态持久化经 toolResult details 快照天然解决分支/恢复问题。
- **设计蓝本**：状态机与 op 集照抄 oh-my-pi 纯逻辑（约 500 行零依赖代码），模型引导三件套用 ZooKeeper 现有事件通道近似，砍掉依赖宿主深度集成的编排联动。
- **必要性**：v2 断供使 getTodoState 链路静默失效（P4 必须做）；且宿主 todo 对插件只读，自建是编排闭环（委派勾选、停手清点）的唯一途径。
- **成本估算**：P0-P2（MVP）约 800-1000 行（含测试），P3-P4 约 300-400 行；核心风险在 P1 的 OpenCode details 读取与 subagent deny 验证。
- **TUI 方案**：pi 侧 widget 双列并排（左 fleet 右 todo）定稿（4.5），与 fleet 共享色彩/符号词汇和渲染管线；OpenCode 侧栏加 section 的数据通道现成；TUI 总量可控，不复刻 oh-my-pi 的 HUD 全家桶。
