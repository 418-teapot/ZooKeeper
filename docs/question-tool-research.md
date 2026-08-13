# Question/Ask 工具调研报告：opencode2 与 oh-my-pi 的用户提问机制

> 调研日期：2026-08-13
> 关联文档：[subagent-mechanism-comparison.md](subagent-mechanism-comparison.md)、[todo-tool-design-research.md](todo-tool-design-research.md)

## 1. 调研范围

"模型向用户提问"是 agent 系统的基础交互原语：执行循环中模型遇到需要用户决策的分叉（歧义澄清、方案选择、偏好收集）时，结构化提问工具比纯文本提问提供更好的 UX 与结果可解析性。本报告调研三个项目的实现：

- **opencode2**（anomalyco/opencode v2 分支，`~/Code/Agent/opencode2`）：`question` 工具
- **opencode v1**（`~/Code/Agent/opencode`，v1.18.18）：同名工具的演进前身
- **oh-my-pi**（`~/Code/Agent/oh-my-pi`）与 **pi 核心**（`~/Code/Agent/pi`）：`ask` 工具与扩展层积木

## 2. opencode2 `question` 工具

### 2.1 基本形态

- 文件：`packages/core/src/tool/plugin/question.ts`（128 行），内置工具插件，**无条件常驻** `pre` 数组（`plugin/internal.ts:211`）——v1 是按 client 门控注册的（app/cli/desktop 才启用），v2 改为全量注册。
- 输入 schema（question.ts:23-25）：`questions: Array<Question.Prompt>`（非空），每个 Prompt 为 `{question, header(≤30字符短标签), options[{label, description}], multiple?}`（`packages/schema/src/question.ts:22-44`）。
- 输出：`answers: string[][]`——每问题一个选中 label 数组（单选单元素、未答空数组）。

### 2.2 执行机制：Form 体系 + Deferred 挂起

v2 把提问收敛进**通用 Form（user elicitation）体系**，不再使用 v1 的专用 Question 服务：

1. **权限门控**：execute 第一步 `permission.assert({action: "question", resources: ["*"]})`（question.ts:62-70）——`question` 是与 read/edit/shell 同级的独立权限 action。
2. **表单创建**：`forms.ask()` 把每个问题转为 Form 字段（`type: multiselect | string`，`custom: true` 恒成立 → 自动追加 "Type your own answer"），`metadata: {kind: "question"}`。
3. **挂起**：`Form.ask` 内 `Deferred.await`（form.ts:150-160），工具 fiber 在 `Effect.uninterruptibleMask` 内阻塞，agent 循环停在该工具调用。
4. **事件通道**：`form.created` 事件经 Bus → TUI 渲染 `<FormPrompt>`（编号选项列表、↑↓/数字键选择、多选 `[✓]` 勾选、Review/Confirm 页、esc 取消）；通知系统提示 "Input needs response"。
5. **回答回流**：用户提交 → `form.reply` 校验并 `Deferred.succeed` → 答案格式化回模型：`User has answered your questions: "问题"="label1, label2"... You can now continue with the user's answers in mind.`

Form 服务同时服务 MCP URL elicitation、provider 凭据收集、integration OAuth——question 工具只是 `kind: "question"` 的一种使用者。**专用 Question 服务在 v2 退化为纯 HTTP API**（server handlers + TUI global-sync）。

### 2.3 两个独特设计

**defect tunnel 取消语义**（question.ts:89-93，注释 "Deliberate defect tunnel"）：用户 esc/dismiss 时工具 `Effect.die(CancelledError)`——以 defect 形式穿透工具层的 `mapError` 毯，**绝不变成模型可见的工具输出**；在 runner 的 `executeTool` 接缝处恢复为类型化失败，模型收到 "The user dismissed this question" 并**中断整个 agent step**。设计意图：用户的"拒绝"永远不能被模型当作普通工具结果消费。

**子代理双层拒绝**：

1. **工具列表级**：general/explore 子代理的权限规则 `deny question`（plugin/agent.ts:110,127）触发 `whollyDisabled` 过滤（tool.ts:213,260-263）——工具从模型可见的 definitions 中**直接消失**，模型根本不知道它存在；
2. **执行级兜底**：自定义子代理若无 deny 规则，permission assert 默认 `"ask"` 弹权限确认；直接命中 deny 则返回 `ToolFailure("Permission denied: question")`。

主 agent（Build/Plan mode）显式 allow。

### 2.4 headless 行为

`opencode run` 对 `form.created` **立即自动 cancel**（noninteractive.ts:156-194）→ Form.ask 返回 cancelled → defect tunnel → step 中断，模型收到 dismiss 失败。**headless 下 question 等效自动拒绝**，`formCancelled` 标志抑制后续错误输出。

### 2.5 v1 → v2 演进对照

| 维度 | v1 | v2 |
|---|---|---|
| 底层机制 | 专用 Question 服务 + QuestionPrompt UI | 通用 Form 服务 + FormPrompt UI |
| 权限门控 | 无 | 有（`action: "question"` 独立 action） |
| 注册方式 | 按 client 门控 | 无条件常驻 |
| 取消语义 | rejected 事件 | defect tunnel（模型不可见 + step 中断） |
| 自定义回答 | schema `custom` 字段（默认 true） | 工具固定 `custom: true` |

## 3. oh-my-pi `ask` 工具

### 3.1 基本形态

- 文件：`packages/coding-agent/src/tools/ask.ts`（1459 行，含 TUI renderer）——比 opencode 的实现重一个数量级。
- 注册：`tools/index.ts:423` `AskTool.createIf`，默认启用（`ask.enabled`）。
- schema（ask.ts:57-80）：`questions[{id, question, header?, options[{label, description?, preview?}], multi?, recommended?}]`（非空数组）。
  - `preview`：选项可带预览内容；
  - `recommended`：推荐项下标，自动加 "(Recommended)" 后缀；
  - **保留选项**（ask.ts:48-55）："Other (type your own)"、"Chat about this"、"Next →"——模型禁止占用这些 label，由 UI 自动追加。

### 3.2 执行机制：进程内阻塞式对话框

- `concurrency: "exclusive"`（ask.ts:824）：独占批执行——TUI 选择器是单一共享 UI 面（HookSelector 无队列），并发 ask 会互相抢占。
- **两条 UI 路径**：Rich dialog（`ui.askDialog`，Tab 分页多问题表单 + CountdownTimer）/ 回退路径（逐问题 `ui.select` 单选 radio / 多选 checkbox + `ui.editor` 自由输入 + ←/→ 多问题导航）。
- **超时**：`ask.timeout`（默认 0=禁用；plan mode 强制禁用）；超时自动选 recommended 或第一项，transcript 标注 "auto-selected after timeout — not a user choice"。
- **headless 保护**：`!hasUI` 直接抛 `ToolAbortError("Ask tool requires interactive mode")`。
- **辅助**：等待时终端通知、TTS 朗读、`/tree` 重新作答（从持久化 toolCall 恢复问题）。
- **取消语义**：用户取消 → `ToolAbortError` 中止整个回合——**模型可见的失败**（与 opencode2 的 defect tunnel 哲学相反）。

### 3.3 子代理剥离：hasUI 门控而非权限 deny

`AskTool.createIf`（ask.ts:831-833）：`return session.hasUI ? new AskTool(session) : null`。所有子代理会话 `hasUI: false`（task/executor.ts:3116 等 7 处）——**无 UI 即工具不创建**，没有专门的剥离名单。权限层完全不拦（`isToolAllowed` 只查 `ask.enabled`）。

### 3.4 使用引导（prompts/tools/ask.md 的 `<critical>` 块）

```
Default to action. Resolve ambiguity via repo conventions... Exhaust
existing sources (code, configs, docs, history) before asking. Ask only when
options have materially different tradeoffs the user must decide.
```

约束强度明显高于 opencode 的工具描述（"默认行动、穷尽资料后再问、只在权衡重大时问"），另要求 2-5 个选项、用 description 写权衡而非 label。

### 3.5 与 approval 的关系

approval 的"批准/拒绝"对话框与 ask 的选项选择器**共用同一个 HookSelector UI 面**（wrapper.ts:317-334，approval 询问就是 `ui.select(safetyPrompt, ["Approve", "Deny"])`）；ask 自身 `approval="read"` 永不触发审批。外部事件流刻意区分二者：`tool_approval_requested → permission_request`、`ask 执行 → question_asked`（warp-events.ts:197-213）。

## 4. pi 核心：无模型侧提问工具

pi 核心（`~/Code/Agent/pi`）**没有任何**模型可用的提问工具（`core/tools/` 只有 bash/edit/find/grep/ls/read/write 等）。提供的是扩展层积木：

- `ExtensionUIContext`（types.ts:131-267）：`select` / `confirm`（select 的 Yes/No 包装）/ `input` / `editor` / `custom`（带键盘焦点的自定义组件）/ `notify` / `setWidget` 等；
- headless（RPC/print）下 fail-closed：`select → undefined`、`confirm → false`（runner.ts:236-237）。

模型的提问退化为**纯文本提问 + 用户下条消息回答**，且有第一方支持：todo-tracker 的 `isAwaitingUserAnswer` 启发式（todo-tracker.ts:23-38, 240-245, 385-390）——检测助手消息末行是否为问题行（`?` 结尾 + 疑问词/you 指向/应答提示词 confirm·reply·choose·let me know，含非 ASCII 修复 #7803），是则**跳过 todo 完成提醒**（"assistant is waiting for user input"）。

## 5. 三方对比

| 维度 | opencode2 `question` | oh-my-pi `ask` | pi 核心 |
|---|---|---|---|
| 存在性 | 有（128 行，Form 体系门面） | 有（1459 行，最重实现） | 无（仅扩展积木） |
| 等待机制 | 事件总线 + Deferred | 进程内阻塞 await + exclusive 并发 | — |
| 取消语义 | defect tunnel：模型不可见 + step 中断 | ToolAbortError：模型可见的回合中止 | — |
| 超时 | 无 | 有（自动选推荐项 + transcript 标注） | — |
| 子代理 | 权限 deny + whollyDisabled 消失 | hasUI 门控不创建 | — |
| 与权限系统 | question 本身是权限 action（先授权后征询） | 共用 UI 通道但 approval="read" | — |
| headless | form.created 自动 cancel | ToolAbortError | ctx.ui fail-closed |
| 转聊天 | 无 | "Chat about this" 分叉 | — |
| 使用引导 | 工具描述（Recommended 放第一项） | `<critical>` 块（默认行动、穷尽再问） | — |

**核心设计差异一句话**：opencode2 把提问做成 **permission 保护的动作 + 事件总线异步通道**（取消对模型不可见、工具可从子代理视野中消失）；oh-my-pi 把提问做成 **进程内阻塞式 TUI 对话框**（独占、可超时、可转聊天、答案进 transcript、取消模型可见）；pi 核心只有扩展积木，模型提问退化为纯文本 + `isAwaitingUserAnswer` 启发式保护。

## 6. 设计取舍分析

**取消语义是两家最大的哲学分歧**。opencode2 的 defect tunnel 认为"用户拒绝提问"是控制流信号而非信息——模型不该把 dismissal 当工具结果消费（否则模型可能围绕"用户没回答"编造推理）；代价是实现复杂（die 穿透 + runner 接缝恢复 + step 中断）。oh-my-pi 的 ToolAbortError 更简单直接，模型明确知道"用户拒绝了这个问题"，可以换方式继续（比如按推荐方案自行推进）——配合 ask.md 的"默认行动"纪律，取消后的行为反而可控。

**子代理剥离的两种路径**各有含义：opencode2 的 whollyDisabled（权限驱动、definitions 消失）是声明式治理——工具可见性由配置决定；oh-my-pi 的 hasUI 门控（能力驱动）是结构性保证——无 UI 的会话在构造期就不可能有提问工具，不依赖配置正确性。对编排器场景，hasUI 式结构保证更可靠，但 whollyDisabled 更灵活（可以允许特定子代理提问并路由到其父会话 UI——opencode2 支持，oh-my-pi 结构上不可能）。

**超时机制只有 oh-my-pi 有**，且做了关键的诚实性处理：自动选择的结果在 transcript 标注 "auto-selected after timeout — not a user choice"，防止模型（和审计者）把超时默认值误读为用户决策。

## 7. 对 ZooKeeper 的启示

1. **OpenCode 侧无需自建**：v1/v2 宿主都有 question 工具。注意 v2 子代理默认 deny question——与 ZooKeeper 委派设计（beaver 不问用户、结果契约回父）天然吻合，config.toml 的 subagent permission 声明可复用这一 action。
2. **pi 侧缺口**：宿主无提问工具，dolphin 向用户提问只能纯文本。扩展层 `ctx.ui.select/confirm/custom` 可自建（ZooKeeper 与宿主同进程，可行），但优先级低——纯文本提问 + 下条消息回答已覆盖编排器的主要场景（方案确认、方向选择）。
3. **`isAwaitingUserAnswer` 启发式值得借用**（oh-my-pi todo-tracker.ts:23-38）：检测"末行是问题/应答提示"时暂停 nudge——这直接适用于 ZooKeeper todo 工具报告的 P3 阶段（checkCompletion 停手清点），防止在"等用户回答"时注入打扰性提醒。该启发式纯字符串匹配、零宿主依赖，可直接移植到 `src/core/`。
4. **诚实性标注模式**：oh-my-pi 的超时自动选择在 transcript 标注 "not a user choice"——任何"系统代替用户做决策"的路径都应留下可审计标记，这一原则可用于 ZooKeeper 未来的自动化机制（如 prewalk 换模型、自动勾选）。
