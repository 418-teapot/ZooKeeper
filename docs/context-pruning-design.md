# 上下文剪枝设计文档：从内置 Compaction 到框架无关的统一剪枝架构

**版本:** 2.6
**日期:** 2026-07-30
**分类:** 技术架构文档 / 上下文管理

> **2.6 更新说明：** 手动压缩功能完整实现（2026-07-30，1560 TS 测试
> 全绿，三轮双路 Eagle 审查闭环）：§4.7 新增手动压缩 as-built 小节
> （`/dcp compress` 无参命令、blocks/compress/fold 三模块、机械摘要、
> 三重保护、幻影门+负收益门、视图变化强制释放）；§4.1/§4.2/§4.3/§4.6
> 同步 Phase 1 折叠、blocks 状态、观测层折叠视图接线与配置键改名
> （`protected_messages`/`released_percent`/`threshold_context`，新增
> `[zoo.context.compress]`）；系统类估算改残差法（§4.3），恒 0 且零
> 消费方的第五类 `misc` 一并删除；transform 管道重编号为 Phase 1-6
> （折→清→标→refs→放→收尾）；原 §4.7
> 认知收获顺延为 §4.8 并新增两条；§5.2/§7.1/§8/§9.4/§9.8/§10.1 同步
> 进度。LLM 驱动摘要仍属 V3。
>
> **2.5 更新说明：** ACP（DCP fork）源码调研（2026-07-27）：
> §3.8 新增 ACP 架构分析（T1/T2/T3 三层压缩、范围保护三件套、幻影
> 门禁、nudge 防刷屏基线、GC 安全网、模型工具面）；§5.2/§5.3 吸收
> 保护口径与防刷屏基线；§8 路线图 V3 行细化并增列 T2 候选；§9 新增
> 摘要累积风险；§10.1 保留清单同步。
>
> **2.4 更新说明：** purge-errors 功能完整实现（R1-R3 架构落地）：
> §4 新增 purge-errors 实现小节（action 建模、R1 三层配置、R3 表驱动
> producer 模型）；§6.5/§6.8 同步配置与文件清单变更；§7.1 对比表"错误清除"
> 已标记完成；§8 路线图同步日期；附 2026-07-25 裸 SQL 实测修正注记
> （error part 无 output 字段、全局 537K input chars ≈ 134K tokens、
> 尾部风暴会话 1-11%、工具分布 edit 273K/write 127K/task 119K chars）。
>
> **2.3 更新说明：** §6 自动 dedup 已**实现并实测通过**（含统一 marks
> 架构重写）：§4 更新为 as-built 实现；§6 保留设计定稿原文并标记完成，
> 其中 §6.6/§6.7/§6.8 已按实际实现修订（ignored 通知、统一 marks 单
> 集合替代双 Map、合并回收展示）；§3.5 补入新一轮源码核实（DCP README
> 漂移两处、ACP pruneToolOutputs hotfix 与 Bug #20、DCP dedup 保护清单
> 实际为空）；§7/§8/§9 同步进度。
>
> **2.2 重写说明：** 在 1.x 完整调研基础上重组：§1-§3、§7、§9 的调研内容
> 全部保留（其中与 DCP 源码不符的描述已就地修正，修正点以"源码核实"
> 标注）；1.x §4（实现前现状）、§5.4-5.10/5.13/5.16（被实际实现取代的
> 设计）、§7（Phase 1-6 计划）、§10（V0 方案）、§11（实现报告）已移除或
> 并入新的 §4（当前实现）与 §6（下一步定稿）。

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [OpenCode 内置 Compaction 机制](#2-opencode-内置-compaction-机制)
3. [DCP 插件架构分析（源码核实）](#3-dcp-插件架构分析源码核实)
4. [ZooKeeper 当前实现](#4-zookeeper-当前实现)
5. [长期方案设计参考（V3+）](#5-长期方案设计参考v3)
6. [自动去重 dedup（✅ 已实现）](#6-自动去重-dedup-已实现2026-07-25)
7. [与 DCP 的架构对比](#7-与-dcp-的架构对比)
8. [后续路线](#8-后续路线)
9. [已知风险与缓解措施](#9-已知风险与缓解措施)
10. [总结](#10-总结)

---

## 1. 背景与动机

### 1.1 上下文膨胀问题

在多 Agent 编排系统中，编排器（Orchestrator）持续通过 `task()` 委派子 Agent、接收返回结果、调用工具验证。随着会话进行，上下文窗口逐渐被以下内容填满：

- 子 Agent 返回的完整 `task_result`（包含推理过程和工具输出）
- 编排器自身的工具调用历史（bash/read/edit 的输出）
- 重复的/冗余的工具输出（多次 grep 同一个文件）
- 已失效的错误信息（早前的构建失败的完整堆栈）

如果不加管理，上下文膨胀导致：

| 问题 | 影响 |
|------|------|
| Token 消耗激增 | 成本线性增长，long-context 模型费用不可控 |
| 推理质量下降 | LLM 在噪声中提取关键信息的信噪比降低 |
| 到达上下文上限 | 会话被迫终止或触发降级行为 |
| 响应延迟增加 | 长上下文的首 token 延迟显著增长 |

### 1.2 编排器的特殊需求

与单 Agent 场景不同，编排器场景对上下文剪枝有特殊要求：

1. **子 Agent 输出可丢弃**：编排器不需要子 Agent 的完整中间步骤，只需最终结果摘要
2. **验证结果可压缩**：过去的 build/test/lint 输出在确认通过后不再需要
3. **委派记录需保留骨架**：谁做了什么、结果如何，但不需要完整回放
4. **权限规则必须保留**：压缩不能干扰 ZooKeeper 注入的 prompt 和 deny list

### 1.3 实测数据（2026-07-18，观测层上线后）

编排器真实负载，~333K 上下文的稳定读数：

| 分类 | 读数 | 占比 | 说明 |
|------|------|------|------|
| user | 19.2K | 5.8% | 用户输入 |
| asst | 102.6K | 30.8% | 助手输出（API 精确） |
| **tool** | **145.9K** | **43.8%** | **工具输入+输出——最大单一消费者** |
| sys | 17.3K | 5.2% | 系统 prompt（与 ztrace 首调记录交叉验证一致） |
| misc | 48.1K | 14.4% | 残差（估算误差 + reasoning 差额 + 非文本 part） |

**结论**：tool 输出是剪枝的第一目标（43.8%），直接验证去重 + 错误清除
作为首批自动策略的优先级；系统 prompt（5.2%）不是大头，无需优化。观测层
为后续每一步剪枝提供了闭环验证手段：策略上线后面板应直接显示 tool 分类
下降。

### 1.4 设计原则

1. **框架无关核心 + 框架适配器** — 剪枝算法与状态管理为纯 TypeScript，
   不依赖宿主 SDK 类型；框架绑定通过薄适配层
2. **两阶段标记-清理** — 策略只写 marks 集合，清理只读 effective 标记；
   两阶段不在同一 pass 内闭合（见 §3.3）
3. **轻量无依赖** — 不引入 tokenizer；API 上报 token 为主力，启发式仅
   补充新增消息
4. **不吃掉有意义的上下文** — 轮次保护、保护工具列表、阈值门控：上下文
   充裕时不剪
5. **渐进增强** — 观测 → 手动剪枝 → 自动策略 → LLM 驱动压缩，每步独立
   可验证；nudge 优先于强制
6. **可观测先行** — 每个策略上线后必须能通过面板/命令/日志看到效果

---

## 2. OpenCode 内置 Compaction 机制

OpenCode 在核心平台层面提供了两层内置的 compaction（上下文压缩）机制，分别在 V2 Core 和 V1 Orchestration 层实现。ZooKeeper 剪枝是其**补充**而非替代。

### 2.1 V2 Core 层 Compaction

**位置**: `packages/core/src/session/compaction.ts`

#### 触发条件

在每次 LLM 请求前，系统通过 `Token.estimate()` 估算当前会话的 token 总量，与可用上下文容量进行比较：

```
trigger if: total_tokens > context - max(output, buffer)
```

其中 `buffer` 默认 20K token。

#### select() — 消息选择

当触发 compaction 时，`select()` 函数将会话消息分为两部分：

- **Recent（保留最近）**：保留 `DEFAULT_KEEP_TOKENS`（默认 8K token）的最新消息，保持原样
- **History（历史摘要）**：较旧的消息被标记为待摘要

#### buildPrompt() — 摘要模板

系统构造一个结构化的摘要 prompt，要求 LLM 生成涵盖以下维度的摘要：

```
LLM 收到的摘要 prompt 包含：
- goal（原始目标）
- constraints（发现的约束）
- progress（已完成的进度）
- decisions（做过的决策）
- next steps（下一步计划）
- key context（关键上下文）
- files（涉及的文件变更）
```

#### 存储与回放

压缩结果存储为 `SessionEvent.Compaction.Ended` 事件，包含：

```typescript
interface CompactionEndedEvent {
  text: string        // LLM 生成的摘要文本
  recent: string      // 保留的近期上下文的序列化内容
}
```

#### filterCompacted() — 消息排序

在模型消费时，`filterCompacted()` 将消息重新排序为：

```
[compaction user message, summary, ...retained tail..., continue user]
```

即：先放压缩请求用户消息（告知 LLM 发生了什么）、再放摘要、再放保留的近期上下文、最后放当前轮的用户消息。

### 2.2 V1 Orchestration 层 Compaction

**位置**: `packages/opencode/src/session/compaction.ts`

这一层提供更细粒度的工具输出剪枝，与 V2 Core 的 LLM 摘要式压缩形成互补。

#### select() — 消息选择

V1 的 `select()` 保留最后 `tail_turns` 个用户轮次（默认 2 轮）。近期内容预算为：

```
recent_budget = min(8_000, max(2_000, 25% * available_context))
```

#### prune() — 工具输出剪枝

prune 函数擦除已完成工具调用的 `output` 字段，将 `part.state.time.compacted` 标记为压缩状态。保护 `skill` 工具不被剪枝。

```typescript
interface PruneConfig {
  enabled: boolean    // 默认 false
  protectTokens: number  // PRUNE_PROTECT = 40K — 保留这么多 token 不受剪枝
  minimumReclaim: number // PRUNE_MINIMUM = 20K — 只有回收超过此值才执行
}
```

仅在满足以下条件时执行：
1. `cfg.compaction?.prune === true`（默认关闭）
2. 可回收的 token 量 > `PRUNE_MINIMUM` (20K)
3. 保留至少 `PRUNE_PROTECT` (40K) 未保护的工具输出

#### ToolOutputMaxChars

同时有一个独立的截断机制，将工具输出限制为 2000 字符。

### 2.3 Overflow 检测

**位置**: `packages/opencode/src/session/overflow.ts`

在每次 assistant turn 后，检查当前 token 总量是否超过模型上限减去预留空间：

```
overflow if: total_tokens >= model.limit.input - reserved
reserved = min(20_000, max_output_tokens)
```

如果溢出，标记会话为待 compaction。这是一个**被动触发**机制——只标记，不主动压缩，等待下一次 LLM 请求时的 compaction 流程处理。

### 2.4 配置参数

内置 compaction 的配置项（V2 模式）：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `auto` | bool | `true` | 启用自动 compaction |
| `prune` | bool | `false` | 启用旧工具输出剪枝 |
| `keep.tokens` | number | `8000` | 从旧轮次保留的 token 数 |
| `buffer` | number | `20000` | 触发阈值缓冲 |

**局限性**：
- tool output 剪枝默认关闭，需用户显式启用
- LLM 摘要式压缩由平台内部调度，插件无法干预
- 无去重逻辑：重复的工具输出占用大量上下文
- 无错误清除：失败的工具调用保留完整输入/输出

---

## 3. DCP 插件架构分析（源码核实）

DCP（`@tarquinen/opencode-dcp`，Dynamic Context Pruning）是一个 OpenCode 插件，用模型驱动的压缩替代了内置 compaction。以下分析基于源码 `~/Code/Agent/opencode-dynamic-context-pruning/`，关键事实经源码核实（2026-07-23）。

### 3.1 整体架构

DCP 注册了 6 个 hook 点：

| Hook | 用途 |
|------|------|
| `experimental.chat.system.transform` | 捕获系统 prompt token 元数据 |
| `experimental.chat.messages.transform` | 核心消息变换管道（16 步） |
| `experimental.text.complete` | 补全请求拦截 |
| `command.execute.before` | `/dcp` 命令处理 |
| `event` | 会话生命周期事件 |
| `config` | 配置注入 |
| `tool` | 注册 `compress` 工具 |

**配置加载**：三层级联加载
1. `~/.config/opencode/dcp.jsonc`（全局）
2. `$OPENCODE_CONFIG_DIR/dcp.jsonc`（用户级）
3. 项目 `.opencode/dcp.jsonc`（项目级）

**状态持久化**：创建 in-memory `SessionState`，周期性地写入 `~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json`。

### 3.2 16 步消息变换管道

核心管道在 `lib/hooks.ts` → `createChatMessageTransformHandler` 中实现，共 16 步：

```
Step  1: filterMessagesInPlace        — 丢弃格式异常的消息
Step  2: checkSession                 — 检测会话切换、子 Agent、内置 compaction
Step  3: syncCompressPermissionState  — 按 agent 解析 compress 权限
Step  4: stripHallucinations          — 移除模型幻觉生成的 DCP 标记
Step  5: cacheSystemPromptTokens      — 缓存系统 prompt 的 token 量
Step  6: assignMessageRefs            — 分配 mNNNN 格式引用 ID
Step  7: syncCompressionBlocks        — 重算活跃压缩块
Step  8: syncToolCache                — 缓存工具调用参数（轮次保护在此生效）
Step  9: buildToolIdList              — 构建全局工具调用 ID 列表
Step 10: prune                        — 读 state.prune.tools 执行替换（4 种模式）
Step 11: injectExtendedSubAgentResults— 替换 <task_result> 为完整文本
Step 12: buildPriorityMap             — 计算消息 token 优先级
Step 13: injectCompressNudges         — 基于阈值注入压力提示
Step 14: injectMessageIds             — 注入 mNNNN 标签到消息中
Step 15: applyPendingManualTrigger    — 替换用户消息文本（手动触发器）
Step 16: stripStaleMetadata           — 移除跨 provider 元数据
```

#### 剪枝模式（Step 10）

prune 阶段提供 4 种剪枝模式：

| 模式 | 作用 |
|------|------|
| `compress range filter` | 范围压缩 — 将连续消息段压缩为摘要块 |
| `tool output prune` | 工具输出剪枝 — 擦除已完成工具的输出 |
| `tool input prune` | 工具输入剪枝 — 擦除工具调用的输入参数 |
| `tool error prune` | 错误剪枝 — 清理错误调用的输入字段 |

> **源码核实修正**：`deduplicate` / `purgeErrors` 策略**不在这 16 步中**。
> 它们只在 compress 工具执行的 `prepareSession()` 里被调用
> （`lib/compress/pipeline.ts:72-73`）。1.x 文档将策略画在 transform
> 管道内（`runDedup()` 在 `pruneToolOutputs()` 之前），与源码不符。

### 3.3 两阶段标记-清理（核心机制，源码核实）

**标记与清理在架构上是分离的代码路径**，不是靠同一 pass 内的调用顺序
或快照实现的：

- **清理**（每轮都跑）：transform 管道 Step 10
  （`lib/hooks.ts:131` → `lib/messages/prune.ts:20-24`）只**读**
  `state.prune.tools`，替换已标记工具的 output/input：

```typescript
// lib/messages/prune.ts:20-24
filterCompressedRanges(state, logger, config, messages)
pruneToolOutputs(state, logger, messages)
pruneToolInputs(state, logger, messages)
pruneToolErrors(state, logger, messages)
```

- **标记**（按需跑）：`deduplicate` / `purgeErrors` 只在 compress 工具的
  `prepareSession()`（`lib/compress/pipeline.ts:72-73`）中运行：

```typescript
// lib/compress/pipeline.ts:72-73
deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)
```

因此"turn N 标记、turn N+1 生效"天然成立：标记发生在 compress 工具
执行路径，清理发生在下一次 transform。核心不变量：

- `state.prune.tools`（`Map<callID, tokenCount>`）是策略与清理之间的
  **唯一数据通路**；累积不清理（替换后不删条目），仅在会话删除/重置时
  清空
- token 记账发生在**标记时**，清理阶段不记账，避免跨轮重复计数
- **推论**：若策略与清理必须同处一个 handler（我们的 dedup 如此，见 §6.2），
  必须**先清后标**——清理只作用于历史标记，本轮新标记下一轮才生效，
  与分离路径语义严格等价

### 3.4 双模压缩引擎

DCP 提供两种压缩模式：

#### A) Range 模式（默认）

模型提供 `topic` + `content[]`，每个 content 项包含 `{startId, endId, summary}`。将连续的消息段压缩为块摘要。支持**嵌套**——重叠的压缩块可以形成层级结构。

使用 `(bN)` 占位符语法引用先前块：

```
用户消息
  m0001: "请检查 src/auth.ts"
  m0002: <task_result>...</task_result>
  m0003: "构建通过了"
  m0004: "现在检查 src/db.ts"

压缩块:
  (b1): m0001-m0003 → "检查完 auth.ts, 构建通过"
  (b2): m0004 → "正在检查 db.ts"
```

#### B) Message 模式（实验性）

模型提供 `topic` + `content[]`，每个 content 项包含 `{messageId, topic, summary}`。独立压缩每条消息，不依赖连续范围。更精确、更灵活，但模型理解成本更高。

### 3.5 自动策略：去重与错误清除

#### 去重（`lib/strategies/deduplication.ts`）

按 `toolName + normalizedParameters` 签名对工具调用分组：

```typescript
// 源码核实（deduplication.ts:96-103）
function createToolSignature(tool: string, parameters?: any): string {
    if (!parameters) { return tool }
    const normalized = normalizeParameters(parameters)  // 剔除 null/undefined
    const sorted = sortObjectKeys(normalized)           // 键递归排序
    return `${tool}::${JSON.stringify(sorted)}`
}
```

策略（源码核实，`deduplication.ts:77-82`）：同一签名组中**保留最新的一
次调用**（`ids.slice(0, -1)`），标记旧调用为待剪枝。保护工具列表与保护
文件模式在签名构建前排除（`deduplication.ts:55-62`）。

```typescript
interface DedupConfig {
  enabled: boolean
  protectedTools: string[]   // 不参与去重的工具
  protectedPatterns: RegExp[] // 匹配的参数模式不参与去重
}
```

#### 错误清除（`lib/strategies/purge-errors.ts`）

在错误发生的 N 轮（默认 4 轮）后，标记失败的工具调用为待剪枝。剪枝时擦除 input、保留 error 消息：

```typescript
interface PurgedToolCall {
  input: {}                  // 空对象
  output: { error: string }  // 保留 error 消息
}
```

#### 轮次口径与轮次保护（源码核实）

DCP 的"轮"**不是用户消息轮次**，而是**助手步**：按消息 parts 中的
`step-start` part 计数（`lib/state/utils.ts:76-93`）。编排器一个用户指令
可含几十上百个助手步，按用户轮计保护窗会让保护范围大到策略永不触发。

轮次保护在 **`syncToolCache` 入口处**生效（`lib/state/tool-cache.ts:39-52`）：

```typescript
// tool-cache.ts:39-44
const isProtectedByTurn =
    turnProtectionEnabled &&
    turnProtectionTurns > 0 &&
    state.currentTurn - turnCounter < turnProtectionTurns
// tool-cache.ts:50-52 — 受保护的调用 continue，不进 state.toolParameters
```

受保护的调用根本不进签名缓存，策略永远看不到它——**事前过滤，非事后
豁免**。默认值：`turns = 4` 且 `enabled = false`（`lib/config.ts:670-673`）。

#### 可观测性（源码核实）

- 标记时只写 debug 日志（`deduplication.ts:92`、`purge-errors.ts:84-86`）
- 替换完全静默，仅留下占位符文本：

```
[Output removed to save context - information superseded or no longer needed]
[input removed due to failed tool call]
[questions removed - see output for user's answers]
```

- 用户可见通知只在 compress 工具触发时发出（toast 或 ignored chat
  message，`lib/ui/notification.ts`）
- `/dcp stats` 命令显示累计节省（读 `state.stats.totalPruneTokens` 与
  `state.prune.tools.size`）

#### 保护清单的真实结构（源码核实，2026-07-25，纠正 README 漂移）

README（:216）称"默认保护 task/skill/todowrite/todoread/compress/batch/
plan_enter/plan_exit/write/edit，且 commands 与 strategies 的数组都会
叠加到该默认清单"。**源码事实与此不符**：

- `DEFAULT_PROTECTED_TOOLS`（config.ts:78-89）只被 `commands.protectedTools`
  （:664，保护 sweep）与 compress 配置消费
- `strategies.deduplication.protectedTools` 默认 **`[]`**（:696），
  `deduplication.ts:42` 只读此键——**dedup 策略实际零保护**，依赖签名
  判等 + 保留最新 + 轮次保护
- 设计含义：DCP 把保护给钝器（sweep 无差别标记），不给精密仪器
  （dedup 精确重复）

#### 通知机制的已知坑（源码核实，2026-07-25）

- DCP 的 `sendIgnoredMessage`（`session.prompt({noReply, ignored})`）不仅
  从命令处理器调用，还从 **compress 工具执行管线**（turn 在途）调用
  （`pipeline.ts:97` → `notification.ts:304`，`pruneNotificationType:"chat"`
  时）
- ACP 的 devlog 将此路径记为 **Bug #20**：通知消息被其自身 lastUser
  检测误拾 → 幽灵 LLM 调用反馈循环；ACP 的修复是**删除 chat 分支、
  一律改用 `client.tui.showToast`**（`opencode-acp/lib/ui/notification.ts:313`）
- ACP 同时 HOTFIX 注释掉了 `pruneToolOutputs/pruneToolInputs/
  pruneToolErrors`（`opencode-acp/lib/messages/prune.ts:19-24`）——
  原地修改历史消息打爆 GLM 前缀缓存（命中率 -89%，Bug 38）；此后
  ACP 的 dedup 只标记不替换，实际减上下文靠模型 compress 整段移除
- **对照核实**：opencode 源码中 ignored part 在构建 LLM 请求时被排除
  （`packages/opencode/src/session/message-v2.ts:206`），
  `session.prompt({noReply, ignored})` 在 turn 在途时也能正确持久化
  （`prompt.ts:1069`）——机制本身安全，Bug #20 是 ACP 自身逻辑问题

### 3.6 Nudge 系统

三级压力提示系统，在上下文接近上限时引导模型主动压缩：

| 级别 | 触发条件 | 注入频率 | 语义 |
|------|---------|---------|------|
| Context limit nudge | `total_tokens > maxContextLimit` | 每 `nudgeFrequency` 帧 | 紧急——必须触发压缩 |
| Turn nudge | 介于 min/max 之间 + 新用户轮次 | 每轮一次 | 温和——考虑压缩 |
| Iteration nudge | 介于 min/max 之间 + 助手消息数超阈值 | 每轮一次 | 警告——对话过长在漂移 |

### 3.7 状态模型与配置模式

#### CompressionBlock 状态

```typescript
interface CompressionBlock {
  blockId: string           // 块 ID
  runId: string             // 所属运行轮次
  active: boolean           // 当前是否活跃

  compressedTokens: number  // 压缩前的 token 总量
  summaryTokens: number     // 摘要的 token 量
  durationMs: number        // 压缩耗时

  mode: "range" | "message"
  topic: string             // 模型指定的主题
  batchTopic: string        // 批处理主题

  startId: string           // 起始消息引用
  endId: string             // 结束消息引用
  anchorMessageId: string   // 锚定消息 ID（用于重新排序）

  includedBlockIds: string[]    // 此块包含的子块
  consumedBlockIds: string[]    // 此块覆盖的已消费块
  parentBlockIds: string[]      // 父块引用

  directMessageIds: string[]     // 直接引用的消息
  directToolIds: string[]       // 直接引用的工具调用

  effectiveMessageIds: string[]  // 展平后的消息列表
  effectiveToolIds: string[]     // 展平后的工具列表

  summary: CompressionSummary   // 包装后的摘要文本
}
```

状态维护在 `SessionState` 中，包含 `byMessageId`（消息→块映射）、`blocksById`、`activeBlockIds`、`activeByAnchorMessageId`。`syncCompressionBlocks` 在每个 transform 周期重新计算哪些块是活跃的。

#### 配置 Schema

完整配置在 `dcp.schema.json`（319 行），关键字段：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | bool | `true` | 启用 DCP |
| `compress.mode` | `"range" \| "message"` | `"range"` | 压缩模式 |
| `compress.maxContextLimit` | number | `100_000` | token 上限（触发紧急 nudge） |
| `compress.minContextLimit` | number | `50_000` | token 下限（开始温和 nudge） |
| `compress.nudgeFrequency` | number | `5` | context limit nudge 注入间隔 |
| `compress.protectedTools` | string[] | `["task"]` | 不参与压缩的工具 |
| `strategies.deduplication.enabled` | bool | `false` | 启用去重 |
| `strategies.purgeErrors.enabled` | bool | `true` | 启用错误清除 |
| `turnProtection` | number | `4`（且 `enabled=false`） | 保护最近 N 个**助手步**（step-start 计数） |
| `protectUserMessages` | bool | `true` | 保留用户消息原样 |
| `protectTags` | string[] | — | 具有特定标签的消息不压缩 |

### 3.8 ACP（DCP fork）架构分析（源码核实，2026-07-27）

ACP（`~/Code/Agent/opencode-acp`）是 DCP 的 fork，修复 39 个 bug，
核心增量是**模型自主的三层 LSM 式压缩**与一系列缓存/防刷工程修正。
自述实测：30,000+ API 调用中 p97 < 200K tokens（1M 窗口）、91%
前缀缓存命中率、会话寿命从 ~0.2 天延至 259 天。与 DCP 相同的机制
（dedup、purge-errors、mNNNN、16 步管道的删减版）不再重复；§3.5
已记载的 pruneToolOutputs hotfix（Bug #38）与通知 Bug #20 此处不
重述，只记 DCP 没有的增量。

#### 3.8.1 三层压缩 T1/T2/T3（LSM 类比）

针对"摘要自身无限累积"问题——扁平 T1 摘要数量随会话增长，最终摘要
本身成为新膨胀源。ACP 的对策是对**平级摘要再压缩**（非块嵌套）：

| 层 | 输入 | 输出 | 压缩比 | 触发 |
|----|------|------|--------|------|
| T1 捕获 | 原始消息段 | 详细摘要（含过程） | ~45× | 原始上下文 > `maxContextLimit`（默认窗口 55%） |
| T2 提炼 | 多个相邻 T1 摘要 | 决策级摘要（只留结论） | ~10× | T1 摘要合计 > `nudgeGrowthTokens`（默认窗口 5%） |
| T3 精简 | 多个 T2 摘要 | 事实级摘要 | ~5× | 同 T2 阈值 |

- **层级提升自动检测**：新块记录 `deactivatedByBlockId` 链，被消费
  的旧块自动失效并从上下文移除；模型无需理解层级概念
- **hideConsumedCompressCalls**：被消费块对应的 compress 工具调用
  part 也一并移除（保留消息外壳）
- **与本文档"扁平块不嵌套"决策的关系**：T2 不是 DCP 式的块套块
  （8 种块间关系），数据模型只需 `tier` 字段 + `deactivatedBy`
  指针；可作为后续增量而非推翻扁平 MVP

#### 3.8.2 压缩范围保护三件套

`preserveRecentMessages`（20）+ `preserveRecentTokens`（20K）+
`preserveLastUserMessage`（true）。`computeProtectedRawIds`
（`lib/compress/pipeline.ts:243-296`）算出受保护消息 ID 集合，
`checkProtectedRange` 拒绝与保护区重叠的模型压缩范围。

> **对照（2026-07-30 更新）**：compress 落地时已引入同口径保护——
> 消息条数（`protected_messages` 20，与 dedup 共用 `protectedBoundary`）
> + token 预算（`protected_tokens` 20K）+ 末条用户消息，三重取最保守
> 边界（§4.7）；原 step-start 保护窗已统一为消息条数口径。

#### 3.8.3 幻影门禁与质量门禁

- `minCompressRange`（默认 5000 字符）：`checkPhantomBlock` 拒绝
  零收益压缩范围——与我们 dedup 的"零收益跳过"同源（§4.5）
- `lib/compress/quality-gate/`：可插拔提交前质量评估（L1 长度下限 +
  L2 ROUGE-1 关键字召回），默认关闭

#### 3.8.4 Nudge 防刷屏基线

跟踪 `lastPerMessageNudgeTokens`（未提示基线）与
`lastNudgeShownTokens`（提示后基线）；再次提示要求 token 增长 ≥
`growthFloor = max(5000, 0.45 × nudgeGrowthTokens)`；压缩后按
压缩比例调整基线，避免"上下文略降 → 立即再提示"的抖动
（`lib/messages/inject/inject.ts:126-153`）。

#### 3.8.5 GC 安全网与缓存纪律

- 仅在 100% 上下文时触发的硬回退：`runMajorGC` 截断旧摘要
  （`maxOldGenSummaryLength` = 3000 字符）、`runBatchCleanup`
  合并相邻旧块
- 缓存纪律：compress 只做**整段移除 + 锚点合成摘要消息 + 尾部
  追加**，不原地编辑历史消息（原地替换打爆 GLM 前缀缓存的教训，
  §3.5 Bug #38）；`filterCompressedRanges` 强制保留第一条用户
  消息（修零用户冻结）

#### 3.8.6 模型工具面

`compress` / `decompress`（支持 `toFile` 写文件避免恢复内容膨胀
上下文、`full` 完全恢复）/ `search_context`（按关键字搜压缩块
摘要）/ `acp_status`（token 分解 + 块明细 + 可压缩范围）/ `prune`。

#### 3.8.7 其他工程细节

- `SessionStateRegistry`：per-session 状态隔离，32 会话软上限逐出
- `resetOnCompaction`：检测到内置 compaction 运行时清空陈旧块状态

---

## 4. ZooKeeper 当前实现

已实现**观测层 + 统一 marks 剪枝核心（手动 sweep + 自动 dedup）+ 批量释放
+ 持久化 + 手动压缩（/dcp compress，机械摘要 MVP）+ 折叠视图观测接线**
（截至 2026-07-30，TS 测试 1560 全绿）。核心逻辑在
`src/core/pruning/`（框架无关），OpenCode 适配在 `src/hooks/` 与
`src/opencode.ts`。

### 4.1 架构总览（统一 producer 模型）

一切剪枝行为建模为 producer `{ selector, range, protection, release }`：

```
sweep  = { selector: all,        range: since-last-user|last-N,
           protection: 0,        release: immediate }
dedup  = { selector: duplicates, range: session,
           protection: 20 条,   release: batch(released_percent) }
```

```
每轮 experimental.chat.messages.transform (src/opencode.ts):
  ├─ contextPruningTransformHandler (src/hooks/context-pruning/hook.ts)
  │   Phase 1 折：syncBlocks（失效检测 → pendingViewChange）
  │              → foldCompressedBlocks（折叠视图替换消息数组）
  │   Phase 2 清：pruneToolOutputs — 替换 effective 标记的输出
  │   Phase 3 标：门控（prompt 侧总量 ≥ threshold_context）→ producer 循环
  │              → 新标记写入 marks（effective=false）
  │   Phase 4 refs（strip → compaction 检测 → 分配 → 注入）
  │   Phase 5 放：批量释放 pending ≥ promptTokens × released_percent%
  │              或 pendingViewChange（视图变化强制释放，无视门槛）
  │              → 释放时注入 ignored 通知（noReply，LLM 不可见）
  │   Phase 6 收尾：清 pendingViewChange + 持久化（dirty 时）
  │              + prune_completed 日志
  └─ measureContext (src/core/metrics.ts)

/dcp sweep [N]（command.execute.before）:
  └─ runSweep → addMark(effective=true)（立即生效，用户主权）

/dcp compress（command.execute.before）:
  └─ planCompression → 用户确认 → buildBlockSummary（机械摘要）
     → createBlock 持久化 → 下轮 Phase 0.5 折叠生效

TUI 侧边栏 (src/tui.tsx): 全量 fetch → 读盘 loadSessionState（纯只读）
   → liveBlocks + previewFold 折叠 → computeContextReport
   （prunedCallIDs 只含 effective 标记）→ 渲染
```

### 4.2 marks 单集合状态（`src/core/pruning/marks.ts`）

```typescript
interface Mark { tokens: number; effective: boolean; action: PruneAction }
interface SessionState {
  sessionId: string;
  marks: Map<string, Mark>;     // 单集合，取代旧双 Map + 5 累计字段
  blocks: Map<string, CompressionBlock>;  // 压缩块（§4.7）
  pendingViewChange: boolean;   // 视图变化标志，in-memory only 不落盘
  lastAccessedAt: number;
  dirty: boolean;               // runtime-only
}
```

- **单集合 + 状态位**：生命周期是实体的属性而非位置；`addMark` 幂等
  （先到先得）天然替代双查重；`releaseBatch` 只统计实际翻转
- **stats 全派生**：`pendingCount/pendingTokens/reclaimedTokens/markedCount/
  markedTokens` 均为 O(n) 纯函数，无累计器双写义务
- **承重语义：marks 永不删除**——即使引用的消息已被压缩移除（悬空
  mark 是无害历史记录；派生正确性依赖单调性）
- **`pendingViewChange` 不落盘**：视图变化强制释放是当轮事件，持久化
  只会在崩溃恢复后误触发一次无意义的全量释放
- **持久化**：`~/.zoo/storage/{sessionId}.json`，shape 为
  `{ marks: Record<callID, {tokens, effective, action}>,
    blocks: Record<blockId, CompressionBlock>, lastUpdated }`；
  旧 shape（紧凑键 `{t,e,a}`/`{t,e}` 及 prune.tools/stats）加载为空
  （无迁移层）；marks 与 blocks 各自全字段严格校验（含 `tier === 1`
  枚举），任一损坏即空载；原子写（tmp + rename）；sessionId 安全正则
  防路径穿越

### 4.3 观测层

| 文件 | 职责 |
|------|------|
| `src/core/metrics.ts` | 唯一测量模块（findLastCompletedAssistant、CJK 启发式、computeContextReport、缓存命中率）；**系统类为残差法** `max(0, total − user − asst − tool)`（见下方注） |
| `src/core/context-report.ts` | 纯展示层：`formatContextReport(report, opts)`——**双口径消息数**（`模型可见 X 条 · 存储 Y 条`，相等时单行）；回收两态（`已生效` / `待生效` 分行）；**不区分手动/自动**（release 后本质相同） |
| `src/hooks/context-command/index.ts` | `/dcp` 命令分发：`context`/`sweep [N]`/`compress`/`help`；报告数据源自内存态 `getOrCreateSessionState`，消息计数经 `liveBlocks` 折算 |
| `src/tui.tsx` | `ZookeeperPanel` 侧边栏；**分类分布跑在折叠视图上**（读盘 `loadSessionState` → `liveBlocks` + `previewFold`，纯只读不写状态）；`prunedCallIDs` 只含 effective 标记 |

> **系统类残差法（2026-07-30 修正）**：旧实现用 DCP 式减法（首条已完成
> assistant 的 API `input+cache` − 之前消息的启发式和）估算系统 prompt。
> TUI 接折叠视图后，被压消息替换为小摘要导致减数缩水、残差爆炸
> （实测系统类 135.6K / 86.7%，四类合计 148%）。改为残差法后 total
> （末条 assistant 的 API 上报，本身即折叠口径）与三类计数天然同视图，
> 任何视图（折叠/原始/compaction 后）自洽；原第五类 `misc` 已删除
> （恒 0 且零消费方，"none" 类 part 流入系统残差）；
> `findFirstCompletedAssistant` 随之删除。

### 4.4 手动剪枝（/dcp sweep）

- `/dcp sweep`：标记最后一条非 ignored 用户消息之后的所有工具输出
- `/dcp sweep N`：回溯标记最近 N 个工具输出
- 语义 = `{ selector: all, protection: 0, release: immediate }` 的
  producer（`src/core/pruning/producers/sweep.ts`）；`addMark` 幂等跳过
  已存在 callID（先到先得：若 dedup 已标 pending，sweep 不覆盖）

### 4.5 自动去重（dedup producer）

`src/core/pruning/producers/dedup.ts`：

- **签名** = `tool::JSON.stringify(归一化 input)`：键递归排序 +
  剔除 null/undefined + 任意深度剔除易变字段（timestamp/ts/date）
- **保护窗**：消息条数口径，末尾 `protected_messages`（默认 20）条非
  ignored 消息内的调用事前过滤（`protectedBoundary`，producers/
  shared.ts；2026-07-30 从 step-start 计步统一改名，被 compress 复用）
- **跳过**：已存在 mark（单集合 `marks.has`）、protected_tools（默认仅
  `question`，§6.5）、error/非 completed part、**零收益**（output 估算
  ≤ 占位符估算时不标记——短输出被更长占位符替换会反增上下文）
- **门控**：prompt 侧总量（`input + cache.read + cache.write`）≥
  `threshold_context`（默认 100K）才扫描；缺失向安全方向失败
- **批量释放**：`Σ pending ≥ promptTokens × released_percent%`
  （默认 10%，0 = 每轮立即释放）时 `releaseBatch` 全部翻转，
  下一轮 Phase 1 替换生效——破缓存从每轮降为低频批量事件；
  **视图变化轮（折叠首秀/块失效）无视门槛强制释放**（§4.7）
- **通知**：仅释放时一条 `session.prompt({ noReply: true, ignored: true })`
  消息（"去重：已折叠 N 个重复工具输出，约释放 X tokens"）——追加在
  末尾不破前缀缓存；ignored part 在 `message-v2.ts:206` 被排除出 LLM
  上下文（源码核实）；fire-and-forget，失败仅 warn

### 4.6 自动错误清除（purge-errors producer）

`src/core/pruning/producers/purge-errors.ts` 实现第三个 producer，清理
**失败（error 状态）工具调用的 input 字符串字段**。与 dedup 互补——

| dedup | purge-errors |
|-------|-------------|
| 成功工具（completed）去重 | 失败工具（error）清 input |
| 替换 output | 替换 input 字符串值字段 |
| 保护窗+零收益跳过 | 保护窗+零收益跳过 |
| action=`"tool-output"` | action=`"tool-error-input"` |

#### Action 建模（`src/core/pruning/marks.ts`）

单一 marks 集合通过 `action` 字段区分两类标记：

```typescript
type PruneAction = "tool-output" | "tool-error-input";
interface Mark { tokens: number; effective: boolean; action: PruneAction; }
```

持久化 shape 为全单词键 `{tokens, effective, action}`（取代紧凑键
`{t, e, a}`）。加载时严格校验：任一条目
缺字段/类型错/action 非枚举值 → 整文件按空会话处理并记 warn 日志
（禁止写旧 shape 推断默认值，无迁移层）。`releaseBatch` 返回新增
`byAction: Record<PruneAction, {count, tokens}>` 供通知泛化计数。

#### R1：三层配置拆分

`config.toml` 管道级共用键位于 `[zoo.context]` 顶层（2026-07-30 改名：
`turn_protection` → `protected_messages`、`release_threshold_percent` →
`released_percent`、各 producer 的 `threshold_tokens` →
`threshold_context`，旧键不再读取），新增 `[zoo.context.compress]`：

```toml
[zoo.context]
enabled = true
protected_messages = 20      # 消息条数保护：末尾 N 条非 ignored 消息计入保护区
released_percent = 10        # pending 合计达上下文长度此百分比时统一释放

[zoo.context.dedup]
enabled = true
threshold_context = 100000
protected_tools = []

[zoo.context.purge_errors]
enabled = true
threshold_context = 100000
protected_tools = []

[zoo.context.compress]       # 新增（§4.7）
enabled = true
threshold_tokens = 2000      # 幻影门禁：小于此收益的段跳过压缩
protected_tokens = 20000     # 末尾累计达此值后不压缩（token 保护窗）
```

`src/hooks/context-pruning/hook.ts` 定义 `ContextPruningConfig` 三层接口：

```typescript
interface ProducerGateConfig {
  enabled?: boolean;
  thresholdContext?: number;
  protectedTools?: string[];
}
interface ContextPruningConfig {
  protectedMessages?: number;      // 管道级保护窗（消息条数口径）
  releasedPercent?: number;        // 管道级批量释放阈值
  dedup: ProducerGateConfig;
  purgeErrors: ProducerGateConfig;
  compress?: CompressionGateConfig; // enabled/thresholdTokens/protectedTokens
}
```

`src/opencode.ts` 中的 `parseContextConfig` 完成三层全量解析：
逐字段类型防御（非期望类型落默认），未知键忽略，旧键不兜底。

#### R3：表驱动 producer 循环

Phase 2（标记阶段）从单一 `if (enabled) { runDedup }` 改为静态数组循环：

```typescript
const producers = [
  { name: "dedup", gate: config.dedup,
    run: () => runDedup(state, messages, {turnProtection, protectedTools}) },
  { name: "purge-errors", gate: config.purgeErrors,
    run: () => runPurgeErrors(state, messages, {turnProtection, protectedTools}) },
];
for (const {name, gate, run} of producers) {
  if (gate.enabled === false) continue;
  if (promptTokens < (gate.thresholdTokens ?? 100000)) continue;
  const marks = run();
  if (marks.length) log(`${name}_marked`, ...);
}
```

每个 producer 独立评估自己的门控（`enabled` + `thresholdContext`）；
提示侧总量不足时向安全方向失败（不执行）。无注册表、无动态发现——
静态数组即止。统一释放（循环外一次 `releaseBatch` 判断：全部 pending
tokens ≥ promptTokens × released_percent% → 两类标记一起翻转；
`pendingViewChange` 置位时无视门槛强制释放，§4.7）。
通知文案改为按 action 计数的中性表述：

```
"上下文清理：已折叠 N 个工具调用，约释放 X tokens（tool-output M 组、tool-error-input K 组）"
```

#### Error 状态检测与跳过链

`runPurgeErrors` 跳过链（短路于首次命中）：

1. **非 tool part** → 跳过
2. **非 error 状态**（`part.state.status !== "error"`）→ 跳过（只处理失败调用）
3. **无 callID** → 跳过
4. **callID 已在 `state.marks`** → 跳过（幂等）
5. **在消息条数保护窗内**（末尾 `protected_messages` 条非 ignored 消息，
   共享 `collectProtectedCallIDs`）→ 跳过
6. **工具名在 `protectedTools`** → 跳过（默认 `["question"]`）
7. **零收益**（input 字符串值总长度 ≤ 占位符长度估算）→ 跳过
8. **命中**：`addMark(state, callID, tokens, false, "tool-error-input")`

#### Phase 1 清阶段分流

`src/core/pruning/prune.ts` 两个清理函数各自过滤 action：

```typescript
pruneToolOutputs(state, messages)  // 只处理 mark.action === "tool-output"
pruneToolErrors(state, messages)   // 只处理 mark.action === "tool-error-input"
```

`pruneToolErrors` 替换语义：

- 整个 input 为字符串 → 替换整个字符串为 `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT`
- input 为对象 → 只替换字符串值字段（数字/布尔/嵌套对象/数组不动）
- `state.error`、`state.output` 不动
- null/undefined input → 跳过

#### 文件清单

| 文件 | 变更 |
|------|------|
| `config.toml` | `[zoo.context]` 顶层管道级键；`[zoo.context.purge_errors]` 三键（2.6 改名：`protected_messages`/`released_percent`/`threshold_context`，新增 `[zoo.context.compress]`，见 §4.6 配置节） |
| `src/core/pruning/types.ts` | 新增 `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT` 常量 |
| `src/core/pruning/marks.ts` | `PruneAction` 类型；`Mark.action`；持久化 `{tokens,effective,action}`；严格加载校验；`releaseBatch` 返回 `byAction` |
| `src/core/pruning/prune.ts` | 新增 `pruneToolErrors`；`pruneToolOutputs` 加 action 判别 |
| `src/core/pruning/producers/purge-errors.ts` | 新建：`runPurgeErrors`（error 扫描 + 跳过链） |
| `src/core/pruning/producers/shared.ts` | 抽取 `collectProtectedCallIDs`/`netReclaimTokens` 共享辅助 |
| `src/hooks/context-pruning/hook.ts` | `ContextPruningConfig` 三层；表驱动 producer 循环；双门控独立评估；统一释放；byAction 通知 |
| `src/opencode.ts` | `parseContextConfig` 三层解析；管道级键从顶层读取（2.6 改名后旧键不兜底） |
| 测试 | 全仓 TS 测试全绿（2.6 时点 1560） |

> **实测修正注记（2026-07-25，裸 SQL 核实）**：
>
> 前设计假定 purge-errors 剪枝 output，经实测更正：
>
> 1. **error 状态 tool part 没有 `state.output` 字段**——全局 0 字符，
>    剪枝 output 无意义。可剪目标是 input 字符串字段。
> 2. **全局数据**：error part 的 input 字符串字段合计 537K chars
>    （≈ 134K tokens，按 4 chars/token 估算），占全局输入约 0.3%。
> 3. **尾部风暴**：错误风暴尾部会话（>500 条消息）中 error input 占比
>    升至 1-11%，价值定位为**尾部保险**——靠 dedup 处理成功调用的大头，
>    purge-errors 兜底失败调用累积。
> 4. **工具分布**（按 input chars）：edit 273K / write 127K / task 119K
>    chars——edit/write 高是失败时快速重试带满参数，task 是子代理出错时
>    大段 intent 文本。
> 5. **DCP 对齐核实**：DCP 的 `purgeToolErrors` 也是擦除 input 字段而非
>    output（`lib/messages/prune.ts:24`），默认 4 步老化保护（默认关闭）。
>    我们的实现保持该语义：清理 error input、保留 `state.error` 消息。

### 4.7 手动压缩（/dcp compress，✅ 已实现 2026-07-30）

范围压缩的机械摘要 MVP：用户一条命令把保护窗外的旧历史折叠为结构化
摘要块，LLM 驱动摘要留给 V3（§5.2）。设计决策（2026-07-30 用户确认）：
**无参命令**（压缩范围由三重保护 + 阈值自动确定，优于手动百分比）；
**机械摘要**（确定性、零 API 成本、可测试；非 LLM 生成——这是与
§5.2 原定"启发式占位摘要→LLM 摘要"路线的有意演进）。

#### 四阶段流水线

```
/dcp compress（command.execute.before，context-command/index.ts）:
  1. planCompression（compress.ts）→ 通知计划（段数/消息数/预估回收）
  2. 用户确认（下一条消息 y/yes）
  3. buildBlockSummary（机械摘要）→ createBlock 持久化（blocks.ts）
     → 锚点幂等检查 → BLOCK_HEADER_TEMPLATE 占位符回填（b<N> → bN）
     → 完成通知（含累计回收）
  4. 下一轮 transform Phase 1：foldCompressedBlocks 折叠生效
     → pendingViewChange → Phase 5 强制释放全部 pending 剪枝标记
```

#### 三重保护与双门禁（compress.ts `planCompression`）

压缩段末端取三者最保守边界（`Math.min`）：

1. **消息条数保护**：末尾 `protected_messages`（默认 20）条非 ignored
   消息不压（`protectedBoundary`，producers/shared.ts，与 dedup 共用）
2. **token 保护**：从末尾累积启发式估算达 `protected_tokens`
   （默认 20K）后的内容不压（ACP 范围保护三件套的口径，§3.8.2）
3. **末条用户消息保护**：最后一条用户消息及其后内容不压

双门禁（与 dedup 零收益跳过同源，§3.8.3）：**幻影门**
（`threshold_tokens` 默认 2000，段收益不足则跳过）与**负收益门**
（摘要估算 ≥ 原文估算时不压）。

#### 块状态层（blocks.ts）与折叠通路（fold.ts）

- `CompressionBlock`：`blockId`（b1/b2/...）、`anchorMessageId`（锚点 =
  段内首条消息，幂等键）、`messageIds`、`summary`、`compressedTokens`/
  `summaryTokens`、`active`、`tier`（恒 1，为 T2 再压缩预留，§9.8）、
  `deactivatedAt`
- **两阶段纪律**：blocks.ts 只写状态，fold.ts 只读状态做变换；
  `previewFold`/`liveBlocks` 为纯函数（TUI/命令/测试复用），
  `foldCompressedBlocks` 是应用其结果的薄壳
- **折叠语义**：整段移除 + 锚点位置插入合成摘要消息（`role=user`，
  header `[Compression Block bN]`），不原地编辑历史消息
  （前缀缓存纪律，§3.8.5）；段内工具输出同时替换为占位符
- **首条用户消息 force-keep** 三分支：锚点即首用户 → 合成消息与原
  消息都保留；首用户被压但非锚点 → 原消息保留；其余 → 正常透传
  （修零用户冻结，同 ACP §3.8.5）
- **块失效**：锚点/成员消息从存储消失（如内置 compaction）时块自动
  失效（`syncBlocks`），原始内容若仍在存储则恢复显示

#### 视图变化强制释放（hook.ts）

用户洞察（2026-07-30）：**压缩必破前缀缓存，此刻释放全部 pending
剪枝标记是零成本搭车**——即使未达 `released_percent` 门槛。

- `pendingViewChange`：in-memory 标志（不落盘），折叠首秀轮与块失效轮
  由 Phase 1 置位
- 批量释放门槛化简为 `pendingViewChange || (promptTokens > 0 &&
  releasedPercent !== undefined)`；强制路径旁路阈值，日志带
  `forced: "view_change"`；标志在释放检查后无条件清除（稳态轮绝不
  误触发）；`promptTokens === 0` 时强制路径不被外层门槛跳过
  （审查发现的边界洞，有回归测试）

#### 观测接线

- **TUI 面板**：分类分布跑在折叠视图上（模型实际所见），TUI 进程
  纯只读（只 `loadSessionState` + 纯函数，不 `syncBlocks`/
  `saveSessionState`；磁盘最多滞后服务端一轮 transform，2 秒防抖
  自愈，这是两进程只读架构的固有延迟而非缺陷）
- **`/dcp context`**：双口径消息数（`模型可见 X 条 · 存储 Y 条`，
  相等时单行）；回收栏已生效/待生效两态分行

#### 端到端验证（2026-07-30）

本会话（实现会话自身）被连续压缩 3 次（b1：48 条 / b2：20 条 /
b3：40 条），编排器以被测对象身份确认：机械摘要的信息密度足够支撑
后续协作（跨块引用审查结论、修复历史无记忆断层）；三轮双路 Eagle
审查全部发现闭环（3 Should Fix + 14 Could Fix：真实项全部修复并
回归，误报/非缺陷项附代码证据驳回）。

### 4.8 认知收获（仍然成立的）

1. **两阶段必须是分离的代码路径**（或在同一 handler 内严格先清后标），
   否则标记-清理边界产生 off-by-one（§3.3）
2. **marks 集合是唯一数据通路**，且永不删除——它同时是 TUI 的剪枝感知
   数据源与全部派生统计的事实源
3. **TUI `api.state` 截断到最近 100 条消息**（`sync.tsx:597`），"第一条
   消息"类推算（如 system 估算）在截断窗口里会被骗——全量数据必须走
   `api.client.session.messages()`
4. **TUI 与 server 的 SDK 签名不同**（TUI 端 `session.messages({ sessionID })`，
   server 端 `session.messages({ path: { id } })`）；SDK 默认
   `throwOnError: false`，HTTP 错误以 `{ error }` 返回，必须显式检查
5. **CJK 分文字系统估算**（/1.5）即可消除中文系统性低估，无需 tokenizer；
   asst 分类用 `Σ tokens.output`（API 精确）
6. **TUI 插件任何异常都要 try/catch 兜底**——崩溃会拖垮整个宿主客户端；
   `api.state` 数组在 streaming 过渡期含 undefined 元素，遍历必须 falsy
   防御；无内容带 border 的 box 会导致 Yoga 布局塌陷，分隔线用纯文本
7. **命令/通知输出必须 `ignored: true`**，否则变成新上下文；ignored
   消息在 TUI 渲染为普通用户气泡（TUI 不过滤 ignored），但 LLM 不可见
   （`message-v2.ts:206`）
8. TUI 进程的 logger 需要显式 `setSessionId` 才能落盘
9. **`session.prompt` 可在 turn 在途时安全调用**（noReply + ignored 标志
   会被正确持久化，源码核实 prompt.ts:1069）；ACP 的 Bug #20 反馈循环
   源于其自身 lastUser 检测逻辑误拾通知消息，非 opencode 机制缺陷
10. **跨视图相减必爆炸**：任何"A 视图的 API 精确值 − B 视图的启发式和"
    的估算，在两个视图可能不同源（折叠/截断/compaction）时必然失真——
    系统类残差法的教训（§4.3）；估算要么全分量同视图，要么用
    `max(0, total − 同视图分量)` 的残差构造
11. **视图变化轮是释放剪枝标记的免费搭车点**：折叠/失效本就打破前缀
    缓存，强制释放零额外成本；用 in-memory 标志（不落盘）把"视图变化"
    事件从 Phase 1 传到释放检查（Phase 5），比持久化状态机简单且崩溃安全

---

## 5. 长期方案设计参考（V3+）

以下为 1.x 文档中仍然有效的长期设计，供压缩引擎（V3）及后续步骤参考。
1.x §5.4-5.10（类型/配置/估算/状态/管道/去重/错误清除的具体代码）已被
§4 的实际实现与 §6 的定稿取代，§5.13（src/index.ts 集成草图）与 §5.16
（持久化设计）已被实际实现取代，不再保留。

### 5.1 目标架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Framework Adapters                        │
│  ┌──────────────────────┐  ┌──────────────────────────┐     │
│  │  OpenCode Hook       │  │  pi Adapter               │     │
│  └─────────┬────────────┘  └──────────┬───────────────┘     │
├─ - - - - - - - - - - - - - - - - - - - - - - - - - - - - ┤  │  ← framework boundary
│            ▼                           ▼                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Framework-Agnostic Core                  │    │
│  │  dedup / purge-errors / compress (range/message)      │    │
│  │  → pipeline → state (SessionState)                    │    │
│  │  types / estimator / nudge                            │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

当前实际布局：`src/core/pruning/`（框架无关）+ `src/hooks/context-*/`
（OpenCode 适配）。随策略增多，可按 types / estimator / state / strategies /
pipeline 进一步拆分。

### 5.2 压缩引擎（Range 模式）参考设计

> **进度（2026-07-30）**：启发式/机械摘要 MVP 已落地（§4.7）——三重
> 保护、幻影门、整段移除 + 锚点合成摘要、缓存纪律均已按本节设计实现，
> 摘要从"占位"演进为确定性机械摘要（非 LLM）。剩余 V3 工作：注册
> compress 工具切换为 LLM 驱动摘要（DCP 的模式，§3.4）、mNNNN 引用、
> nudge 系统。
>
> 原实施路线：先启发式 Range 压缩（无 LLM 调用）验证块生命周期，再注册
> compress 工具切换为 LLM 驱动摘要（DCP 的模式，§3.4）。

```typescript
// 压缩触发：仅在总量超阈值时执行
const totalTokens = estimateTotalTokens(working);
if (config.compressEnabled && totalTokens > config.compressMaxTokens) {
  const result = runCompression(working, state, config);
}

// 可压缩范围识别（启发式）：
//   - 已完成的 task() 交互轮次（task + tool results）
//   - 已验证的工具输出（successful bash/read after verification）
//   - 保护窗之外的旧历史
// 块替换：范围消息 → 单条摘要消息（metadata.compressed = true，
//   原始消息可通过 blockId 追溯，非破坏性）
```

摘要结构对齐 OpenCode V2 的七维度（§2.1）：goal / progress / decisions /
keyContext / files。启发式阶段先生成占位摘要，LLM 阶段由 compress 工具
的参数驱动。

ACP 经验吸收（§3.8，2026-07-27 调研）：

- **范围保护三件套**：preserveRecentMessages=20 / preserveRecentTokens=
  20K / 保留最后一条用户消息；模型提交范围与保护区重叠时拒绝或裁剪
- **幻影门禁**：minCompressRange（默认 5000 字符）拒绝零收益范围，
  与 dedup 零收益跳过同源
- **替换语义**：整段移除 + 锚点合成摘要消息，不原地编辑历史消息
  （前缀缓存纪律，§3.8.5）；被消费块的 compress 调用 part 一并隐藏
- **手动触发先行**：`/dcp compress` 走 DCP 的 pendingManualTrigger
  模式（改写为合成用户消息，模型自主调 compress 工具），不做旁路
  API 调用；nudge 系统可晚于 compress 工具交付

### 5.3 Nudge 注入参考

三级体系对齐 DCP（§3.6）：紧急（超 urgent 阈值）/ 温和（min-max 之间新
用户轮）/ 漂移（助手消息数过多）。nudge 是 soft guidance 而非硬约束；
文本注入即可，不需要 compress 工具存在（但"建议调用 compress"类文案
需在工具注册后才有意义）。防刷屏基线吸收 ACP（§3.8.4）：记录上次
nudge 时 token 基线，增长未达 floor（max(5000, 0.45 ×
nudgeGrowthTokens)）不再提示；压缩后按比例调整基线。

### 5.4 命令机制与扩展

命令通过 `config` hook 动态注册（**不要**在 config.toml/install.py 静态
声明——OpenCode 在 config 最终化时读取 `config.command`），处理通过
`command.execute.before` 分发，输出用 `sendIgnoredMessage`
（`ignored: true`）。当前已实现 `context`/`sweep`/`compress`/`help`；
后续可扩展：

| 命令 | 用途 | 依赖 |
|------|------|------|
| ~~`/dcp compress`~~ | ✅ 已实现（无参，机械摘要 MVP，§4.7）；V3 演进为 LLM 驱动摘要 | compress 工具（V3） |
| `/dcp decompress <id>` | 恢复指定 blockId 的原始消息 | 压缩引擎（V3） |
| `/dcp recompress <id>` | 用新策略重新压缩指定范围 | 压缩引擎（V3） |

> 跨会话累计回收统计**不做聊天命令**（2026-07-27 决策）：归 `zinspect`
> （Rust CLI），作为 `stats` 的新 section（无剪枝事件时不显示；加
> `--pruning` 标志与 `--tokens`/`--hooks` 同构可单独查看），数据源为
> JSONL hook 日志中的 `prune_completed` / `*_marked` / `*_released`
> 事件——zinspect 已是 hook 观测的统一入口，聊天侧不新增命令噪音。

---

## 6. 自动去重 dedup（✅ 已实现，2026-07-25）

> **完成状态**：本节设计已落地并经实测验证（>100K 会话中标记/批量释放/
> ignored 通知/占位符替换全链路确认）。实现过程中发生一次重要架构升级：
> 初版"双 Map + 累计器"被重写为**统一 producer 模型 + marks 单集合**
> （§4.1/§4.2），§6.6/§6.7/§6.8 已按 as-built 修订，§6.2-§6.5 保留
> 定稿原文（语义与实现一致）。
>
> **2.6 注记（2026-07-30）**：配置键已改名（`turn_protection` →
> `protected_messages`、`release_threshold_percent` → `released_percent`、
> `threshold_tokens` → `threshold_context`，见 §4.6）；保护窗从
> step-start 计步（5 步）统一为**消息条数口径**（默认 20 条非 ignored
> 消息，`protectedBoundary`），与 compress 共用；`protected_tools`
> 默认已从 `["question"]` 改为 `[]`。本节下文保留历史定稿原文。

决策记录（2026-07-23 与用户确认）：只做 dedup（purge-errors 下一步）；
阈值门控触发，默认 100K 可配置；轮次保护默认 5 步（step-start 口径）。
追加决策（2026-07-25）：门控口径改为 prompt 侧总量；批量释放
（release_threshold_percent）；protected_tools 默认精简为 question；
ignored 释放通知；展示层不区分手动/自动。

### 6.1 目标

编排器在跨委派轮次中重复 `read`/`grep`/`bash` 是最大冗余源（§1.3）。dedup
自动发现重复工具调用并标记旧副本，复用现有两阶段通路，**零新基础设施**。
算法对齐 DCP 去重策略（§3.5）。

### 6.2 触发与两阶段时序

DCP 把策略挂在 compress 工具上（§3.3）；我们没有 compress 工具，策略
放进 transform 管道，因此必须**先清后标**。每次
`experimental.chat.messages.transform`：

```
1. pruneToolOutputs        — 清理：替换【之前轮次】标记的 callID
2. 门控判断                — enabled 且
                              最后一条已完成 assistant 的 prompt 侧总量
                              （input + cache.read + cache.write）≥ 100K
3. runDedup                — 标记：扫描全量消息，新标记写入 state.marks
                             （effective=false）【下一轮 transform 生效】
```

清理只作用于历史标记，本轮新标记必然下一轮生效，与 DCP 分离路径语义
严格等价。去掉现有的"空 map 早退"（门控不满足时扫描本身不执行）。

门控语义：

- 阈值依据是**最后一条已完成 assistant 消息的 prompt 侧总量
  （`input + cache.read + cache.write`）**（API 精确的上下文填充量），
  不含启发式尾段——门控决策宁稳勿滥。`cache.read` 与 `cache.write` 纳入
  总量是因为 prompt caching 开启后，大部分上下文计在 cache 字段而非
  `input` 中（实测 `tokens.input` 仅 527 而上下文总量 109K），
  单独依赖 `tokens.input` 会导致门控永远不触发
- 缺失处理向安全方向失败：`input`、`cache.read`、`cache.write` 三项
  全缺视为 0（不通过门控）
- 剪枝是有损操作：上下文充裕时保留原始信息；且 dedup 是全量扫描，触发时
  能补标所有历史重复，门控不会漏收

### 6.3 签名与保留策略

- 签名 = `tool::JSON.stringify(归一化参数)`；归一化 = 剔除 null/undefined +
  键递归排序 + 剔除易变字段（timestamp/ts/date）
- 同签名组**保留最新**，旧副本写入 `state.marks`（mark-time 估算 tokens
  随标记固化，公式同 sweep：`estimate(output) − estimate(占位符)`，下限 0）
- 跳过：已标记 callID、保护工具、错误状态的 part（留给 purge-errors）、
  进行中的 part（无完整 output）
- 参数来源：消息内 tool part 的 `state.input`（全量扫描自带参数，
  无需 DCP 的独立 toolParameters 缓存）

### 6.4 轮次保护（step-start，5 步）

- 按 `step-start` part 计助手步（与 DCP 对齐，§3.5）
- **最近 5 步内的工具调用完全不参与签名检测**（DCP 语义：新副本在保护
  期内时，旧副本也不标记——事前过滤，非事后豁免）
- 回退：会话中无 `step-start` part 时，退化为"保护最近 5 个工具调用"
- `/dcp sweep` 维持用户消息锚点不变（手动命令语义不同，无需统一）

### 6.5 配置

`config.toml` 配置（运行时直读，同 `[zoo.validation]` 模式，不改
install.py）：

```toml
[zoo.context]
# 轮次保护（管道级共用）
turn_protection = 5
# 批量释放阈值：pending 标记合计达到 prompt 侧总量该百分比时统一释放
release_threshold_percent = 5

[zoo.context.dedup]
# 自动去重开关
enabled = true
# 触发门控：最后一条已完成 assistant 消息的 prompt 侧总量达到该值才扫描
threshold_tokens = 100000
# 受保护工具（输出不可再生的工具）
protected_tools = ["question"]

[zoo.context.purge_errors]
# 错误清除开关（尾部保险）
enabled = true
# 触发门控
threshold_tokens = 100000
# 受保护工具
protected_tools = ["question"]
```

`turn_protection` 和 `release_threshold_percent` 位于 `[zoo.context]` 顶层
（剪枝策略共用）。`dedup` 与 `purge_errors` 各自三键下沉到子节。

默认仅保护 `question`：剪枝只影响发给 LLM 的消息副本、不动会话存储，
且在保留最新语义下 `read`/`bash`/`task`/`skill`/`todowrite`/`todoread`
的精确重复被去重均安全；唯一需要保护的是 `question`（输出即用户输入、
不可再生，同问题两次回答可能不同）。用户可自行加回其他工具。

### 6.6 可观测性（as-built 修订）

三层通道：

1. **日志**：`dedup_marked`（标记）、`dedup_released`（批量释放，含
   releasedTokens/promptTokens）、`prune_completed`（含
   totalReclaimedTokens，sweep+dedup 合计）
2. **`/dcp context`**：合并回收行 `回收  X tokens（累计回收）`，
   pending 时追加 `，待生效 N 个标记（约 Y tokens）`——**不区分手动/
   自动**（用户决策：release 后无本质区别；数据源自内存态）
3. **聊天通知**：仅批量释放时一条 ignored 消息（noReply，LLM 不可见，
   追加末尾不破前缀缓存）；marked 阶段不通知（每轮噪音）
4. **TUI 面板**：tool 分类占比下降（prunedCallIDs 只含 effective 标记）

### 6.7 批量释放语义（as-built：统一 marks 单集合）

初版实现为双 Map（tools + pending），后重写为统一模型（§4.1/§4.2）：

- **标记/替换解耦**：dedup 标记写入 marks（`effective=false`）；
  sweep 标记写入 marks（`effective=true`，立即生效）
- **批量释放**：每轮 transform 检查 `Σ pending（派生）≥ promptTokens ×
  release_threshold_percent / 100`，满足则 `releaseBatch` 全部翻转
  （只统计实际翻转），下一轮 Phase 1 替换
- **破缓存成本锚定**：释放阈值用百分比而非固定 tokens——破一次缓存的
  成本 ≈ 全量上下文重算，与上下文大小成正比，收益门槛也应同比
- **0 是合法语义**：`release_threshold_percent = 0` → pending 非空即
  释放，退化为每轮替换（缓存开销最大，注释明示）

时序示例：

```
Turn N:   runDedup → 3 marks pending (500 tokens). 500 < 5% → 不释放
Turn N+1: runDedup → 累计 8000 tokens ≥ 5% × 150000 → releaseBatch
          → dedup_released 日志 + ignored 通知
Turn N+2: Phase 1 替换已生效标记的输出
```

### 6.8 涉及文件（as-built）

| 文件 | 变更 |
|------|------|
| `config.toml` | `[zoo.context]`（`turn_protection` + `release_threshold_percent`）+ `[zoo.context.dedup]`（`enabled`/`threshold_tokens`/`protected_tools`）+ `[zoo.context.purge_errors]`（`enabled`/`threshold_tokens`/`protected_tools`） |
| `src/core/pruning/marks.ts` | 新建：marks 单集合 + addMark/releaseBatch + 派生 stats + 持久化（取代旧 state.ts，已删除）；后增 `PruneAction`/`Mark.action`/`byAction`/`{tokens,effective,action}` 严格加载 |
| `src/core/pruning/producers/dedup.ts` | 新建：runDedup（签名归一化/保护窗/零收益跳过） |
| `src/core/pruning/producers/sweep.ts` | 新建：runSweep（原 collectSweepCallIDs 迁移，锚点语义不变） |
| `src/core/pruning/producers/purge-errors.ts` | 新建：runPurgeErrors（错误状态扫描 + 跳过链） |
| `src/core/pruning/producers/shared.ts` | 新建：collectProtectedCallIDs/netReclaimTokens 共享辅助 |
| `src/core/pruning/prune.ts` | pruneToolOutputs 只消费 effective 标记；后增 action 判别 + pruneToolErrors |
| `src/hooks/context-pruning/hook.ts` | 先清后标 + 门控 + 批量释放 + notify 回调；后增三层 Config 表驱动循环 + 双门控 |
| `src/opencode.ts` | parseContextConfig（两层读取 + 逐字段类型防御）+ notify 注入（fire-and-forget）；后改为三层解析 + release_threshold_percent 顶层读取 |
| `src/core/context-report.ts` | 合并回收行（FormatContextReportOptions） |
| `src/hooks/context-command/index.ts` | sweep 走 producer；报告读内存态 |
| `src/tui.tsx` | prunedCallIDs 只含 effective 标记 |
| 测试 | marks/producers/hook/command/report 全套（879 TS 测试全绿） |

### 6.9 测试与实测验证

单测+集成测试覆盖（879 TS 测试全绿）：签名归一化、保护窗边界与回退、
门控两侧（含 cache.read 补门控回归）、批量两侧、先清后标时序、释放
通知、旧 shape 加载为空、派生正确性、pending 不污染 prunedCallIDs
回归。

实测（2026-07-25，>100K 真实会话）：门控按 prompt 侧总量正确触发；
release_threshold_percent=0 时当轮标记当轮释放；ignored 通知
`role=user, ignored=1` 存储正确且 LLM 不可见；首轮全量扫描发现 8 个
历史重复（2K tokens）并在下一轮替换为占位符。

---

## 7. 与 DCP 的架构对比

### 7.1 差异总览

| 维度 | DCP (`@tarquinen/opencode-dcp`) | ZooKeeper 内建方案 |
|------|-------------------------------|-------------------|
| **框架绑定** | 强（仅 OpenCode） | 弱（核心框架无关） |
| **依赖** | OpenCode SDK, 文件系统存储 | 无外部依赖 |
| **Token 计数** | 未开源具体实现 | API 上报（主力）+ 启发式（补充），误差 < 5% |
| **压缩模式** | Range + Message（双模） | ✅ Range 手动压缩（机械摘要 MVP，§4.7）；LLM 驱动 → V3 |
| **LLM 驱动压缩** | ✅ 完整 | ❌（V3 规划：compress 工具注册；机械摘要已先行，§4.7） |
| **去重** | ✅ 基于签名（compress 时检测，零保护清单） | ✅ 基于签名（transform 每轮检测 + 批量释放，§4.5） |
| **错误清除** | ✅ 4 轮后 | ✅ 基于 action 判别 + 表驱动 producer + 老化保护窗 + 零收益跳过（§4.6） |
| **Nudge 系统** | 3 级阈值 | ❌（V3 规划，3 级阈值） |
| **状态持久化** | 磁盘 JSON 文件 | ✅ 磁盘 JSON（`~/.zoo/storage/`） |
| **Block 嵌套** | 支持 | 不支持（V3 也不做，扁平块） |
| **配置层级** | 3 层级联 + JSONC | 单层 config.toml |
| **消息引用** | mNNNN 格式 | ❌（V3 随 compress 工具引入） |
| **命令系统** | `/dcp` 全套命令 | ✅ 部分（context/sweep/compress/help） |
| **轮次保护** | step-start 计数，默认 4（disabled） | 消息条数口径，默认 20 条（`protected_messages`，2026-07-30 统一） |
| **状态模型复杂度** | 高（8 种块间关系） | 低（prune.tools 单通路） |

### 7.2 为什么不在 ZooKeeper 中直接依赖 DCP

**1. 框架绑定问题**：DCP 紧密耦合 OpenCode 的 hook API 和消息格式。
ZooKeeper 双宿主（OpenCode + pi），上下文剪枝核心逻辑必须与框架解耦。
DCP 无法被 pi 复用。

**2. 复杂度与收益权衡**：DCP 在状态模型、块嵌套、跨会话持久化等方面的
设计复杂度远超 ZooKeeper 的需求。作为编排器插件，ZooKeeper 的上下文剪枝
是**补充性**的——辅助 OpenCode 内置 compaction，而非完全替代。

**3. 配置单一事实来源**：ZooKeeper 的所有配置来自 `config.toml`。引入
DCP 意味着增加 `dcp.jsonc`，破坏现有配置管理模型。

**4. 依赖管理**：引入 DCP 作为 npm 依赖会增加 `node_modules` 体积、引入
版本兼容风险、需要跟进 DCP 更新。

**结论**：不直接依赖 DCP，而是借鉴其设计（两阶段标记-清理、签名去重、
错误清除、nudge 系统、双模压缩）实现 ZooKeeper 内建的轻量级方案。

---

## 8. 后续路线

| 步骤 | 内容 | 设计来源 | 前置 |
|------|------|---------|------|
| ~~当前~~ | 观测层 + 手动 sweep + 持久化 | — | ✅ 已完成（§4） |
| ~~下一步~~ | 自动去重 dedup（统一 marks + 批量释放 + ignored 通知） | §3.5 | ✅ 已完成（§4.5/§6，2026-07-25） |
| +1 | ~~purge-errors：错误工具调用老化 N 步后标记清除 input~~ | §3.5 / §4.6 | ✅ 已完成（R1-R3 架构落地，§4.6，2026-07-25） |
| +1.5 | ~~手动压缩 `/dcp compress`：机械摘要 MVP + 三重保护 + 幻影门 + 折叠通路 + 视图变化强制释放 + TUI/报告折叠视图接线 + 系统类残差法~~ | §3.8 / §5.2 | ✅ 已完成（§4.7，2026-07-30） |
| +2 | zinspect `stats` 新增剪枝回收 section（`--pruning` 标志与 `--tokens`/`--hooks` 同构；读 JSONL 日志的 `prune_completed`/`*_marked`/`*_released` 事件；2026-07-27 决策：不做 `/dcp stats` 聊天命令、不加独立子命令） | — | 即刻可做 |
| V3 | compress 工具注册 + LLM 驱动摘要替换机械摘要 + mNNNN 引用 + nudge 系统（用户确认：模型自主压缩为未来方向，统一 producer 模型与 CompressionBlock.tier 已为其留位） | §3.3 / §3.4 / §3.6 / §5.2-5.3 | 手动压缩实测稳定 |
| V3.5（候选） | T2 摘要再压缩（应对摘要累积；视 V3 实测决定，§9.8） | §3.8.1 | V3 实测数据 |
| V4 | Message 模式压缩、decompress/recompress、子代理结果展开 | §3.4 / §5.4 | V3 |
| 另行规划 | pi 宿主适配（核心已框架无关，缺 transform 接线） | — | pi 侧 hook 能力确认 |

**明确不做/推迟**：块嵌套（复杂度错配）、用户可覆盖提示词、Toast 通知、
自动更新、per-agent 权限引擎。

---

## 9. 已知风险与缓解措施

### 9.1 Token 计数精度

**风险**：对最后一次 assistant 消息之后新增的消息使用启发式，在中文或
混合内容中可能偏差。

**缓解**：启发式仅用于最近几条新增消息（通常 < 2K tokens）；95%+ 的
token 来自 API 精确数据；CJK /1.5 分文字系统估算；门控决策只用 API
精确值（`input + cache.read + cache.write`），缺失时向安全方向失败。

### 9.2 去重误伤有效上下文

**风险**：同签名但语义不同的输出被误标（如 `bash("git status")` 在不同
时间点结果不同）。

**缓解**：保留最新副本（被清的只是陈旧副本）；20 条消息保护窗
（窗内调用完全不参与检测，2.6 统一为消息条数口径）；保护清单默认为空
（剪枝只影响 LLM 视图、不动会话存储，精确重复去重均安全——源码核实
DCP dedup 亦零保护，§3.5）；100K 高默认
门控（上下文充裕时不剪）；零收益跳过（短输出不替换）；剪枝非破坏性
（占位符替换，callID 可追溯）。

### 9.3 step-start 缺失（✅ 已消解，2026-07-30）

**原风险**：某些会话/provider 的消息中可能没有 `step-start` part，导致
轮次保护失效。

**消解**：2.6 保护窗统一为**消息条数口径**（`protectedBoundary` 从末尾
倒数 N 条非 ignored 消息），不再依赖 step-start part，该风险消失；
ignored 消息不占保护槽（系统注入消息不会压缩实际保护范围）。

### 9.4 压缩误伤有效上下文

**风险**：范围压缩可能折叠包含关键信息的消息。

**缓解**（as-built，§4.7）：三重保护取最保守边界（`protected_messages`
20 条 + `protected_tokens` 20K + 末条用户消息）；幻影门拒绝低收益段；
负收益门拒绝摘要 ≥ 原文的段；压缩非破坏性（存储不动，摘要 + blockId
可追溯，块失效自动恢复）；机械摘要保留用户请求/任务委托/涉及文件/
最终进度骨架；首条用户消息 force-keep。

### 9.5 Nudge 对 LLM 行为影响不足（V3+）

**风险**：LLM 可能忽略 nudge 消息。

**缓解**：紧急 nudge 用较强语气；nudge 是 soft guidance 而非硬约束；
未来可在 `tool.execute.before` 中增加硬限制。

### 9.6 与内置 Compaction 冲突

**风险**：ZooKeeper 剪枝后，内置 compaction 基于已剪枝消息再次压缩。

**缓解**：剪枝只替换 output 为占位符、不删消息；compaction 对占位符的
二次摘要无危害；占位符文本本身标注了"已移除"语义。

### 9.7 性能开销

**风险**：每轮 transform 运行策略引入延迟。

**缓解**：清理阶段是 Map 查找 O(k)；dedup 扫描仅在超 100K 阈值时触发；
签名构建是 O(工具调用数)；持久化仅 dirty 时写入且失败静默。

### 9.8 摘要累积（V3+）

**风险**：扁平块方案下 T1 摘要数量随会话无限增长，摘要自身成为新的
膨胀源（ACP 实测需 T2/T3 分层应对，§3.8.1）。

**缓解**：数据模型已落地 `tier` 字段（恒 1，持久化严格校验枚举）+
`deactivatedAt`，扁平 MVP 不实现层级逻辑，后续升级不推倒重来；
通过面板/命令观测摘要占比，确认真实累积后再做 T2 再压缩
（§8 V3.5 候选）。

---

## 10. 总结

### 10.1 与 DCP 的关系

借鉴但不复制。**保留**：两阶段标记-清理（分离代码路径）、签名去重、
错误清除、3 级 nudge、mNNNN 引用机制（V3）、范围保护三件套与幻影
门禁（ACP §3.8.2/§3.8.3，已落地 §4.7）、nudge 防刷屏基线（ACP §3.8.4）、
整段移除 + 锚点合成摘要的缓存纪律（ACP §3.8.5，已落地 §4.7）。**简化**：状态模型（无
嵌套块）、配置层级（单层 config.toml）、摘要生成（机械摘要 MVP，
LLM 驱动留 V3）。**替换**：框架绑定 → 框架无关
核心 + 适配器。**推迟**：提示词覆盖、Toast 通知、子代理结果展开、
自动更新。

### 10.2 与 OpenCode 内置 Compaction 的关系

```
OpenCode 内置 → 平台级，LLM 驱动摘要，全局调度
ZooKeeper 剪枝 → 插件级，启发式策略 + 手动控制，编排器专用

互补关系：
  - 去重 + 错误清除：在 compaction 之前减少无用内容
  - 手动 sweep：用户主导的即时回收
  - 手动压缩（§4.7）：用户主导的整段折叠（机械摘要 MVP；LLM 驱动 V3）
  - Nudge（V3）：引导编排器主动管理上下文
```

### 10.3 实施路径

观测 → 手动剪枝 → 自动策略（dedup → purge-errors）→ 手动压缩
（机械摘要）→ LLM 驱动压缩。
每步独立可验证，每步都有面板/命令/日志三层可观测性闭环。

---

**相关文档**：
- `docs/dcp-architecture.md` — DCP 完整代码级分析
- `docs/opencode-plugin-mechanism.md` — OpenCode 插件机制参考
- `docs/task-prompt-validation-evolution.md` — 相近的"软约束先行"设计哲学
- `docs/todo-nudge-research.md` — 类似的 nudge 系统设计
