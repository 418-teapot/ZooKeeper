# OpenCode 插件日志方案调研报告

**版本:** 1.0  
**日期:** 2026-06-11  
**分类:** 技术调研 / 日志方案  

---

## 目录

1. [概述](#1-概述)
2. [问题根因](#2-问题根因)
   - 2.1 [Bun 运行时中 console.debug 的行为](#21-bun-运行时中-consoledebug-的行为)
   - 2.2 [OpenCode 插件加载模型](#22-opencode-插件加载模型)
   - 2.3 [影响范围](#23-影响范围)
3. [ZooKeeper 当前方案](#3-zookeeper-当前方案)
   - 3.1 [设计思路](#31-设计思路)
   - 3.2 [实现细节](#32-实现细节)
   - 3.3 [调用点位统计](#33-调用点位统计)
   - 3.4 [方案评估](#34-方案评估)
4. [参考实现分析](#4-参考实现分析)
   - 4.1 [omo (oh-my-openagent) 三层架构](#41-omo-oh-my-openagent-三层架构)
     - 4.1.1 [第一层：文件日志 `log()`](#411-第一层文件日志-log)
     - 4.1.2 [第二层：NODE_DEBUG 门控计时](#412-第二层node_debug-门控计时)
     - 4.1.3 [第三层：用户面向消息](#413-第三层用户面向消息)
   - 4.2 [slim (oh-my-opencode-slim) 两层架构](#42-slim-oh-my-opencode-slim-两层架构)
     - 4.2.1 [第一层：异步文件日志](#421-第一层异步文件日志)
     - 4.2.2 [第二层：OpenCode 原生 API + stderr 回退](#422-第二层opencode-原生-api--stderr-回退)
5. [三方对比](#5-三方对比)
   - 5.1 [设计维度对比表](#51-设计维度对比表)
   - 5.2 [技术细节对比表](#52-技术细节对比表)
6. [值得借鉴的设计](#6-值得借鉴的设计)
   - 6.1 [来自 omo 的亮点](#61-来自-omo-的亮点)
   - 6.2 [来自 slim 的亮点](#62-来自-slim-的亮点)
   - 6.3 [两者的共同设计原则](#63-两者的共同设计原则)
7. [演进建议](#7-演进建议)
   - 7.1 [短期：补充文件日志](#71-短期补充文件日志)
   - 7.2 [中期：多级日志体系](#72-中期多级日志体系)
   - 7.3 [长期：统一日志框架](#73-长期统一日志框架)
   - 7.4 [不建议采用的方案](#74-不建议采用的方案)

---

## 1. 概述

OpenCode 插件运行在 Bun 运行时环境中，与 OpenCode 主进程共享同一进程空间。插件开发者经常使用 `console.debug()` 输出调试信息，这在 Node.js 等传统运行时中是标准做法——`console.debug` 默认不输出或输出到 stderr，不会干扰主界面。

然而，在 Bun 运行时环境下，`console.debug` 的行为与 Node.js 不同，导致插件调试日志污染 OpenCode TUI（终端用户界面）。这一问题在所有基于 Bun 运行的 OpenCode 插件中都存在。

本文档系统性地分析该问题的根因，详细对比 ZooKeeper、omo（`oh-my-openagent`）和 slim（`oh-my-opencode-slim`）三个项目的日志方案设计，提炼值得借鉴的模式，并为 ZooKeeper 的后续演进提出具体建议。

---

## 2. 问题根因

### 2.1 Bun 运行时中 console.debug 的行为

**核心发现：** Bun 运行时将 `console.debug` 视为 `console.log` 的同义词，两者均写入 stdout。

| 运行时 | `console.debug` 输出目标 | 默认是否可见 |
|--------|------------------------|-------------|
| Node.js | stderr（或按实现不同可被 `NODE_DEBUG` 控制） | 默认静默 |
| Deno | stdout，但带有 `DEBUG` 前缀标记 | 可见 |
| **Bun** | **stdout（与 console.log 完全一致）** | **可见** |

在 Node.js 中，`console.debug` 的行为由 V8 的 Inspector 调试通道控制，默认不会出现在进程的标准输出中。开发者可以放心地在生产代码中使用 `console.debug` 而不用担心污染用户界面。

Bun 为了追求 API 兼容性的简洁实现，将 `console.debug`、`console.log`、`console.info` 全部映射到相同的底层 `write(stdout)` 调用。这意味着任何 `console.*` 输出——无论其语义级别——都会在 TUI 中显示，造成视觉污染。

### 2.2 OpenCode 插件加载模型

OpenCode 支持通过 `opencode.json` 的 `plugin` 数组以文件路径（相对路径、绝对路径或 `file://` URL）直接加载 `.ts` 源文件：

```json
{
  "plugin": [
    "./path/to/plugin/src/index.ts"
  ]
}
```

Bun 运行时原生支持直接加载和执行 TypeScript 源文件，**无需预先编译**（no compile step）。这意味着：

1. 插件源码中的 `console.debug()` 调用保留原样被执行
2. 不存在构建步骤来重写或移除调试日志
3. 插件代码直接运行在 OpenCode 主进程的 stdout/stderr 上

组合上述两个因素，插件中的 `console.debug` 调用在开发和调试阶段产生的输出会直接流向 stdout，进而被 OpenCode TUI 捕获并显示，干扰用户体验。

### 2.3 影响范围

该问题影响所有基于 Bun 运行的 OpenCode 插件——不仅是 ZooKeeper，也包括 omo 和 slim 等参考实现。三者在早期版本中都曾使用 `console.debug` 或 `console.log` 进行调试输出，并因同样的根因而遇到了 TUI 污染问题。

---

## 3. ZooKeeper 当前方案

### 3.1 设计思路

ZooKeeper 采用**最小改动原则**——不引入文件系统依赖，通过环境变量 `ZOOKEEPER_DEBUG` 控制日志输出，并将所有日志写入 stderr 而非 stdout。

关键决策：
- **默认静默**：不设置 `ZOOKEEPER_DEBUG` 时，日志函数体为空操作（no-op），零运行时开销
- **stderr 输出**：使用 `process.stderr.write()` 替代 `console.*`，避免 OpenCode TUI 对 stdout 的捕获
- **无文件持久化**：日志仅输出到终端，不写入磁盘文件

### 3.2 实现细节

日志模块实现在 `src/hooks/shared/logger.ts`：

```typescript
// src/hooks/shared/logger.ts — 核心逻辑（55 行）
function isDebugEnabled(): boolean {
  const val = process.env.ZOOKEEPER_DEBUG;
  if (!val) return false;
  return (
    val === "1" || val.toLowerCase() === "true" || val.toLowerCase() === "yes"
  );
}

export function debug(tag: string, data?: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  const prefix = `[zookeeper:${tag}]`;
  if (data === undefined) {
    process.stderr.write(`${prefix}\n`);
  } else {
    process.stderr.write(`${prefix} ${JSON.stringify(data)}\n`);
  }
}
```

输出格式示例：
```
[zookeeper:focus-reminder] {"agent":"build","sessionId":"abc123"}
[zookeeper:task-prompt-validate] {"valid":false,"errors":1}
[zookeeper:json-error-nudge] {"tool":"webfetch","pattern":"..."}
```

启用方式：
```bash
ZOOKEEPER_DEBUG=1 opencode
# 或
export ZOOKEEPER_DEBUG=1
opencode
```

### 3.3 调用点位统计

当前共有 **8 处调用**，分布在 5 个 hook 文件中：

| 文件 | 标签 | 调用行数 | 触发时机 |
|------|------|---------|---------|
| `src/hooks/focus-reminder/hook.ts` | `focus-reminder` | 1 | 每轮 LLM 注入委派提醒时 |
| `src/hooks/task-prompt/hook.ts` | `task-prompt-validate` | 2 | task() prompt 验证阻塞失败/通过时 |
| `src/hooks/task-prompt/hook.ts` | `task-prompt-nudge` | 1 | task() 输出附加建议时 |
| `src/hooks/json-error-nudge/hook.ts` | `json-error-nudge` | 1 | 检测到 JSON 解析错误时 |
| `src/hooks/direct-work-nudge/hook.ts` | `direct-work-nudge` | 1 | 检测到直接编辑行为时 |
| `src/hooks/post-task-nudge/hook.ts` | `post-task-nudge` | 2 | task() 返回后验证 + todo 提醒时 |

所有原有的 `console.debug` 调用已被全部替换为 `logger.debug()`。

### 3.4 方案评估

| 维度 | 评分 | 说明 |
|------|------|------|
| **TUI 无污染** | ✅ 优秀 | 使用 stderr，Bun 不会将 stderr 内容注入 TUI |
| **默认零开销** | ✅ 优秀 | 不启用时函数直接返回，无字符串拼接或对象构建 |
| **实现复杂度** | ✅ 极简 | 单个文件 55 行，无外部依赖 |
| **调试可用性** | ❌ 不足 | 仅实时输出，无历史记录，不方便事后排查 |
| **持久化能力** | ❌ 不足 | 无文件写入，重启后日志丢失 |
| **结构化程度** | ⚠️ 基础 | JSON.stringify 序列化，但不支持日志级别（info/warn/error） |
| **性能开销** | ✅ 低 | 每次调用写一次 stderr，无缓冲区/批量处理 |

**核心不足**：缺少文件持久化能力，使得调试依赖实时观察终端输出，不利于重现问题和事后分析。

---

## 4. 参考实现分析

### 4.1 omo (oh-my-openagent) 三层架构

omo 采用**三层日志架构**（three tiers），按用途和门控条件分离：

```
┌──────────────────────────────────────────────────┐
│                    三层日志架构                      │
│                                                    │
│  Tier 1: log()             文件日志，始终开启        │
│           └─ os.tmpdir()/oh-my-opencode.log        │
│              缓冲写入，50MB 轮转                    │
│                                                    │
│  Tier 2: util.debuglog()   NODE_DEBUG 门控计时      │
│           └─ NODE_DEBUG=codex-rules                 │
│              noopTimer 零成本模式                    │
│                                                    │
│  Tier 3: console.warn/err  用户面向消息              │
│           └─ 仅用户可见的警告/错误                   │
│              绝不用于内部诊断                        │
└──────────────────────────────────────────────────┘
```

#### 4.1.1 第一层：文件日志 `log()`

**源文件：** `src/shared/logger.ts`

**设计要点：**

| 特性 | 说明 |
|------|------|
| 输出路径 | `os.tmpdir()/oh-my-opencode.log` |
| 启用方式 | 始终开启（always-on） |
| 写入策略 | 同步 `appendFileSync` |
| 缓冲机制 | 500ms 刷新间隔，50 条批量合并 |
| 轮转策略 | 50MB 上限，保留 2 个备份文件（`.1`, `.2`） |
| 调用规模 | ~100 个调用点 |

**实现模式简化示意：**

```typescript
// src/shared/logger.ts（omo 文件日志核心逻辑示意）
const LOG_PATH = path.join(os.tmpdir(), "oh-my-opencode.log");
const MAX_SIZE = 50 * 1024 * 1024; // 50MB
const BATCH_INTERVAL = 500; // 500ms
const BATCH_LIMIT = 50;

let batch: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (batch.length === 0) return;
  const lines = batch.join("\n") + "\n";
  batch = [];
  // 在写入前检查文件大小，超过则轮转
  rotateIfNeeded(LOG_PATH, MAX_SIZE);
  appendFileSync(LOG_PATH, lines, "utf-8");
}

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  batch.push(line);
  if (batch.length >= BATCH_LIMIT) {
    flush();
  } else if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, BATCH_INTERVAL);
  }
}
```

**同步 vs 异步的权衡：** omo 选择 `appendFileSync`（同步写入）而非异步方案。这在插件上下文中是可接受的，因为：
- 日志写入频率较低（~100 个调用点分布在运行全周期）
- 同步写入避免了竞态条件和并发问题
- 插件进程退出时无需等待异步写入完成

**轮转策略：** 50MB 上限配合 2 个备份文件（类似 logrotate 的 `rotateCount=2` 策略）。在 `appendFileSync` 写入之前检查文件大小，超过阈值则执行 `rename` 链式轮转（`xxx.log.1 → xxx.log.2`，`xxx.log → xxx.log.1`）。

#### 4.1.2 第二层：NODE_DEBUG 门控计时

**源文件：** `packages/omo-codex/plugin/components/rules/src/debug-log.ts`

**设计要点：**

- 使用 Node.js 内置的 `util.debuglog` API
- 门控环境变量：`NODE_DEBUG=codex-rules`
- 专门用于 Hook 执行时的性能计时
- 配合 `noopTimer` 模式实现零成本禁用

**`noopTimer` 模式（核心设计亮点）：**

```typescript
// debug-log.ts（omo noopTimer 模式示意）
import { debuglog } from "node:util";

const log = debuglog("codex-rules");

// 当 NODE_DEBUG 未设置时，noopTimer 的 start/end 为空操作
export interface Timer {
  start: () => void;
  end: (label: string) => void;
}

export function createTimer(): Timer {
  if (!log.enabled) {
    // 零成本模式：返回空操作函数
    return { start: () => {}, end: (_label: string) => {} };
  }

  let startTime: number;
  return {
    start: () => { startTime = performance.now(); },
    end: (label: string) => {
      const elapsed = performance.now() - startTime;
      log("[%s] %dms", label, elapsed);
    },
  };
}
```

**设计价值：**
- `util.debuglog` 的 `enabled` 属性可在运行时判断门控是否激活
- 未启用时，`noopTimer` 返回的函数体为空，V8/JSC 可内联消除调用开销
- 区别于环境变量布尔检查，`util.debuglog` 支持命名空间通配符（如 `NODE_DEBUG=codex-*`）

#### 4.1.3 第三层：用户面向消息

omo 严格区分两种输出用途：

| 输出方式 | 用途 | 示例 |
|----------|------|------|
| `console.warn` | 用户可见的警告 | "配置项已废弃，请迁移" |
| `console.error` | 用户可见的错误 | "工具阻断失败，请联系管理员" |
| `log()` / `debuglog()` | 内部诊断 | Hook 触发记录、性能计时、决策路径 |

**核心原则：** `console.warn` 和 `console.error` 仅用于用户应该看到的消息，绝不用于内部调试诊断。所有内部诊断信息都通过 Tier 1（文件日志）和 Tier 2（`util.debuglog`）输出。

### 4.2 slim (oh-my-opencode-slim) 两层架构

slim 采用**异步两层架构**，更注重文件管理的便利性和安全性：

```
┌──────────────────────────────────────────────────┐
│                    两层日志架构                      │
│                                                    │
│  Tier 1: log()             异步文件日志，始终开启    │
│           └─ ~/.local/share/opencode/log/          │
│              per-session 文件，Promise 链串行       │
│              7 天自动清理，循环引用防御              │
│                                                    │
│  Tier 2: client.app.log()  OpenCode 原生 API       │
│           └─ 仅启动阶段关键事件                     │
│              stderr 回退（v1.4.8-1.4.9 死锁风险）   │
└──────────────────────────────────────────────────┘
```

#### 4.2.1 第一层：异步文件日志

**源文件：** `src/utils/logger.ts`

**设计要点：**

| 特性 | 说明 |
|------|------|
| 输出路径 | `~/.local/share/opencode/log/oh-my-opencode-slim.{sessionId}.log` |
| 启用方式 | 始终开启（`initLogger()` 后激活） |
| 写入策略 | **异步 Promise 链串行**（lock-free ordered writes） |
| 文件管理 | **per-session** 文件，7 天保留期自动清理 |
| 序列化防御 | `JSON.stringify` 失败时回退为 `'[unserializable]'` |

**Promise 链串行（核心设计亮点）：**

```typescript
// src/utils/logger.ts（slim Promise 链串行模式示意）
let writeChain: Promise<void> = Promise.resolve();

function scheduleWrite(line: string): void {
  writeChain = writeChain.then(() => {
    return appendFile(logPath, line + "\n", "utf-8");
  });
}
```

这种模式相比同步写入的优势：
- **无锁**：不涉及 mutex 或读写锁（lock-free）
- **顺序保证**：Promise 链天然保证写入顺序与调用顺序一致
- **非阻塞**：主线程不会被日志写入阻塞
- **退出安全**：进程退出前可 `await writeChain` 确保所有写入完成

**per-session 文件管理：**

slim 按会话 ID 拆分日志文件，每个子 Agent 会话拥有独立的日志文件：

```
~/.local/share/opencode/log/
├── oh-my-opencode-slim.abc123.log
├── oh-my-opencode-slim.def456.log
└── oh-my-opencode-slim.ghi789.log
```

这使得调试特定会话时无需在大文件中 grep 过滤，直接查看对应会话的日志文件即可。

**7 天保留期清理：** `initLogger()` 启动时扫描日志目录，删除最后修改时间早于 7 天的 `.log` 文件。

**循环引用防御：**

```typescript
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '[unserializable]';
  }
}
```

当 `JSON.stringify` 遇到循环引用（circular reference）或 `BigInt` 等不可序列化值时，不会抛出异常导致日志写入中断，而是回退为标记字符串。

#### 4.2.2 第二层：OpenCode 原生 API + stderr 回退

**源文件：** `src/index.ts`（第 67-83 行）

slim 在启动阶段（`server()` 函数中）使用 `client.app.log()` 输出关键事件：

```typescript
// src/index.ts（slim 启动日志示意）
try {
  client.app.log("[slim] plugin initialized");
  client.app.log(`[slim] session: ${sessionId}`);
} catch {
  process.stderr.write("[slim] failed to log via client.app.log()\n");
}
```

**设计考量：**

| 特性 | 说明 |
|------|------|
| 使用场景 | 仅限插件启动、初始化完成等关键生命周期事件 |
| 优势 | 日志出现在 OpenCode 的"日志"面板中，对用户可见 |
| 死锁风险 | OpenCode v1.4.8–v1.4.9 存在 `client.app.log` 调用阻塞的已知问题 |
| 回退策略 | `try-catch` 捕获异常后回退到 `process.stderr.write` |

**设计意图：** `client.app.log` 是 OpenCode 平台提供的官方日志 API，能在 OpenCode 的日志面板中显示。slim 将其用于**启动阶段的关键状态通知**，让用户能看到插件是否正常加载。但由于已知的死锁风险，slim 将其限制在最少使用，并提供了回退方案。

---

## 5. 三方对比

### 5.1 设计维度对比表

| 维度 | ZooKeeper | omo | slim |
|------|-----------|-----|------|
| **日志层级** | 单层 | 三层（文件 + NODE_DEBUG + 用户） | 两层（文件 + 原生 API） |
| **启用方式** | 环境变量门控（默认关闭） | 始终开启（always-on） | 始终开启（after init） |
| **输出目标** | stderr | 文件（`os.tmpdir()`） | 文件（`~/.local/share/opencode/log/`） |
| **文件持久化** | ❌ 无 | ✅ 有（50MB 轮转） | ✅ 有（per-session，7 天清理） |
| **写入策略** | 直接 stderr write | 同步 `appendFileSync` + 批量 | 异步 Promise 链串行 |
| **缓冲机制** | 无 | 500ms / 50 条批量 | 无（每行直接加入 Promise 链） |
| **文件轮转** | N/A | 50MB 上限，2 备份 | 7 天定期清理 |
| **门控方式** | `ZOOKEEPER_DEBUG` | 无门控（始终记录） | 无门控（始终记录） |
| **调用点数量** | 8 处 | ~100 处 | ~30 处 |
| **代码行数** | 55 行 | ~120 行 | ~150 行 |
| **TUI 污染** | ✅ 无 | ✅ 无 | ✅ 无 |

### 5.2 技术细节对比表

| 技术细节 | ZooKeeper | omo | slim |
|---------|-----------|-----|------|
| **日志输出格式** | `[zookeeper:tag] {JSON}` | `[ISO时间] 消息` | `[ISO时间] 消息 {JSON}` |
| **日志级别支持** | ❌ 无（仅 debug） | ❌ 文件日志无级别（仅 Tier 2 计时） | ⚠️ 文件日志无级别（`appLog` 支持 error/warn/info） |
| **结构化日志** | ✅ JSON 序列化 | ⚠️ 字符串拼接 | ✅ JSON 序列化 |
| **循环引用防御** | ❌ 不适用 | ❌ 无 | ✅ `'[unserializable]'` 回退 |
| **运行时开销（关闭时）** | ✅ 零（函数直接返回） | ⚠️ 始终有批量组装开销 | ⚠️ 始终有 Promise 链开销 |
| **退出安全** | ✅ 天然安全 | ✅ 同步写入；但有丢失最后一批的风险 | ✅ `await writeChain` |
| **性能计时** | ❌ 无 | ✅ `noopTimer` + `util.debuglog` | ❌ 无 |
| **开发者体验** | ⚠️ 需手动设环境变量 | ✅ 直接看 `/tmp` 下的文件 | ✅ 按 session 分文件易于定位 |
| **生产安全性** | ❌ 无法回溯问题 | ✅ 可查看历史日志 | ✅ 可查看历史日志 + 自动清理 |

---

## 6. 值得借鉴的设计

### 6.1 来自 omo 的亮点

**1. `util.debuglog` + `noopTimer` 零成本模式**

```typescript
import { debuglog } from "node:util";
const log = debuglog("codex-rules");

// 未启用时 createTimer() 返回的空操作函数可被引擎内联消除
export function createTimer(): Timer {
  if (!log.enabled) return { start: () => {}, end: () => {} };
  // ... 实际计时逻辑
}
```

这是 Node.js 内置 API 在 Bun 中也兼容的特例（Node.js 兼容层）。`enabled` 属性提供运行时门控判断，`noopTimer` 让计时逻辑在禁用时零开销。ZooKeeper 未来若需要性能计时，可借鉴此模式。

**2. 三层分离原则**

omo 将**内部诊断**（文件日志）、**开发调试**（`NODE_DEBUG`）和**用户通知**（`console.warn`）严格分离，避免不同用途的日志相互干扰。这一分层思路值得在 ZooKeeper 的后续演进中引入。

**3. 文件轮转策略**

50MB 阈值 + 2 个备份的简单轮转策略实现代价低，且能防止日志文件无限增长占用磁盘空间。

### 6.2 来自 slim 的亮点

**1. Promise 链串行（lock-free ordered writes）**

```typescript
let writeChain: Promise<void> = Promise.resolve();

function scheduleWrite(line: string): void {
  writeChain = writeChain.then(() => appendFile(logPath, line + "\n", "utf-8"));
}
```

这是一种优雅的无锁异步写入模式：
- 不涉及 mutex 或锁
- 天然保证写入顺序
- 主线程不被阻塞
- 进程退出前可等待写入完成

**2. Per-session 文件组织**

按会话 ID 拆分日志文件大幅提升调试效率。在多 Agent 编排场景中，单个运行周期可能涉及多个子 Agent 会话，per-session 文件使开发者可以直接定位到目标会话的日志，无需在混合日志中 grep。

**3. 循环引用防御**

```typescript
function safeStringify(obj: unknown): string {
  try { return JSON.stringify(obj); } catch { return '[unserializable]'; }
}
```

简单三行代码，保护日志写入不会被意外的循环引用中断。这是一个值得在所有日志模块中采用的通用防御措施。

**4. 自动清理策略**

7 天保留期的自动清理策略确保日志目录不会无限膨胀，同时保留了足够的回溯窗口。

### 6.3 两者的共同设计原则

1. **Always-on 优于门控**：omo 和 slim 均默认始终记录日志，仅在事后需要时查看文件。门控（如 env var）增加调试摩擦——当问题发生时，发现需要先设置环境变量复现，可能已经错过了关键线索。

2. **文件日志优于 stdout/stderr**：文件日志持久化后方便事后分析，不受终端关闭影响，可配合 `tail -f`、`grep` 等工具灵活使用。

3. **免依赖**：两个项目均未引入外部日志依赖（如 `winston`、`pino`），而是使用 Node.js 内置 API 和手写工具函数。作为插件，保持依赖最小化可以降低冲突风险。

---

## 7. 演进建议

基于上述分析，建议 ZooKeeper 的日志方案按以下阶段演进：

### 7.1 短期：补充文件日志

在保留现有 env-var-gated stderr logger 的同时，增加文件日志作为可选项：

**实施要点：**
1. 在 `logger.ts` 中新增 `initFileLogger(logDir: string)` 函数，用于初始化文件日志
2. 日志文件路径：`~/.local/share/opencode/log/zookeeper.{sessionId}.log`
3. 采用 slim 的 Promise 链串行模式实现异步写入
4. 输出格式扩展为带时间戳和日志级别：`[2026-06-11T10:00:00.000Z] [INFO] [zookeeper:tag] {JSON}`
5. 文件日志默认开启，不依赖 `ZOOKEEPER_DEBUG` 门控
6. 保留现有的 env-var-gated stderr logger 作为实时调试选项

**目标：** 在不大幅改动现有代码的前提下，获得日志持久化能力。

### 7.2 中期：多级日志体系

引入日志级别，构建更完善的日志体系：

| 级别 | 用途 | 输出目标 |
|------|------|---------|
| `ERROR` | 插件异常、Hook 执行失败 | 文件 + stderr（始终输出） |
| `WARN` | 非严重但值得关注的情况 | 文件（始终） + stderr（`ZOOKEEPER_DEBUG` 时） |
| `INFO` | 关键生命周期事件（插件初始化、config 注入等） | 文件（始终） |
| `DEBUG` | 详细调试信息 | 文件（`ZOOKEEPER_DEBUG` 时） |
| `TRACE` | 极详细的流程跟踪 | 文件（`ZOOKEEPER_DEBUG=trace` 时） |

**实施要点：**
1. 将现有 `debug(tag, data)` 扩展为 `log(level, tag, data)` 统一接口
2. 添加循环引用防御（借鉴 slim 的 `safeStringify`）
3. 保留 `debug()` 作为 `log(LogLevel.DEBUG, ...)` 的便捷别名
4. 引入 `noopTimer` 模式（借鉴 omo）用于 Hook 性能分析

### 7.3 长期：统一日志框架

当 ZooKeeper 的功能复杂度进一步提升后，可考虑将日志模块升级为独立的轻量框架：

**可选的增强方向：**

1. **可配置输出通道**：允许用户通过 `config.toml` 的 `[logging]` 部分配置日志行为：
   ```toml
   [logging]
   file = "~/.local/share/opencode/log/zookeeper.log"
   level = "INFO"
   retention_days = 14
   max_size_mb = 100
   ```

2. **每 session 日志**：借鉴 slim 的 per-session 文件，方便在多 Agent 场景中定位问题

3. **自动清理**：借鉴 slim 的 7 天保留期清理策略，防止日志无限增长

4. **结构化的 JSON 日志**：输出 JSON Lines 格式（每行一个 JSON 对象），便于用 `jq` 等工具分析

### 7.4 不建议采用的方案

| 方案 | 不推荐理由 |
|------|-----------|
| 引入 `winston` 或 `pino` 等外部日志库 | 增加依赖体积，与 Bun 运行时的兼容性不确定；插件应保持最小依赖 |
| 使用 `client.app.log()` 作为主要日志通道 | OpenCode v1.4.8–v1.4.9 存在已知死锁风险，且日志输出受平台控制 |
| 继续仅依赖 stderr 输出 | 无法持久化，不利于事后分析，不符合 "always-on" 调试原则 |
| 完全切换到同步文件写入 | 可能阻塞主线程，影响 LLM 请求的响应速度 |

**推荐路径总结：**

```
当前状态                   短期目标                    中期目标
┌────────────┐           ┌──────────────────┐       ┌────────────────────┐
│ env-var    │ ────────→ │ env-var stderr    │ ────→ │ 多级日志体系        │
│ stderr     │   keep    │ + always-on 文件  │       │ 文件 + stderr      │
│ (55行)     │           │ (Promise 链串行)  │       │ 级别过滤           │
└────────────┘           └──────────────────┘       │ 循环引用防御       │
                                                    │ noopTimer 计时     │
                                                    └────────────────────┘
```

每个阶段向下兼容，不需要重写现有代码——在现有 `debug()` 函数之上逐渐增加能力。