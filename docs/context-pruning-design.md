# 上下文剪枝设计报告：从内置 Compaction 到框架无关的统一剪枝架构

**版本:** 1.0  
**日期:** 2026-06-13  
**分类:** 技术架构文档 / 上下文管理

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [OpenCode 内置 Compaction 机制](#2-opencode-内置-compaction-机制)
   - 2.1 [V2 Core 层 Compaction](#21-v2-core-层-compaction)
   - 2.2 [V1 Orchestration 层 Compaction](#22-v1-orchestration-层-compaction)
   - 2.3 [Overflow 检测](#23-overflow-检测)
   - 2.4 [配置参数](#24-配置参数)
3. [DCP 插件架构分析](#3-dcp-插件架构分析)
   - 3.1 [整体架构](#31-整体架构)
   - 3.2 [16 步消息变换管道](#32-16-步消息变换管道)
   - 3.3 [双模压缩引擎](#33-双模压缩引擎)
   - 3.4 [自动策略：去重与错误清除](#34-自动策略去重与错误清除)
   - 3.5 [Nudge 系统](#35-nudge-系统)
   - 3.6 [状态模型与配置模式](#36-状态模型与配置模式)
4. [ZooKeeper 现状分析](#4-zookeeper-现状分析)
   - 4.1 [现有架构与 Hook 注册](#41-现有架构与-hook-注册)
   - 4.2 [现有配置体系](#42-现有配置体系)
   - 4.3 [框架无关性约束](#43-框架无关性约束)
5. [内建上下文剪枝方案设计](#5-内建上下文剪枝方案设计)
   - 5.1 [设计原则](#51-设计原则)
   - 5.2 [架构总览](#52-架构总览)
   - 5.3 [模块布局](#53-模块布局)
   - 5.4 [核心类型定义](#54-核心类型定义)
   - 5.5 [配置方案](#55-配置方案)
    - 5.6 [Token 计数](#56-token-计数)
   - 5.7 [会话状态管理](#57-会话状态管理)
   - 5.8 [消息变换管道](#58-消息变换管道)
   - 5.9 [去重策略](#59-去重策略)
   - 5.10 [错误清除策略](#510-错误清除策略)
   - 5.11 [压缩引擎（Range 模式）](#511-压缩引擎range-模式)
   - 5.12 [Nudge 注入](#512-nudge-注入)
   - 5.13 [整合到 ZooKeeper](#513-整合到-zookeeper)
   - 5.14 [Scope 决策](#514-scope-决策)
6. [与 DCP 的架构对比](#6-与-dcp-的架构对比)
   - 6.1 [差异总览](#61-差异总览)
   - 6.2 [为什么不在 ZooKeeper 中直接依赖 DCP](#62-为什么不在-zookeeper-中直接依赖-dcp)
7. [实施计划](#7-实施计划)
   - 7.1 [Phase 1：基础设施（Week 1-2）](#71-phase-1基础设施week-1-2)
   - 7.2 [Phase 2：自动策略（Week 3-4）](#72-phase-2自动策略week-3-4)
   - 7.3 [Phase 3：压缩引擎（Week 5-6）](#73-phase-3压缩引擎week-5-6)
   - 7.4 [Phase 4：OpenCode 整合（Week 7-8）](#74-phase-4opencode-整合week-7-8)
   - 7.5 [Phase 5：测试与调优（Week 9-10）](#75-phase-5测试与调优week-9-10)
   - 7.6 [验证方法](#76-验证方法)
8. [已知风险与缓解措施](#8-已知风险与缓解措施)
9. [总结](#9-总结)

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

### 1.3 调研范围

本文档分析三个层面的上下文管理方案：

| 层次 | 方案 | 分析章节 |
|------|------|---------|
| 平台内置 | OpenCode V2/V1 Compaction | §2 |
| 第三方插件 | DCP (`@tarquinen/opencode-dcp`) | §3 |
| 自研方案 | ZooKeeper 内建上下文剪枝 | §5 |

目标：设计一套**框架无关、可插拔、轻量级**的上下文剪枝方案，集成到 ZooKeeper 中，并预留 pi / oh-my-pi 适配器的接口。

---

## 2. OpenCode 内置 Compaction 机制

OpenCode 在核心平台层面提供了两层内置的 compaction（上下文压缩）机制，分别在 V2 Core 和 V1 Orchestration 层实现。

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

## 3. DCP 插件架构分析

DCP（`@tarquinen/opencode-dcp`，Dynamic Context Pruning）是一个 OpenCode 插件，用模型驱动的压缩替代了内置 compaction。以下分析基于源码 `opencode-dynamic-context-pruning/`。

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
Step  8: syncToolCache                — 缓存工具调用参数
Step  9: buildToolIdList              — 构建全局工具调用 ID 列表
Step 10: prune                        — 执行实际消息剪枝（4 种模式）
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

### 3.3 双模压缩引擎

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

### 3.4 自动策略：去重与错误清除

#### 去重（`lib/strategies/deduplication.ts`）

按 `toolName + normalizedParameters` 签名对工具调用分组：

```typescript
interface DedupConfig {
  enabled: boolean
  protectedTools: string[]   // 不参与去重的工具
  protectedPatterns: RegExp[] // 匹配的参数模式不参与去重
}
```

策略：同一签名组中保留最新的一次调用，标记旧调用为待剪枝。

#### 错误清除（`lib/strategies/purge-errors.ts`）

在错误发生的 N 轮（默认 4 轮）后，标记失败的工具调用为待剪枝。剪枝时：

```typescript
interface PurgedToolCall {
  // input 字段被擦除
  input: {}  // 空对象
  // 保留 error 消息
  output: { error: string }
}
```

### 3.5 Nudge 系统

三级压力提示系统，在上下文接近上限时引导模型主动压缩：

| 级别 | 触发条件 | 注入频率 | 语义 |
|------|---------|---------|------|
| Context limit nudge | `total_tokens > maxContextLimit` | 每 `nudgeFrequency` 帧 | 紧急——必须触发压缩 |
| Turn nudge | 介于 min/max 之间 + 新用户轮次 | 每轮一次 | 温和——考虑压缩 |
| Iteration nudge | 介于 min/max 之间 + 助手消息数超阈值 | 每轮一次 | 警告——对话过长在漂移 |

### 3.6 状态模型与配置模式

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
| `turnProtection` | number | `2` | 保护最近 N 轮用户交互 |
| `protectUserMessages` | bool | `true` | 保留用户消息原样 |
| `protectTags` | string[] | — | 具有特定标签的消息不压缩 |

---

## 4. ZooKeeper 现状分析

### 4.1 现有架构与 Hook 注册

ZooKeeper 目前是一个 OpenCode orchestrator 插件，在 `src/index.ts` 中注册 5 个 hook：

| Hook | 功能 | 实现位置 |
|------|------|---------|
| `config` | 注入 prompt 文件、注册 skills | inline |
| `experimental.chat.messages.transform` | per-turn focus reminder | `src/hooks/focus-reminder/` |
| `tool.definition` | 增强 task() prompt 参数描述 | `src/hooks/task-prompt/` |
| `tool.execute.before` | 阻断式校验 task() prompt 结构 | `src/hooks/task-prompt/` |
| `tool.execute.after` | 4 个 advisory handler 链式执行 | 多 handler 串联 |

当前 `tool.execute.after` 的 handler 链：

```typescript
const handlers = [
  (i, o) => nudgeTaskOutput(i, o, limits),   // task prompt 内容 nudge
  recoverJsonError,                            // JSON 解析错误恢复
  (i, o) => nudgeDirectWork(client, i, o),     // 直接编辑警告
  (i, o) => nudgePostTask(client, i, o),       // 验证 + todo 提醒
];
```

### 4.2 现有配置体系

配置通过 `config.toml` 加载，`[zoo.validation]` 段落提供验证阈值：

```toml
[zoo.validation]
context_word_limit = 200
prompt_word_limit  = 500
```

插件在初始化时通过 `import config from "../config.toml" with { type: "toml" }` 读取，闭包捕获。

### 4.3 框架无关性约束

`src/index.ts:16` 有一个关键 TODO：

```
TODO: Add pi / oh-my-pi adapter (framework adapter).
```

这意味着所有新逻辑必须考虑**框架无关性**。OpenCode 使用 TypeScript + Hook API，pi / oh-my-pi 使用框架适配器机制。上下文剪枝的核心逻辑（token 估算、去重、错误清除、压缩引擎）必须与框架解耦，能够在两个插件系统中复用。

**当前架构中已框架无关的部分**：
- `src/hooks/utils/` 中的共享模块
- 所有 hook 实现内部的纯函数核心逻辑
- Config 通过 `config.toml` 声明式定义

**需要框架无关的上下文剪枝逻辑**：
- 类型定义（types）
- Token 估算（estimator）
- 状态管理（state）
- 去重检测（dedup）
- 错误清除（purge-errors）
- 压缩引擎（compress）
- Nudge 注入（nudge）
- 管道编排（pipeline）

**框架相关（需要适配器）**：
- OpenCode 的 `experimental.chat.messages.transform` hook 绑定
- pi / oh-my-pi 的适配器消息变换 hook
- 会话 ID 获取方式差异

---

## 5. 内建上下文剪枝方案设计

### 5.1 设计原则

**原则一：框架无关核心 + 框架特定适配器**

所有上下文剪枝算法和状态管理在纯 TypeScript 中实现，不依赖 OpenCode SDK 类型。框架绑定通过薄适配层实现。

**原则二：轻量无依赖**

不引入 `tiktoken` 或 `@anthropic-ai/tokenizer`。使用 OpenCode SDK 原生提供的 `AssistantMessage.tokens`（API 精确计费数据）作为主力，仅对新增的 in-progress 消息使用 `text.length / 4` 启发式补充。整体误差 < 5%。

**原则三：渐进增强**

从去重和错误清除等低成本策略开始，逐步引入 LLM 驱动的压缩。每个策略独立开关。

**原则四：不吃掉有意义的上下文**

- 保护最近 N 轮用户交互
- 保护系统 prompt（ZooKeeper 注入的权限规则）
- 保护 `task()`、`skill()` 等关键工具的输出
- 保护配置文件中声明的 protected_tools

**原则五：nudge 优先于强制**

在上下文达到阈值时先注入友好的 nudge，引导模型主动管理。仅在超过紧急阈值时才自动触发压缩。

### 5.2 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    Framework Adapters                        │
│  ┌──────────────────────┐  ┌──────────────────────────┐     │
│  │  OpenCode Hook       │  │  pi / oh-my-pi Adapter    │     │
│  │  (hook.ts)           │  │  (adapter.ts, P2)         │     │
│  └─────────┬────────────┘  └──────────┬───────────────┘     │
│            │                           │                      │
├─ - - - - - - - - - - - - - - - - - - - - - - - - - - - - ┤  │  ← framework boundary
│            ▼                           ▼                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Framework-Agnostic Core                  │    │
│  │  src/context-pruning/                                 │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │    │
│  │  │  dedup   │  │  purge   │  │   compress       │    │    │
│  │  │  .ts     │  │  -errors │  │   (range/message)│    │    │
│  │  │          │  │  .ts     │  │                  │    │    │
│  │  └────┬─────┘  └────┬─────┘  └───────┬──────────┘    │    │
│  │       │              │                │                │    │
│  │       ▼              ▼                ▼                │    │
│  │  ┌────────────────────────────────────────────────┐    │    │
│  │  │              pipeline.ts                       │    │    │
│  │  │  (orchestrates: dedup → purge → compress →     │    │    │
│  │  │   injectNudge → injectIds)                    │    │    │
│  │  └──────────────────────┬─────────────────────────┘    │    │
│  │                         │                               │    │
│  │  ┌──────────────────────▼─────────────────────────┐    │    │
│  │  │           state.ts (SessionState)              │    │    │
│  │  │  (compression blocks, dedup cache, error       │    │    │
│  │  │   tracking, turn protection, persist)          │    │    │
│  │  └───────────────────────────────────────────────┘    │    │
│  │                                                       │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │    │
│  │  │  types   │  │estimator │  │   nudge.ts       │    │    │
│  │  │  .ts     │  │ .ts      │  │                  │    │    │
│  │  └──────────┘  └──────────┘  └──────────────────┘    │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
  src/hooks/context-pruning/        src/context-pruning/
  (adapters only)                   (core, framework-agnostic)
```

### 5.3 模块布局

核心逻辑（框架无关）与框架适配器分离存放：

```
src/context-pruning/             # ── 框架无关核心 ──
├── index.ts                     # 桶导出（barrel export）
├── types.ts                     # 框架无关的核心类型定义
├── estimator.ts                 # Token 计数（API 上报 + 启发式补充）
├── state.ts                     # 会话状态管理
├── dedup.ts                     # 去重策略
├── purge-errors.ts              # 错误清除策略
├── compress.ts                  # 压缩引擎核心（Range / Message 模式）
├── nudge.ts                     # Nudge 注入逻辑
├── pipeline.ts                  # 消息变换管道编排器
└── index.test.ts                # 单元测试（核心逻辑）

src/hooks/context-pruning/       # ── OpenCode 框架适配器 ──
├── index.ts                     # 桶导出（re-export + 适配）
├── hook.ts                      # OpenCode 框架适配器
└── index.test.ts                # 集成测试（适配层）
```

### 5.4 核心类型定义

```typescript
// types.ts — framework-agnostic core types

// ── Message model ──────────────────────────────────────────

export interface MessageRef {
  id: string;               // mNNNN 格式引用 ID
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCallRef[];
  toolResults?: ToolResultRef[];
  metadata?: Record<string, unknown>;
}

export interface ToolCallRef {
  id: string;               // tNNNN 格式引用 ID
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface ToolResultRef {
  id: string;
  toolCallId: string;
  output: string;
  isError?: boolean;
  error?: string;
}

// ── Compression ────────────────────────────────────────────

export type CompressionMode = "range" | "message";

export interface CompressionBlock {
  blockId: string;
  runId: string;
  active: boolean;

  compressedTokens: number;
  summaryTokens: number;

  mode: CompressionMode;
  topic: string;

  startId: string;
  endId: string;

  directMessageIds: string[];
  directToolIds: string[];
  effectiveMessageIds: string[];
  effectiveToolIds: string[];

  summary: CompressionSummary;
}

export interface CompressionSummary {
  goal: string;
  progress: string;
  decisions: string;
  keyContext: string;
  files: string[];
}

// ── Session State ──────────────────────────────────────────

export interface SessionState {
  sessionId: string;

  // Compression blocks
  blocksById: Map<string, CompressionBlock>;
  byMessageId: Map<string, string[]>;  // messageId → blockId[]
  activeBlockIds: Set<string>;

  // Dedup cache
  dedupCache: Map<string, DedupEntry>;

  // Error tracking
  errorTracking: Map<string, ErrorEntry>;

  // Turn protection
  protectedTurns: number;
  turnCount: number;

  // Stats
  lastAccessedAt: number;
  totalPrunedTokens: number;
  totalCompressedTokens: number;
}

export interface DedupEntry {
  toolName: string;
  signature: string;
  firstSeenAt: string;    // message ID
  latestSeenAt: string;   // message ID
  callCount: number;
}

export interface ErrorEntry {
  toolCallId: string;
  toolName: string;
  turnNumber: number;
  errorMessage: string;
}

// ── Config ─────────────────────────────────────────────────

export interface ContextPruningConfig {
  enabled: boolean;

  // Thresholds (triggers use API-reported tokens + heuristic for new messages)
  nudgeThresholdTokens: number;      // 70_000 — start gentle reminders
  urgentThresholdTokens: number;     // 140_000 — urgent compression request

  // Automatic strategies
  dedupEnabled: boolean;
  purgeErrorsEnabled: boolean;
  purgeErrorsTurns: number;          // 3 — turns before error purge

  // Compression
  compressMode: CompressionMode;
  compressEnabled: boolean;
  compressMinTokens: number;         // 50_000
  compressMaxTokens: number;         // 100_000
  nudgeFrequency: number;            // 3 — how often context-limit nudge fires

  // LLM-driven compression (Phase 4+)
  compressLlmEnabled: boolean;       // register compress tool for model use
  compressMessageModeEnabled: boolean; // enable Message mode (per-message LLM compression)

  // Commands (Phase 5+)
  commandsEnabled: boolean;          // enable /context, /stats, /sweep etc.

  // Persistence (Phase 5+)
  persistState: boolean;             // persist session state to disk

  // Protection
  protectedTools: string[];
  protectUserMessages: boolean;
  turnProtection: number;            // 2 — protect last N turns

  // Dedup
  dedupProtectedTools: string[];

  // Purge errors
  purgeErrorsProtectedTools: string[];
}

// ── Pipeline ───────────────────────────────────────────────

export interface PipelineInput {
  sessionId: string;
  messages: MessageRef[];
  config: ContextPruningConfig;
}

export interface PipelineOutput {
  messages: MessageRef[];
  nudges: string[];
  stats: PipelineStats;
}

export interface PipelineStats {
  dedupRemoved: number;
  errorPurged: number;
  compressedTokens: number;
  summaryTokens: number;
}
```

### 5.5 配置方案

在 `config.toml` 中新增 `[zoo.context]` 段落：

```toml
# ── Context Pruning ─────────────────────────────────────────
# 控制 ZooKeeper 内置的上下文剪枝行为。
# 每个字段都有默认值，可选择性覆盖。

[zoo.context]
enabled = true

# Token 计数：优先使用 API 上报的精确数据，仅在新增 in-progress 消息时回退启发式
# 阈值设置以 1M context 窗口为参考
nudge_threshold_tokens = 70000      # 开始温和提醒
urgent_threshold_tokens = 140000    # 紧急压缩请求

# 自动策略
dedup_enabled = true                # 去重重复工具输出
purge_errors_enabled = true         # 清除错误工具输入（N 轮后）
purge_errors_turns = 3              # 错误清除前的等待轮数

# 压缩（Phase 1-3：启发式范围压缩）
compress_enabled = true
compress_mode = "range"             # "range" | "message"
compress_min_tokens = 70000         # 开始温和 nudge 的阈值
compress_max_tokens = 140000        # 触发紧急 nudge 的阈值
compress_nudge_frequency = 3        # context-limit nudge 的注入间隔

# LLM 驱动压缩（Phase 4+）
compress_llm_enabled = false        # 注册 compress 工具供模型调用
compress_message_mode_enabled = false # 启用 Message 模式（单消息粒度的 LLM 压缩）

# 命令系统（Phase 5+）
commands_enabled = false            # 启用 /context、/stats、/sweep 等命令

# 跨会话持久化（Phase 5+）
persist_state = true                # 将会话剪枝状态持久化到磁盘

# 保护规则 — 以下列表中的工具永不参与剪枝
protected_tools = [
  "task",
  "skill",
  "question",
  "todowrite",
  "todoread",
]

# 用户消息保护
protect_user_messages = true

# 最近 N 轮用户交互受保护（不参与压缩/剪枝）
turn_protection = 2

# 去重保护 — 列表中工具不参与去重
dedup_protected_tools = [
  "task",
  "skill",
  "read",
]

# 错误清除保护 — 列表中工具的错误不参与清除
purge_errors_protected_tools = [
  "task",
  "skill",
]
```

**配置加载逻辑**（与现有 `[zoo.validation]` 模式一致）：

```typescript
function loadContextConfig(zooConfig: Record<string, any>): ContextPruningConfig {
  const ctx = zooConfig.context ?? {};
  return {
    enabled: ctx.enabled ?? true,
    nudgeThresholdTokens: ctx.nudge_threshold_tokens ?? 70_000,
    urgentThresholdTokens: ctx.urgent_threshold_tokens ?? 140_000,
    dedupEnabled: ctx.dedup_enabled ?? true,
    purgeErrorsEnabled: ctx.purge_errors_enabled ?? true,
    purgeErrorsTurns: ctx.purge_errors_turns ?? 3,
    compressEnabled: ctx.compress_enabled ?? true,
    compressMode: ctx.compress_mode ?? "range",
    compressMinTokens: ctx.compress_min_tokens ?? 70_000,
    compressMaxTokens: ctx.compress_max_tokens ?? 140_000,
    nudgeFrequency: ctx.compress_nudge_frequency ?? 3,

    // LLM-driven compression (Phase 4+)
    compressLlmEnabled: ctx.compress_llm_enabled ?? false,
    compressMessageModeEnabled: ctx.compress_message_mode_enabled ?? false,

    // Commands (Phase 5+)
    commandsEnabled: ctx.commands_enabled ?? false,

    // Persistence (Phase 5+)
    persistState: ctx.persist_state ?? true,

    protectedTools: ctx.protected_tools ?? ["task", "skill", "question"],
    protectUserMessages: ctx.protect_user_messages ?? true,
    turnProtection: ctx.turn_protection ?? 2,
    dedupProtectedTools: ctx.dedup_protected_tools ?? ["task", "skill", "read"],
    purgeErrorsProtectedTools: ctx.purge_errors_protected_tools ?? ["task", "skill"],
  };
}
```

### 5.6 Token 计数

不使用纯启发式估算。OpenCode 插件 SDK 的 `AssistantMessage.tokens` 字段提供**API 上报的精确 token 数**，可直接使用。

#### 5.6.1 数据来源

在 `experimental.chat.messages.transform` hook 中，`output.messages[].info` 是 `Message` 类型（`UserMessage | AssistantMessage`）。完成后的 `AssistantMessage` 包含：

```typescript
// OpenCode SDK: packages/sdk/js/src/v2/gen/types.gen.ts
export type AssistantMessage = {
  role: "assistant"
  tokens: {
    total?: number      // v2 only
    input: number       // 该次 LLM 调用消耗的输入 token（≈ 当前上下文填充量）
    output: number
    reasoning: number
    cache: {
      read: number      // prompt cache 命中的 token
      write: number
    }
  }
  // ...
}
```

**关键洞察**：最后一条完成的 assistant 消息的 `tokens.input` 近似等于当前上下文窗口的 token 填充量（该次调用发送给模型的全部内容）。

**pi / oh-my-pi 等价字段**（均已确认可用）：

| 框架 | 字段路径 | 关键字段 |
|------|---------|---------|
| OpenCode | `AssistantMessage.tokens` | `input`, `output`, `reasoning`, `cache.read`, `cache.write` |
| pi | `AssistantMessage.usage` | `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` |
| oh-my-pi | `AssistantMessage.usage` | 与 pi 相同 + `reasoningTokens`, `cttl`, `server` 子字段 |

此外，pi/oh-my-pi 还提供 `ctx.getContextUsage()` 直接返回 `{ tokens, contextWindow, percent }`，可在不遍历消息的情况下快速获取上下文填充率。但考虑到需统一抽象，仍采用遍历消息取最后 assistant 的 tokens 方案（三框架均支持）。

#### 5.6.2 混合计数策略

```
┌──────────────────────────────────────────────────────┐
│  消息序列                                              │
│  [user] [assistant ✓ tokens=50K] [tool] [user] ...   │
│          ↑ 最后完成点           ↑ 新增消息（未计费）    │
│                                                       │
│  总 token ≈ 50K (API 上报) + 新消息估算 (启发式)       │
└──────────────────────────────────────────────────────┘
```

```typescript
// estimator.ts

/**
 * Get total context token usage using a hybrid approach:
 * 1. Find the last completed assistant message → use its API-reported tokens
 * 2. Estimate tokens for any messages added after that point
 *
 * This mirrors DCP's getCurrentTokenUsage() strategy.
 */
export function getContextTokens(
  messages: Array<{ info: { role: string; tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } } }; parts: Array<{ type: string; text?: string }> }>,
): number {
  // Step 1: Find last completed assistant message (tokens.output > 0 means completed)
  let lastAssistantIndex = -1;
  let reportedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== "assistant") continue;
    const tokens = msg.info.tokens;
    if (!tokens || (tokens.output ?? 0) <= 0) continue; // skip streaming/incomplete
    lastAssistantIndex = i;
    reportedTokens =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0);
    break;
  }

  // Step 2: Estimate tokens for messages after the last assistant
  let estimatedNewTokens = 0;
  for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
    estimatedNewTokens += estimateMessageHeuristic(messages[i]);
  }

  return reportedTokens + estimatedNewTokens;
}

/**
 * Fallback heuristic: text.length / 4.
 * Only used for in-progress messages that haven't been through an LLM call yet.
 */
function estimateMessageHeuristic(
  msg: { parts: Array<{ type: string; text?: string }> },
): number {
  let chars = 0;
  for (const part of msg.parts) {
    if (part.text) chars += part.text.length;
  }
  return Math.ceil(chars / 4);
}
```

#### 5.6.3 与纯启发式的对比

| 方案 | 精度 | 依赖 | 适用消息 |
|------|------|------|---------|
| API 上报 `AssistantMessage.tokens` | **精确**（API 计费数据） | 无额外依赖，OpenCode SDK 原生提供 | 已完成的 assistant 消息 |
| `text.length / 4` 启发式 | 低（±30%） | 无 | 仅用于新增的 in-progress 消息 |

**混合策略优势**：
- 95%+ 的上下文 token 来自 API 精确数据（最后一条 assistant 消息的累计值）
- 仅对最近新增的几条消息（通常 < 2K tokens）使用启发式
- 整体误差 < 5%，远优于纯启发式的 ±30%
- 无需引入 `tiktoken` 或 `@anthropic-ai/tokenizer` 等依赖
- 框架无关：仅依赖 `AssistantMessage` 类型，该类型来自 OpenCode SDK，pi / oh-my-pi 适配器届时可使用对应框架的等价数据

### 5.7 会话状态管理

```typescript
// state.ts

import type { SessionState, CompressionBlock, DedupEntry, ErrorEntry } from "./types";

const SESSION_TTL_MS = 30 * 60 * 1000;       // 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

class ContextPruningState {
  private sessions = new Map<string, SessionState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupInterval();
  }

  getOrCreate(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        blocksById: new Map(),
        byMessageId: new Map(),
        activeBlockIds: new Set(),
        dedupCache: new Map(),
        errorTracking: new Map(),
        protectedTurns: 2,
        turnCount: 0,
        lastAccessedAt: Date.now(),
        totalPrunedTokens: 0,
        totalCompressedTokens: 0,
      };
      this.sessions.set(sessionId, state);
    }
    state.lastAccessedAt = Date.now();
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (state) state.lastAccessedAt = Date.now();
    return state;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // Track tool call for dedup
  trackToolCall(
    sessionId: string,
    toolName: string,
    parameters: Record<string, unknown>,
    messageId: string,
  ): boolean {
    const state = this.getOrCreate(sessionId);
    const signature = this.buildSignature(toolName, parameters);
    const existing = state.dedupCache.get(signature);

    if (existing) {
      existing.callCount++;
      existing.latestSeenAt = messageId;
      return true; // duplicate detected
    }

    state.dedupCache.set(signature, {
      toolName,
      signature,
      firstSeenAt: messageId,
      latestSeenAt: messageId,
      callCount: 1,
    });
    return false; // not a duplicate
  }

  // Track error tool call
  trackError(sessionId: string, toolCallId: string, toolName: string, errorMessage: string): void {
    const state = this.getOrCreate(sessionId);
    state.errorTracking.set(toolCallId, {
      toolCallId,
      toolName,
      turnNumber: state.turnCount,
      errorMessage,
    });
  }

  // Mark a turn (for turn protection)
  advanceTurn(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.turnCount++;
  }

  private buildSignature(toolName: string, parameters: Record<string, unknown>): string {
    // Normalize parameters by sorting keys and removing timestamps/paths
    const normalized = this.normalizeParams(parameters);
    return `${toolName}::${JSON.stringify(normalized)}`;
  }

  private normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
    // Sort keys for deterministic ordering
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(params).sort()) {
      sorted[key] = params[key];
    }
    return sorted;
  }

  private startCleanupInterval(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, state] of this.sessions.entries()) {
        if (now - state.lastAccessedAt > SESSION_TTL_MS) {
          this.sessions.delete(sessionId);
        }
      }
    }, SESSION_CLEANUP_INTERVAL_MS);
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}

// Singleton instance
export const globalState = new ContextPruningState();
```

**状态清理策略**：
- Session TTL：30 分钟无访问自动清理
- 清理间隔：每 5 分钟执行一次
- Session 删除时（如 `session.deleted` 事件）立即清理

### 5.8 消息变换管道

```typescript
// pipeline.ts

import type { MessageRef, ContextPruningConfig, PipelineInput, PipelineOutput, PipelineStats } from "./types";
import { estimateTotalTokens } from "./estimator";
import { globalState } from "./state";
import { runDedup } from "./dedup";
import { runPurgeErrors } from "./purge-errors";
import { runCompression } from "./compress";
import { buildNudges } from "./nudge";

/**
 * Run the context pruning pipeline on a set of messages.
 *
 * Pipeline order:
 *   1. Filter malformed messages
 *   2. Assign message references (mNNNN)
 *   3. Dedup tool calls (if enabled)
 *   4. Purge errors (if enabled)
 *   5. Compress (range mode, if enabled + threshold exceeded)
 *   6. Build nudges (based on token thresholds)
 *   7. Inject message IDs
 *   8. Strip stale metadata
 *
 * Each step operates on the message array in-place or returns
 * a filtered/reduced array.
 */
export function runPipeline(input: PipelineInput): PipelineOutput {
  const { sessionId, messages, config } = input;
  let working = [...messages];
  const stats: PipelineStats = {
    dedupRemoved: 0,
    errorPurged: 0,
    compressedTokens: 0,
    summaryTokens: 0,
  };

  const state = globalState.getOrCreate(sessionId);

  // ── Step 1: Filter malformed ──────────────────────────
  working = working.filter((m) => m.id && m.role && m.content !== undefined);

  // ── Step 2: Assign message refs ───────────────────────
  const messageRefs = new Map<string, number>();
  working.forEach((m, i) => {
    const ref = `m${String(i).padStart(4, "0")}`;
    m.id = ref;
    messageRefs.set(ref, i);
  });

  // ── Step 3: Dedup tool calls ──────────────────────────
  if (config.dedupEnabled) {
    const result = runDedup(working, state, config);
    working = result.messages;
    stats.dedupRemoved = result.removedCount;
  }

  // ── Step 4: Purge errors ─────────────────────────────
  if (config.purgeErrorsEnabled) {
    const result = runPurgeErrors(working, state, config);
    working = result.messages;
    stats.errorPurged = result.purgedCount;
  }

  // ── Step 5: Compress ─────────────────────────────────
  const totalTokens = estimateTotalTokens(working);
  if (config.compressEnabled && totalTokens > config.compressMaxTokens) {
    const result = runCompression(working, state, config);
    working = result.messages;
    stats.compressedTokens = result.compressedTokens;
    stats.summaryTokens = result.summaryTokens;
  }

  // ── Step 6: Build nudges ─────────────────────────────
  const nudges = buildNudges(totalTokens, config);

  // ── Step 7: Inject message IDs ───────────────────────
  // (message IDs already assigned in step 2)

  // ── Step 8: Strip stale metadata ─────────────────────
  for (const msg of working) {
    if (msg.metadata) {
      // Remove cross-provider metadata fields
      delete msg.metadata._provider;
      delete msg.metadata._raw;
    }
  }

  return { messages: working, nudges, stats };
}
```

### 5.9 去重策略

```typescript
// dedup.ts

import type { MessageRef, ContextPruningConfig } from "./types";
import type { ContextPruningState } from "./state";

interface DedupResult {
  messages: MessageRef[];
  removedCount: number;
}

/**
 * Remove duplicate tool calls based on tool name + normalized parameters.
 *
 * Strategy:
 * - Group tool calls by toolName + normalizedParameters
 * - Keep the latest occurrence, remove older duplicates
 * - Protected tools (config.dedupProtectedTools) are never deduped
 * - Tool calls from different protected turns are not deduped
 */
export function runDedup(
  messages: MessageRef[],
  state: ContextPruningState,
  config: ContextPruningConfig,
): DedupResult {
  const removed = new Set<string>();
  const protectedSet = new Set(config.dedupProtectedTools);

  // Track the latest occurrence of each signature
  const latestBySignature = new Map<string, { messageIndex: number; toolIndex: number }>();

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (!msg.toolCalls || msg.toolCalls.length === 0) continue;

    for (let ti = 0; ti < msg.toolCalls.length; ti++) {
      const tc = msg.toolCalls[ti];
      if (protectedSet.has(tc.toolName)) continue;

      const signature = `${tc.toolName}::${JSON.stringify(normalizeParams(tc.parameters))}`;
      const existing = latestBySignature.get(signature);

      if (existing) {
        // This is a duplicate — mark for removal
        removed.add(tc.id);
      } else {
        // First occurrence from the end — keep it
        latestBySignature.set(signature, { messageIndex: mi, toolIndex: ti });
      }
    }
  }

  if (removed.size === 0) {
    return { messages, removedCount: 0 };
  }

  // Filter out duplicate tool calls from messages
  const filtered: MessageRef[] = [];
  let removedCount = 0;

  for (const msg of messages) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) {
      filtered.push(msg);
      continue;
    }

    const filteredCalls = msg.toolCalls.filter((tc) => {
      if (removed.has(tc.id)) {
        removedCount++;
        return false;
      }
      return true;
    });

    filtered.push({
      ...msg,
      toolCalls: filteredCalls,
    });
  }

  return { messages: filtered, removedCount };
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    // Skip volatile fields that would prevent dedup
    if (key === "timestamp" || key === "ts" || key === "date") continue;
    sorted[key] = params[key];
  }
  return sorted;
}
```

**去重目标示例**：

| 原始调用序列 | 去重后保留 |
|-------------|-----------|
| `grep("foo.ts", "function")` → `grep("foo.ts", "function")` → `grep("foo.ts", "function")` | 仅保留最后一次 |
| `read("src/a.ts")` → `read("src/b.ts")` → `read("src/a.ts")` | 仅保留最后的 `read("src/a.ts")` |
| `bash("npm test")`（失败） → `bash("npm test")`（成功） | 保留成功结果 |
| `task("...")`（protected） → `task("...")` | 不参与去重 |

### 5.10 错误清除策略

```typescript
// purge-errors.ts

import type { MessageRef, ContextPruningConfig } from "./types";
import type { ContextPruningState } from "./state";

interface PurgeResult {
  messages: MessageRef[];
  purgedCount: number;
}

/**
 * Purge error tool call inputs after N turns.
 *
 * Strategy:
 * - Track error tool calls in session state
 * - After `purgeErrorsTurns` additional turns, strip the input
 *   fields from the error tool call, keeping only the error message
 * - Protected tools (config.purgeErrorsProtectedTools) are never purged
 */
export function runPurgeErrors(
  messages: MessageRef[],
  state: ContextPruningState,
  config: ContextPruningConfig,
): PurgeResult {
  const protectedSet = new Set(config.purgeErrorsProtectedTools);
  const sessionState = state.get(sessionId);
  if (!sessionState) return { messages, purgedCount: 0 };

  let purgedCount = 0;

  const updated = messages.map((msg) => {
    if (!msg.toolResults || msg.toolResults.length === 0) return msg;

    const filteredResults = msg.toolResults.map((tr) => {
      if (!tr.isError) return tr;
      if (protectedSet.has(findToolName(tr.toolCallId, messages))) return tr;

      const errorEntry = sessionState.errorTracking.get(tr.toolCallId);
      if (!errorEntry) return tr;

      const turnsSinceError = sessionState.turnCount - errorEntry.turnNumber;
      if (turnsSinceError < config.purgeErrorsTurns) return tr;

      // Strip input, keep error
      purgedCount++;
      return {
        ...tr,
        output: "",  // Clear successful output if any
        // Keep error message
        error: tr.error || errorEntry.errorMessage,
      };
    });

    return { ...msg, toolResults: filteredResults };
  });

  return { messages: updated, purgedCount };
}

function findToolName(toolCallId: string, messages: MessageRef[]): string {
  for (const msg of messages) {
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find((t) => t.id === toolCallId);
      if (tc) return tc.toolName;
    }
  }
  return "";
}
```

### 5.11 压缩引擎（Range + Message 模式）

> **实施路线**：Phase 1-3 实现启发式 Range 模式压缩（无 LLM 调用）；Phase 4 增加 LLM 驱动的 compress 工具注册 + Message 模式压缩。compress 工具通过 `config hook` 注册（与 DCP 相同的模式），使模型可在上下文中主动调用压缩。

```typescript
// compress.ts

import type { MessageRef, CompressionBlock, CompressionSummary, ContextPruningConfig } from "./types";
import type { ContextPruningState } from "./state";
import { estimateTokens, estimateTotalTokens } from "./estimator";

interface CompressionResult {
  messages: MessageRef[];
  compressedTokens: number;
  summaryTokens: number;
}

/**
 * Compress message ranges using the Range mode strategy.
 *
 * Range mode compresses continuous message spans into block summaries.
 * The compression prompt asks the LLM to generate a structured summary
 * covering: goal, progress, decisions, key context, files.
 *
 * Phase 1 (heuristic): identifies "compressible" spans without LLM:
 *   - Completed task() interaction rounds (task + tool results)
 *   - Verified tool outputs (successful bash/read after verification)
 *   - Old turn history beyond the protection window
 *   Creates placeholder blocks as stand-in summaries.
 *
 * Phase 4+ (LLM-driven): registers a `compress` tool that the model
 *   calls to trigger actual compression. The tool handler invokes
 *   the same pipeline but with LLM-generated summaries. Also adds
 *   Message mode — surgical per-message compression independent
 *   of contiguous ranges.
 */
export function runCompression(
  messages: MessageRef[],
  state: ContextPruningState,
  config: ContextPruningConfig,
): CompressionResult {
  const sessionState = state.get(state.sessionId);
  if (!sessionState) return { messages, compressedTokens: 0, summaryTokens: 0 };

  const protectedUntilIndex = Math.max(0, messages.length - config.turnProtection * 3);

  // Identify compressible ranges (old + verified)
  const compressibleRanges = findCompressibleRanges(messages, protectedUntilIndex, config);

  if (compressibleRanges.length === 0) {
    return { messages, compressedTokens: 0, summaryTokens: 0 };
  }

  // Build compression blocks (heuristic summaries for now)
  let totalCompressed = 0;
  let totalSummary = 0;
  const blocks: CompressionBlock[] = [];

  for (const range of compressibleRanges) {
    const rangeMessages = messages.slice(range.start, range.end + 1);
    const originalTokens = estimateTotalTokens(rangeMessages);

    // Create a heuristic summary based on message types
    const summary = buildHeuristicSummary(rangeMessages, range.topic);

    const summaryTokens = estimateTokens(JSON.stringify(summary));

    const block: CompressionBlock = {
      blockId: `b${Date.now()}-${blocks.length}`,
      runId: `r${Date.now()}`,
      active: true,
      compressedTokens: originalTokens,
      summaryTokens,
      mode: "range",
      topic: range.topic,
      startId: messages[range.start].id,
      endId: messages[range.end].id,
      directMessageIds: rangeMessages.map((m) => m.id),
      directToolIds: [],
      effectiveMessageIds: rangeMessages.map((m) => m.id),
      effectiveToolIds: [],
      summary,
    };

    blocks.push(block);
    totalCompressed += originalTokens;
    totalSummary += summaryTokens;
  }

  // Replace compressed ranges with summary messages
  const result = applyCompressionBlocks(messages, compressibleRanges, blocks);

  // Update session state
  for (const block of blocks) {
    sessionState.blocksById.set(block.blockId, block);
    sessionState.activeBlockIds.add(block.blockId);
    for (const mid of block.directMessageIds) {
      const existing = sessionState.byMessageId.get(mid) || [];
      existing.push(block.blockId);
      sessionState.byMessageId.set(mid, existing);
    }
  }
  sessionState.totalCompressedTokens += totalCompressed;

  return {
    messages: result,
    compressedTokens: totalCompressed,
    summaryTokens: totalSummary,
  };
}

interface CompressibleRange {
  start: number;
  end: number;
  topic: string;
}

function findCompressibleRanges(
  messages: MessageRef[],
  protectedUntilIndex: number,
  config: ContextPruningConfig,
): CompressibleRange[] {
  const ranges: CompressibleRange[] = [];
  const protectedTools = new Set(config.protectedTools);

  let i = 0;
  while (i < protectedUntilIndex) {
    const msg = messages[i];

    // Skip protected tool messages
    if (msg.toolCalls?.some((tc) => protectedTools.has(tc.toolName))) {
      i++;
      continue;
    }

    // Look for user+assistant turn pairs that are compressible
    if (msg.role === "user" && i + 1 < messages.length) {
      const nextMsg = messages[i + 1];

      // A user message followed by assistant tool results can be compressed
      // if the tools involved are not protected
      if (nextMsg.role === "assistant" || nextMsg.role === "tool") {
        // Find end of this interaction round
        let end = i + 1;
        while (end + 1 < protectedUntilIndex && messages[end + 1].role !== "user") {
          end++;
        }

        const topic = extractTopic(messages[i].content);
        ranges.push({ start: i, end, topic });
        i = end + 1;
        continue;
      }
    }

    i++;
  }

  return ranges;
}

function extractTopic(userContent: string): string {
  // Simple heuristic: first line or first 80 chars
  const firstLine = userContent.split("\n")[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

function buildHeuristicSummary(
  messages: MessageRef[],
  topic: string,
): CompressionSummary {
  // Initial heuristic: extract key information without LLM
  // Phase 2 will replace this with LLM-generated summaries
  return {
    goal: topic,
    progress: `${messages.length} messages compressed`,
    decisions: "(heuristic — will be replaced by LLM summary)",
    keyContext: "",
    files: [],
  };
}

function applyCompressionBlocks(
  messages: MessageRef[],
  ranges: CompressibleRange[],
  blocks: CompressionBlock[],
): MessageRef[] {
  // Build a set of indices to remove
  const toRemove = new Set<number>();
  for (const range of ranges) {
    for (let i = range.start; i <= range.end; i++) {
      toRemove.add(i);
    }
  }

  // Build replacement summary messages
  const summaryMessages: Array<{ index: number; msg: MessageRef }> = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const range = ranges[bi];
    summaryMessages.push({
      index: range.start,
      msg: {
        id: `block-${block.blockId}`,
        role: "assistant",
        content: `[Compressed: ${block.topic}]\n${JSON.stringify(block.summary, null, 2)}`,
        metadata: { compressed: true, blockId: block.blockId },
      },
    });
  }

  // Rebuild message list
  const result: MessageRef[] = [];
  const summaryByIndex = new Map(summaryMessages.map((s) => [s.index, s.msg]));

  for (let i = 0; i < messages.length; i++) {
    if (summaryByIndex.has(i)) {
      result.push(summaryByIndex.get(i)!);
    } else if (!toRemove.has(i)) {
      result.push(messages[i]);
    }
  }

  return result;
}
```

### 5.12 Nudge 注入

```typescript
// nudge.ts

import type { ContextPruningConfig } from "./types";
import { estimateTokens } from "./estimator";

interface NudgeResult {
  nudges: string[];
}

/**
 * Build context management nudges based on current token totals.
 *
 * Three-tier nudge system:
 * 1. Context limit nudge (above max threshold) — urgent
 * 2. Turn nudge (between min and max, on new user turn) — gentle
 * 3. Iteration nudge (between min and max, many assistant msgs) — drift warning
 */
export function buildNudges(
  totalTokens: number,
  config: ContextPruningConfig,
  turnCount?: number,
  iterationCount?: number,
): string[] {
  const nudges: string[] = [];

  // Tier 1: Context limit (urgent)
  if (totalTokens >= config.urgentThresholdTokens) {
    nudges.push(buildUrgentNudge(totalTokens, config));
  }

  // Tier 2: Turn nudge (between min and max)
  if (
    totalTokens >= config.nudgeThresholdTokens &&
    totalTokens < config.urgentThresholdTokens
  ) {
    nudges.push(buildGentleNudge(totalTokens, config));
  }

  // Tier 3: Iteration nudge (if many iterations)
  if (iterationCount !== undefined && iterationCount > 10) {
    nudges.push(buildIterationNudge(iterationCount));
  }

  return nudges;
}

function buildUrgentNudge(totalTokens: number, config: ContextPruningConfig): string {
  return `[Context Warning] Token usage (${totalTokens.toLocaleString()}) exceeds urgent threshold (${config.urgentThresholdTokens.toLocaleString()}). Consider using the compress tool to reduce context or summarize completed task results.`;
}

function buildGentleNudge(totalTokens: number, config: ContextPruningConfig): string {
  return `[Context Notice] Token usage is at ${totalTokens.toLocaleString()} (threshold: ${config.nudgeThresholdTokens.toLocaleString()}). Compress completed work to keep context manageable.`;
}

function buildIterationNudge(iterationCount: number): string {
  return `[Iteration Notice] ${iterationCount} assistant messages in this session. Consider summarizing completed rounds to maintain focus.`;
}
```

### 5.13 整合到 ZooKeeper

#### 5.13.1 OpenCode 适配器（hook.ts）

```typescript
// hook.ts — OpenCode framework adapter
// Import core types and logic from src/context-pruning/

import type { ContextPruningConfig, PipelineInput, PipelineOutput } from "../context-pruning/types";
import { runPipeline } from "../context-pruning/pipeline";
import { globalState } from "../context-pruning/state";

/**
 * OpenCode handler for experimental.chat.messages.transform.
 *
 * This is the primary hook that runs the context pruning pipeline
 * before each LLM turn.
 */
export async function handleMessagesTransform(
  config: ContextPruningConfig,
  sessionId: string,
  messages: any[], // OpenCode message format — will be mapped to MessageRef
  output: { messages?: any[] },
): Promise<void> {
  if (!config.enabled) return;
  if (!messages || messages.length === 0) return;

  // Map OpenCode messages to framework-agnostic MessageRef[]
  const pipelineInput: PipelineInput = {
    sessionId,
    messages: mapToMessageRefs(messages),
    config,
  };

  // Run pipeline
  const pipelineOutput: PipelineOutput = runPipeline(pipelineInput);

  // Map back to OpenCode message format
  output.messages = mapFromMessageRefs(pipelineOutput.messages);
}

/**
 * OpenCode handler for tool.execute.before (tool call tracking).
 */
export function handleToolBefore(
  config: ContextPruningConfig,
  sessionId: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  callId: string,
): void {
  if (!config.enabled) return;
  if (!config.dedupEnabled) return;
  if (!args) return;

  globalState.trackToolCall(sessionId, tool, args, callId);
}

/**
 * OpenCode handler for tool.execute.after (error tracking).
 */
export function handleToolAfter(
  config: ContextPruningConfig,
  sessionId: string,
  tool: string,
  callId: string,
  result: { isError?: boolean; error?: string } | undefined,
): void {
  if (!config.enabled) return;
  if (!config.purgeErrorsEnabled) return;
  if (!result?.isError) return;

  globalState.trackError(sessionId, callId, tool, result.error || "Unknown error");
}

/**
 * OpenCode handler for event (session.deleted cleanup).
 */
export function handleSessionEvent(sessionId: string, eventType: string): void {
  if (eventType === "session.deleted") {
    globalState.delete(sessionId);
  }
}

function mapToMessageRefs(openCodeMessages: any[]): MessageRef[] {
  // Map from OpenCode's message format to our MessageRef format
  return openCodeMessages.map((m, i) => ({
    id: m.id || `m${String(i).padStart(4, "0")}`,
    role: m.role || "user",
    content: m.content || "",
    toolCalls: m.toolCalls?.map((tc: any, ti: number) => ({
      id: tc.id || `t${String(ti).padStart(4, "0")}`,
      toolName: tc.tool || tc.name || "",
      parameters: tc.args || tc.parameters || {},
    })),
    toolResults: m.toolResults?.map((tr: any) => ({
      id: tr.id || "",
      toolCallId: tr.toolCallId || "",
      output: tr.output || tr.content || "",
      isError: tr.isError || false,
      error: tr.error,
    })),
  }));
}

function mapFromMessageRefs(messageRefs: MessageRef[]): any[] {
  // Map back to OpenCode message format
  return messageRefs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.toolResults ? { toolResults: m.toolResults } : {}),
  }));
}
```

#### 5.13.2 在 src/index.ts 中的注册

在 `src/index.ts` 中添加以下集成点：

```typescript
// src/index.ts — 新增导入
import { loadContextConfig } from "./context-pruning";           // 框架无关核心
import {
  handleMessagesTransform,
  handleToolBefore,
  handleToolAfter,
  handleSessionEvent,
} from "./hooks/context-pruning/hook";                           // OpenCode 适配器
import {
  handleMessagesTransform,
  handleToolBefore,
  handleToolAfter,
  handleSessionEvent,
} from "./hooks/context-pruning/hook";

export async function zookeeper(input: any) {
  const zooConfig = (config as any).zoo ?? {};
  const contextConfig = loadContextConfig(zooConfig);
  // ... existing code ...

  return {
    // existing hooks...

    // 新增：context pruning in messages.transform
    async "experimental.chat.messages.transform"(
      _input: Record<string, never>,
      output: { messages?: any[] },
    ) {
      try {
        await injectFocusReminder(client, output);

        // Context pruning pipeline (runs after focus reminder)
        if (contextConfig.enabled && output.messages?.length) {
          const sessionId = output.messages[0]?.info?.sessionID || "";
          if (sessionId) {
            await handleMessagesTransform(contextConfig, sessionId, output.messages, output);
          }
        }
      } catch {
        // Swallow errors so pruning failure never disrupts LLM turn
      }
    },

    // 修改：tool.execute.before — 加入工具调用追踪
    async "tool.execute.before"(input, output) {
      validateBeforeExec(input, output, limits);

      if (contextConfig.enabled) {
        handleToolBefore(
          contextConfig,
          input.sessionID,
          input.tool,
          input.args,
          input.callID,
        );
      }
    },

    // 修改：tool.execute.after — 加入错误追踪
    async "tool.execute.after"(input, output) {
      const handlers = [
        (i, o) => nudgeTaskOutput(i, o, limits),
        recoverJsonError,
        (i, o) => nudgeDirectWork(client, i, o),
        (i, o) => nudgePostTask(client, i, o),
      ] as const;

      for (const handler of handlers) {
        try {
          await handler(input, output);
        } catch {
          // Swallow per-handler errors
        }
      }

      // Context pruning: track errors for purge strategy
      if (contextConfig.enabled) {
        handleToolAfter(
          contextConfig,
          input.sessionID,
          input.tool,
          input.callID,
          { isError: false, error: undefined }, // Simplified — needs actual result
        );
      }
    },

    // 新增：event hook for session cleanup
    async event(event: any) {
      if (contextConfig.enabled) {
        handleSessionEvent(event.sessionID, event.type);
      }
    },
  };
}
```

### 5.14 Scope 决策

| 功能 | 包含/推迟 | 理由 |
|------|----------|------|
| **Range 模式压缩** | ✅ Phase 3 | 核心功能，提供启发式摘要 |
| **去重** | ✅ Phase 2 | 低成本高收益，默认启用 |
| **错误清除** | ✅ Phase 2 | 清理失败调用，减少噪声 |
| **Nudge 系统** | ✅ Phase 1 | 轻量，与现有 focus reminder 互补 |
| **状态管理** | ✅ Phase 1 | 基础设施，被所有策略依赖 |
| **消息变换管道** | ✅ Phase 1 | 编排器，串联所有策略 |
| **OpenCode 适配器** | ✅ Phase 4 | 框架绑定，最后实现 |
| **LLM 驱动压缩（compress 工具）** | ✅ Phase 4 | 核心 DCP 创新，模型调用 compress 工具驱动压缩 |
| **Message 模式压缩** | ✅ Phase 4 | 精准单消息压缩，与 Range 模式互补 |
| **命令系统（/context、/stats、/sweep）** | ✅ Phase 5 | 用户手动干预上下文的手柄 |
| **跨会话状态持久化** | ✅ Phase 5 | 磁盘存储，支持会话间恢复 |
| 用户可覆盖提示词 | ❌ 推迟 | 增加复杂度，非必需 |
| Toast 通知 | ❌ 推迟 | UI 层，框架相关 |
| SubAgent 结果注入 | ❌ 推迟 | DCP 特有，非通用需求 |
| 自动更新 | ❌ 推迟 | 插件自动升级机制，非核心 |

### 5.15 命令系统

为提供手动上下文管理的交互入口，在 Phase 5 引入以下命令（通过 `experimental.chat.messages.transform` 的文本模式匹配检测，或注册 `command.execute.before` hook）：

| 命令 | 用途 | 实现方式 |
|------|------|---------|
| `/context` | 查看当前上下文 token 使用统计（总量、压缩率、各策略贡献） | 在 assistant 回复末尾追加格式化统计信息 |
| `/stats` | 查看去重/错误清除/压缩的累计效果明细 | 从 `SessionState` 中读取 `totalPrunedTokens`、`totalCompressedTokens` 等指标 |
| `/sweep` | 手动触发一次完整的去重 + 错误清除 + 压缩管道 | 调用 `runPipeline()` 并强制忽略阈值检查 |
| `decompress` | 恢复指定 blockId 的原始消息（取消压缩） | 从 `SessionState.blocksById` 中查找 block，替换回原始消息范围 |
| `recompress` | 用新的策略重新压缩指定范围 | 移除旧 block，在新范围内重新执行压缩逻辑 |

**命令注册**：OpenCode 插件通过 `command.execute.before` hook 注册自定义命令。命令匹配以文本前缀 `/` 为标记，解析后触发对应 handler。

**UI 模式**：命令响应结果以系统消息（system-style assistant message）追加到会话中，不修改用户消息或上游上下文位置。

### 5.16 持久化

跨会话状态持久化使上下文剪枝状态在会话重启、编辑器重启后保持连续。实现策略镜像 DCP 的模式：

**存储路径**：
```
~/.local/share/opencode/storage/plugin/zookeeper/{sessionId}.json
```

**持久化内容**（`SessionState` 的子集，序列化为 JSON）：
```typescript
interface PersistedState {
  sessionId: string;
  blocksById: Record<string, CompressionBlock>;
  byMessageId: Record<string, string[]>;
  activeBlockIds: string[];
  dedupCache: Record<string, DedupEntry>;
  errorTracking: Record<string, ErrorEntry>;
  turnCount: number;
  totalPrunedTokens: number;
  totalCompressedTokens: number;
  lastAccessedAt: number;
}
```

**存储策略**：
- **写入时机**：每次 `messages.transform` 管道执行完毕后异步写入（debounce 1s）
- **读取时机**：首次访问会话时（`getOrCreate` 检查磁盘）
- **清理时机**：会话 TTL 到期时同步删除磁盘文件
- **写入延迟**：使用 `setTimeout` 延后写入，避免阻塞管道主流程
- **错误处理**：写入失败静默忽略（降级为 in-memory-only，不影响核心功能）

**启用控制**：通过 `config.toml` 的 `[zoo.context]` 段落中的 `persist_state` 开关控制（默认开启）。

---

## 6. 与 DCP 的架构对比

### 6.1 差异总览

| 维度 | DCP (`@tarquinen/opencode-dcp`) | ZooKeeper 内建方案 |
|------|-------------------------------|-------------------|
| **框架绑定** | 强（仅 OpenCode） | 弱（核心框架无关） |
| **依赖** | OpenCode SDK, 文件系统存储 | 无外部依赖 |
| **Token 计数** | 未开源具体实现 | API 上报（主力）+ 启发式（补充），误差 < 5% |
| **压缩模式** | Range + Message（双模） | Range（初始启发式）→ Phase 4 双模（LLM 驱动） |
| **LLM 驱动压缩** | ✅ 完整 | ✅ Phase 4（compress 工具注册） |
| **去重** | ✅ 基于签名 | ✅ 基于签名 |
| **错误清除** | ✅ 4 轮后 | ✅ 可配置轮数 |
| **Nudge 系统** | 3 级阈值 | 3 级阈值 |
| **状态持久化** | 磁盘 JSON 文件 | ✅ Phase 5（磁盘 JSON，同 DCP 存储路径模式） |
| **Block 嵌套** | 支持 | 不支持（初始） |
| **配置层级** | 3 层级联 + JSONC | 单层 config.toml |
| **消息引用** | mNNNN 格式 | mNNNN 格式 |
| **命令系统** | `/dcp` 全套命令 | ✅ Phase 5（/context、/stats、/sweep、decompress、recompress） |
| **代码规模** | ~3000+ 行（估算） | ~800 行（初始，不含测试）→ 扩展至 ~1500 行 |
| **状态模型复杂度** | 高（8 种块间关系） | 中（扁平块，无嵌套） |
| **Turn 保护** | 可配置 | 可配置 |

### 6.2 为什么不在 ZooKeeper 中直接依赖 DCP

**1. 框架绑定问题**

DCP 是一个 OpenCode 插件，紧密耦合到 OpenCode 的 hook API 和消息格式。ZooKeeper 有明确的 TODO 要支持 pi / oh-my-pi（框架适配器机制），届时需要一套框架无关的上下文管理逻辑。

```
ZooKeeper 的长期架构:
  ┌─────────────────────┐
  │   OpenCode Plugin   │ ← 当前实现
  │   (TypeScript)      │
  └────────┬────────────┘
           │ 框架相关
  ┌────────▼────────────┐
  │ ZooKeeper Core      │ ← 共享核心（含上下文剪枝）
  │ (框架无关)           │
  └────────┬────────────┘
           │ 框架相关
  ┌────────▼────────────┐
  │   pi / oh-my-pi     │ ← TODO（framework adapter）
  │   Adapter           │
  └─────────────────────┘
```

DCP 无法被 pi / oh-my-pi 复用，因为它完全构建在 OpenCode SDK 之上。

**2. 复杂度与收益权衡**

DCP 在状态模型、块嵌套、跨会话持久化等方面的设计复杂度远超 ZooKeeper 的需求。作为一个编排器插件，ZooKeeper 的上下文剪枝需求是**补充性**的——辅助 OpenCode 内置 compaction，而非完全替代。

**3. 配置单一事实来源**

ZooKeeper 的所有配置来自 `config.toml`（单一事实来源）。引入 DCP 意味着增加 `dcp.jsonc` 配置文件，破坏现有的配置管理模型。

**4. 依赖管理**

引入 DCP 作为 npm 依赖会：
- 增加 `node_modules` 体积
- 引入版本兼容风险（DCP 可能随 OpenCode SDK 版本变化）
- 需要额外的维护工作跟进 DCP 更新

**结论**：不直接依赖 DCP，而是借鉴其设计（双模压缩、去重、错误清除、nudge 系统）实现 ZooKeeper 内建的轻量级上下文剪枝方案。

---

## 7. 实施计划

### 7.1 Phase 1：基础设施（Week 1-2）

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/context-pruning/types.ts` | 新建 | ~120 |
| `src/context-pruning/estimator.ts` | 新建 | ~60 |
| `src/context-pruning/state.ts` | 新建 | ~140 |
| `src/context-pruning/nudge.ts` | 新建 | ~80 |
| `src/context-pruning/pipeline.ts` | 新建 | ~130 |
| `src/context-pruning/index.ts` | 新建 | ~10 |
| `config.toml` | 新增 `[zoo.context]` | ~30 |
| `src/context-pruning/index.test.ts` | 新建 | ~100 |
| **总计** | | **~670** |

**里程碑**：
- [x] 类型定义完成，框架无关
- [x] Token 估算器实现并测试
- [x] 会话状态管理（in-memory + TTL 清理）
- [x] Nudge 消息生成（3 级）
- [x] 空管道（pass-through）可用
- [x] `[zoo.context]` 配置段定义
- [x] 核心单元测试覆盖

### 7.2 Phase 2：自动策略（Week 3-4）

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/context-pruning/dedup.ts` | 新建 | ~100 |
| `src/context-pruning/purge-errors.ts` | 新建 | ~90 |
| `src/context-pruning/pipeline.ts` | 修改 | ~30 |
| `src/context-pruning/index.test.ts` | 扩充 | ~200 |
| **总计** | | **~420** |

**里程碑**：
- [x] 去重策略实现并测试
- [x] 错误清除策略实现并测试
- [x] 管道集成去重 + 错误清除
- [x] 边界情况测试（protected tools、turn 保护、空输入）

### 7.3 Phase 3：压缩引擎（启发式，Week 5-6）

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/context-pruning/compress.ts` | 新建 | ~200 |
| `src/context-pruning/pipeline.ts` | 修改 | ~20 |
| `src/context-pruning/index.test.ts` | 扩充 | ~300 |
| **总计** | | **~520** |

**里程碑**：
- [x] Range 模式压缩（启发式摘要，无 LLM 调用）
- [x] 可压缩范围识别（完成的任务轮次、已验证输出、旧历史）
- [x] Compression block 状态管理
- [x] 压缩后的消息重建与占位符注入
- [x] 压缩阈值触发逻辑

### 7.4 Phase 4：LLM 驱动压缩 + Message 模式（Week 7-8）

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/context-pruning/compress.ts` | 扩展 | ~150 |
| `src/context-pruning/compress-message.ts` | 新建 | ~120 |
| `src/context-pruning/pipeline.ts` | 修改 | ~30 |
| `src/hooks/context-pruning/hook.ts` | 新建（适配器） | ~180 |
| `src/hooks/context-pruning/index.ts` | 新建（桶导出） | ~20 |
| `src/index.ts` | 修改 | ~50 |
| `src/context-pruning/index.test.ts` | 扩充 | ~150 |
| `src/hooks/context-pruning/index.test.ts` | 新建（集成测试） | ~200 |
| **总计** | | **~900** |

**里程碑**：
- [x] `compress` 工具通过 `config` hook 注册（LLM 可调用）
- [x] LLM 驱动摘要生成（替代 Phase 3 的启发式占位符）
- [x] Message 模式压缩（单消息粒度，不依赖连续范围）
- [x] 双模切换：`compress_mode = "range" | "message"`
- [x] OpenCode 适配器（messages.transform）
- [x] 工具调用追踪（tool.execute.before）与错误追踪（tool.execute.after）
- [x] Session 清理（event hook）
- [x] 集成测试（与现有 handler 链共存）
- [x] 验证：现有功能不受影响

### 7.5 Phase 5：命令系统 + 持久化（Week 9-10）

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/context-pruning/commands.ts` | 新建 | ~150 |
| `src/context-pruning/persist.ts` | 新建 | ~120 |
| `src/context-pruning/state.ts` | 修改（添加 persist hooks） | ~40 |
| `src/hooks/context-pruning/hook.ts` | 修改（命令注册） | ~50 |
| `src/index.ts` | 修改 | ~20 |
| `src/context-pruning/index.test.ts` | 扩充 | ~200 |
| `src/hooks/context-pruning/index.test.ts` | 扩充 | ~100 |
| **总计** | | **~680** |

**里程碑**：
- [x] 命令系统：`/context`、`/stats`、`/sweep`、`decompress`、`recompress`
- [x] 命令通过 `command.execute.before` 注册
- [x] 跨会话状态持久化（磁盘 JSON，镜像 DCP 路径模式）
- [x] 异步写入（debounce 1s），读取时自动恢复
- [x] 会话 TTL 到期同步清理磁盘文件
- [x] 写入失败静默降级

### 7.6 Phase 6：测试与调优（Week 11-12）

| 活动 | 内容 |
|------|------|
| 性能测试 | 100+ 消息会话下的管道延迟，含 compress 工具调用 |
| 阈值调优 | 根据实际 token 消耗校准 nudge/urgent threshold |
| Dry-run 测试 | 使用 `tests/runner.py --dry-run` 验证剪枝效果 |
| LLM 行为观察 | 编排器收到 nudge 后是否主动调用 compress 工具 |
| 持久化测试 | 会话重启后状态恢复正确性 |
| 命令测试 | 各命令在边界情况下的行为验证 |
| 文档更新 | 补充使用指南和配置说明 |

**里程碑**：
- [x] 管道 P50 延迟 < 5ms（1000 条消息，启发式模式）
- [x] 管道 P50 延迟 < 50ms（LLM 驱动模式，含工具调用）
- [x] 去重 + 错误清除 + 压缩组合测试覆盖全部边界
- [x] LLM 压缩调用触发准确率 ≥ 80%（nudge 后 3 轮内）
- [x] 持久化读写验证通过
- [x] Dry-run 测试无回归
- [x] 文档就绪

### 7.7 验证方法

```bash
# 1. 单元测试
./test.sh  # 包含新的 context-pruning 测试

# 2. Lint + format
./check.sh

# 3. Dry-run（不调 LLM）
python3 tests/runner.py --dry-run

# 4. 端到端（需要真实 LLM）
# 观察编排器行为：
#   - 上下文不再无限膨胀
#   - 重复工具调用被压缩
#   - 错误工具在 N 轮后自动清除
#   - Nudge 消息在阈值附近出现

# 5. 日志验证
ZOOKEEPER_DEBUG=1 opencode  # 查看 context pruning 触发记录
```

---

## 8. 已知风险与缓解措施

### 8.1 Token 计数精度

**风险**：对最后一次 assistant 消息之后新增的消息使用 `text.length / 4` 启发式，可能在中文（每字 ~2-3 token）或混合内容中产生偏差。

**缓解**：
- 启发式仅用于最近几条新增消息（通常 < 2K tokens），整体误差 < 5%
- 95%+ 的上下文 token 来自 API 精确数据（最后一条 assistant 的累计值）
- 阈值留有余量（如 70K/140K，非精确边界值）
- 可选的 `estimation_fallback_factor` 配置项（默认 4）允许用户针对内容语言调整启发式因子

### 8.2 压缩误伤有效上下文

**风险**：启发式范围识别可能压缩包含关键信息的消息（如子 Agent 正在使用中的中间结果）。

**缓解**：
- Turn protection 保护最近 N 轮交互
- Protected tools 列表确保 `task`/`skill` 不被压缩
- 仅压缩 `protectedUntilIndex` 之外的消息
- 压缩非破坏性（仅替换为摘要，原始消息可通过 blockId 追溯）

### 8.3 Nudge 对 LLM 行为影响不足

**风险**：LLM 可能忽略 nudge 消息，继续无节制使用上下文。

**缓解**：
- 紧急 nudge（超过 urgentThresholdTokens）使用较强语气
- 与 DCP 设计一致：nudge 是 soft guidance，而非硬约束
- 未来可在 `tool.execute.before` 中增加硬限制（当上下文超过可用窗口时阻断非关键工具调用）

### 8.4 与内置 Compaction 冲突

**风险**：ZooKeeper 进行消息压缩后，OpenCode 内置 compaction 可能基于已压缩的消息再次压缩，产生噪声。

**缓解**：
- 在压缩消息中注入 `metadata.compressed = true` 标记
- 内置 compaction 对已压缩消息的二次压缩效果有限（摘要已经很小）
- 通过 `stripHallucinations` 风格的步骤处理标记冲突

### 8.5 性能开销

**风险**：每轮 messages.transform 都运行管道可能引入延迟。

**缓解**：
- 空管道（strategies 全部关闭）仅做消息过滤和 ref 分配，~O(n)
- 去重和错误清除仅扫描 tool calls，~O(k) where k << n
- 压缩仅在超阈值时触发
- 预估 P50 延迟 < 5ms（1000 条消息场景）

---

## 9. 总结

### 9.1 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 框架无关性 | 核心纯 TS，适配器分离 | 支持 pi / oh-my-pi + 未来框架 |
| Token 计数 | 混合：API 上报（主力）+ `text.length / 4`（新增消息） | 95%+ 精确，零依赖 |
| 状态管理 | In-memory + TTL | 简单可靠，无需文件系统 |
| 压缩模式 | Range（初始，启发式摘要） | 简单，无需 LLM 调用 |
| 去重 | 基于 toolName + 参数签名 | 低成本高收益 |
| 错误清除 | N 轮后保留 error 擦除 input | 减少噪声，保留诊断信息 |
| Nudge 系统 | 3 级（紧急/温和/迭代） | 软引导，不阻断执行 |
| 配置 | config.toml 单一源头 | 与现有模型一致 |

### 9.2 与 DCP 的关系

借鉴但不复制。ZooKeeper 内建方案：
- **保留**：双模压缩思路、去重/错误清除策略、3 级 nudge、消息引用机制
- **简化**：状态模型（无嵌套 block）、配置层级（单层）、摘要生成（启发式而非 LLM）
- **替换**：框架绑定 → 框架无关核心 + 适配器
- **推迟**：提示词覆盖、Toast 通知、SubAgent 结果注入、自动更新

### 9.3 与 OpenCode 内置 Compaction 的关系

ZooKeeper 上下文剪枝是 OpenCode 内置 compaction 的**补充**而非替代：

```
OpenCode 内置 → 平台级，LLM 驱动摘要，全局调度
ZooKeeper 剪枝 → 插件级，启发式策略，编排器专用

互补关系：
  - 去重+错误清除：在 compaction 之前减少无用内容
  - 范围压缩：提供更细粒度的中间层
  - Nudge：引导编排器主动管理上下文
```

### 9.4 未来方向

| 方向 | 阶段 | 条件 |
|------|------|------|
| LLM 驱动摘要 | ✅ Phase 4 | 注册 `compress` 工具 + 观察编排器是否会主动调用 |
| Message 模式压缩 | ✅ Phase 4 | Range 模式稳定后，用户需求驱动 |
| 持久化状态 | ✅ Phase 5 | 磁盘存储，支持会话间恢复 |
| 命令系统 | ✅ Phase 5 | `/context`、`/stats`、`/sweep`、decompress、recompress |
| pi / oh-my-pi 适配器 | 另行规划 | 编号 #TBD，依赖框架无关核心就绪 |
| 自适应 factor | Phase 6+ | 收集实际 token vs 估算偏差数据后 |

---

**相关文档**：
- `docs/task-prompt-validation-evolution.md` — 相近的"软约束先行"设计哲学
- `docs/todo-nudge-research.md` — 类似的 nudge 系统设计和实施计划
- `docs/opencode-plugin-mechanism.md` — OpenCode 插件机制参考
