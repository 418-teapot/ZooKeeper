# ZooKeeper 自建 Todo 工具调研报告

> 调研日期：2026-08-13
> 关联文档：[subagent-mechanism-comparison.md](subagent-mechanism-comparison.md)、[todo-nudge-research.md](todo-nudge-research.md)

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

### 2.2 oh-my-pi：深度制度化的"编排记账本"（1270 行）

**设计哲学四个支柱：**

1. **content 字符串作标识、禁止 ID**——"todo 是给模型自己看的便签，不是给程序索引的数据库"。模型传 `task-\d+` 会收到显式纠错回退到"看上一次结果"；重复 content 在 init/append 前置拒绝（重复即不可寻址）；5-10 词限制保证逐字可复述。
2. **block 语义 = 卡在不可自主推进的外部依赖**——与终结态正交；blocked 不计入收尾提醒；"能自己解阻就该 append 解阻任务而不是 block"。
3. **init 逐条承诺纪律（`<critical>` 块）**——用户列举的多步计划 MUST 逐条 init，"NEVER summarize into fewer tasks, sample 'the important ones', or track from memory"。
4. **todo 调用不许独占一轮**——"Batch with real work: init with first reads/edits"，solo todo turn 浪费一次模型往返。

**架构要点：**

- 分 phase 5 态（pending/in_progress/completed/abandoned/blocked+blocker 原因），9 个 op 增量更新（init/start/done/drop/rm/block/unblock/append/view）；
- 批量原子性：单 op 内先验证全批再变更，整批任一错误整体丢弃不落库；
- `normalizeInProgressTask`：多 in_progress 只留第一个，无 in_progress 自动提升最早 pending；
- 持久化 = toolResult `details.phases` 快照进 session JSONL + `user_todo_edit` 自定义条目（用户编辑最高权威）；**恢复 = 从 transcript 倒序取最新快照，不重放 op 历史**；内存态只是缓存，6 个时机 syncFromBranch 重建；
- 模型引导三件套：eager prelude（三档，always 档用 `buildNamedToolChoice` 强制首轮 tool_choice）、checkCompletion 停手清点（8 个跳过条件：等用户回答/async job 在飞/提醒后无进展防轰炸/max 上限等）、takeMidRunNudge（只统计成功的 mutating 工具，阈值 12，每周期最多 2 次，injection-time 评估）；
- UI：粘性 HUD（AnchoredLiveContainer）+ 瞬态渲染器共享同一折叠视口策略（selectCollapsedTodos，#5873）；完成划线 14 帧动画；`/todo` 命令全家（$EDITOR Markdown 往返，blocker 藏 HTML 注释）；
- 编排联动：subagent 完成自动勾选匹配描述的父 todo（归一化+双向子串、最小 6 字符重叠；blocked 纳入——完成即解阻信号；failed/aborted 不勾）；prewalk 门控（提交 todo 后才切便宜模型）；
- 用户手动清空时注入 "Do NOT recreate or re-populate"（issue #5258）阻断模型下一轮重建。

### 2.3 pi 官方示例：`examples/extensions/todo.ts`

pi 宿主自带一个完整的 todo 扩展示例（296 行），证明了关键模式：

- **状态存 toolResult details**——"State is stored in tool result details…when you branch, the todo state is automatically correct"（todo.ts:8-11），分支/恢复天然正确；
- session_start/session_tree 时从 `ctx.sessionManager.getBranch()` 重建状态；
- registerTool + renderCall/renderResult + registerCommand(`/todos`) + `ctx.ui.custom()` 全屏组件。

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
| TUI 呈现 | ✅ | renderCall/renderResult 优先于默认渲染；`ctx.ui.custom()` 全屏；registerCommand |

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

**暂不做**（依赖宿主深度集成，超出现有通道）：subagent 完成自动勾选（需要 task 生命周期事件——OpenCode 侧 ZooKeeper 有 post-task-nudge 切入点可近似，pi 侧暂无委派工具）、prewalk 门控、粘性 HUD（OpenCode 插件无 TUI 槽位；pi 侧可用 setWidget 近似，列为后期增强）。

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

### 4.5 工具命名与词汇

吸取 opencode task→subagent 改名教训（"task" 一词在 v1 承载 5 种语义）：ZooKeeper 已有 `task()` 委派概念（prompt 层），todo 工具应避开 `task` 词根。建议工具名 `todo`（op 参数区分动作），todo item 的字段用 `content` 不用 `task`/`id`。

## 5. 分期路线

| 阶段 | 内容 | 依据 |
|---|---|---|
| P0 | `src/core/todo/` 纯逻辑（状态机 + markdown + summary + 单测） | 零宿主依赖，可独立验证 |
| P1 | OpenCode 侧工具注册 + details 快照持久化 + 恢复 | 与 compress/decompress 同路，风险最低 |
| P2 | pi 侧 registerTool 适配（TypeBox schema + prepareArguments 容错） | 官方 todo.ts 示例蓝本 |
| P3 | checkCompletion 停手清点 + mid-run nudge（新 hook 单元） | 现有事件通道可实现 |
| P4 | getTodoState/checkTodoProgress 切换到自建状态源 | 解除 v2 断供隐患 |
| P5（可选） | `/ztodo` 命令 + pi 侧 widget 呈现 + eager preferred 注入 | 增强项 |

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
