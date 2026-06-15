# DCP 插件完整架构文档

**版本:** 1.0
**日期:** 2026-06-15
**来源:** `@tarquinen/opencode-dcp` v3.1.12 源码分析

---

## 目录

1. [概览](#1-概览)
2. [入口与 Hook 注册](#2-入口与-hook-注册)
3. [消息变换管道（16 步）](#3-消息变换管道)
4. [状态管理](#4-状态管理)
5. [压缩引擎](#5-压缩引擎)
6. [消息剪枝](#6-消息剪枝)
7. [自动策略](#7-自动策略)
8. [Nudge 注入](#8-nudge-注入)
9. [消息 ID 引用系统](#9-消息-id-引用系统)
10. [Token 计数](#10-token-计数)
11. [权限管理](#11-权限管理)
12. [命令系统](#12-命令系统)
13. [Prompt 系统](#13-prompt-系统)
14. [配置系统](#14-配置系统)
15. [持久化](#15-持久化)
16. [UI 通知](#16-ui-通知)
17. [子代理处理](#17-子代理处理)
18. [脚本工具](#18-脚本工具)
19. [数据流全景图](#19-数据流全景图)

---

## 1. 概览

### 核心思想

DCP 是一个**两阶段**上下文管理系统：

1. **标记阶段 (Mark)**：在 `experimental.chat.messages.transform` hook 中识别哪些消息/工具应该被剪枝或压缩，将结果写入 `SessionState.prune`（不立即删除消息）
2. **清理阶段 (Clean)**：在**下一轮** `messages.transform` 中，根据标记重建消息列表——用压缩块摘要替换已压缩消息，用占位符替换已剪枝的工具输出

两个阶段通过 `SessionState.prune` 共享状态。标记阶段写入元数据，清理阶段读取并执行变换。

### 文件结构

```
opencode-dynamic-context-pruning/
├── index.ts                          # Plugin 入口，注册 6 个 hook
├── lib/
│   ├── hooks.ts                      # 所有 hook 工厂函数
│   ├── config.ts                     # 三层级联配置加载
│   ├── logger.ts                     # 文件日志
│   ├── message-ids.ts                # mNNNN 引用系统
│   ├── token-utils.ts                # Token 计数
│   ├── compress-permission.ts        # 压缩权限解析
│   ├── host-permissions.ts           # OpenCode 权限规则引擎
│   ├── protected-patterns.ts         # 文件路径保护模式
│   ├── auth.ts                       # 安全模式认证
│   ├── update.ts                     # 自动更新
│   ├── compress/                     # 压缩引擎
│   │   ├── index.ts                  # 导出两个工具工厂
│   │   ├── types.ts                  # 压缩相关类型
│   │   ├── state.ts                  # 标记阶段核心（写入 prune 状态）
│   │   ├── pipeline.ts               # 准备 + 最终确定
│   │   ├── range.ts                  # 范围模式工具
│   │   ├── range-utils.ts            # 范围解析
│   │   ├── message.ts                # 消息模式工具
│   │   ├── message-utils.ts          # 消息解析
│   │   ├── protected-content.ts      # 受保护内容保留
│   │   ├── search.ts                 # 搜索与边界解析
│   │   └── timing.ts                 # 压缩计时
│   ├── messages/                     # 消息变换
│   │   ├── index.ts                  # 导出
│   │   ├── shape.ts                  # Step 0: 消息类型守卫
│   │   ├── utils.ts                  # 消息操作工具
│   │   ├── prune.ts                  # Step 10: 剪枝执行
│   │   ├── priority.ts               # Step 12: 优先级映射
│   │   ├── sync.ts                   # Step 7: 块同步
│   │   ├── query.ts                  # 消息查询谓词
│   │   ├── reasoning-strip.ts         # Step 16: 元数据净化
│   │   └── inject/
│   │       ├── inject.ts             # Step 13/14: Nudge + ID 注入
│   │       ├── subagent-results.ts   # Step 11: 子代理结果
│   │       └── utils.ts              # 注入辅助
│   ├── state/                        # 状态管理
│   │   ├── index.ts                  # 导出
│   │   ├── types.ts                  # SessionState 完整类型
│   │   ├── state.ts                  # 会话生命周期
│   │   ├── persistence.ts            # 磁盘序列化
│   │   ├── tool-cache.ts             # 工具参数缓存
│   │   └── utils.ts                  # 状态工具函数
│   ├── strategies/                   # 自动剪枝策略
│   │   ├── index.ts                  # 导出
│   │   ├── deduplication.ts          # 去重
│   │   └── purge-errors.ts           # 错误清除
│   ├── prompts/                      # Prompt 模板
│   │   ├── index.ts                  # renderSystemPrompt
│   │   ├── store.ts                  # PromptStore
│   │   ├── system.ts                 # 系统提示
│   │   ├── compress-range.ts         # 范围模式工具描述
│   │   ├── compress-message.ts       # 消息模式工具描述
│   │   ├── context-limit-nudge.ts    # 上下文限制提示
│   │   ├── turn-nudge.ts             # 轮次提示
│   │   ├── iteration-nudge.ts        # 迭代提示
│   │   └── extensions/
│   │       ├── system.ts             # protected-tools / manual / subagent
│   │       ├── nudge.ts              # Nudge 扩展
│   │       └── tool.ts               # 工具格式扩展
│   ├── commands/                     # /dcp 命令处理器
│   │   ├── index.ts, context.ts, stats.ts, sweep.ts
│   │   ├── help.ts, manual.ts, decompress.ts, recompress.ts
│   │   └── compression-targets.ts
│   ├── subagents/subagent-results.ts # 子代理结果构建
│   └── ui/
│       ├── notification.ts           # UI 通知
│       └── utils.ts                  # 工具
└── tests/                            # 15 个测试文件
```

---

## 2. 入口与 Hook 注册

**文件:** `index.ts` (137 行)

### 初始化序列

```
Plugin 加载
  │
  ├─1. getConfig(ctx)              → 三层级联合并
  ├─2. new Logger(config.debug)    → 日志目录 ~/.config/opencode/logs/dcp/
  ├─3. createSessionState()        → 空 SessionState
  ├─4. new PromptStore(...)        → 加载/验证 prompt 模板
  ├─5. isSecureMode() → auth       → 可选认证
  ├─6. startAutoUpdate()           → 可选自动更新
  └─7. 创建 compressTool           → range 或 message 模式
```

### 注册的 Hook

| Hook | 工厂函数 | 调用时机 |
|------|---------|---------|
| `experimental.chat.system.transform` | `createSystemPromptHandler` | 每次 LLM 请求构建系统 prompt |
| `experimental.chat.messages.transform` | `createChatMessageTransformHandler` | 每次 LLM 请求前，transform 消息列表 |
| `experimental.text.complete` | `createTextCompleteHandler` | 流式文本完成时 |
| `command.execute.before` | `createCommandExecuteHandler` | 用户输入 `/dcp` 命令 |
| `event` | `createEventHandler` | 会话生命周期事件 |
| `config` | 内联函数 | 插件配置阶段 |
| `tool.compress` | `createCompressRangeTool` / `createCompressMessageTool` | LLM 调用 compress 工具 |

### Config Hook 行为

在 `config` hook 中：
1. 检查 host 权限是否禁用 compress → 设置 `permission = "deny"`
2. 注册 `/dcp` 命令到 `ocConfig.command["dcp"]`
3. 添加 `"compress"` 到 `ocConfig.experimental.primary_tools`
4. 设置 `ocConfig.permission.compress`
5. 快照 host permissions 供运行时检查

---

## 3. 消息变换管道

**文件:** `lib/hooks.ts` → `createChatMessageTransformHandler`

每次 LLM turn 调用一次，按以下顺序执行 16 个步骤：

### Step 0: filterMessagesInPlace (shape.ts)

**功能：** 原地删除无效消息
**算法：** 双指针法。遍历消息，保留满足 `isMessageWithInfo` 守卫的条目，截断数组末尾。
**守卫条件：** 必须有 `info.id`、`info.sessionID`、`info.role ∈ {user, assistant}`、`info.time.created`、`parts` 数组。

### Step 1: checkSession (state.ts)

**功能：** 检测会话切换和压缩
**算法：**
1. 从最后一条用户消息获取 session ID
2. 如果 ID 变化 → `ensureSessionInitialized` (重置状态 + 加载持久化)
3. 如果检测到 compaction 事件 (`role=assistant, summary=true`) → `resetOnCompaction` (清空所有状态)
4. 更新 `currentTurn` 计数

### Step 2: syncCompressPermissionState (compress-permission.ts)

**功能：** 解析当前 agent 的 compress 权限
**决策树：**
1. `config.compress.permission === "deny"` → deny（配置强制）
2. host permissions 中有匹配的 deny 规则 → deny
3. 否则使用 config 值 (`ask` / `allow`)

### Step 3: 子代理保护

**功能：** 如果 `state.isSubAgent && !config.experimental.allowSubAgents` → 提前退出（跳过 Step 4-16）

### Step 4: stripHallucinations (utils.ts)

**功能：** 移除 LLM 幻觉生成的 `<dcp...>` 标签
**算法：**
1. 遍历所有消息的所有文本部分和工具输出
2. 删除配对标签：`<dcp...>...</dcp...>`
3. 删除孤立标签：`<dcp...>` 或 `</dcp>`

### Step 5: cacheSystemPromptTokens (ui/utils.ts)

**功能：** 估算系统 prompt token 数
**算法：**
1. 找到第一个有 token 数据的 assistant 消息
2. `systemPromptTokens = firstInputTokens - countTokens(firstUserText)`
3. 缓存到 `state.systemPromptTokens`

### Step 6: assignMessageRefs (message-ids.ts)

**功能：** 为消息分配 `m0001`~`m9999` 引用
**算法：**
1. 跳过忽略的用户消息和子代理初始 prompt
2. 已有映射 → 更新双向引用
3. 无映射 → 分配下一个空闲 `mNNNN`
4. 存储在 `state.messageIds.byRawId` 和 `byRef`

### Step 7: syncCompressionBlocks (sync.ts)

**功能：** 重新计算压缩块的活跃状态
**算法：**
1. 收集当前消息 ID 集合
2. 清空 `activeBlockIds` 和 `activeByAnchorMessageId`
3. 按创建顺序遍历每个块：
   - **缺少起源消息**（`compressMessageId` 不在消息集中）→ 停用
   - **用户停用** (`deactivatedByUser`) → 停用
   - **消费关系** → 停用被消费的块，然后激活当前块
4. 更新 `PrunedMessageEntry` 的 activeBlockIds

### Step 8: syncToolCache (tool-cache.ts)

**功能：** 缓存工具调用参数
**算法：**
1. 遍历消息中的工具部分
2. 跳过压缩消息
3. 遵守轮次保护（`config.turnProtection`）
4. 通过 `callID` 缓存 `ToolParameterEntry`（最多 1000 个）

### Step 9: buildToolIdList (utils.ts)

**功能：** 收集所有非压缩工具的 callID 到 `state.toolIdList`

### Step 10: prune (prune.ts) — 四个子步骤

#### 10a: filterCompressedRanges

**功能：** 用合成摘要消息替换已压缩消息范围
**算法：**
1. 遍历消息列表
2. 如果消息是活跃块的锚点 → 注入合成用户消息（含摘要）
3. 如果消息属于活跃块（`activeBlockIds.length > 0`）→ 跳过
4. 否则保留
5. 原地替换消息数组

#### 10c: pruneToolOutputs

**功能：** 替换已剪枝工具的输出为占位符
**条件：** `state.prune.tools.has(callID)` + `status === "completed"`
**排除：** `question`、`edit`、`write` 工具不剪枝
**替换内容：** `"[Output removed to save context - information superseded or no longer needed]"`

#### 10d: pruneToolInputs

**功能：** 剪枝 `question` 工具的问题文本
**条件：** 同 10c + 工具是 `question`
**替换内容：** `"[questions removed - see output for user's answers]"`

#### 10e: pruneToolErrors

**功能：** 清理失败工具的输入
**条件：** `state.prune.tools.has(callID)` + `status === "error"`
**动作：** 将 `input` 对象中所有字符串字段替换为 `"[input removed due to failed tool call]"`

### Step 11: injectExtendedSubAgentResults (subagent-results.ts)

**功能：** 获取子代理会话消息并合并回 `task()` 工具输出
**条件：** 仅 `config.experimental.allowSubAgents` 时执行
**算法：** 缓存结果避免重复获取，合并到 `<task_result>` XML 块中

### Step 12: buildPriorityMap (priority.ts)

**功能：** 为消息分配压缩优先级
**条件：** 仅 `compress.mode === "message"` 时执行
**优先级分配：**
- `>= 5000 tokens` 或包含 compress 工具 → `"high"`
- `>= 500 tokens` → `"medium"`
- 其余 → `"low"`
- 跳过：忽略消息、受保护用户消息、已压缩消息

### Step 13: injectCompressNudges (inject.ts)

**功能：** 注入压缩提示
**决策树：** 详见 [§8 Nudge 注入](#8-nudge-注入)

### Step 14: injectMessageIds (inject.ts)

**功能：** 注入 `<dcp-message-id>mNNNN</dcp-message-id>` 标签
**用户消息：** 追加到文本部分
**助手消息：** 追加到工具输出 > 最后文本部分 > 合成部分
**受保护消息：** 标签内容为 `"BLOCKED"`

### Step 15: applyPendingManualTrigger (manual.ts)

**功能：** 如果存在待处理的手动触发，将压缩提示注入消息

### Step 16: stripStaleMetadata (reasoning-strip.ts)

**功能：** 移除跨 provider 元数据
**算法：** 找到最后用户消息的 `modelID`/`providerID`，对所有不同 model/provider 的 assistant 消息移除 metadata

### Epilog: logger.saveContext

将转换后的消息转储为日志文件（仅 debug 模式）

---

## 4. 状态管理

**文件:** `lib/state/`

### SessionState 完整结构

```typescript
interface SessionState {
  // ── 身份 ──
  sessionId: string | null                    // 当前会话 ID
  isSubAgent: boolean                         // 是否为子代理会话

  // ── 控制 ──
  manualMode: false | "active" | "compress-pending"
  compressPermission: "ask" | "allow" | "deny" | undefined
  pendingManualTrigger: { sessionId, prompt } | null

  // ── 剪枝/压缩核心 ──
  prune: {
    tools: Map<string, number>                // callID → 已剪枝 token 数
    messages: {
      byMessageId: Map<string, PrunedMessageEntry>  // 消息压缩前元数据
      blocksById: Map<number, CompressionBlock>      // 所有压缩块
      activeBlockIds: Set<number>                     // 当前活跃块
      activeByAnchorMessageId: Map<string, number>    // 锚点消息 → 块 ID
      nextBlockId: number                             // 自增序列
      nextRunId: number
    }
  }

  // ── Nudge 锚点（每个事件仅提示一次）──
  nudges: {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
  }

  // ── 统计 ──
  stats: { pruneTokenCounter, totalPruneTokens }

  // ── 计时 ──
  compressionTiming: {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingCompressionDuration>
  }

  // ── 缓存 ──
  toolParameters: Map<string, ToolParameterEntry>  // 工具参数缓存（最大 1000）
  subAgentResultCache: Map<string, string>          // 子代理结果缓存
  toolIdList: string[]                              // 有序工具 ID 列表

  // ── 引用 ──
  messageIds: {
    byRawId: Map<string, string>    // 原始 ID → mNNNN
    byRef: Map<string, string>      // mNNNN → 原始 ID
    nextRef: number                 // 下一个可用的 mNNNN
  }

  // ── 运行时 ──
  lastCompaction: number            // 上次压缩时间戳
  currentTurn: number               // 当前轮次
  modelContextLimit: number | undefined
  systemPromptTokens: number | undefined
}
```

### CompressionBlock 完整结构

```typescript
interface CompressionBlock {
  // ── 标识 ──
  blockId: number              // 唯一块 ID
  runId: number                // 压缩运行 ID
  active: boolean              // 当前是否活跃
  deactivatedByUser: boolean   // 用户是否手动停用

  // ── 度量 ──
  compressedTokens: number     // 压缩前的 token 总量
  summaryTokens: number        // 摘要的 token 量
  durationMs: number           // 压缩耗时

  // ── 内容 ──
  mode?: "range" | "message"   // 压缩策略
  topic: string                // 主题标签
  batchTopic?: string          // 批处理主题

  // ── 边界 ──
  startId: string              // 范围起始 (mNNNN)
  endId: string                // 范围终止 (mNNNN)
  anchorMessageId: string      // 锚定消息 ID
  compressMessageId: string    // 压缩摘要消息 ID
  compressCallId?: string      // compress 工具调用 ID

  // ── 关系 ──
  includedBlockIds: number[]   // 包含的父块
  consumedBlockIds: number[]   // 被摘要消费的块
  parentBlockIds: number[]     // 父块链
  directMessageIds: string[]   // 直接包含的消息
  directToolIds: string[]      // 直接包含的工具
  effectiveMessageIds: string[]// 传递包含的消息
  effectiveToolIds: string[]   // 传递包含的工具

  // ── 结果 ──
  summary: string              // 摘要文本

  // ── 时间线 ──
  createdAt: number
  deactivatedAt?: number
  deactivatedByBlockId?: number
}
```

### PrunedMessageEntry

```typescript
interface PrunedMessageEntry {
  tokenCount: number          // 压缩前的原始 token 数
  allBlockIds: number[]       // 包含此消息的所有块（含不活跃）
  activeBlockIds: number[]    // 当前活跃的块
}
```

### ToolParameterEntry

```typescript
interface ToolParameterEntry {
  tool: string           // 工具名称
  parameters: any        // 工具输入参数
  status?: ToolStatus    // "pending" | "running" | "completed" | "error"
  error?: string         // 错误信息
  turn: number           // 工具所在轮次
  tokenCount?: number    // 缓存的 token 数
}
```

---

## 5. 压缩引擎

**文件:** `lib/compress/`

### 两种模式

| 模式 | 工具参数 | 特点 |
|------|---------|------|
| **Range** | `{ topic, content: [{ startId, endId, summary }] }` | 连续范围压缩，支持 `(bN)` 占位符引用已有块 |
| **Message** | `{ topic, content: [{ messageId, topic, summary }] }` | 独立消息压缩，每条消息独立处理 |

### 执行流程 (公共)

```
Tool 被 LLM 调用
  │
  ▼
prepareSession()
  ├─ 检查 manualMode（"active" 时拒绝）
  ├─ 请求 "compress" 权限
  ├─ fetchSessionMessages() — 从 API 获取原始消息
  ├─ ensureSessionInitialized() — 确保状态就绪
  ├─ assignMessageRefs() — 分配 mNNNN 引用
  ├─ deduplicate() / purgeErrors() — 策略标记
  └─ buildSearchContext() — 构建查找映射
  │
  ▼
解析 (模式特定)
  ├─ [RANGE] resolveRanges → 占位符注入 → 受保护内容 → 缺失块
  └─ [MESSAGE] resolveMessages → 去重/保护检查 → 跳过无效项
  │
  ▼
applyCompressionState() — 标记阶段
  ├─ 分配 blockId / runId
  ├─ 创建 CompressionBlock (active=true)
  ├─ 停用被消费的块 (active=false)
  ├─ 合并 effectiveMessageIds / effectiveToolIds
  └─ 更新 stats
  │
  ▼
finalizeSession()
  ├─ applyPendingCompressionDurations()
  ├─ saveSessionState() — 持久化到磁盘
  └─ sendCompressNotification() — UI 通知
```

### 标记阶段 (applyCompressionState) — 详细

```typescript
// 创建新块
const block: CompressionBlock = {
  blockId, runId, active: true, mode, topic,
  startId, endId, anchorMessageId, compressMessageId,
  directMessageIds, directToolIds,
  effectiveMessageIds, effectiveToolIds,
  consumedBlockIds, summary, ...
}

// 写入状态
state.prune.messages.blocksById.set(blockId, block)
state.prune.messages.activeBlockIds.add(blockId)
state.prune.messages.activeByAnchorMessageId.set(anchorMessageId, blockId)

// 停用被消费的块
for (const consumedId of consumedBlockIds) {
  const consumed = blocksById.get(consumedId)
  consumed.active = false
  consumed.deactivatedAt = Date.now()
  consumed.deactivatedByBlockId = blockId
  activeBlockIds.delete(consumedId)
  // 合并 effectiveIds 到新块
}

// 更新 byMessageId 映射
for (const msgId of effectiveMessageIds) {
  let entry = byMessageId.get(msgId)
  if (!entry) entry = { tokenCount, allBlockIds: [], activeBlockIds: [] }
  entry.allBlockIds.push(blockId)
  entry.activeBlockIds = [...activeBlockIds subset]
}
```

### 清理阶段

清理**不在压缩引擎内部**。它发生在下一轮 `messages.transform` 的 **Step 10a (filterCompressedRanges)** 中：

1. 遍历消息数组
2. 如果消息的 `anchorMessageId` 是活跃块的锚点 → 注入合成摘要消息
3. 如果消息的 `activeBlockIds.length > 0` → 跳过（从数组中移除）
4. 否则保留

### Range 模式特有逻辑

**占位符系统：** LLM 在摘要中写 `(bN)` 引用已有压缩块。处理流程：
1. `parseBlockPlaceholders(summary)` — 提取所有 `(bN)` / `{block_N}`
2. `validateSummaryPlaceholders` — 验证必须包含（不重复、已知块 ID）
3. `injectBlockPlaceholders` — 用真实摘要文本替换占位符
4. `appendMissingBlockSummaries` — 追加遗漏的必需块摘要

**边界处理：** 如果 startId/endId 引用的是现有压缩块（`bN`），合并边界摘要

**受保护内容（仅 Range 模式）：**
- `appendProtectedUserMessages` — 附加原始用户消息文本
- `appendProtectedPromptInfo` — 附加 `<protect>` 标签内容
- `appendProtectedTools` — 附加保护工具的输出

### 搜索与边界解析

**`buildSearchContext`：** 构建快速查找结构
```typescript
SearchContext = {
  rawMessages: WithParts[]
  rawMessagesById: Map<string, WithParts>
  rawIndexById: Map<string, number>
  summaryByBlockId: Map<number, string>    // 仅活跃块
}
```

**`resolveBoundaryIds`：** 解析 start/end ID
1. 构建 `boundaryLookup` — Map<引用ID, BoundaryReference>
2. 支持 `mNNNN`（原始消息引用）和 `bN`（压缩块引用）
3. 验证 start ≤ end

**`resolveSelection`：** 解析范围内的所有消息
1. 迭代 start 到 end 之间的原始消息
2. 收集 messageIds、tokenCount、toolIds
3. 识别范围内完全包含的已有压缩块（通过 anchorMessageId 匹配）→ `requiredBlockIds`

### 压缩计时

```
compress 工具调用
  │
  ├─ event(pending) → startsByCallId.set(key, timestamp)
  │     key = "messageId:callId"
  │
  ├─ event(completed) → consume start + 计算 duration
  │     duration = max(0, eventTime - startedAt)
  │     或 toolEnd - toolStart（如果有）
  │     → pendingByCallId.set(key, { messageId, callId, durationMs })
  │
  └─ finalizeSession → applyPendingCompressionDurations()
      遍历 pendingByCallId → attachCompressionDuration()
      找到匹配的 block → 设置 block.durationMs
```

---

## 6. 消息剪枝

**文件:** `lib/messages/prune.ts`

### 四种剪枝模式

| 子步骤 | 目标 | 条件 | 结果 |
|--------|------|------|------|
| **filterCompressedRanges** (10a) | 已压缩消息范围 | `activeBlockIds.length > 0` 或锚点 | 移除消息，注入合成摘要 |
| **pruneToolOutputs** (10c) | 已完成工具输出 | `prune.tools.has(callID)` | 替换为占位符字符串 |
| **pruneToolInputs** (10d) | question 工具问题 | 同 10c + 工具是 question | `questions` 字段设为占位符 |
| **pruneToolErrors** (10e) | 失败工具输入 | `status === "error"` | 所有字符串输入替换为占位符 |

### 标记来源

`state.prune.tools` 是一个 `Map<callID, tokenCount>`，由以下写入：

1. **去重策略** (`strategies/deduplication.ts`) — 重复工具调用
2. **错误清除** (`strategies/purge-errors.ts`) — 过期错误调用
3. **sweep 命令** (`commands/sweep.ts`) — 手动标记
4. **压缩引擎** — 通过 `applyCompressionState` 更新 `byMessageId`

### 保护规则

- **轮次保护：** `config.turnProtection` — 最近 N 轮不参与剪枝
- **工具保护：** `question`/`edit`/`write` 不剪枝输出
- **压缩消息保护：** `isMessageCompacted()` 返回 true 的消息跳过所有剪枝

---

## 7. 自动策略

**文件:** `lib/strategies/`

### 去重 (deduplication.ts)

**检测算法：**
1. 遍历 `state.toolIdList` 中所有未剪枝的工具 ID
2. 计算签名：`createToolSignature(tool, normalizedParams)`
   - 归一化：移除 null/undefined，递归排序对象键
   - 签名格式：`"toolName::${JSON.stringify(sorted)}"`
3. 按签名分组：`Map<string, string[]>`
4. 每组 >1 个 ID → 仅保留**最后一个**（最新），其余标记为剪枝

**保护规则：**
- `config.strategies.deduplication.enabled === false` → 跳过
- `manualMode && !config.manualMode.automaticStrategies` → 跳过
- 工具名在 `protectedTools` 列表中 → 跳过
- 工具参数中的路径匹配 `protectedFilePatterns` → 跳过
- 已在 `prune.tools` 中 → 跳过

### 错误清除 (purge-errors.ts)

**检测算法：**
1. 遍历 `state.toolParameters` 中缓存的工具
2. 仅处理 `status === "error"`
3. 计算轮次年龄：`turnAge = state.currentTurn - metadata.turn`
4. `turnAge >= config.strategies.purgeErrors.turns`（最小 1）→ 标记为剪枝

**行为：** 仅清除工具**输入**，错误消息保留在对话中。

**保护规则：** 同去重（独立的 `protectedTools` 列表 + `protectedFilePatterns`）

### 策略执行时机

策略在两个地方执行：

1. **`compress/pipeline.ts` → `prepareSession()`** — compress 工具被调用前，执行 `deduplicate()` + `purgeErrors()`
2. **隐式在 Step 8 (syncToolCache) + Step 9 (buildToolIdList)** — 为策略准备数据，策略在压缩工具的 pipeline 中执行

---

## 8. Nudge 注入

**文件:** `lib/messages/inject/inject.ts` + `lib/messages/inject/utils.ts`

### 门控条件

提前返回（不注入任何 nudge）：
- `compressPermission === "deny"`
- `state.manualMode` 为真
- 最后助手消息已有完成的 compress 工具调用 → **清除所有锚点**

### 三级 Nudge 系统

#### Context Limit Nudge — 紧急

**触发：** 上下文 token > 最大阈值
**阈值计算：**
```
maxLimit = config.compress.maxContextLimit  (默认 100,000)
         或 model-specific: config.compress.modelMaxLimits["provider/model"]
若 summaryBuffer=true: maxLimit += activeSummaryTokenUsage
支持百分比: "80%" → 0.8 * state.modelContextLimit
```
**频率控制：** `addAnchor()` 确保两个锚点间至少有 `nudgeFrequency`(5) 条消息

#### Turn Nudge — 温和

**触发：** 上下文在最小和最大阈值之间 + 新用户轮次
```
minLimit = config.compress.minContextLimit  (默认 50,000)
```
**锚定策略：** `nudgeForce: "strong"` → 仅用户消息 / `"soft"` → 仅助手消息

#### Iteration Nudge — 警告

**触发：** 上下文在 min/max 之间 + 自最后用户消息以来的消息数 >= `iterationNudgeThreshold`(15)
**频率控制：** 同 context limit

### Nudge 文本注入

Range 模式：
```
<dcp-system-reminder>
{turn-nudge / context-limit-nudge / iteration-nudge prompt}
compressedBlockGuidance: 显示当前活跃的压缩块范围
</dcp-system-reminder>
```

Message 模式：
```
<dcp-system-reminder>
{nudge prompt}
messagePriorityGuidance: 列出各优先级消息的 mNNNN 引用和 token 数
</dcp-system-reminder>
```

### Nudge 锚点持久化

当锚点集合变化时，调用 `saveSessionState` 持久化到磁盘。

---

## 9. 消息 ID 引用系统

**文件:** `lib/message-ids.ts`

### 引用格式

| 引用 | 格式 | 示例 | 范围 |
|------|------|------|------|
| 消息引用 | `mNNNN` | `m0001`, `m9999` | 1-9999 |
| 块引用 | `bN` | `b1`, `b42` | 1-∞ |

### 分配规则

1. 跳过忽略的用户消息 (`isIgnoredUserMessage`)
2. 子代理会话跳过第一个用户消息
3. 已映射 → 更新双向引用
4. 未映射 → `allocateNextMessageRef()` 线性搜索下一个空闲槽
5. 超过 9999 → 抛出错误

### 标签格式

```xml
<dcp-message-id priority="high">m0042</dcp-message-id>
```

- 属性按字母排序
- XML 转义属性值
- 前缀 `\n` 确保独占一行

### 受保护消息

标签内容替换为 `"BLOCKED"`：
```xml
<dcp-message-id>m0042</dcp-message-id>  // 正常
<dcp-message-id>BLOCKED</dcp-message-id> // 受保护
```

---

## 10. Token 计数

**文件:** `lib/token-utils.ts`

### 计数变体

| 变体 | 函数 | 技术 |
|------|------|------|
| **文本 token** | `countTokens(text)` | `@anthropic-ai/tokenizer` → 回退 `Math.round(text.length / 4)` |
| **批量文本** | `estimateTokensBatch(texts)` | 空格连接 → countTokens |
| **工具 token** | `countToolTokens(part)` | input + output/error 的 token 总和 |
| **缓存工具 token** | `getTotalToolTokens(state, ids)` | 对 `toolParameters` 中缓存的 tokenCount 求和 |
| **消息文本 token** | `countMessageTextTokens(msg)` | 所有 text 部分 |
| **全部消息 token** | `countAllMessageTokens(msg)` | text + 工具内容 |
| **SDK 上下文使用** | `getCurrentTokenUsage(state, msgs)` | 最后 assistant 的 `tokens.input + output + reasoning + cache.read + cache.write` |
| **摘要 token** | `block.summaryTokens` | 存储在块上，`countTokens(summary)` |

### 混合策略

DCP 同时使用精确计数和启发式：
- `@anthropic-ai/tokenizer` 用于本地文本的精确计数
- `getCurrentTokenUsage` 使用 SDK 上报的 API 精确数据
- `text.length / 4` 作为 tokenizer 不可用时的回退

### 系统 Prompt Token 估算

`cacheSystemPromptTokens` (Step 5):
```
systemPromptTokens = firstAssistantInputTokens - countTokens(firstUserText)
```

---

## 11. 权限管理

**文件:** `lib/compress-permission.ts` + `lib/host-permissions.ts`

### 权限决策树

```
compressPermission(state, config, hostPermissions, activeAgent):

1. config.compress.permission === "deny"?
   → YES → deny (配置强制)

2. host permissions 有匹配的 deny 规则?
   ├─ 收集规则: global + agents[activeAgent]
   ├─ 展开规则: 顶级条目 + 模式对象
   ├─ 匹配 "compress" 工具名: wildcardMatch (支持 * glob)
   └─ 匹配且 action=deny? → YES → deny

3. 否则 → config.compress.permission (ask/allow)
```

### Host Permission Snapshot

在 `config` hook 中快照：
```typescript
hostPermissions.global = ocConfig.permission
hostPermissions.agents = Object.fromEntries(
  Object.entries(ocConfig.agent).map(([name, agent]) => [name, agent?.permission])
)
```

### compressDisabledByOpencode

启动时检查 host 配置是否全局禁用了 compress：
```
遍历所有 permissionConfigs → 收集权限规则
→ 查找 compress + * 匹配 + deny 的最后一条规则
→ 存在 → true
```

---

## 12. 命令系统

**文件:** `lib/commands/` + `lib/hooks.ts` → `createCommandExecuteHandler`

### 命令协议

1. `input.command === "dcp"` 时激活
2. 前置检查：获取消息、初始化会话、同步权限、检查 compress 权限
3. 分发子命令
4. 处理完后抛出 sentinel error (`__DCP_STATS_HANDLED__` 等) 通知宿主

### 子命令列表

| 命令 | 处理函数 | 退出信号 |
|------|---------|---------|
| `/dcp` / `/dcp help` | `handleHelpCommand` | `__DCP_HELP_HANDLED__` |
| `/dcp context` | `handleContextCommand` | `__DCP_CONTEXT_HANDLED__` |
| `/dcp stats` | `handleStatsCommand` | `__DCP_STATS_HANDLED__` |
| `/dcp sweep [n]` | `handleSweepCommand` | `__DCP_SWEEP_HANDLED__` |
| `/dcp manual [on\|off]` | `handleManualToggleCommand` | `__DCP_MANUAL_HANDLED__` |
| `/dcp compress [focus]` | `handleManualTriggerCommand` | (不抛出，设 pendingManualTrigger) |
| `/dcp decompress <n>` | `handleDecompressCommand` | `__DCP_DECOMPRESS_HANDLED__` |
| `/dcp recompress <n>` | `handleRecompressCommand` | `__DCP_RECOMPRESS_HANDLED__` |

### Sentinel Error 机制

DCP 命令处理完后通过 `throw new Error("__DCP_STATS_HANDLED__")` 通知 OpenCode "命令已处理，不要再执行默认行为"。宿主必须在 catch 中识别并重新抛出这些 sentinel 错误。

### /dcp compress 特殊流程

`/dcp compress` 是唯一不抛出错误的命令：
1. `handleManualTriggerCommand` 构建压缩提示文本
2. 设置 `state.manualMode = "compress-pending"`
3. 设置 `state.pendingManualTrigger = { sessionId, prompt }`
4. 将 `/dcp compress` 文本回显到 `output.parts`
5. 实际的压缩注入由 Step 15 (applyPendingManualTrigger) 在下一轮 transform 中执行

### sweep 命令

`/dcp sweep [n]` — 手动标记工具为剪枝：
- 无参数：自最后用户消息以来的所有工具
- 带数字 `n`：最后 n 个工具
- 过滤掉已剪枝/受保护的工具和文件路径
- 标记到 `state.prune.tools`，持久化

---

## 13. Prompt 系统

**文件:** `lib/prompts/`

### PromptStore

管理 6 个可编辑 prompt + 2 个内部扩展。

**覆盖层叠顺序（最高优先）：**
1. 项目 `.opencode/dcp-prompts/overrides/`
2. `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/`
3. `~/.config/opencode/dcp-prompts/overrides/`

### 系统提示 (system.ts)

核心指令（不随运行时变化）：
- DCP 环境说明
- 唯一工具：`compress`
- `<dcp-message-id>` / `<dcp-system-reminder>` 是元数据——不要输出
- 压缩时机：已关闭的部分、研究/实施已完成
- 不压缩时机：仍活跃、仍需精确内容
- 定期评估信噪比

### 工具描述

**Range 模式 (compress-range.ts):**
- `topic` + `content[]` 数组，每项含 `{startId, endId, summary}`
- `(bN)` 占位符语法说明
- 边界引用格式（mNNNN / bN）
- 批处理不重叠范围支持

**Message 模式 (compress-message.ts):**
- `topic` + `content[]` 数组，每项含 `{messageId, topic, summary}`
- `priority` 属性说明
- `BLOCKED` ID 不可压缩
- 不重新压缩压缩结果

### Nudge 提示

**context-limit-nudge.ts:** 紧急——必须立即压缩。如果在原子操作中先完成。从较旧已解决的历史开始。

**turn-nudge.ts:** 评估可压缩范围。压缩已关闭的消息。

**iteration-nudge.ts:** 长时间迭代后，如果存在不太可能被引用的已关闭部分，压缩它。

### 条件扩展

**System prompt 渲染 (index.ts → renderSystemPrompt):**
```
systemPrompt
  + buildProtectedToolsExtension(config.compress.protectedTools)
  + (manualMode ? prompts.manualExtension : "")
  + (isSubAgent && allowSubAgents ? prompts.subagentExtension : "")
```

### 系统 Prompt 注入方式

在 `createSystemPromptHandler` 中：
- 追加到 `output.system` 的最后一个元素，用 `\n\n` 分隔
- 多个空白行折叠为 `\n\n`

---

## 14. 配置系统

**文件:** `lib/config.ts`

### 三层级联加载

```
1. ~/.config/opencode/dcp.jsonc (全局)
2. $OPENCODE_CONFIG_DIR/dcp.jsonc (配置目录)
3. .opencode/dcp.jsonc (项目)
```

每层可选，后者覆盖前者（merge 策略，非全量替换）。

### 默认配置

```typescript
const defaultConfig: PluginConfig = {
  enabled: true,
  autoUpdate: true,
  debug: false,
  pruneNotification: "detailed",     // "off" | "minimal" | "detailed"
  pruneNotificationType: "chat",     // "chat" | "toast"
  commands: { enabled: true, protectedTools: [...] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  experimental: { allowSubAgents: false, customPrompts: false },
  protectedFilePatterns: [],
  compress: {
    mode: "range",                   // "range" | "message"
    permission: "allow",             // "ask" | "allow" | "deny"
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100000,         // 也支持 "80%" 百分比
    minContextLimit: 50000,
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",             // "strong" | "soft"
    protectedTools: ["task", "skill", "todowrite", "todoread"],
    protectTags: false,
    protectUserMessages: false,
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
  },
}
```

### 配置验证

- `getInvalidConfigKeys` — 检查未知键
- `validateConfigTypes` — 检查类型正确性
- 警告通过 `showToast` 延迟 7 秒显示（等 TUI 初始化）

### Merge 策略

`mergeLayer` 按字段合并：
- 简单字段 → 后者覆盖
- 数组字段（protectedTools）→ `Set` 合并去重
- 对象字段（compress/strategies）→ 递归 merge

---

## 15. 持久化

**文件:** `lib/state/persistence.ts`

### 位置

```
~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
```

（可通过 `XDG_DATA_HOME` 覆盖）

### 磁盘格式 (PersistedSessionState)

```typescript
{
  sessionName?: string
  prune: {
    tools?: Record<string, number>       // Map → Object
    messages?: {
      byMessageId: Record<string, PrunedMessageEntry>
      blocksById: Record<string, CompressionBlock>  // 键为字符串
      activeBlockIds: number[]
      activeByAnchorMessageId: Record<string, number>
      nextBlockId: number
      nextRunId: number
    }
  }
  nudges: {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
  }
  stats: SessionStats
  lastUpdated: string                    // ISO 时间戳
}
```

### 持久化 vs 不持久化

| 持久化 | 不持久化 |
|--------|---------|
| prune.tools (剪枝记录) | sessionId (文件名) |
| prune.messages (所有压缩块) | isSubAgent |
| nudges 锚点集合 | manualMode |
| stats (累计统计) | compressPermission |
| | pendingManualTrigger |
| | compressionTiming (计时器) |
| | toolParameters (运行时缓存) |
| | subAgentResultCache |
| | toolIdList, messageIds |
| | lastCompaction, currentTurn |
| | modelContextLimit, systemPromptTokens |

### 加载验证

`loadSessionState` 和 `loadPruneMessagesState` 进行严格验证：
- 每个整数字段：验证类型 + 范围
- 数组字段：过滤/去重
- 枚举字段：验证有效值
- `summaryTokens` 回退：如果缺失，从摘要文本重新计算
- 从块重建 `activeBlockIds` 和 `activeByAnchorMessageId`

---

## 16. UI 通知

**文件:** `lib/ui/notification.ts` + `lib/ui/utils.ts`

### 通知机制

**sendIgnoredMessage:** 调用 `client.session.prompt()` + `noReply: true` + `parts: [{ type: "text", text, ignored: true }]`
- `ignored: true` 防止模型将其当做用户指令

**sendCompressNotification:** 压缩完成后的 UI 反馈
- 指标：`-X.XK removed, +X.XK summary`
- 进度条（50字符：`█`=活跃，`░`=已剪枝，`⣿`=最近压缩）
- 主题、消息数、工具数、可选摘要文本

**sendUnifiedNotification:** 自动剪枝后的 UI 反馈
- `"off"` → 不发送
- `"minimal"` → 仅摘要
- `"detailed"` → 完整输出 + 工具列表

### 通知渠道

`pruneNotificationType`：
- `"chat"` → `sendIgnoredMessage`（消息流）
- `"toast"` → `client.tui.showToast()`（弹窗，5秒，长度限制）

---

## 17. 子代理处理

**文件:** `lib/subagents/subagent-results.ts`

### 子代理检测

```typescript
// 通过 client.session.get() 检查 parentID
const isSubAgent = (await client.session.get()).has(parentID)
```

### 子代理结果提取

`buildSubagentResultText(messages)`:
1. 获取最后一个 assistant 的文本
2. 如果 ≥2 条 assistant 消息且倒数第二条有完成的 compress 工具 → 合并两者
3. 否则仅返回最后一条文本

`mergeSubagentResult(output, subAgentResultText)`:
- 替换 `<task_result>...</task_result>` 块体内的内容为完整子代理结果

### 子代理保护

`Step 3` — 如果 `isSubAgent && !allowSubAgents` → 跳过 Step 4-16

`appendProtectedTools` — 如果有 `allowSubAgents && tool === "task"` → 合并子代理结果

---

## 18. 脚本工具

**目录:** `scripts/`

DCP 提供一套离线 CLI 脚本，用于分析 OpenCode 会话的 token 使用模式。这些脚本**不是插件的一部分**——它们独立运行，通过直接查询 OpenCode 的 SQLite 数据库（`~/.local/share/opencode/opencode.db`）获取数据。脚本随插件源码分发，但不打包进 `dist/`。

### 18.1 共享 API 层

**文件:** `scripts/opencode_api.py` (249 行)

所有 Python 脚本通过 `OpencodeAPI` 类访问 OpenCode SQLite 数据库（只读模式 `?mode=ro`）。

```python
class OpencodeAPI:
    def list_projects() → list[dict]               # 列出所有项目
    def list_sessions(directory?, roots?, search?, limit?) → list[dict]
    def get_session(session_id, directory?) → dict
    def get_session_messages(session_id, directory?, limit?) → list[{info, parts}]
    def get_session_message(session_id, message_id, directory?) → {info, parts}
    def health() → dict                              # SELECT 1
```

辅助函数：
- `add_api_arguments(parser)` — 添加 `--db` 和 `--session-list-limit` 参数
- `create_client_from_args(args)` — 从命令行参数创建客户端
- `list_sessions_across_projects(client, ...)` — 跨项目列出会话

### 18.2 脚本清单

| 脚本 | 语言 | 用途 |
|------|------|------|
| `opencode-dcp-stats` | Python | 分析 DCP compress 工具对缓存命中率的影响 |
| `opencode-find-session` | Python | 按标题搜索会话 ID |
| `opencode-get-message` | Python | 按消息 ID 获取完整消息 JSON |
| `opencode-message-token-counts` | Python+Node | 显示每条消息的 token 数（模拟 `countAllMessageTokens`） |
| `opencode-session-timeline` | Python | 显示会话内每个 step 的 token 值变化 |
| `opencode-token-stats` | Python | 跨多个会话汇总 token 使用统计 |
| `print.ts` | TypeScript | 预览 DCP prompt 输出（system/nudge/compress-nudge 等） |
| `verify-package.mjs` | JS (ESM) | npm 发布前的包完整性验证 |

### 18.3 opencode-dcp-stats

**功能：** 分析 DCP `compress` 工具调用前后的上下文大小变化和缓存命中率影响。

**核心指标：**
- **缓存命中率变化：** `hit_rate_before / hit_rate_after`
- **上下文变化：** `context_before / context_after`
- **恢复分析：** DCP 调用后第 N 步的缓存命中率恢复曲线

**输出（按工具聚合）：**
```
Tool      Calls  Avg Hit% Before  Avg Hit% After  Delta  Avg Ctx Before  Avg Ctx After
compress   42         65.2%          42.8%       -22.4%     89,200          61,400
```

**缓存恢复分析：** 按"DCP 后第 N 步"统计命中率，判断缓存在几步内恢复到 85%+。

**使用：**
```bash
./scripts/opencode-dcp-stats --sessions 20 --min-messages 5 [--json] [--verbose]
```

### 18.4 opencode-find-session

**功能：** 按标题搜索会话，返回匹配的会话 ID。

**使用：**
```bash
./scripts/opencode-find-session "debug auth" [--exact] [--json] [--all]
```

**输出：**
- 单个匹配：直接打印 session ID（方便管道）
- 多个匹配：表格展示 ID / 最后使用时间 / 标题

### 18.5 opencode-get-message

**功能：** 按消息 ID 获取完整消息 JSON（`{info, parts}` 格式）。

**使用：**
```bash
./scripts/opencode-get-message <message-id> [--session <id>]
```

**查找策略：**
- 有 `--session` → 直接查
- 无 `--session` → 扫描最近 200 个会话（`--scan-sessions`）

### 18.6 opencode-message-token-counts

**功能：** 为会话中每条消息计算 `countAllMessageTokens` 风格的 token 数。

**Token 计数：**
1. 优先使用 `@anthropic-ai/tokenizer`（通过 Node.js 子进程）
2. 不可用时回退到 `text.length / 4`

**输出（宽屏）：**
```
  # Role      Tokens Size      Seg/Part ID             Preview
  1 user        124 #...   0%  1/2      abc123...      "请检查 src/auth.ts"
  2 assistant  3421 ####.  85% 3/5      def456...      [tools: read, edit, grep]
```

**输出（窄屏）：** 紧凑双行格式。

**使用：**
```bash
./scripts/opencode-message-token-counts [--session ID] [--json] [--no-color]
```

### 18.7 opencode-session-timeline

**功能：** 显示会话内每个 step 的 token 值随时间的变化，标注 DCP 工具导致缓存下跌的事件。

**核心列：**
```
Step  Cache Read  Δ Cache   Input  Output  Cache%  Duration  Gap     DCP Tools     Reason
1          4,200      +4,200  1,200     340   77.8%     2.3s    -     -             tool-calls
2         52,300    +48,100  5,100     820   91.1%     4.1s  0.5s    -             tool-calls
3         12,400    -39,900  8,200   1,200   60.2%    12.3s  0.2s    compress      stop
```

**关键：** DCP 调用导致缓存下降（`Δ Cache` 为负），随后几步缓存逐步恢复。

**使用：**
```bash
./scripts/opencode-session-timeline [--session ID] [--json] [--no-color]
```

### 18.8 opencode-token-stats

**功能：** 跨多个会话汇总 token 使用统计（input/output/reasoning/cache 分类）。

**输出：**
```
Session     Title       Steps    Input   Output  Reasoning  Cache Read  Cache%
sess_abc    Fix Auth       12   45,200   8,300    1,200     380,000    89.4%
sess_def    Refactor API   18   62,100  12,400    3,500     520,000    89.3%
```

**使用：**
```bash
./scripts/opencode-token-stats [--sessions N] [--session ID] [--json]
```

### 18.9 print.ts

**功能：** 预览 DCP 运行时 prompt 内容。通过 `npm run dcp` 调用（在 `package.json` 中注册）。

**使用：**
```bash
npm run dcp -- --list                    # 列出所有 prompt key
npm run dcp -- --show compress-range     # 打印指定 prompt
npm run dcp -- --system                  # 系统 prompt（无扩展）
npm run dcp -- --system-manual           # 系统 prompt + manual 扩展
npm run dcp -- --system-subagent         # 系统 prompt + subagent 扩展
npm run dcp -- --system-all              # 系统 prompt + 所有扩展
```

### 18.10 verify-package.mjs

**功能：** npm 发布前的包完整性验证脚本。检查 `dist/` 目录内容、导出配置等。

### 18.11 脚本使用模式

```bash
# 1. 找到目标会话
SESSION_ID=$(./scripts/opencode-find-session "refactor auth")

# 2. 查看该会话的 token 时间线
./scripts/opencode-session-timeline --session $SESSION_ID

# 3. 查看 DCP 对缓存的影响
./scripts/opencode-dcp-stats --sessions 30

# 4. 查看具体消息的 token 分布
./scripts/opencode-message-token-counts --session $SESSION_ID

# 5. 获取特定消息的完整内容（调试用）
./scripts/opencode-get-message <message-id> --session $SESSION_ID
```

所有脚本支持 `--json` 输出和 `--db` 指定数据库路径。

---

## 19. 数据流全景图

```
用户输入 / LLM 响应
        │
        ▼
┌─── experimental.chat.messages.transform ──────────────────────────────┐
│                                                                      │
│  Step 0: filterMessagesInPlace     ── 清理无效消息                   │
│  Step 1: checkSession              ── 会话切换/压缩检测              │
│  Step 2: syncCompressPermission    ── 权限解析                       │
│  Step 3: 子代理保护                ── 提前退出                       │
│  Step 4: stripHallucinations       ── 移除 <dcp> 标签               │
│  Step 5: cacheSystemPromptTokens   ── 估算系统 prompt token          │
│  Step 6: assignMessageRefs         ── 分配 mNNNN 引用               │
│  Step 7: syncCompressionBlocks     ── 重算块活跃状态                 │
│  Step 8: syncToolCache             ── 缓存工具参数                   │
│  Step 9: buildToolIdList           ── 构建工具 ID 列表               │
│  Step 10: prune                    ── 执行剪枝（4 子步骤）           │
│  Step 11: injectSubAgentResults    ── 合并子代理结果                 │
│  Step 12: buildPriorityMap         ── 计算优先级                     │
│  Step 13: injectCompressNudges     ── 注入 nudge                     │
│  Step 14: injectMessageIds         ── 注入 mNNNN 标签               │
│  Step 15: applyManualTrigger       ── 手动压缩触发                   │
│  Step 16: stripStaleMetadata       ── 清理跨 provider 元数据         │
│                                                                      │
│  ┌─ 写入 SessionState ──────────────────────────────────────────────┐│
│  │ prune.tools, prune.messages, messageIds, nudges, stats          ││
│  │ toolParameters, toolIdList, subAgentResultCache                  ││
│  └──────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘

        │                    ┌────────────────────────────────────┐
        ▼                    │  LLM 调用 compress 工具            │
                             │  prepareSession()                  │
LLM 输出                     │  resolveRanges/Messages            │
        │                    │  applyCompressionState() ← 标记   │
        ▼                    │  finalizeSession()                 │
┌─── experimental.text.complete ──┘  └────────────────────────────────┘
│  stripHallucinationsFromString      │
└──────────────────────────────────── │
                                      ▼
┌─── event ────────────────────────────────────────────────────────────┐
│  message.part.updated + tool=compress                                │
│  pending → 记录 start                                                │
│  completed → 计算 duration → applyPendingCompressions                │
└──────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─── command.execute.before ──────────────────────────────────────────┐
│  /dcp stats/context/sweep/compress/decompress/recompress/manual/help │
│  处理后抛出 sentinel error                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 标记-清理循环

```
Turn N:
  messages.transform:
    Step 7: syncCompressionBlocks — 发现块 X 已活跃
    Step 10a: filterCompressedRanges — 移除块 X 覆盖的消息，注入摘要
    Step 10c: pruneToolOutputs — 替换已标记工具的输出

  LLM 调用 compress:
    prepareSession + deduplicate + purgeErrors — 标记新工具
    applyCompressionState — 创建新块 Y，消费块 X

  saveSessionState — 持久化

Turn N+1:
  messages.transform:
    Step 7: syncCompressionBlocks — 块 Y 活跃，块 X 已停用
    Step 10a: filterCompressedRanges — 移除块 Y 覆盖的消息，注入摘要
    Step 10c: pruneToolOutputs — 替换新标记的工具输出
    ...
```
