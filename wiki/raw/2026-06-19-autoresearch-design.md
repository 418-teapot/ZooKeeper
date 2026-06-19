# Autoresearch 设计文档

> 版本: 2.0 · 最后更新: 2026-06-17
> 源代码: `oh-my-pi/packages/coding-agent/src/autoresearch/` (~4131 行 TypeScript + 4 个 prompt markdown 文件)

---

## 目录

- [1. 概述与灵感来源](#1-概述与灵感来源)
- [2. 行业调研与相关工作](#2-行业调研与相关工作)
- [3. Agent vs Skill vs Plugin Extension — 设计讨论](#3-agent-vs-skill-vs-plugin-extension--设计讨论)
- [4. 架构概览](#4-架构概览)
- [5. 核心循环流程](#5-核心循环流程)
- [6. 类型系统](#6-类型系统)
- [7. 状态管理](#7-状态管理)
- [8. 存储层 (Storage)](#8-存储层-storage)
- [9. Git 分支策略](#9-git-分支策略)
- [10. METRIC / ASI 协议](#10-metric--asi-协议)
- [11. 工具规范](#11-工具规范)
- [12. 插件 Hook 集成](#12-插件-hook-集成)
- [13. Dashboard 功能](#13-dashboard-功能)
- [14. Prompt 工程](#14-prompt-工程)
- [15. 关键设计决策](#15-关键设计决策)
- [16. 测试策略](#16-测试策略)
- [17. 配置参数](#17-配置参数)
- [18. 已知局限与关注点](#18-已知局限与关注点)
- [19. ZooKeeper 实现路线](#19-zookeeper-实现路线)

---

## 1. 概述与灵感来源

**Autoresearch** 是 Pi（oh-my-pi，即 OpenCode 的 fork/演进）自带的一个扩展模块，通过 Pi 的 Extension Bridge API 集成，为 LLM agent 提供自主迭代优化的能力。其核心是一个"生成 → 运行 → 测量 → 保留/丢弃"循环 (generate → run → measure → keep/discard)，灵感来自 Andrej Karpathy 的 [autoresearch 项目](https://github.com/karpathy/autoresearch)。

> **重要背景**：omp（oh-my-pi）不是 OpenCode 的插件——它是 Pi 自身的 fork/演进代码，session 管理是 Pi 自己的成熟代码（`session-manager.ts` 3622 行 + `session-storage.ts` 529 行），支持 JSONL 文件 + SQL（PostgreSQL/MySQL/SQLite）+ Redis 多后端，并对外提供 `appendCustomEntry()` / `appendCustomMessageEntry()` 等深度集成的扩展 API。这与 ZooKeeper 仅通过 OpenCode SDK 的 `client.getSession()` / `client.session.todo()` 访问 session 的方式有本质差异（详见 §19.3）。

### 核心思想

| 概念 | 说明 |
|------|------|
| **human changes program.md** | 人类负责定义目标和优化方向（修改 prompt 或 notes） |
| **agent changes train.py** | Agent 负责修改代码、运行 benchmark、测量结果 |
| **"NEVER STOP" 循环** | Agent 持续迭代，直到达到迭代上限或被用户打断 |

### 为什么是 Extension（Pi 扩展桥），而非 Agent 或 Skill

autoresearch 通过 Pi 的 **Extension Bridge API**（`ExtensionAPI.appendEntry`、`ExtensionAPI.sendMessage`、`ExtensionAPI.on` 等）集成到 Pi 的运行时中。这个设计选择是基于以下技术需求：

1. **生命周期绑定**：需要监听 `session_start` / `session_switch` / `session_branch` / `session_tree` / `agent_end` / `before_agent_start` 等 Pi 运行时事件来注入 prompt、自动恢复运行
2. **自定义工具**：注册 `init_experiment` / `run_experiment` / `log_experiment` / `update_notes` 四个 LLM-callable 工具
3. **持久化状态**：跨对话会话使用**独立的 SQLite 文件**（`~/.omp/autoresearch/*.db`），与 Pi 的 session 存储分离，插件负责打开/关闭数据库连接
4. **Session Entry 注入**：通过 `appendCustomEntry("autoresearch-control", ...)` 将模式切换状态写入 Pi 的 session JSONL，实现跨 turn 状态重建
5. **Dashboard UI**：通过 TUI widget + overlay 提供实时可视化
6. **快捷键**：注册 `ctrl+x` / `ctrl+shift+x` 切换 dashboard

---

## 2. 行业调研与相关工作

### 2.1 Karpathy autoresearch — 灵感来源

- GitHub: github.com/karpathy/autoresearch (87.3k ⭐, 2026-03)
- 核心架构: 3 个文件 — `prepare.py`（只读固定代码）、`train.py`（agent 修改）、`program.md`（人类维护的方法论）
- 实验循环: 修改代码 → 运行 5 分钟 → 读 `val_bpb` → keep 或 git reset → 记录到 `results.tsv`
- 700 次迭代后: ~20 项验证改善的变更，Time to GPT-2 从 2.02h 降至 1.80h（11% 提升）
- 关键设计: 固定时间预算（5 min）使实验可比、单一黄金指标（val_bpb）、"NEVER STOP" 自主性指令、简洁性准则（更简单 = 更好）
- Karpathy 原话: "你关心的任何指标，只要能够高效评估，都可以由 agent 群进行自动研究"

### 2.2 Linux OS 内核调优系统

| 项目 | 来源 | 做了什么 | 局限 |
|------|------|---------|------|
| **TuneAgent** | 中科院 arXiv:2508.12551 | LLM + RL 搜索内核参数配置空间，5.6% 性能提升 | 只管 sysctl/Kconfig 参数，不改代码 |
| **BYOS** | 同团队 arXiv:2503.09663, 开源 github.com/LHY-24/BYOS | 知识图谱 + RAG 约束 LLM 生成 kernel config，7-155% 提升 | 同上，参数层面 |
| **KEN (eBPF)** | arXiv:2312.05531 | LLM 生成 eBPF 程序 + 符号执行验证，80% 正确率 | 只生成 eBPF，不做性能分析 |

### 2.3 GPU 计算内核优化 — 最近似的架构参考

| 项目 | 来源 | 架构模式 | 对 ZooKeeper 的启发 |
|------|------|---------|---------------------|
| **KForge** | ISCA 2026, arXiv:2606.02963 | **双 agent**: generation agent ↔ performance-analysis agent 交替迭代 | 🔥 profile 解读 agent 和实现 agent 分离 |
| **Arbor** | arXiv:2606.12563 | Orchestrator + Domain Specialists + **Critic agent**（不可被覆盖的安全门） | 用 Critic 防破坏性改动 |
| **GPU Forecasters** | arXiv:2605.31464, 开源 github.com/codezakh/gpu-forecasters | LLM 当性能代理模型（surrogate），不确定时才跑硬件 | LLM 预测热点而非每次都 perf |
| **Kernel Foundry** | arXiv:2605.30359 | LLM + evolutionary search，最高 100% 正确率 | 集中化经验库用于复用 |
| **NPU Agent Skill** | ISCA 2026, arXiv:2606.07586 | 人类指导 → 记录调优轨迹 → **蒸馏为可复用 skill** → 自治 | agent 化后 skill 化的渐进路径 |

### 2.4 提炼的设计模式

从以上调研中提炼出 6 个通用模式:

1. **知识锚定 (Knowledge Grounding)**: TuneAgent/BYOS 用知识图谱/RL 防止 LLM 幻觉 — 内核配置空间巨大，纯 LLM 不可行
2. **双 agent 制衡 (Checks-and-Balances)**: KForge (generation ↔ analysis) 和 Arbor (Orchestrator ↔ Critic) — 两个 agent 互不信任，互相验证
3. **度量-建议-重调循环 (Profile-Recommend-Retune)**: 几乎所有系统使用 `profile → LLM analysis → suggest → apply → measure → repeat`
4. **LLM 作为代理模型 (Surrogate Model)**: GPU Forecasters 用 LLM 预测性能，不确定时才跑硬件
5. **两阶段训练 (Safety → Performance)**: TuneAgent 先训 format/correctness，再训 performance — 探索可能 crash 内核
6. **技能蒸馏 (Skill Distillation)**: NPU agent 把人类 guided sessions 蒸馏为 skill — 渐进式自治

### 2.5 空白地带

明确指出目前没有的工作:
- 没有 LLM agent 消费 `perf` 输出 → 定位内核热点 → 建议代码级优化
- 没有 ftrace/eBPF + LLM 集成的瓶颈检测
- 现有内核调优 agent 都是参数调优（sysctl/Kconfig），不是代码热点优化
- 没有开源的"agent + profiler"完整 Linux 内核流水线

---

## 3. Agent vs Skill vs Plugin Extension — 设计讨论

### 3.1 判断框架

| 维度 | **Agent**（独立人格） | **Skill**（按需加载的能力） |
|------|----------------------|---------------------------|
| **权限隔离** | ✅ 需要不同的工具访问面 | ❌ 共享 host agent 权限 |
| **模型差异** | ✅ 需要不同 tier 模型 | ❌ 沿用 host 模型 |
| **上下文隔离** | ✅ 专项上下文会污染主对话 | ❌ 共享上下文有益 |
| **并行执行** | ✅ 同时跑多个实例 | ❌ 单一执行流 |
| **角色边界** | ✅ 身份清晰 | ❌ 角色不重要，流程才重要 |
| **迭代模式** | measure → analyze → change 循环 | 单次工作流 |
| **核心载体** | "谁来做" | "怎么做" |

简化判据:
- **Agent**: 换个身份、换个脑子、换个沙箱
- **Skill**: 同一个人，穿上专门的工作服

### 3.2 内核调优的分项评估

| 维度 | 评估 | 倾向 |
|------|------|------|
| 权限 | 和 general 几乎一样（read/write/edit/bash/grep/glob） | Skill |
| 模型 | 热点分析、推理链、寄存器状态判断 — 需要 ZOO_MODEL 强模型 | Agent |
| 上下文 | kernel 调优上下文很重（perf 火焰图、汇编片段、pipeline 分析），会严重污染主对话窗口 | **Agent** ✅ |
| 并行 | 多策略并行很常见（A/B/C 三种调优方案同时测） | **Agent** ✅ |
| 身份 | 有明确身份 — "调优专家"，不应在 general 实现其他功能时干扰 | **Agent** ✅ |
| 迭代 | measure → analyze → change → re-measure 多次循环 | **Agent** ✅ |

结论: Agent 化更合适（4/6 维度成立）。

### 3.3 关键洞察: autoresearch 既不是 agent 也不是 skill

autoresearch 模式的真正价值不在"谁来做"（agent 身份问题），而在**循环机制 + 度量协议 + 状态持久化**:

```
┌─ Plugin Extension (omp autoresearch) ─────────────┐
│  提供: 循环基础设施 + 4 个工具 + SQLite + METRIC/ASI  │
│  不给: 领域知识 + 身份 + 执行能力                     │
└──────────────────────┬──────────────────────────────┘
                       │ 注入工具 + 激活循环
                       ▼
┌─ 某个 Agent（驱动循环）────────────────────────────┐
│  提供: 领域知识 + 身份 + 执行能力（read/write/edit）│
│  使用: plugin 提供的工具进入自主循环               │
└───────────────────────────────────────────────────────┘
```

和纯 agent / skill 方案的本质区别:

| 方案 | 循环能力 | 状态持久化 | 度量协议 |
|------|---------|----------|----------|
| 纯 agent | prompt 自己维持循环（不可靠，容易丢状态） | 无 | 无标准 |
| 纯 skill | 教 agent "怎么做"，每次人工驱动（非自主） | 无 | 无标准 |
| plugin + agent | **plugin 提供循环基础设施**，agent 专注"做什么" | ✅ SQLite | ✅ METRIC 协议 |

### 3.4 最终结论: autoresearch plugin + perf-tuner agent + perf-tuning skill

三层协作:

```
perf-tuning (skill)
├── 方法论: measure first, profile → analyze → change → verify
├── 工具链约定: perf、ftrace、BPF 使用规范
├── 报告模板: 调优成果 → wiki/analysis/
└── 决策树: 何时委派 perf-tuner

perf-tuner (agent)
├── 权限: 和 general 接近, deny task/webfetch/websearch
├── 模型: ZOO_MODEL（推理要求高）
├── prompt: 性能调优专家身份
└── 使用: autoresearch plugin 的工具进入自主循环

autoresearch (plugin extension)
├── 4 个实验工具 (init/run/log/update_notes)
├── SQLite 状态持久化
├── segment + MAD confidence
├── auto-resume + METRIC/ASI 协议
└── dashboard 可视化
```

---

## 4. 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Plugin / Hooks 层                            │
│  (index.ts:536)                                                     │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐  │
│  │ session_*    │ │ agent_end    │ │ before_agent │ │ /autoresearch│  │
│  │ rehydrate()  │ │ auto-resume  │ │ _start       │ │ command     │  │
│  └─────────────┘ └──────────────┘ └──────┬───────┘ └────────────┘  │
│                                          │                          │
│                           injects system prompt                     │
├──────────────────────────────────────────┼──────────────────────────┤
│                         Tools 层          │                          │
│  ┌────────────────┐ ┌──────────────┐ ┌───┴────────┐ ┌────────────┐ │
│  │init_experiment │ │run_experiment│ │log_experiment│ │update_notes│ │
│  │(tools/:272行)  │ │(tools/:407行)│ │(tools/:524行)│ │(tools/:109行)│
│  └───────┬────────┘ └──────┬───────┘ └──────┬──────┘ └──────┬─────┘ │
│          │                 │                │               │        │
│          │         ┌───────┴───────┐        │               │        │
│          │         │ METRIC/ASI    │        │               │        │
│          │         │ 解析 (helpers)│        │               │        │
│          │         └───────┬───────┘        │               │        │
├──────────┼─────────────────┼────────────────┼───────────────┼────────┤
│         State 层           │                │               │        │
│  (state.ts:273)            │                │               │        │
│  ┌───────────────────────────────────────────────────────────┐       │
│  │ createExperimentState / buildExperimentState / compute-   │       │
│  │ Confidence (MAD-based) / Filter functions                 │       │
│  └───────────────────────────────────────────────────────────┘       │
│         │                 │                │               │        │
├─────────┼─────────────────┼────────────────┼───────────────┼────────┤
│        Storage 层          │                │               │        │
│  (storage.ts:699)          │                │               │        │
│  ┌───────────────────────────────────────────────────────────┐       │
│  │  SQLite (bun:sqlite) — sessions + runs 表                  │       │
│  │  WAL 模式 / per-project DB 文件                            │       │
│  │  JSON 序列化数组列                                         │       │
│  └───────────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────────┤
│                       Dashboard (dashboard.ts:436)                  │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────────────────┐    │
│  │ Collapsed  │  │ Expanded │  │ Overlay (全屏 + vim 导航)     │    │
│  │ widget 行  │  │ widget   │  │                              │    │
│  └────────────┘  └──────────┘  └──────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### 四层职责

| 层 | 职责 | 关键文件 |
|------|----------|-----------|
| **Plugin/Hooks** | 生命周期管理、prompt 注入、自动恢复、模式切换 | `index.ts` |
| **Tools** | 4 个 LLM-callable 工具，实现实验循环的各步骤 | `oh-my-pi/.../tools/*.ts` |
| **State** | 内存中的实验状态、MAD 置信度计算、过滤函数 | `state.ts` |
| **Storage** | SQLite 持久化、会话/运行记录的 CRUD | `storage.ts` |
| **Dashboard** (独立 UI 层) | TUI widget + 全屏 overlay 可视化 | `dashboard.ts` |

---

## 5. 核心循环流程

### Phase 1: Harness 设置

```
用户输入优化目标
      │
      ▼
  before_agent_start hook 注入 prompt-setup.md
      │
      ▼
  Agent 执行 Phase 1:
    1. 阅读源代码，理解目标
    2. 编写 ./autoresearch.sh（benchmark 入口）
    3. 编写支持文件（benchmark binaries, fixtures 等）
    4. 通过 bash 工具验证: bash autoresearch.sh
    5. 调用 init_experiment 进入 Phase 2
      │
      ▼
  init_experiment 工具:
    - 自动 commit harness 文件（如已在 autoresearch 分支）
    - 捕获 baseline commit
    - 创建 SQLite session 记录
    - 设置 runtime.autoresearchMode = true
    - 设置 runtime.autoResumeArmed = true
    - 更新 dashboard
```

### Phase 2: 迭代循环

```
Phase 2 激活 — before_agent_start 注入 prompt.md (完整迭代上下文)
      │
      ▼
  ===== 迭代循环 (7 步操作协议) =====
      │
      ├─ 1. 理解目标: 阅读源码，识别瓶颈
      ├─ 2. 更新目标/范围: init_experiment 或 update_notes
      ├─ 3. 建立基线: 首次 run_experiment + log_experiment keep
      ├─ 4. 迭代: 修改代码 → run_experiment → log_experiment
      ├─ 5. 评估指标: keep(改善) / discard(退化) / crash / checks_failed
      ├─ 6. 使用 ASI 记录洞察: hypothesis, rollback_reason 等
      └─ 7. 置信度低时重跑: 直到 conf ≥ 2x noise floor
           │
           ▼
  agent_end hook: 如有 pending run 且无待处理消息
      │
      ▼
  发送 autoresearch-resume 消息 (nextTurn + triggerTurn)
      │
      ▼
  下一次 before_agent_start: 注入带 pending run 上下文的 prompt.md
      │
      ▼
  Agent 继续迭代...
```

### 自动恢复 (Auto-Resume) 流程

```
agent_end 事件触发
      │
      ▼
  检查条件:
    1. autoresearchMode === true
    2. 无 pending 用户消息 (ctx.hasPendingMessages() === false)
    3. 存在 pending run (run.status === null && run.completedAt !== null)
    4. lastAutoResumePendingRunNumber !== pendingRun.runNumber (防重复)
      │
      ▼
  发送 autoresearch-resume 自定义消息:
    - customType: "autoresearch-resume"
    - deliverAs: "nextTurn"
    - triggerTurn: true
    - display: false (不展示给用户)
      │
      ▼
  下一次 before_agent_start:
    注入 pending run 上下文到 prompt.md，agent 继续迭代
```

---

## 6. 类型系统

文件: `types.ts` (168 行)

### 枚举与基础类型

```typescript
// types.ts:6-9
type MetricDirection = "lower" | "higher";
type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";
type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };
```

`ASIValue` 是一个递归类型，支持任意嵌套的结构化元数据——agent 可以自由地存储任何信息而无需预定义 schema。`MetricDirection` 控制 `isBetter()` 函数（`helpers.ts:116-118`）的比较方向。`ExperimentStatus` 覆盖了四种结果：改善、持平/退化、crash、及人工验证失败。

```typescript
// types.ts:11-22
export interface ASIData {
    [key: string]: ASIValue;
}
export interface NumericMetricMap {
    [key: string]: number;
}
export interface MetricDef {
    name: string;
    unit: string;
}
```

`ASIData` 是 ASI 行的结构化容器，允许 agent 存储任意元数据（假设、回滚原因、下一步建议）。`NumericMetricMap` 是 `Record<string, number>` 的具名别名，用于指标字典。`MetricDef` 是最小指标描述符——名称+单位。

### 核心接口：完整字段与 JSDoc

以下列出所有核心接口的完整 TypeScript 定义，包含每个字段的详细说明。

#### ExperimentResult 接口 (`types.ts:24-40`, 16 字段)

```typescript
// types.ts:24-40 — 单次实验记录（已 logged 不可变快照）
interface ExperimentResult {
  runNumber: number | null;       // run id (SQLite PK), null 表示未分配
  commit: string;                 // keep 时的 commit hash (空字符串 = 未 commit)
  metric: number;                 // 主指标值（人工确认或覆盖后的值）
  metrics: NumericMetricMap;      // 完整的指标字典（含主指标 + 次要指标）
  status: ExperimentStatus;       // keep / discard / crash / checks_failed
  description: string;            // agent 提供的简短描述
  timestamp: number;              // logged_at 时间戳 (epoch ms)
  segment: number;                // 所属 segment 编号
  confidence: number | null;      // MAD 置信度（null = 数据不足或无法计算）
  asi?: ASIData;                  // 可选的结构化元数据（假设、回滚原因等）
  modifiedPaths: string[];        // 本次迭代实际修改的文件路径
  scopeDeviations: string[];      // 超出 scope 或触及 off_limits 的路径
  justification: string | null;   // 越界修改的合理性说明（null = 未提供）
  flagged: boolean;               // 是否被后续 run 标记为可疑
  flaggedReason: string | null;   // 标记原因（如 "reward-hacked"）
}
```

#### ExperimentState 接口 (`types.ts:42-61`, 17 字段)

```typescript
// types.ts:42-61 — 当前 segment 的完整实验上下文（由 buildExperimentState 重建）
interface ExperimentState {
  results: ExperimentResult[];     // 所有 segment 的 logged run 列表（含历史 segment）
  bestMetric: number | null;       // 基线指标值 = 当前 segment 第一个 kept 且非 flagged 的 metric
  bestDirection: MetricDirection;  // "lower" | "higher"（优化方向）
  metricName: string;              // 主指标名称（如 "latency_ms"）
  metricUnit: string;              // 主指标单位（如 "ms", "µs", "mb"）
  secondaryMetrics: MetricDef[];   // 已发现的次要指标列表（自动注册 + 手动指定）
  name: string | null;             // session 名称
  goal: string | null;             // 优化目标
  currentSegment: number;          // 当前 segment 编号（0-based）
  maxExperiments: number | null;   // 软迭代上限（null = 无限制）
  confidence: number | null;       // 当前 segment 的 MAD 置信度
  scopePaths: string[];            // 预期修改路径列表
  offLimits: string[];             // 禁止修改路径列表
  constraints: string[];           // 自由格式约束
  notes: string;                   // session 笔记（持久化，可被 agent 通过 update_notes 编辑）
  branch: string | null;           // 当前 git 分支（null = 非 git 仓库）
  baselineCommit: string | null;   // 基线 commit SHA
  sessionId: number | null;        // SQLite session id (PK)
}
```

#### RunDetails 接口 (`types.ts:71-91`, 21 字段)

```typescript
// types.ts:71-91 — run_experiment 返回的详细运行信息（全部 21 个字段）
interface RunDetails {
  runNumber: number;               // 本次运行 id (SQLite PK)
  runDirectory: string;            // 运行产物目录 (projects/…/runs/0001/)
  benchmarkLogPath: string;        // 完整 benchmark log 文件路径
  command: string;                 // 执行的命令（固定为 "bash autoresearch.sh"）
  exitCode: number | null;         // 进程退出码
  durationSeconds: number;         // 运行时长（秒）
  passed: boolean;                 // 是否成功 (exitCode === 0 && !timedOut)
  crashed: boolean;                // 是否崩溃 (exitCode !== 0 || timedOut)
  timedOut: boolean;               // 是否超时被杀死
  tailOutput: string;              // 截断后输出（展示用，DEFAULT_MAX_LINES/BYTES）
  parsedMetrics: NumericMetricMap | null;   // 自动解析的 METRIC 行
  parsedPrimary: number | null;    // 自动解析的主指标值
  parsedAsi: ASIData | null;       // 自动解析的 ASI 行
  metricName: string;              // 主指标名称（来自 session 配置）
  metricUnit: string;              // 主指标单位（来自 session 配置）
  preRunDirtyPaths: string[];      // 运行开始前的 dirty 文件（用于 diff 计算）
  abandonedPriorRun: number | null; // 被本运行覆盖的前序 pending run id
  truncation?: TruncationResult;   // LLM 输出截断信息（仅截断时存在）
  fullOutputPath?: string;         // 完整日志路径（可与 benchmarkLogPath 相同）
}
```

**字段关系说明：** `preRunDirtyPaths` 与 `benchmarkLogPath` 的差值就是本次迭代的修改——`computeRunModifiedPaths()` (`git.ts:302-319`) 通过比较这两个集合精确计算出 agent 的 diff，不受前序 dirty 状态的干扰。

#### LogDetails 接口 (`types.ts:93-100`, 4 字段)

```typescript
// types.ts:93-100 — log_experiment 返回的日志详情
interface LogDetails {
  experiment: ExperimentResult;    // 刚记录的实验快照
  state: ExperimentState;          // 记录后的完整实验状态（含更新后的置信度）
  wallClockSeconds: number | null; // 实际运行时长（秒）
  scopeDeviations: string[];       // 本次记录的越界路径（与 experiment 中一致）
  justification: string | null;    // 越界修改的合理性说明
  flaggedRuns: Array<{ runId: number; reason: string }>; // 本次标记的可疑 run
}
```

#### PendingRunSummary 接口 (`types.ts:102-114`, 11 字段)

```typescript
// types.ts:102-114 — 未 logged 的运行摘要（运行完成后、日志记录前）
interface PendingRunSummary {
  command: string;                 // 执行的命令
  durationSeconds: number | null;  // 运行时长
  parsedAsi: ASIData | null;       // 自动解析的 ASI
  parsedMetrics: NumericMetricMap | null; // 自动解析的指标
  parsedPrimary: number | null;    // 自动解析的主指标
  passed: boolean;                 // 是否成功退出
  preRunDirtyPaths: string[];      // 运行前的 dirty 路径
  runDirectory: string;            // 运行产物目录
  runNumber: number;               // 运行 id
  exitCode: number | null;         // 进程退出码
  timedOut: boolean;               // 是否超时
}
```

#### RunningExperiment 接口 (`types.ts:116-121`, 4 字段)

```typescript
// types.ts:116-121 — 当前正在运行的实验（仅在运行中有效）
interface RunningExperiment {
  startedAt: number;               // 开始时间戳
  command: string;                 // 执行命令
  runDirectory: string;            // 运行产物目录
  runNumber: number;               // 运行 id
}
```

#### AutoresearchRuntime 接口 (`types.ts:123-136`, 12 字段)

```typescript
// types.ts:123-136 — 每个 session 的运行时状态（ephemeral，不持久化）
interface AutoresearchRuntime {
  autoresearchMode: boolean;       // 当前是否处于 autoresearch 模式
  autoResumeArmed: boolean;        // 是否允许自动恢复（由 tool 执行设置）
  dashboardExpanded: boolean;      // Dashboard 是否展开（UI 状态）
  lastAutoResumePendingRunNumber: number | null; // 上次自动恢复的 run number（防重复）
  lastRunDuration: number | null;  // 上次运行时长
  lastRunAsi: ASIData | null;      // 上次运行的 ASI
  lastRunArtifactDir: string | null; // 上次运行的产物目录
  lastRunNumber: number | null;    // 上次运行的 run number
  lastRunSummary: PendingRunSummary | null; // 上次运行的摘要（未 logged 时有效）
  runningExperiment: RunningExperiment | null; // 当前正在运行的实验
  state: ExperimentState;          // 当前实验状态
  goal: string | null;             // 当前优化目标
}
```

#### 控制状态接口 (`types.ts:138-152`)

```typescript
// types.ts:138-141 — 持久化的模式切换记录（存在 session entries 中）
interface AutoresearchControlEntryData {
  mode: "on" | "off" | "clear";    // 模式：开启 / 关闭 / 清除
  goal?: string;                    // 可选的优化目标
}

// types.ts:143-147 — 从 session entries 重建的控制状态
interface ReconstructedControlState {
  autoresearchMode: boolean;       // 最终模式推断结果
  goal: string | null;             // 最新目标
  lastMode: "on" | "off" | "clear" | null; // 最新未处理模式
}

// types.ts:149-152 — 运行时存储接口
interface RuntimeStore {
  clear(sessionKey: string): void;
  ensure(sessionKey: string): AutoresearchRuntime;
}
```

#### DashboardController 接口 (`types.ts:154-159`)

```typescript
// types.ts:154-159 — Dashboard 控制器的公共接口
interface DashboardController {
  clear(ctx: ExtensionContext): void;                           // 清理 dashboard widget
  requestRender(): void;                                        // 请求重新渲染 overlay
  showOverlay(ctx: ExtensionContext, runtime: AutoresearchRuntime): Promise<void>; // 显示全屏 overlay
  updateWidget(ctx: ExtensionContext, runtime: AutoresearchRuntime): void; // 更新 widget
}
```

#### 工具工厂选项 (`types.ts:161-165`)

```typescript
// types.ts:161-165 — 所有工具工厂函数的公共依赖注入参数
interface AutoresearchToolFactoryOptions {
  dashboard: DashboardController;  // Dashboard 控制器，用于 push 更新
  getRuntime(ctx: ExtensionContext): AutoresearchRuntime; // runtime 访问器
  pi: ExtensionAPI;                // 插件 API，用于 appendEntry / setActiveTools
}
```

#### 复用类型别名

```typescript
// types.ts:167-168
type AutoresearchToolResult<TDetails> = AgentToolResult<TDetails>;
type SessionEntries = SessionEntry[];
```

---

## 7. 状态管理

文件: `state.ts` (273 行)

### ExperimentState 构造函数

```typescript
// state.ts:16-37 — 创建默认空状态
export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    goal: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
    scopePaths: [],
    offLimits: [],
    constraints: [],
    notes: "",
    branch: null,
    baselineCommit: null,
    sessionId: null,
  };
}
```

```typescript
// state.ts:39-54 — 创建默认运行时状态
export function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    autoResumeArmed: false,
    dashboardExpanded: false,
    lastAutoResumePendingRunNumber: null,
    lastRunDuration: null,
    lastRunAsi: null,
    lastRunArtifactDir: null,
    lastRunNumber: null,
    lastRunSummary: null,
    runningExperiment: null,
    state: createExperimentState(),
    goal: null,
  };
}
```

### 深拷贝函数

```typescript
// state.ts:56-75
export function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map(cloneResult),
    secondaryMetrics: state.secondaryMetrics.map(metric => ({ ...metric })),
    scopePaths: [...state.scopePaths],
    offLimits: [...state.offLimits],
    constraints: [...state.constraints],
  };
}

function cloneResult(result: ExperimentResult): ExperimentResult {
  return {
    ...result,
    metrics: { ...result.metrics },
    asi: result.asi ? structuredClone(result.asi) : undefined, // structuredClone 递归复制 ASI 树
    modifiedPaths: [...result.modifiedPaths],
    scopeDeviations: [...result.scopeDeviations],
  };
}
```

### MAD-Based 置信度算法（完整实现）

这是系统的核心数学组件。代码位于 `state.ts:134-170`，包含三个函数。

#### sortedMedian — 排序中位数

```typescript
// state.ts:134-142 — 计算排序数组的中位数
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    // 偶数个元素：取中间两个的平均值
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }
  // 奇数个元素：取中间元素
  return sorted[midpoint];
}
```

#### computeMAD（内联实现）

MAD 计算没有单独的函数——它在 `computeConfidence` 中作为中间步骤实现：

```typescript
// 这行内联在 computeConfidence 中（state.ts:153-154）:
const values = current.map(result => result.metric);
const median = sortedMedian(values);
const mad = sortedMedian(values.map(value => Math.abs(value - median)));
```

#### computeConfidence — 置信度计算

```typescript
// state.ts:144-170 — 完整置信度计算
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  // 1. 过滤当前 segment，排除 flagged 和 metric <= 0 的 run
  const current = currentResults(results, segment)
    .filter(result => !result.flagged && result.metric > 0);
  // 2. 样本数 < 3 → 数据不足
  if (current.length < 3) return null;

  // 3. 计算 MAD（Median Absolute Deviation）
  const values = current.map(result => result.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map(value => Math.abs(value - median)));
  // 4. MAD = 0 → 所有值完全相同，无噪声信息
  if (mad === 0) return null;

  // 5. 查找基线指标值
  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // 6. 查找当前 segment 中的最佳 kept 值
  let bestKept: number | null = null;
  for (const result of current) {
    if (result.status !== "keep" || result.metric <= 0) continue;
    if (bestKept === null || isBetter(result.metric, bestKept, direction)) {
      bestKept = result.metric;
    }
  }
  // 7. 无法计算（无改善或无最佳值）
  if (bestKept === null || bestKept === baseline) return null;

  // 8. 最终置信度 = |bestKept - baseline| / MAD
  return Math.abs(bestKept - baseline) / mad;
}
```

**置信度解读:**
- `conf >= 2.0` → likely real（信号显著高于噪声）
- `1.0 <= conf < 2.0` → marginal
- `conf < 1.0` → within noise floor

#### 完整数值示例

假设有以下数据集（segment 0, "lower" is better）：

| run | metric | status | flagged |
|-----|--------|--------|---------|
| 1 | 100.0 | keep | false |
| 2 | 102.0 | keep | false |
| 3 | 98.0 | keep | false |
| 4 | 95.0 | keep | false |
| 5 | 97.0 | keep | false |

**步骤 1:** 过滤 → all 5 runs pass (metric > 0, not flagged)

**步骤 2:** N = 5 ≥ 3 ✓

**步骤 3:** 计算 MAD
- values = [100.0, 102.0, 98.0, 95.0, 97.0]
- sorted = [95.0, 97.0, 98.0, 100.0, 102.0]
- median = 98.0
- absolute deviations = [|95-98|=3, |97-98|=1, |98-98|=0, |100-98|=2, |102-98|=4] = [3, 1, 0, 2, 4]
- sorted deviations = [0, 1, 2, 3, 4]
- MAD = median of deviations = 2.0

**步骤 4:** MAD = 2.0 ≠ 0 ✓

**步骤 5:** baseline = 100.0 (first kept, not flagged)

**步骤 6:** bestKept = 95.0 (lowest kept among the 5)

**步骤 7:** bestKept ≠ baseline ✓

**步骤 8:** Confidence = |95.0 - 100.0| / 2.0 = 5.0 / 2.0 = **2.5x**

→ 置信度 2.5x，归类为 "likely real"（信号显著高于噪声）。

如果只有 2 个 run，或 MAD=0，或 bestKept=baseline，则返回 `null`（数据不足以判断）。

### 关键过滤函数

```typescript
// state.ts:77-132 — 所有过滤函数的完整实现

// 按 segment 过滤
export function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter(result => result.segment === segment);
}

// 当前 segment 中第一个 kept 且非 flagged 的结果
export function findBaselineResult(results: ExperimentResult[], segment: number): ExperimentResult | null {
  return currentResults(results, segment).find(result => result.status === "keep" && !result.flagged) ?? null;
}

// 基线指标值
export function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const baseline = findBaselineResult(results, segment);
  return baseline ? baseline.metric : null;
}

// 最佳 kept 指标值（按 direction 方向比较）
export function findBestKeptMetric(
  results: ExperimentResult[], segment: number, direction: MetricDirection,
): number | null {
  let best: number | null = null;
  for (const result of currentResults(results, segment)) {
    if (result.status !== "keep" || result.flagged) continue;
    if (best === null || isBetter(result.metric, best, direction)) {
      best = result.metric;
    }
  }
  return best;
}

// 基线运行编号
export function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const baseline = findBaselineResult(results, segment);
  if (!baseline) return null;
  if (baseline.runNumber !== null) return baseline.runNumber;
  const index = results.indexOf(baseline);
  return index >= 0 ? index + 1 : null;
}

// 基线次要指标值（遍历已知指标，从基线结果或当前 segment 其他非 flagged 结果中取值）
export function findBaselineSecondary(
  results: ExperimentResult[], segment: number, knownMetrics: MetricDef[],
): NumericMetricMap {
  const baseline = findBaselineResult(results, segment);
  const values: NumericMetricMap = baseline ? { ...baseline.metrics } : {};
  for (const metric of knownMetrics) {
    if (values[metric.name] !== undefined) continue;
    for (const result of currentResults(results, segment)) {
      if (result.flagged) continue;
      const value = result.metrics[metric.name];
      if (value !== undefined) { values[metric.name] = value; break; }
    }
  }
  return values;
}
```

### 状态重建

```typescript
// state.ts:172-218 — 从 SQLite rows 重建完整的 ExperimentState
export function buildExperimentState(session: SessionRow, loggedRuns: RunRow[]): ExperimentState {
  const state = createExperimentState();
  state.name = session.name;
  state.goal = session.goal;
  state.metricName = session.primaryMetric;
  state.metricUnit = session.metricUnit;
  state.bestDirection = session.direction;
  state.scopePaths = [...session.scopePaths];
  state.offLimits = [...session.offLimits];
  state.constraints = [...session.constraints];
  state.notes = session.notes;
  state.branch = session.branch;
  state.baselineCommit = session.baselineCommit;
  state.sessionId = session.id;
  state.maxExperiments = session.maxIterations;
  state.currentSegment = session.currentSegment;
  state.secondaryMetrics = session.secondaryMetrics.map(
    name => ({ name, unit: inferMetricUnitFromName(name) })
  );

  for (const run of loggedRuns) {
    if (run.status === null) continue;
    const result: ExperimentResult = {
      runNumber: run.id,
      commit: run.commitHash ?? "",
      metric: run.metric ?? 0,
      metrics: run.metrics ?? {},
      status: run.status,
      description: run.description ?? "",
      timestamp: run.loggedAt ?? run.startedAt,
      segment: run.segment,
      confidence: run.confidence,
      asi: run.asi ?? undefined,
      modifiedPaths: run.modifiedPaths ?? [],
      scopeDeviations: run.scopeDeviations ?? [],
      justification: run.justification,
      flagged: run.flagged,
      flaggedReason: run.flaggedReason,
    };
    state.results.push(result);
    if (run.segment === state.currentSegment) {
      registerSecondaryMetrics(state.secondaryMetrics, result.metrics);
    }
  }

  state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
  state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
  return state;
}
```

### Runtime Store

```typescript
// state.ts:238-252 — 基于 Map 的运行时存储（ephemeral，不持久化）
export function createRuntimeStore(): RuntimeStore {
  const runtimes = new Map<string, AutoresearchRuntime>();
  return {
    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
    ensure(sessionKey: string): AutoresearchRuntime {
      const existing = runtimes.get(sessionKey);
      if (existing) return existing;
      const runtime = createSessionRuntime();
      runtimes.set(sessionKey, runtime);
      return runtime;
    },
  };
}
```

### 控制状态重建

```typescript
// state.ts:220-236 — 从 session entries 重建控制状态
export function reconstructControlState(entries: SessionEntry[]): ReconstructedControlState {
  let autoresearchMode = false;
  let goal: string | null = null;
  let lastMode: ReconstructedControlState["lastMode"] = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "autoresearch-control") continue;
    const data = parseControlEntry(entry.data);
    if (!data) continue;
    lastMode = data.mode;
    autoresearchMode = data.mode === "on";
    goal = data.goal ?? goal;
    if (data.mode === "clear") { goal = null; }
  }
  return { autoresearchMode, goal, lastMode };
}
```

---

### ExperimentState 数据结构

```typescript
interface ExperimentState {        // types.ts:42-61
  results: ExperimentResult[];     // 当前 segment 的所有 logged run
  bestMetric: number | null;       // 基线指标值（首个 kept run）
  bestDirection: MetricDirection;  // "lower" | "higher"
  metricName: string;              // 主指标名称
  metricUnit: string;              // 单位（ms, µs, mb 等）
  secondaryMetrics: MetricDef[];   // 已发现的次要指标
  name: string | null;             // session 名称
  goal: string | null;             // 优化目标
  currentSegment: number;          // 当前 segment 编号
  maxExperiments: number | null;   // 软迭代上限
  confidence: number | null;       // MAD-based 置信度
  scopePaths: string[];            // 预期修改路径
  offLimits: string[];             // 禁止修改路径
  constraints: string[];           // 自由格式约束
  notes: string;                   // session 笔记（持久化，可被 agent 编辑）
  branch: string | null;           // 当前 git 分支
  baselineCommit: string | null;   // 基线 commit hash
  sessionId: number | null;        // SQLite session id
}
```

### MAD-Based 置信度算法

代码位置: `state.ts:144-170`

```
Confidence = |bestKept - baseline| / MAD

其中:
  MAD = median(|xi - median(x)|)  对当前 segment 中所有非 flagged、metric > 0 的 run
  bestKept = 当前 segment 中 kept 且非 flagged 的最佳指标值
  baseline = 当前 segment 中第一个 kept 且非 flagged 的指标值
```

**算法步骤:**
1. 过滤当前 segment 中 `metric > 0` 且非 flagged 的 run
2. 如果样本数 < 3，返回 `null`（数据不足）
3. 计算 `median` (有序中位数)
4. 计算 `MAD` = median of absolute deviations from median
5. 如果 `MAD === 0`，返回 `null`（无噪声信息）
6. 如果 `bestKept === baseline` 或 `bestKept === null`，返回 `null`
7. 返回 `|bestKept - baseline| / MAD`

**置信度解读:**
- `conf >= 2.0` → likely real（信号显著高于噪声）
- `1.0 <= conf < 2.0` → marginal
- `conf < 1.0` → within noise floor

MAD 相比标准差对异常值更鲁棒——单个极端值不会大幅膨胀噪声底限。

### 关键过滤函数

| 函数 | 行号 | 用途 |
|--------|------|---------|
| `currentResults(results, segment)` | `state.ts:77-79` | 过滤出指定 segment 的结果 |
| `findBaselineResult(results, segment)` | `state.ts:81-83` | 第一个 kept + 非 flagged 的结果 |
| `findBaselineMetric(results, segment)` | `state.ts:85-88` | 基线指标值 |
| `findBestKeptMetric(results, segment, direction)` | `state.ts:90-103` | 最佳 kept + 非 flagged 指标值 |
| `findBaselineRunNumber(results, segment)` | `state.ts:105-111` | 基线运行的编号 |
| `findBaselineSecondary(results, segment, ...)` | `state.ts:113-132` | 基线运行的次要指标值 |

### Runtime Store

`state.ts:238-252`: 基于 `Map<string, AutoresearchRuntime>` 的运行时存储。`ensure()` 方法对每个 session key 延迟创建运行时。**不持久化**——纯 ephemeral，每次插件加载时重建。

### 状态重建

`state.ts:172-218` `buildExperimentState(session, loggedRuns)`: 从 SQLite rows 重建完整的 `ExperimentState`，包括计算 `confidence` 和 `bestMetric`。在每次 `before_agent_start` 和 `rehydrate` 时调用。

---

## 8. 存储层 (Storage)

文件: `storage.ts` (699 行)

### 数据库引擎

- SQLite 通过 `bun:sqlite`（Bun 内置）
- **WAL 模式** (PRAGMA journal_mode=WAL)
- **synchronous=NORMAL**（平衡安全性与性能）
- **busy_timeout=5000**（5 秒等待锁释放）
- **外键约束启用** (PRAGMA foreign_keys=ON)

### 完整 DDL（Schema SQL）

代码位置: `storage.ts:192-254`。以下是经过格式化的完整 DDL：

```sql
-- storage.ts:194-254 — 完整 Schema DDL
-- Schema 版本号: 1（通过 PRAGMA user_version 跟踪）
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

-- sessions 表：每次实验会话（跨多个 turn 和 segment）
CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY,          -- 自增主键
    name            TEXT NOT NULL,                 -- 实验名称（agent 在 init_experiment 时指定）
    goal            TEXT,                          -- 优化目标（可空，agent 可更新）
    primary_metric  TEXT NOT NULL,                 -- 主指标名称（如 "latency_ms"）
    metric_unit     TEXT NOT NULL DEFAULT '',      -- 指标单位（如 "ms", "µs"）
    direction       TEXT NOT NULL DEFAULT 'lower', -- "lower" | "higher"
    preferred_command TEXT,                        -- 推荐运行命令（通常为 "bash autoresearch.sh"）
    branch          TEXT,                          -- git 分支名（关联的分支）
    baseline_commit TEXT,                          -- 基线 commit SHA
    current_segment INTEGER NOT NULL DEFAULT 0,    -- 当前 segment 编号（0-based）
    max_iterations  INTEGER,                       -- 软迭代上限（null = 无限制）
    scope_paths_json     TEXT NOT NULL DEFAULT '[]',  -- 期望修改路径列表 (JSON 数组)
    off_limits_json      TEXT NOT NULL DEFAULT '[]',  -- 禁止修改路径列表 (JSON 数组)
    constraints_json     TEXT NOT NULL DEFAULT '[]',  -- 约束条件列表 (JSON 数组)
    secondary_metrics_json TEXT NOT NULL DEFAULT '[]', -- 次要指标名称列表 (JSON 数组)
    notes           TEXT NOT NULL DEFAULT '',       -- Session 笔记
    created_at      INTEGER NOT NULL,              -- 创建时间戳（epoch ms）
    closed_at       INTEGER                        -- 关闭时间戳（null = 活跃中）
);

-- runs 表：单次实验运行
CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY,           -- 自增主键
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,  -- 外键→sessions
    segment         INTEGER NOT NULL,              -- 所属 segment 编号
    command         TEXT NOT NULL,                  -- 执行的命令
    started_at      INTEGER NOT NULL,              -- 开始时间戳
    completed_at    INTEGER,                       -- 完成时间戳
    duration_ms     INTEGER,                       -- 运行时长 (ms)
    exit_code       INTEGER,                       -- 退出码
    timed_out       INTEGER NOT NULL DEFAULT 0,    -- 是否超时 (0/1 boolean)
    parsed_primary  REAL,                          -- 自动解析的主指标值（float）
    parsed_metrics_json TEXT,                      -- 自动解析的完整指标字典 (JSON)
    parsed_asi_json     TEXT,                      -- 自动解析的 ASI 数据 (JSON)
    pre_run_dirty_paths_json TEXT NOT NULL DEFAULT '[]', -- 运行前的 dirty 路径 (JSON 数组)
    log_path        TEXT NOT NULL,                 -- 日志文件路径
    status          TEXT,                          -- "keep"|"discard"|"crash"|"checks_failed" (null=pending)
    description     TEXT,                          -- 人类可读描述
    metric          REAL,                          -- 人工确认/覆盖的主指标值
    metrics_json    TEXT,                          -- 人工确认/覆盖的指标字典 (JSON)
    asi_json        TEXT,                          -- 人工确认/覆盖的 ASI 数据 (JSON)
    commit_hash     TEXT,                          -- keep 时的 commit SHA
    confidence      REAL,                          -- MAD 置信度
    modified_paths_json   TEXT,                    -- 检测到的修改路径 (JSON 数组)
    scope_deviations_json TEXT,                    -- 超出范围的修改路径 (JSON 数组)
    justification   TEXT,                          -- 越界修改的理由
    flagged         INTEGER NOT NULL DEFAULT 0,    -- 是否被标记 (0/1 boolean)
    flagged_reason  TEXT,                          -- 标记原因
    logged_at       INTEGER,                       -- logged 时间戳
    abandoned_at    INTEGER                        -- 遗弃时间戳（pending run 被覆盖时设置）
);

-- 索引：按 session_id + segment 查询运行时使用
CREATE INDEX IF NOT EXISTS runs_session_segment_idx ON runs(session_id, segment);
-- 索引：查找 pending run 时使用（按 session_id + status + abandoned_at 过滤）
CREATE INDEX IF NOT EXISTS runs_pending_idx ON runs(session_id, status, abandoned_at);
```

### Schema 迁移策略

当前 **无迁移策略**（`storage.ts:192-193`）：

```typescript
// storage.ts:192-193 — Schema 版本号
const SCHEMA_VERSION = 1;
```

```typescript
// storage.ts:267-271 — version check
const versionRow = this.#db.query("PRAGMA user_version").get() as { user_version: number } | null;
const currentVersion = versionRow?.user_version ?? 0;
if (currentVersion < SCHEMA_VERSION) {
  this.#db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
```

现有代码只检查版本号并更新 `user_version`，但不执行任何迁移脚本。使用 `CREATE TABLE IF NOT EXISTS` 意味着添加新列不会自动升级已有数据库。这是 [`§18.3`](#183-无迁移策略) 中记录的已知局限。

### TypeScript 行类型定义

```typescript
// storage.ts:21-71 — SessionRow 和 RunRow 接口（应用层）
export interface SessionRow {
  id: number; name: string; goal: string | null;
  primaryMetric: string; metricUnit: string; direction: MetricDirection;
  preferredCommand: string | null; branch: string | null; baselineCommit: string | null;
  currentSegment: number; maxIterations: number | null;
  scopePaths: string[]; offLimits: string[]; constraints: string[];
  secondaryMetrics: string[]; notes: string; createdAt: number; closedAt: number | null;
}

export interface RunRow {
  id: number; sessionId: number; segment: number; command: string;
  startedAt: number; completedAt: number | null; durationMs: number | null;
  exitCode: number | null; timedOut: boolean;
  parsedPrimary: number | null; parsedMetrics: NumericMetricMap | null;
  parsedAsi: ASIData | null; preRunDirtyPaths: string[]; logPath: string;
  status: ExperimentStatus | null; description: string | null;
  metric: number | null; metrics: NumericMetricMap | null; asi: ASIData | null;
  commitHash: string | null; confidence: number | null;
  modifiedPaths: string[] | null; scopeDeviations: string[] | null;
  justification: string | null; flagged: boolean; flaggedReason: string | null;
  loggedAt: number | null; abandonedAt: number | null;
}
```

注意 `SessionRow` 的 JSON 数组列（`scopePaths`, `offLimits`, `constraints`, `secondaryMetrics`）在应用层已经是解析后的 `string[]`，而数据库中存储为 `scope_paths_json` 等 TEXT 列。`rowToSession()` (`storage.ts:603-624`) 和 `rowToRun()` (`storage.ts:626-657`) 负责在数据库行与应用层行之间转换。

### 每项目独立 DB 文件

```
~/.omp/autoresearch/--<encoded-repo-root>--.db
```

通过 `encodeProjectKey()` 函数 (`storage.ts:17-19`) 将项目根目录绝对路径编码为文件系统安全的字符串：

```typescript
// storage.ts:17-19 — 路径编码（注意：/a/b 和 /a-b 都编码为 --a-b--，存在碰撞风险）
function encodeProjectKey(repoRoot: string): string {
  return `--${repoRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
```

### Storage Cache

```typescript
// storage.ts:551-601 — 全局缓存，防止同一 dbPath 重复打开
const storageCache = new Map<string, AutoresearchStorage>();

export async function openAutoresearchStorage(cwd: string): Promise<AutoresearchStorage> {
  const { dbPath, projectDir } = await resolveAutoresearchPaths(cwd);
  const cached = storageCache.get(dbPath);
  if (cached) return cached;
  // ... 创建新实例并缓存
}

export function closeAllAutoresearchStorages(): void {
  for (const storage of storageCache.values()) {
    try { storage.close(); } catch (err) { /* warn */ }
  }
  storageCache.clear();
}
```

---

## 9. Git 分支策略

文件: `git.ts` (319 行)

### 完整 allocateBranchName 实现

```typescript
// git.ts:173-182 — 分支名分配（含冲突自增后缀）
async function allocateBranchName(api: ExtensionAPI, workDir: string, goal: string | null): Promise<string> {
  const baseName = `${AUTORESEARCH_BRANCH_PREFIX}${slugifyGoal(goal)}-${currentDateStamp()}`;
  let candidate = baseName;
  let suffix = 2;
  while (await branchExists(api, workDir, candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

// git.ts:184-187 — 检查分支是否存在
async function branchExists(api: ExtensionAPI, workDir: string, branchName: string): Promise<boolean> {
  void api;
  return git.ref.exists(workDir, `refs/heads/${branchName}`);
}
```

分支命名格式: `autoresearch/{slugified-goal}-{yyyymmdd}`

冲突处理：首次冲突加 `-2`，再冲突递增 `-3`, `-4`...

#### slugifyGoal — 目标名标准化

```typescript
// git.ts:189-196 — 将 goal 转换为安全的分支名片段
function slugifyGoal(goal: string | null): string {
  const normalized = (goal ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")     // 非字母数字 → 连字符
    .replace(/^-+|-+$/g, "");         // 去除首尾连字符
  const trimmed = normalized.slice(0, BRANCH_NAME_MAX_LENGTH).replace(/-+$/g, "");
  return trimmed || "session";         // 空结果 fallback
}
```

### 完整 ensureAutoresearchBranch 流程

```typescript
// git.ts:35-85 — 确保当前正在 autoresearch 分支上
export async function ensureAutoresearchBranch(
  api: ExtensionAPI,
  workDir: string,
  goal: string | null,
): Promise<EnsureAutoresearchBranchResult> {
  // 1. 检查是否在 git 仓库中
  const repoRoot = await git.repo.root(workDir);
  if (!repoRoot) {
    return { ok: true, branchName: null, created: false,
             warning: "Not in a git repository — autoresearch will run without branch isolation." };
  }

  // 2. 检查 git status
  let dirtyPathsOutput: string;
  try {
    dirtyPathsOutput = await git.status(repoRoot, { porcelainV1: true, untrackedFiles: "all", z: true });
  } catch (err) {
    return { ok: false, error: `Unable to inspect git status: ...` };
  }

  // 3. 检查是否已在 autoresearch 分支
  const workDirPrefix = await readGitWorkDirPrefix(api, workDir);
  const dirtyPaths = collectRelativeDirtyPaths(dirtyPathsOutput, workDirPrefix);
  const currentBranch = await getCurrentAutoresearchBranch(api, workDir);
  if (currentBranch) {
    return { ok: true, branchName: currentBranch, created: false };
  }

  // 4. 检查工作区是否 dirty
  if (dirtyPaths.length > 0) {
    return { ok: false, error: `Worktree is dirty ...` };
  }

  // 5. 分配新分支并 checkout
  const branchName = await allocateBranchName(api, workDir, goal);
  try {
    await git.branch.checkoutNew(workDir, branchName);
  } catch (err) {
    return { ok: false, error: `Failed to create branch ${branchName}: ...` };
  }
  return { ok: true, branchName, created: true };
}
```

**流程总结：**

```
  check git repo?                 → No  → warning, return null branch
    ↓ Yes
  check git status?               → Fail → error
    ↓ OK
  on autoresearch/* branch?       → Yes → return current
    ↓ No
  worktree dirty?                 → Yes → error
    ↓ Clean
  allocate branch name + checkout → return branchName
```

### 脏路径检测（完整实现）

#### NUL-delimited 格式解析 (`git status -z`)

```typescript
// git.ts:128-148 — 解析 NUL 分隔的 git status 输出（推荐模式）
function parseDirtyPathsNul(statusOutput: string): string[] {
  const unsafePaths = new Set<string>();
  let index = 0;
  while (index + 3 <= statusOutput.length) {
    const statusToken = statusOutput.slice(index, index + 3);  // XY 状态码 + 1 空格
    index += 3;
    const pathEnd = statusOutput.indexOf("\0", index);
    if (pathEnd < 0) break;
    const firstPath = statusOutput.slice(index, pathEnd);
    index = pathEnd + 1;
    addDirtyPath(unsafePaths, firstPath);
    if (isRenameOrCopy(statusToken)) {
      // R/C 条目有第二个路径（重命名目标）
      const secondPathEnd = statusOutput.indexOf("\0", index);
      if (secondPathEnd < 0) break;
      const secondPath = statusOutput.slice(index, secondPathEnd);
      index = secondPathEnd + 1;
      addDirtyPath(unsafePaths, secondPath);
    }
  }
  return [...unsafePaths];
}
```

#### Regular porcelain 格式解析 (非 `-z` fallback)

```typescript
// git.ts:150-163 — 解析按行分隔的 git status 输出（fallback 模式）
function parseDirtyPathsLines(statusOutput: string): string[] {
  const unsafePaths = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    const trimmedLine = line.trimEnd();
    if (trimmedLine.length < 4) continue;           // 最短有效行：XY<space><path>
    const rawPath = trimmedLine.slice(3).trim();     // 去掉前 3 字符（XY + 空格）
    if (rawPath.length === 0) continue;
    const renameParts = rawPath.split(" -> ");
    for (const renamePart of renameParts) {
      addDirtyPath(unsafePaths, renamePart);
    }
  }
  return [...unsafePaths];
}
```

#### 统一入口

```typescript
// git.ts:121-126 — 自动检测输出格式
export function parseDirtyPaths(statusOutput: string): string[] {
  if (statusOutput.includes("\0")) {
    return parseDirtyPathsNul(statusOutput);  // NUL-delimited → 精确解析
  }
  return parseDirtyPathsLines(statusOutput);  // Plain text → 行解析
}
```

#### DirtyPathEntry（含 untracked 信息）

```typescript
// git.ts:231-289 — 带 untracked 状态的脏路径解析
export interface DirtyPathEntry {
  path: string;
  untracked: boolean;
}

export function parseDirtyPathsWithStatus(statusOutput: string): DirtyPathEntry[] {
  if (statusOutput.includes("\0")) {
    return parseDirtyPathsNulWithStatus(statusOutput);
  }
  return parseDirtyPathsLinesWithStatus(statusOutput);
}
```

### 路径转换

#### relativizeGitPathToWorkDir — git 仓库路径 → 工作目录相对路径

```typescript
// git.ts:97-110 — 路径转换（monorepo/subdir 场景中至关重要）
export function relativizeGitPathToWorkDir(repoRelativePath: string, workDirPrefix: string): string | null {
  const normalizedPath = normalizeStatusPath(repoRelativePath);
  const normalizedPrefix = normalizePathSpec(workDirPrefix);
  if (normalizedPrefix === "" || normalizedPrefix === ".") {
    return normalizedPath;      // 工作目录在 git 仓库根目录
  }
  if (normalizedPath === normalizedPrefix) {
    return ".";                 // 路径本身就是工作目录
  }
  if (!normalizedPath.startsWith(`${normalizedPrefix}/`)) {
    return null;                // 路径不在工作目录下（过滤掉）
  }
  return normalizePathSpec(normalizedPath.slice(normalizedPrefix.length + 1));
}
```

#### computeRunModifiedPaths — 精确计算本次迭代的修改

```typescript
// git.ts:302-319 — 通过比较运行前后 dirty 状态计算精确 diff
export function computeRunModifiedPaths(
  preRunDirtyPaths: string[],
  currentStatusOutput: string,
  workDirPrefix: string,
): { tracked: string[]; untracked: string[] } {
  const preRunSet = new Set(preRunDirtyPaths);           // 运行前已 dirty 的文件
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const entry of parseWorkDirDirtyPathsWithStatus(currentStatusOutput, workDirPrefix)) {
    if (preRunSet.has(entry.path)) continue;             // 排除运行前已 dirty 的（那是前序残留）
    if (entry.untracked) {
      untracked.push(entry.path);
    } else {
      tracked.push(entry.path);
    }
  }
  return { tracked, untracked };
}
```

### Keep 与 Discard 的差异

| 操作 | 在 autoresearch 分支 | 不在 autoresearch 分支 |
|--------|----------------------|------------------------|
| **keep** | `git add` → `git commit`（result JSON 在 commit message 中） | 跳过 auto-commit，文件留在工作区 + warning |
| **discard** | `git reset --hard HEAD` + `git clean` | 仅通过 `git restore` + `fs.rmSync` 回滚 run 修改的文件 |

**关键安全保证:** 在 autoresearch 分支上的 `discard` 只会回滚本次迭代的未 commit 更改——之前的 `keep` commit 不会被丢弃 (`git.ts:350-361`)。

**discard 的非 autoresearch 分支实现（选择性 revert）：**

```typescript
// log-experiment.ts:345-383 — revertFailedExperiment（非分支模式）
async function revertFailedExperiment(
  cwd: string, preRunDirtyPaths: string[], onAutoresearchBranch: boolean,
): Promise<KeepCommitResult> {
  if (onAutoresearchBranch) {
    // 分支模式：暴力重置，安全（因为 keep commit 不可变）
    await git.reset(cwd, { hard: true, target: "HEAD" });
    await git.clean(cwd);
    return { note: "worktree reset to HEAD" };
  }
  // 非分支模式：选择性 revert 仅本次修改的文件
  const { tracked, untracked } = computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix);
  if (tracked.length > 0) {
    await git.restore(cwd, { files: tracked, source: "HEAD", staged: true, worktree: true });
  }
  for (const filePath of untracked) {
    fs.rmSync(path.join(cwd, filePath), { force: true, recursive: true });  // best effort
  }
  return { note: `reverted ${total} file(s)` };
}
```

---

### 分支命名

```
AUTORESEARCH_BRANCH_PREFIX = "autoresearch/"
BRANCH_NAME_MAX_LENGTH = 48

格式: autoresearch/{slugified-goal}-{yyyymmdd}

示例: autoresearch/optimize-sort-20260617
冲突: autoresearch/optimize-sort-20260617-2 (自增 -2, -3 后缀)
```

参考 `git.ts:173-182` (allocateBranchName) 和 `git.ts:189-196` (slugifyGoal)。

### 脏路径检测

支持两种 git status 输出格式:

| 格式 | 检测方式 | 函数 |
|--------|-----------|--------|
| NUL-delimited (`-z`) | 按 `\0` 分隔解析 | `parseDirtyPathsNul` (`git.ts:128-148`) |
| Regular porcelain | 按换行 + 3 字符状态码解析 | `parseDirtyPathsLines` (`git.ts:150-163`) |

`DirtyPathEntry` (`git.ts:231-233`): `{ path: string, untracked: boolean }`——区分 tracked 与 untracked 文件。

### 分支分配流程

```
ensureAutoresearchBranch(api, workDir, goal)
  │
  ├─ 检查是否在 git 仓库中 → 否: 返回 warning（无分支隔离）
  ├─ 检查 git status → 失败: 返回 error
  ├─ 检查是否已在 autoresearch/* 分支 → 是: 返回当前分支
  ├─ 检查工作区是否 dirty → 是: 返回 error（需先 commit/stash）
  └─ 分配分支名并 checkout → 返回新分支名
```

### Keep 与 Discard 的差异

| 操作 | 在 autoresearch 分支 | 不在 autoresearch 分支 |
|--------|----------------------|------------------------|
| **keep** | `git add` → `git commit`（result JSON 在 commit message 中） | 跳过 auto-commit，文件留在工作区 + warning |
| **discard** | `git reset --hard HEAD` + `git clean` | 仅通过 `git restore` + `fs.rmSync` 回滚 run 修改的文件 |

**关键安全保证:** 在 autoresearch 分支上的 `discard` 只会回滚本次迭代的未 commit 更改——之前的 `keep` commit 不会被丢弃。

### 路径转换

`relativizeGitPathToWorkDir` (`git.ts:97-110`): 将 git 仓库相对路径转换为工作目录相对路径。这在 monorepo 或 subdir 场景中至关重要。

`computeRunModifiedPaths` (`git.ts:302-319`): 通过比较运行前 (preRunDirtyPaths) 和运行后的 git status，精确计算出 agent 本次迭代修改了哪些文件。

---

## 10. METRIC / ASI 协议

文件: `helpers.ts` (218 行)

### 常量定义

```typescript
// helpers.ts:4-9 — 协议常量和保护键
export const METRIC_LINE_PREFIX = "METRIC";
export const ASI_LINE_PREFIX = "ASI";
export const EXPERIMENT_MAX_LINES = 10;          // LLM 输出截断行数
export const EXPERIMENT_MAX_BYTES = 4 * 1024;    // LLM 输出截断字节数（4KB）
const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
```

### 完整 parseMetricLines 实现

```typescript
// helpers.ts:11-26 — 解析标准输出中的 METRIC 行
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  // 正则: ^METRIC\s+([\w.µ-]+)=(\S+)\s*$
  // 匹配如: METRIC latency_ms=42.5, METRIC throughput=1500
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, "gm");
  let match = regex.exec(output);
  while (match !== null) {
    const name = match[1];
    if (!DENIED_KEY_NAMES.has(name)) {          // 过滤原型污染键
      const value = Number(match[2]);
      if (Number.isFinite(value)) {             // 仅保留有限数值
        metrics.set(name, value);
      }
    }
    match = regex.exec(output);
  }
  return metrics;
}
```

### 完整 parseAsiLines 实现

```typescript
// helpers.ts:28-60 — 解析标准输出中的 ASI 行
export function parseAsiLines(output: string): ASIData | null {
  const asi: ASIData = {};
  // 正则: ^ASI\s+([\w.-]+)=(.+)\s*$
  // 匹配如: ASI hypothesis=prefetch improves, ASI rollback_reason=cache bug
  const regex = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, "gm");
  let match = regex.exec(output);
  while (match !== null) {
    const key = match[1];
    if (!DENIED_KEY_NAMES.has(key)) {
      asi[key] = parseAsiValue(match[2]);       // 自动类型检测
    }
    match = regex.exec(output);
  }
  return Object.keys(asi).length > 0 ? asi : null;
}

// helpers.ts:42-60 — ASI 值类型检测（顺序敏感）
function parseAsiValue(raw: string): ASIValue {
  const value = raw.trim();
  if (value === "true") return true;            // boolean true
  if (value === "false") return false;           // boolean false
  if (value === "null") return null;             // null
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {         // number
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
    try { return JSON.parse(value) as ASIValue; } catch { /* fall through to string */ }
  }
  return value;                                  // 默认保留为 string
}
```

**类型检测优先级：** "true" / "false" → "null" → number → JSON object/array → string。

### 示例输出流

```
$ bash autoresearch.sh
Compiling...
Running benchmark...
METRIC latency_ms=42.5
METRIC throughput=1500
ASI hypothesis=prefetch improves throughput
ASI next_action_hint=try doubling buffer size
```

**解析结果：**

```
parseMetricLines 返回:
  Map { "latency_ms" => 42.5, "throughput" => 1500 }

parseAsiLines 返回:
  { hypothesis: "prefetch improves throughput", next_action_hint: "try doubling buffer size" }
```

### 多行 ASI 示例

```
METRIC inference_time=0.8
ASI hypothesis={"strategy":"quantization","bits":8}
ASI rollback_reason="accuracy dropped below threshold"
```

**解析结果：**

```javascript
{
  hypothesis: { strategy: "quantization", bits: 8 },   // JSON 对象
  rollback_reason: "accuracy dropped below threshold"   // 自动去除外层引号
}
```

### 截断限制的使用

```typescript
// run-experiment.ts:148-155 — 两阶段截断：LLM 用严格限制，显示用默认限制
const llmTruncation = truncateTail(execution.output, {
  maxBytes: EXPERIMENT_MAX_BYTES,       // 4KB
  maxLines: EXPERIMENT_MAX_LINES,       // 10 行
});
const displayTruncation = truncateTail(execution.output, {
  maxBytes: DEFAULT_MAX_BYTES,          // 来自 opencode 默认
  maxLines: DEFAULT_MAX_LINES,          // 来自 opencode 默认
});
```

### METRIC/ASI 流转时序

```
run_experiment 执行 bash autoresearch.sh
  │
  ├─ executeProcess() 流式捕获输出到 benchmark.log + tailBuffer
  │
  ├─ parseMetricLines(output) → parsedMetrics, parsedPrimary
  ├─ parseAsiLines(output) → parsedAsi
  │
  ├─ 持久化到 SQLite (markRunCompleted):
  │     parsed_primary, parsed_metrics_json, parsed_asi_json
  │
  └─ 返回 RunDetails 给 LLM:
        parsedPrimary, parsedMetrics, parsedAsi, tailOutput(截断后)
```

### 工具函数

```typescript
// helpers.ts:62-68 — 合并自动解析的 ASI 与手工覆盖 ASI
export function mergeAsi(base: ASIData | null, override: ASIData | undefined): ASIData | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

// helpers.ts:155-165 — 确保 NumericMetricMap 不包含非法值
export function ensureNumericMetricMap(value: NumericMetricMap | undefined): NumericMetricMap {
  if (!value) return {};
  const out: NumericMetricMap = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (DENIED_KEY_NAMES.has(key)) continue;
    if (typeof entryValue === "number" && Number.isFinite(entryValue)) out[key] = entryValue;
  }
  return out;
}

// helpers.ts:167-202 — ASI 递归清理（防原型污染）
export function sanitizeAsi(value: { [key: string]: unknown } | undefined): ASIData | undefined {
  if (!value) return undefined;
  // ...递归过滤 __proto__/constructor/prototype
}

// helpers.ts:120-127 — 启发式单位推断
export function inferMetricUnitFromName(name: string): string {
  if (name.endsWith("µs") || name.endsWith("_µs")) return "µs";
  if (name.endsWith("ms") || name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec") || name.endsWith("_secs")) return "s";
  if (name.endsWith("_kb") || name.endsWith("kb")) return "kb";
  if (name.endsWith("_mb") || name.endsWith("mb")) return "mb";
  return "";
}
```

---

## 11. 工具规范

所有工具都是 LLM-callable，`defaultInactive: true`——仅当 autoresearch mode 激活时才出现在 agent 的工具列表中。

### 11.1 init_experiment (272 行)

| 属性 | 值 |
|--------|-------|
| 文件名 | `oh-my-pi/packages/coding-agent/src/autoresearch/tools/init-experiment.ts` |
| Schema | `initExperimentSchema` (line 19-34) |
| 用途 | 初始化/重配置 session，Phase 1 → Phase 2 的转换器 |

**完整 Zod Schema:**

```typescript
// init-experiment.ts:19-34 — 完整参数定义
const initExperimentSchema = z.object({
  name: z.string().describe("experiment name"),
  goal: z.string().describe("session goal").optional(),
  primary_metric: z.string().describe("primary metric name"),
  metric_unit: z.string().describe("metric unit (e.g. ms, µs, mb)").optional(),
  direction: z.enum(["lower", "higher"] as const)
    .describe("better direction (default lower)").optional(),
  secondary_metrics: z.array(z.string()).describe("secondary metric names").optional(),
  scope_paths: z.array(z.string()).describe("expected-to-modify paths").optional(),
  off_limits: z.array(z.string()).describe("off-limits paths").optional(),
  constraints: z.array(z.string()).describe("free-form constraints").optional(),
  max_iterations: z.number().describe("soft iteration cap per segment").optional(),
  new_segment: z.boolean().describe("bump to a new segment in existing session").optional(),
});
```

**完整 execute() 流程（伪代码 + 行号引用）：**

```
execute() 入口 (line 55)
  │
  ├─ 1. 参数预处理 (lines 59-71)
  │     direction ← params.direction ?? "lower"
  │     scopePaths ← dedupe(normalize(params.scope_paths))
  │     offLimits ← dedupe(normalize(params.off_limits))
  │     constraints ← dedupe(params.constraints)
  │     goal ← params.goal?.trim() || null
  │     branch ← git.branch.current(cwd)
  │
  ├─ 2. 检查 harness 文件 (lines 73-89)
  │     existing ← storage.getActiveSessionForBranch(branch)
  │     requiresHarness ← !existing || params.new_segment
  │     if requiresHarness && !exists(./autoresearch.sh) → return ERROR
  │
  ├─ 3. 自动 commit harness 更改 (lines 91-105)
  │     if requiresHarness && onAutoresearchBranch && dirty:
  │       git.stage([]) → git.commit("autoresearch: harness setup")
  │       harnessCommitted = true
  │     (如果 git 失败 → commitWarning, 降级运行)
  │
  ├─ 4. 捕获基线 commit (line 107)
  │     baselineCommit ← git.head.sha(cwd)
  │
  ├─ 5. 创建/更新 session (lines 114-154)
  │     if !existing:
  │       session ← storage.openSession({name, goal, primaryMetric, ...})
  │       createdSession = true
  │     else:
  │       abandonedRuns ← storage.abandonPendingRuns(existing.id)
  │       updates ← { goal, scopePaths, offLimits, ... }
  │       if new_segment:
  │         updates.baselineCommit = baselineCommit
  │         session ← storage.bumpSegment(existing.id)
  │       else:
  │         session ← storage.updateSession(existing.id, updates)
  │
  ├─ 6. 重建状态 + 更新 runtime (lines 156-168)
  │     state ← buildExperimentState(session, loggedRuns)
  │     runtime.state = state
  │     runtime.autoresearchMode = true
  │     runtime.autoResumeArmed = true
  │     runtime.lastRunSummary = null (clear any stale pending state)
  │     dashboard.updateWidget(ctx, runtime)
  │
  └─ 7. 构建返回消息 (lines 171-230)
        lines ← [abandoned 信息, commit 状态, session 详情, metric 配置, ...
        return { content: lines.join("\n"), details: {state, createdSession, ...} }
```

**错误处理分支：**
- Harness 文件缺失 → 返回错误消息 + 提示 Phase 1
- Git commit 失败 → commitWarning（不阻塞，降级运行）
- GET HEAD SHA 失败 → baselineCommit = null（基线不可用）
- 非 autoresearch 分支 → warning（discard 不能完全回滚）

### 11.2 run_experiment (407 行)

| 属性 | 值 |
|--------|-------|
| 文件名 | `oh-my-pi/packages/coding-agent/src/autoresearch/tools/run-experiment.ts` |
| Schema | `runExperimentSchema` (line 28-30) |
| 用途 | 执行 benchmark 并捕获输出 |

**完整 Zod Schema:**

```typescript
// run-experiment.ts:28-30 — 唯一的参数
const runExperimentSchema = z.object({
  timeout_seconds: z.number().describe("timeout in seconds (default 600)").optional(),
});
```

**完整 execute() 流程：**

```
execute() 入口 (line 57)
  │
  ├─ 1. 前置检查 (lines 58-70)
  │     无活动 session → return ERROR "no active autoresearch session"
  │
  ├─ 2. 弃用前序 pending run (lines 74-79)
  │     pending ← storage.getPendingRun(session.id)
  │     if pending:
  │       storage.abandonPendingRuns(session.id)
  │       abandonedPriorRun = pending.id
  │
  ├─ 3. 记录 pre-run dirty 状态 (lines 81-84)
  │     preRunStatus ← git.status(cwd, -z)
  │     preRunDirtyPaths ← parseWorkDirDirtyPaths(preRunStatus, workDirPrefix)
  │
  ├─ 4. 插入 run 记录 + 创建产物目录 (lines 86-99)
  │     insertedRun ← storage.insertRun({sessionId, segment, command, ...})
  │     runDirectory ← projectDir/runs/{padded-id}/
  │     benchmarkLogPath ← runDirectory/benchmark.log
  │     storage.updateRunLogPath(insertedRun.id, benchmarkLogPath)
  │
  ├─ 5. 设置运行中状态 (lines 101-113)
  │     runtime.runningExperiment ← {startedAt, command, runDirectory, runNumber}
  │     dashboard.updateWidget(ctx, runtime) → 显示 spinner
  │
  ├─ 6. 执行进程 (lines 117-141)
  │     executeProcess({command: "bash autoresearch.sh", cwd, logPath, timeoutMs})
  │       ├─ 创建 TailBuffer + 日志文件 writer
  │       ├─ setInterval 每秒推送进度 (onProgress callback) → dashboard 更新
  │       ├─ executeBash() → 等待完成 / 超时 / abort
  │       ├─ 流式写入 benchmark.log + 累积到 tailBuffer
  │       └─ 返回 {exitCode, killed, logPath, output}
  │     finally: clear runtime.runningExperiment
  │
  ├─ 7. 计算运行时间 + 截断 (lines 143-155)
  │     durationMs ← completedAt - startedAt
  │     llmTruncation ← truncateTail(output, 4KB/10行)
  │     displayTruncation ← truncateTail(output, DEFAULT)
  │
  ├─ 8. 解析 METRIC/ASI (lines 157-161)
  │     parsedMetricsMap ← parseMetricLines(output)
  │     parsedPrimary ← parsedMetricsMap.get(session.primaryMetric)
  │     parsedAsi ← parseAsiLines(output)
  │
  ├─ 9. 持久化完成状态 (lines 163-172)
  │     storage.markRunCompleted({runId, completedAt, durationMs, exitCode, ...})
  │
  ├─ 10. 更新运行时状态 (lines 174-219)
  │      runtime.lastRunSummary ← {command, durationSeconds, parsedAsi, ...}
  │      runtime.autoResumeArmed = true
  │
  └─ 11. 构建返回消息 (lines 221-235)
         lines ← [abandoned 信息, run 详情, output preview, truncation 提示]
         return { content: warningPrefix + buildRunText(...), details: resultDetails }
```

**完整 executeProcess 实现 (`run-experiment.ts:269-342`)：**

```typescript
async function executeProcess(opts: {
  command: string; cwd: string; logPath: string; timeoutMs: number;
  signal?: AbortSignal;
  onProgress?(details: ProgressSnapshot): void;
}): Promise<ProcessExecutionResult> {
  const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);  // 流式捕获
  const progressTimer = opts.onProgress
    ? setInterval(() => opts.onProgress?.(snapshot()), 1000)
    : undefined;
  const logSink = Bun.file(opts.logPath).writer();
  try {
    const result = await executeBash(opts.command, {
      cwd: opts.cwd, sessionKey: `autoresearch:${opts.cwd}`,
      timeout: opts.timeoutMs > 0 ? opts.timeoutMs : 2_147_000_000,
      signal: opts.signal, chunkThrottleMs: 0,
      onChunk: chunk => { tailBuffer.append(chunk); logSink.write(chunk); },
    });
    await logSink.end();
    const output = await fs.promises.readFile(opts.logPath, "utf8");
    return { exitCode: result.exitCode ?? null, killed: result.cancelled, logPath: opts.logPath, output };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}
```

### 11.3 log_experiment (524 行)

| 属性 | 值 |
|--------|-------|
| 文件名 | `oh-my-pi/packages/coding-agent/src/autoresearch/tools/log-experiment.ts` |
| Schema | `logExperimentSchema` (line 39-56) |
| 用途 | 记录实验结果，执行 git keep/discard |

**完整 Zod Schema:**

```typescript
// log-experiment.ts:39-56 — 完整参数定义（最复杂的工具）
const logExperimentSchema = z.object({
  metric: z.number().describe("primary metric value"),
  status: z.enum(["keep", "discard", "crash", "checks_failed"] as const)
    .describe("run outcome"),
  description: z.string().describe("short run description"),
  metrics: z.record(z.string(), z.number()).describe("secondary metrics").optional(),
  asi: z.object({}).passthrough().describe("free-form structured metadata").optional(),
  commit: z.string().describe("override recorded commit hash").optional(),
  justification: z.string()
    .describe("required when keeping a scope-deviating run").optional(),
  flag_runs: z.array(
    z.object({
      run_id: z.number().describe("run id to flag"),
      reason: z.string().describe("why this run is suspect"),
    })
  ).describe("flag earlier runs as suspect").optional(),
});
```

**完整 execute() 流程：**

```
execute() 入口 (line 68)
  │
  ├─ 1. 前置检查 (lines 69-87)
  │     无 session → return ERROR
  │     无 pending run → return ERROR "no pending run available"
  │
  ├─ 2. 处理 flag_runs (lines 91-97)
  │     for each flag: storage.flagRun(run_id, reason)
  │
  ├─ 3. 检测修改路径 (lines 99-118)
  │     if onAutoresearchBranch:
  │       直接读取 git status（分支模式所有 dirty 路径都是本次修改）
  │     else:
  │       computeRunModifiedPaths(preRunDirtyPaths, currentStatus, workDirPrefix)
  │       排除 preRunDirtyPaths 中已存在的路径
  │
  ├─ 4. 计算 scope 偏差 (lines 119-120)
  │     scopeDeviations ← computeScopeDeviations(allModified, session)
  │     // 比较每个修改路径与 scopePaths/offLimits
  │
  ├─ 5. 执行 git 操作 (lines 124-176)
  │     if status === "keep":
  │       在 autoresearch 分支 + 有修改 → git add + git commit
  │       commit message 包含 Result JSON: "{status, primaryMetric, metrics...}"
  │       不在分支 → warning "auto-commit skipped"
  │     else (discard/crash/checks_failed):
  │       在分支 → git reset --hard HEAD + git clean
  │       不在分支 → git restore + fs.rmSync（选择性 revert）
  │
  ├─ 6. 合并指标 + ASI (lines 178-190)
  │     metrics ← mergeMetrics(parsed, override, primaryMetric)
  │     asi ← mergeAsi(parsedAsi, sanitizeAsi(override))
  │     if parsedPrimary !== metric → warning "值差异"
  │
  ├─ 7. 持久化 + 置信度 (lines 192-227)
  │     storage.markRunLogged({runId, status, metric, metrics, asi, ...})
  │     confidence ← computeConfidence(...)
  │     storage.updateRunConfidence(runId, confidence)
  │     runtime.state ← buildExperimentState( refreshed session )
  │
  ├─ 8. 检查迭代上限 (lines 248-258)
  │     if maxExperiments !== null && segmentRunCount >= maxExperiments:
  │       runtime.autoresearchMode = false
  │       分离实验工具
  │
  ├─ 9. 构建返回消息 (lines 264-284)
  │     包含: run #, 基准线, delta%, 次要指标, ASI 摘要, 置信度, git 状态
  │
  └─ return { content, details: {experiment, state, wallClockSeconds, ...} }
```

### 11.4 update_notes (109 行)

| 属性 | 值 |
|--------|-------|
| 文件名 | `oh-my-pi/packages/coding-agent/src/autoresearch/tools/update-notes.ts` |
| Schema | `updateNotesSchema` (line 11-14) |
| 用途 | 编辑 session 笔记 |

**完整实现:**

```typescript
// update-notes.ts:11-14 — 参数定义
const updateNotesSchema = z.object({
  body: z.string().describe("replacement notes body"),
  append_idea: z.string().describe("append as bullet under Ideas instead of replacing body").optional(),
});

// update-notes.ts:20-84 — 工具工厂函数
export function createUpdateNotesTool(
  options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof updateNotesSchema, UpdateNotesDetails> {
  return {
    name: "update_notes",
    label: "Update Notes",
    description: "Persist the durable autoresearch playbook ...",
    parameters: updateNotesSchema,
    defaultInactive: true,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // 1. 检查活动 session
      const storage = await openAutoresearchStorageIfExists(ctx.cwd);
      const currentBranch = (await git.branch.current(ctx.cwd)) ?? null;
      const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
      if (!storage || !session) {
        return { content: [{ type: "text", text: "Error: no active session" }] };
      }

      // 2. 确定下一版 notes
      const nextNotes =
        params.append_idea !== undefined && params.append_idea.trim().length > 0
          ? appendIdea(session.notes, params.append_idea.trim())   // 在 ## Ideas 下追加
          : params.body;                                             // 完整替换

      // 3. 持久化 + 刷新 runtime
      storage.updateSession(session.id, { notes: nextNotes });
      const refreshed = storage.getSessionById(session.id);
      if (refreshed) {
        const runtime = options.getRuntime(ctx);
        runtime.state = buildExperimentState(refreshed, storage.listLoggedRuns(session.id));
      }

      return {
        content: [{ type: "text", text: `Notes updated (${nextNotes.length} chars).` }],
        details: { notes: nextNotes },
      };
    },
  };
}
```

**appendIdea 助手（`update-notes.ts:89-109`）：**

```typescript
const IDEAS_HEADING = "## Ideas";

function appendIdea(currentNotes: string, idea: string): string {
  const trimmed = currentNotes.trimEnd();
  if (trimmed.length === 0) {
    return `${IDEAS_HEADING}\n- ${idea}\n`;
  }
  if (trimmed.includes(IDEAS_HEADING)) {
    const lines = trimmed.split("\n");
    const ideasIndex = lines.findIndex(line => line.trim() === IDEAS_HEADING);
    // 在 ## Ideas 区末尾或下一标题前插入
    let insertAt = lines.length;
    for (let i = ideasIndex + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i] ?? "")) { insertAt = i; break; }
    }
    lines.splice(insertAt, 0, `- ${idea}`);
    return `${lines.join("\n")}\n`;
  }
  return `${trimmed}\n\n${IDEAS_HEADING}\n- ${idea}\n`;
}
```

---

## 12. Pi Extension Bridge Hook 集成

文件: `index.ts` (536 行)

> **注意**：autoresearch 通过 Pi 的 Extension Bridge API（`ExtensionAPI.on()`、`ExtensionAPI.appendEntry()`、`ExtensionAPI.sendMessage()` 等）集成到 Pi 的运行时。这些 hook 是 Pi 专有的扩展点，不是 OpenCode 通用的插件 API。ZooKeeper 基于 OpenCode SDK 构建，目前仅提供有限的 `client.getSession()` / `client.session.todo()` 等 session 读接口，不支持写入自定义 entry 或监听深度生命周期事件（详见 §19.3）。

### 注册的事件

| 事件 | 行号 | 处理函数 | 用途 |
|-------|------|-------------|---------|
| `session_start` | `248` | `rehydrate(ctx)` | 新对话开始时恢复状态 |
| `session_switch` | `249` | `rehydrate(ctx)` | 切换 session 时恢复 |
| `session_branch` | `250` | `rehydrate(ctx)` | 创建 session branch 时恢复 |
| `session_tree` | `251` | `rehydrate(ctx)` | 切换 session tree 节点时恢复 |
| `session_shutdown` | `252` | `clear dashboard, runtime` | 清理 dashboard + 运行时 |
| `agent_end` | `257` | `auto-resume` | 检查 pending run 并自动继续 |
| `before_agent_start` | `294` | `inject system prompt` | 注入 Phase 1 或 Phase 2 的 system prompt |

### rehydrate() 函数（完整实现）

这是状态恢复的核心逻辑，在每次 session 切换/恢复时调用。`index.ts:50-105`:

```typescript
// index.ts:50-105 — 状态恢复核心
const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
  const runtime = getRuntime(ctx);
  // 1. 从 session entries 重建控制状态
  const control = reconstructControlState(ctx.sessionManager.getBranch());
  runtime.goal = control.goal;
  runtime.autoResumeArmed = false;
  runtime.lastAutoResumePendingRunNumber = null;

  // 2. 检查是否曾在当前对话中激活过 autoresearch
  const everActivated = control.lastMode !== null;
  //    未激活 → 跳过 storage 加载（不创建 SQLite 文件）
  const { session, currentBranch } = everActivated
    ? await loadActiveSession(ctx)
    : { session: null, currentBranch: null };

  // 3. 检查分支匹配（session.branch === currentBranch）
  const onActiveBranch = session === null || session.branch === null || session.branch === currentBranch;
  runtime.autoresearchMode = control.autoresearchMode && onActiveBranch;

  // 4. 如果匹配 → 从 SQLite 加载 session + runs，buildExperimentState
  if (session && onActiveBranch) {
    const storage = await openAutoresearchStorageIfExists(ctx.cwd);
    if (storage) {
      const loggedRuns = storage.listLoggedRuns(session.id);
      runtime.state = buildExperimentState(session, loggedRuns);
      runtime.goal = runtime.goal ?? session.goal;
      runtime.lastRunSummary = pendingRunSummaryFromRow(storage.getPendingRun(session.id));
    } else {
      runtime.state = createExperimentState();
      runtime.lastRunSummary = null;
    }
  } else {
    runtime.state = createExperimentState();
    runtime.lastRunSummary = null;
  }

  // 5. 同步实验工具
  runtime.lastRunDuration = runtime.lastRunSummary?.durationSeconds ?? null;
  runtime.lastRunAsi = runtime.lastRunSummary?.parsedAsi ?? null;
  runtime.lastRunArtifactDir = runtime.lastRunSummary?.runDirectory ?? null;
  runtime.lastRunNumber = runtime.lastRunSummary?.runNumber ?? null;
  runtime.runningExperiment = null;
  dashboard.updateWidget(ctx, runtime);

  const activeTools = api.getActiveTools();
  const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
  const nextActiveTools = runtime.autoresearchMode
    ? [...new Set([...activeTools, ...EXPERIMENT_TOOL_NAMES])]   // mode on → 添加工具
    : activeTools.filter(name => !experimentTools.has(name));    // mode off → 移除
  const toolsChanged = /* 比较前后列表 */;
  if (toolsChanged) {
    await api.setActiveTools(nextActiveTools);
  }
};
```

### setMode() 函数

`index.ts:107-119` — 将模式变更写入 session entries：

```typescript
// index.ts:107-119 — 设置模式（写 session entry，不持久化到 SQLite）
const setMode = (
  ctx: ExtensionContext,
  enabled: boolean,
  goal: string | null,
  mode: "on" | "off" | "clear",
): void => {
  const runtime = getRuntime(ctx);
  runtime.autoresearchMode = enabled;
  runtime.autoResumeArmed = false;
  runtime.goal = goal;
  runtime.lastAutoResumePendingRunNumber = null;
  // 写入 session entries，实现跨对话持久化
  api.appendEntry("autoresearch-control", goal ? { mode, goal } : { mode });
};
```

`setMode` 不访问 SQLite，只通过 `appendEntry` 写入 session entries。这意味着：
- 模式是跨对话持续的（session entries 随对话保存）
- 不需要 SQLite 就能开关模式
- `rehydrate` 通过 `reconstructControlState` 从 entries 重建模式

### /autoresearch 命令处理流程

`index.ts:126-226` — 完整的命令处理：

```typescript
// index.ts:126-226 — /autoresearch 命令
api.registerCommand("autoresearch", {
  description: "Toggle autoresearch mode, or pass off / clear, or a goal message.",
  // 自动补全: "off", "clear"
  async handler(args, ctx): Promise<void> {
    const trimmed = args.trim();
    const runtime = getRuntime(ctx);

    // 1. 空参数 + mode on → 关闭
    if (trimmed === "" && runtime.autoresearchMode) { /* off */ }

    // 2. "off" → 关闭模式 + 分离工具
    if (trimmed === "off") { /* off + notify */ }

    // 3. "clear" → 关闭 session + 基线重置 + 清理遗留文件
    if (trimmed === "clear" || trimmed.startsWith("clear ")) {
      await handleClear(ctx, runtime, { keepTree, resetTreeForce });
      return;
    }

    // 4. 有 goal/无参数 → 激活 autoresearch
    const goalArg = trimmed.length > 0 ? trimmed : null;
    const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goalArg ?? runtime.goal);
    if (!branchResult.ok) { /* error notify */ return; }

    // 5. 查找已有 session（恢复模式 vs 新会话模式）
    const existingStorage = await openAutoresearchStorageIfExists(ctx.cwd);
    const existingSession = existingStorage?.getActiveSessionForBranch(branchResult.branchName) ?? null;

    if (existingSession && existingStorage) {
      // 恢复已有 session → 注入 command-resume.md
      if (goalArg) existingStorage.updateSession(existingSession.id, { goal: goalArg });
      runtime.state = buildExperimentState(/* 刷新状态 */);
      setMode(ctx, true, runtime.goal, "on");
      api.sendUserMessage(prompt.render(commandResumeTemplate, { branch_status_line, ... }));
    } else {
      // 新会话 → 注入 goal 或 notify
      setMode(ctx, true, goalArg, "on");
      if (goalArg !== null) {
        api.sendUserMessage(goalArg);
      } else {
        ctx.ui.notify("Autoresearch enabled—describe what to optimize.", "info");
      }
    }
  },
});
```

### 自动恢复流程（完整实现）

`index.ts:257-292` — `agent_end` hook：

```typescript
// index.ts:257-292 — agent_end 自动恢复
api.on("agent_end", async (_event, ctx) => {
  const runtime = getRuntime(ctx);
  runtime.runningExperiment = null;   // 确保运行状态清理
  dashboard.updateWidget(ctx, runtime);
  dashboard.requestRender();

  // 条件 1: autoresearchMode === true
  if (!runtime.autoresearchMode) return;

  // 条件 2: 无 pending 用户消息
  if (ctx.hasPendingMessages()) {
    runtime.autoResumeArmed = false;
    return;
  }

  // 条件 3: 存在 pending run
  const { session } = await loadActiveSession(ctx);
  const storage = session ? await openAutoresearchStorageIfExists(ctx.cwd) : null;
  const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
  const pendingRun = pendingRunSummaryFromRow(pendingRow);
  runtime.lastRunSummary = pendingRun;

  // 条件 4: lastAutoResumePendingRunNumber !== pendingRun.runNumber（防重复）
  const shouldResumePendingRun =
    pendingRun !== null && runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber;
  if (!shouldResumePendingRun && !runtime.autoResumeArmed) return;

  // 发送 autoresearch-resume 消息
  runtime.autoResumeArmed = false;
  runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
  api.sendMessage({
    customType: "autoresearch-resume",
    content: prompt.render(resumeMessageTemplate, {
      has_pending_run: Boolean(pendingRun),
    }),
    display: false,                    // 不展示给用户
    attribution: "agent",
  }, { deliverAs: "nextTurn", triggerTurn: true });  // 作为下一个 turn 的输入
});
```

### before_agent_start 完整实现

`index.ts:294-412` — System prompt 注入逻辑：

```typescript
// index.ts:294-412 — before_agent_start handler
api.on("before_agent_start", async (event, ctx) => {
  const runtime = getRuntime(ctx);
  // 1. 非 autoresearch 模式 → 跳过
  if (!runtime.autoresearchMode) return;

  // 2. 重新检查 git 分支（用户可能手动切换）
  const { session, currentBranch } = await loadActiveSession(ctx);
  const onActiveBranch = session === null || session.branch === null || session.branch === currentBranch;
  if (!onActiveBranch) {
    // 用户切换出了 autoresearch 分支 → 静默关闭
    runtime.autoresearchMode = false;
    runtime.state = createExperimentState();
    dashboard.updateWidget(ctx, runtime);
    await api.setActiveTools(api.getActiveTools()
      .filter(name => !new Set(EXPERIMENT_TOOL_NAMES).has(name)));
    return;
  }

  // 3. 从 SQLite 重新加载最新状态
  const storage = await openAutoresearchStorageIfExists(ctx.cwd);
  if (session && storage) {
    runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
  }

  // 4. 检查 pending run
  const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
  const pendingRun = pendingRow ? pendingRunSummaryFromRow(pendingRow) : null;
  runtime.lastRunSummary = pendingRun;

  // 5. 计算显示用指标
  const state = runtime.state;
  const currentSegmentResults = currentResults(state.results, state.currentSegment);
  const baselineMetric = findBaselineMetric(state.results, state.currentSegment);
  const bestMetric = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
  const recentResults = currentSegmentResults.slice(-3).map(result => ({
    asi_summary: summarizeExperimentAsi(result),
    description: result.description,
    metric_display: formatNum(result.metric, state.metricUnit),
    run_number: result.runNumber ?? /* index+1 */,
    status: result.status,
    has_deviations: result.scopeDeviations.length > 0,
    deviations: result.scopeDeviations.join(", "),
    justified: Boolean(result.justification),
    flagged: result.flagged, flagged_reason: result.flaggedReason ?? "",
  }));
  const unjustifiedRuns = currentSegmentResults
    .filter(r => r.status === "keep" && !r.flagged && r.scopeDeviations.length > 0 && !r.justification)
    .slice(-3).map(r => ({ run_number: r.runNumber, paths: r.scopeDeviations.join(", ") }));

  // 6. Phase 1 vs Phase 2 分支
  if (!session) {
    // 无 session → 注入 prompt-setup.md (Phase 1)
    return { systemPrompt: [prompt.render(setupPromptTemplate, { base_system_prompt, goal, ... })] };
  }
  // 有 session → 注入 prompt.md (Phase 2)
  return { systemPrompt: [prompt.render(promptTemplate, { base_system_prompt, goal, notes, recent_results, ... })] };
});
```

### handleClear 流程

`index.ts:414-456` — `/autoresearch clear` 命令的完整处理：

```typescript
// index.ts:414-456 — 清除 session
async function handleClear(
  ctx: ExtensionContext, runtime: AutoresearchRuntime,
  opts: { keepTree: boolean; resetTreeForce: boolean },
): Promise<void> {
  const storage = await openAutoresearchStorage(ctx.cwd);
  const session = storage.getActiveSession();
  const branchName = await tryReadBranch(ctx.cwd);
  const onAutoresearchBranch = branchName?.startsWith("autoresearch/") ?? false;

  // 可选: 重置工作区到基线
  const shouldResetTree = !opts.keepTree && (onAutoresearchBranch || opts.resetTreeForce);
  if (shouldResetTree && session?.baselineCommit) {
    await git.reset(ctx.cwd, { hard: true, target: session.baselineCommit });
    await git.clean(ctx.cwd);
  }

  removeLegacyArtifacts(ctx.cwd);   // 清理 autoresearch.sh, .autoresearch/ 等

  if (session) storage.closeSession(session.id);
  runtime.state = createExperimentState();
  runtime.goal = null;
  // ... 清理其他运行时字段
  setMode(ctx, false, null, "clear");
  dashboard.updateWidget(ctx, runtime);
  await api.setActiveTools(api.getActiveTools().filter(/* 移除实验工具 */));
}
```

---

### 注册的事件

| 事件 | 行号 | 处理函数 | 用途 |
|-------|------|-------------|---------|
| `session_start` | `248` | `rehydrate(ctx)` | 新对话开始时恢复状态 |
| `session_switch` | `249` | `rehydrate(ctx)` | 切换 session 时恢复 |
| `session_branch` | `250` | `rehydrate(ctx)` | 创建 session branch 时恢复 |
| `session_tree` | `251` | `rehydrate(ctx)` | 切换 session tree 节点时恢复 |
| `session_shutdown` | `252` | `clear dashboard, runtime` | 清理 dashboard + 运行时 |
| `agent_end` | `257` | `auto-resume` | 检查 pending run 并自动继续 |
| `before_agent_start` | `294` | `inject system prompt` | 注入 Phase 1 或 Phase 2 的 system prompt |

### rehydrate() 函数

`index.ts:50-105`: 状态恢复的核心逻辑。

```
rehydrate(ctx)
  │
  ├─ 从 session entries 重建控制状态 (reconstructControlState)
  │   └─ 遍历 "autoresearch-control" 类型条目，确定 mode/goal
  │
  ├─ 检查是否曾在当前对话中激活过 (control.lastMode !== null)
  │   └─ 否 → 跳过 storage 加载（不创建 SQLite 文件）
  │
  ├─ 检查分支匹配 (session.branch === currentBranch)
  │   └─ 否 → 保持 mode = false（widget 隐藏，工具分离，但 session entries 保留）
  │
  ├─ 如果匹配 → 从 SQLite 加载 session + runs，buildExperimentState
  │
  ├─ 同步实验工具 (activeTools)
  │   └─ mode on → 添加 experiment 工具；mode off → 移除
  │
  └─ 更新 dashboard
```

### 自动恢复流程

详见[第 5 节的自动恢复图表](#自动恢复-auto-resume-流程)。关键设计:

- **`agent_end` 而非 `tool_result` 触发** — 解耦于特定工具，实现无需人类干预的连续运行
- **`lastAutoResumePendingRunNumber` 防重复** — 确保不会连续发送相同的恢复消息
- **`hasPendingMessages()` 检查** — 如果用户在运行时发送了新消息，自动恢复被抑制，等待用户输入
- **`nextTurn` + `triggerTurn` 交付** — 恢复消息作为下一个 turn 的系统输入，触发 LLM 继续

### System Prompt 注入

`index.ts:294-412` `before_agent_start` handler:

1. 如果 `!runtime.autoresearchMode` → 不操作
2. 重新检查 git 分支 → 如果用户手动切换到非 autoresearch 分支，静默关闭 mode
3. 从 SQLite 重新加载最新状态
4. 检查是否存在 session:
    - **无 session** → 注入 `oh-my-pi/.../prompt-setup.md` (Phase 1 harness setup)
    - **有 session** → 注入 `oh-my-pi/.../prompt.md` (Phase 2 iteration loop)，包含:
     - 当前 segment 编号和运行计数
     - 基线指标和最佳指标
     - 最近 3 个 run 详情（含 ASI 摘要、scope deviations、flagged 状态）
     - 无理由的越界修改清单
     - Pending run 状态
     - Session notes

---

## 13. Dashboard 功能

文件: `dashboard.ts` (436 行)

### 三种显示模式

#### 1. Collapsed Line（单行 widget）

`dashboard.ts:154-221` — 实现：

```typescript
// dashboard.ts:154-221 — 折叠态单行显示
function renderCollapsedLine(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
  // 有 pending run 时:
  if (runtime.lastRunSummary) {
    return [
      theme.fg("accent", "autoresearch"),
      theme.fg("warning", ` pending run #${runtime.lastRunSummary.runNumber}`),
      theme.fg("dim", runtime.lastRunSummary.passed ? " pass" : " fail"),
      // 如果有 parsedPrimary → 显示 parsed metric
      // 附加 " | log_experiment required"
    ].join("");
  }

  // 无结果时:
  if (state.results.length === 0) {
    return [
      theme.fg("accent", "autoresearch"),
      theme.fg("warning", ` ${runtime.autoresearchMode ? "baseline pending" : "mode off"}`),
      // 如果有 name → 显示 | name
      // mode on 时附加 " | run the baseline"
    ].join("");
  }

  // 有结果时 — 完整折叠行:
  const current = currentResults(state.results, state.currentSegment);
  const kept = current.filter(r => r.status === "keep").length;
  const crashed = current.filter(r => r.status === "crash").length;
  const checksFailed = current.filter(r => r.status === "checks_failed").length;
  // 格式: autoresearch N runs K kept +M archived C crash F checks_failed | best X baseline Y | conf Z.x | ctrl+x expand
  // ...
}
```

**典型折叠行输出：**

```
autoresearch 12 runs 8 kept +2 archived 1 crash | best 42.0ms baseline 45.0ms | conf 2.3x | ctrl+x expand
```

```
autoresearch pending run #5 pass | latency_ms=42.5 | log_experiment required
```

```
autoresearch baseline pending | run the baseline | ctrl+x expand
```

#### 2. Expanded Widget

`dashboard.ts:145-152` (header) + `renderDashboardLines` (line 223-329):

```typescript
// dashboard.ts:145-152 — 展开态头部
function renderExpandedHeader(runtime: AutoresearchRuntime, width: number, theme: Theme): string {
  const state = runtime.state;
  const status = renderModeStatus(runtime, state);   // "mode on" / "baseline pending" / "mode off"
  const label = state.name ? ` autoresearch: ${state.name} ` : " autoresearch ";
  const hint = ` ctrl+x collapse  ctrl+shift+x overlay${status ? `  ${status}` : ""} `;
  return truncateToWidth(
    theme.fg("accent", label) + theme.fg("borderMuted", "-".repeat(fillWidth)) + hint, width);
}
```

`renderDashboardLines` — 核心渲染函数（`dashboard.ts:223-329`）。展开态 dashboard 的 body 部分：

```typescript
// dashboard.ts:223-329 — 展开态 body 渲染
export function renderDashboardLines(
  runtime: AutoresearchRuntime, width: number, theme: Theme, maxRows: number,
): string[] {
  const state = runtime.state;
  // 无结果 + pending → 显示 pending run 信息
  // 无结果 + mode on → "Current segment: 0 runs / Baseline: pending / Next action: run baseline"
  // 无结果 + mode off → "No experiments logged yet."

  // 有结果 → 完整视图:
  const lines = [
    `Current segment: ${current.length} runs  ${kept} kept  ...`,
    `Baseline: ${formatNum(baseline, unit)}${runNumber ? ` (#${runNumber})` : ""}`,
  ];

  // 最佳指标 + delta% + 置信度
  if (best) {
    let progress = `Best: ${formatNum(best.metric, unit)} (#${runNumber})`;
    if (baseline !== baseline && baseline !== 0) {
      const delta = ((best.metric - baseline) / baseline) * 100;
      progress += ` ${sign}${delta.toFixed(1)}%`;
    }
    lines.push(progress);
  }

  // 次要指标对比
  if (state.secondaryMetrics.length > 0) {
    const details = state.secondaryMetrics.map(metric =>
      renderSecondarySummary(metric.name, best.metrics[metric.name], baselineSecondary[metric.name], metric.unit));
    lines.push(`Secondary: ${details.join("  ")}`);
  }
  lines.push("");

  // 结果表格
  lines.push(renderTableHeader(state, width, theme));
  lines.push(theme.fg("borderMuted", "-".repeat(width - 1)));
  for (const result of visible) {
    lines.push(renderResultRow(result, state, baselineSecondary, width, theme));
  }

  return lines;
}
```

**renderResultRow — 表格行渲染：**

```typescript
// dashboard.ts:340-365 — 单行结果渲染
function renderResultRow(
  result: ExperimentResult, state: ExperimentState,
  baselineSecondary: { [key: string]: number }, width: number, theme: Theme,
): string {
  const runNumber = result.runNumber ?? state.results.indexOf(result) + 1;
  const secondary = state.secondaryMetrics.map(metric =>
    truncateToWidth(renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]), 10).padEnd(11)
  ).join("");
  const statusColor = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
  const line =
    `${theme.fg("dim", String(runNumber).padEnd(4))}` +
    `${theme.fg("accent", (result.commit || "-").padEnd(10))}` +
    `${theme.fg(statusColor, formatNum(result.metric, state.metricUnit).padEnd(12))}` +
    `${secondary}` +
    `${theme.fg(statusColor, result.status.padEnd(14))}` +
    `${theme.fg("muted", result.description)}`;
  return truncateToWidth(line, width);
}
```

**展开态示例输出：**

```
──────────────────────────────────────────────── autoresearch: optimize-sort  ctrl+x collapse  ctrl+shift+x overlay  mode on ─
Current segment: 5 runs  3 kept  1 discarded  1 crashed  0 checks_failed
Baseline: 45.0ms (#1)
Best: 42.0ms (#4) -6.7%  conf 2.3x
Secondary: memory_mb 256 -2.3%

#    commit     latency_ms   memory_mb    status         description
────────────────────────────────────────────────────────────────────────────────────────
1    a1b2c3d4e  45.0ms       256          keep           baseline
2    b2c3d4e5f  43.0ms       250 (-2.3%)  keep           reduced memory alloc
3    c3d4e5f6g  42.0ms       250           keep           optimized hot path
4    d4e5f6g7h  44.0ms       255           discard        too conservative
5    e5f6g7h8i  0.0ms        -            crash          segfault on edge case
```

#### 3. Overlay（全屏模式）

`dashboard.ts:55-121` — 完整实现：

```typescript
// dashboard.ts:55-121 — 全屏 overlay 实现
async showOverlay(ctx, runtime): Promise<void> {
  if (!ctx.hasUI || !shouldShowDashboard(runtime, runtime.state)) return;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      overlayTui = tui;
      // Spinner 动画（80ms 间隔）
      if (!spinnerTimer) {
        spinnerTimer = setInterval(() => { spinnerFrame++; requestRender(); }, 80);
      }
      let scrollOffset = 0;
      return {
        render(width: number): string[] {
          const terminalRows = process.stdout.rows ?? 40;
          const header = renderExpandedHeader(runtime, width, theme);
          const body = renderDashboardLines(runtime, width, theme, 0);
          if (runtime.runningExperiment) {
            body.push(renderOverlayRunningLine(runtime, theme, width, spinnerFrame));
          }
          const viewportRows = Math.max(4, terminalRows - 4);
          const maxScroll = Math.max(0, body.length - viewportRows);
          if (scrollOffset > maxScroll) scrollOffset = maxScroll;
          const sv = new ScrollView(body.slice(scrollOffset, scrollOffset + viewportRows), {
            height: viewportRows, scrollbar: "auto", totalRows: body.length,
            theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
          });
          sv.setScrollOffset(scrollOffset);
          return [header, ...sv.render(width), renderOverlayFooter(width, theme)];
        },
        handleInput(data: string): void {
          // Vim 风格导航:
          // j/↓ = 下滚  k/↑ = 上滚  g = 顶部  G = 底部
          // pageUp / pageDown = 翻页  q/esc = 关闭
          if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
            done(undefined); return;
          }
          if (matchesKey(data, "up") || data === "k") { scrollOffset = Math.max(0, scrollOffset - 1); }
          else if (matchesKey(data, "down") || data === "j") { scrollOffset = Math.min(maxScroll, scrollOffset + 1); }
          else if (matchesKey(data, "pageUp")) { scrollOffset = Math.max(0, scrollOffset - viewportRows); }
          else if (matchesKey(data, "pageDown")) { scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows); }
          else if (data === "g") { scrollOffset = 0; }
          else if (data === "G") { scrollOffset = maxScroll; }
          tui.requestRender();
        },
        invalidate(): void {},
        dispose(): void { clear(); },
      };
    },
    { overlay: true },   // 全屏模式
  );
}

// dashboard.ts:391-407 — 运行中 spinner 行
function renderOverlayRunningLine(runtime: AutoresearchRuntime, theme: Theme, width: number, spinnerFrame: number): string {
  const spinner = theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length] ?? "*";
  return truncateToWidth(
    theme.fg("warning",
      `${spinner} running ${formatElapsed(Date.now() - (runtime.runningExperiment?.startedAt ?? Date.now()))} ${runtime.runningExperiment?.command ?? ""}`
    ), width);
}

// dashboard.ts:409-413 — 底部提示栏
function renderOverlayFooter(width: number, theme: Theme): string {
  const hint = theme.fg("dim", " up/down j/k pageup pagedown g G esc ");
  return theme.fg("borderMuted", "-".repeat(Math.max(0, width - visibleWidth(hint)))) + hint;
}
```

### Dashboard Controller 工厂

`dashboard.ts:7-123` — 完整控制器创建：

```typescript
// dashboard.ts:7-123 — Dashboard 控制器工厂
export function createDashboardController(): DashboardController {
  let overlayTui: { requestRender(): void } | null = null;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerFrame = 0;

  return {
    clear(ctx): void {
      overlayTui = null;
      if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = undefined; }
      if (ctx.hasUI) { ctx.ui.setWidget("autoresearch", undefined); }
    },
    requestRender(): void { overlayTui?.requestRender(); },
    updateWidget(ctx, runtime): void {
      if (!ctx.hasUI) return;
      const state = runtime.state;
      if (!shouldShowDashboard(runtime, state)) {
        ctx.ui.setWidget("autoresearch", undefined);  // 隐藏 widget
        return;
      }
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        if (state.results.length === 0 && runtime.runningExperiment) {
          return new Text(renderRunningOnly(runtime, state, theme), 0, 0);
        }
        if (runtime.dashboardExpanded) {
          const width = process.stdout.columns ?? 120;
          return new Text([
            renderExpandedHeader(runtime, width, theme),
            ...renderDashboardLines(runtime, width, theme, 8),  // 最多 8 行
          ].join("\n"), 0, 0);
        }
        return new Text(renderCollapsedLine(runtime, state, theme), 0, 0);
      });
    },
    async showOverlay(ctx, runtime): Promise<void> { /* 见上述 overlay 实现 */ },
  };
}
```

### 显示条件

```typescript
// dashboard.ts:136-143 — 满足任一条件即显示 dashboard
function shouldShowDashboard(runtime: AutoresearchRuntime, state: ExperimentState): boolean {
  return (
    runtime.autoresearchMode ||       // 模式开启
    state.results.length > 0 ||        // 有历史结果
    runtime.runningExperiment !== null ||  // 正在运行
    runtime.lastRunSummary !== null    // 有 pending run 摘要
  );
}
```

### 颜色编码

| 状态 | 颜色 |
|--------|-------|
| keep | 绿 (success) |
| discard | 黄 (warning) |
| crash / checks_failed | 红 (error) |
| conf >= 2.0 | 绿 (success) |
| conf >= 1.0 | 黄 (warning) |
| conf < 1.0 | 红 (error) |

---

## 14. Prompt 工程

### 14.1 oh-my-pi/.../prompt.md (103 行) — Phase 2 迭代循环

这是 agent 每次迭代时收到的 system prompt。模板使用 Handlebars 语法（`{{var}}` / `{{#if}}...{{/if}}` / `{{#each}}...{{/each}}`），由 `prompt.render()` 渲染。

**完整内容：**

```markdown
{{base_system_prompt}}

## Autoresearch Mode

Autoresearch mode is active.

{{#if has_goal}}
Primary goal:
{{goal}}
{{else}}
There is no goal recorded for this session yet. Infer what to optimize from the latest user message and the conversation; capture the goal in your notes (`update_notes`) once it is clear.
{{/if}}

Session state and run artifacts are managed for you. The benchmark entrypoint is `bash autoresearch.sh` (committed during Phase 1). Do not edit `autoresearch.sh` mid-segment unless you intentionally bump segment via `init_experiment new_segment: true`. Do not create `autoresearch.md` or `.autoresearch/` in this repo.

Working directory: `{{working_dir}}`
{{#if has_branch}}Active branch: `{{branch}}`{{/if}}
{{#if has_baseline_commit}}Baseline commit: `{{baseline_commit}}`{{/if}}

You are running an autonomous experiment loop. Keep iterating until the user interrupts you or the configured maximum iteration count is reached.

### Available tools
- `init_experiment` — open or reconfigure the session. Pass `new_segment: true` to start a fresh baseline within the current session.
- `run_experiment` — run the benchmark (`bash autoresearch.sh`). Output is captured automatically and `METRIC name=value` / `ASI key=value` lines printed by the harness are parsed back to you. The command is fixed; if you need a different workload, edit `autoresearch.sh` and bump segment via `init_experiment new_segment: true`.
- `log_experiment` — record the result. On `keep`, modified files are committed for you; on `discard`/`crash`/`checks_failed`, the worktree is reverted. Pass `flag_runs` to mark earlier runs as suspect; flagged runs are excluded from baseline and best-metric math.
- `update_notes` — replace the durable session playbook (`body`) or append to the ideas backlog (`append_idea`). The notes are injected into your system prompt every iteration.

### Operating protocol
1. Understand the target before touching code: read source, identify the bottleneck, verify prerequisites and benchmark inputs.
2. Update goal, scope, or constraints via another `init_experiment` call (no segment bump) or `update_notes`. Bump segment when you intentionally change `autoresearch.sh`.
3. Establish a baseline first.
4. Iterate: change code, run `run_experiment`, log honestly with `log_experiment`. One coherent experiment per iteration.
5. Keep the primary metric as the decision maker:
   - `keep` when it improves;
   - `discard` when it regresses or stays flat;
   - `crash` when the run fails;
   - `checks_failed` when validation fails (you decide what validation means; run it through the regular `bash` tool).
6. Use ASI freely — it is opaque, just stash useful learnings (`hypothesis`, `rollback_reason`, `next_action_hint`, anything else).
7. When confidence is low, re-run promising changes before keeping them. `log_experiment` reports a confidence score (multiples of the observed noise floor) on each kept run.

### Scope, off-limits, and accountability
- Edits are not blocked. You can change anything.
- `log_experiment` records the modified paths. Files outside `scope_paths` or inside `off_limits` are recorded as `scope_deviations` on the run.
- If you keep a run with deviations, pass `justification` explaining why. Without it, the run logs but is flagged in the next iteration's prompt as unjustified.
- If a previous run looks reward-hacked or otherwise wrong, pass `flag_runs: [{ run_id, reason }]` on the next `log_experiment` to exclude it from baseline and best-metric calculations.

{{#if has_notes}}
### Your notes (use `update_notes` to edit)

{{notes}}

{{/if}}
{{#if has_recent_results}}
### Current segment snapshot
- segment: `{{current_segment}}`
- runs in current segment: `{{current_segment_run_count}}`
{{#if has_baseline_metric}}
- baseline `{{metric_name}}`: `{{baseline_metric_display}}`
{{/if}}
{{#if has_best_result}}
- best kept `{{metric_name}}`: `{{best_metric_display}}`{{#if best_run_number}} from run `#{{best_run_number}}`{{/if}}
{{/if}}

Recent runs:
{{#each recent_results}}
- run `#{{run_number}}`: `{{status}}` `{{metric_display}}` — {{description}}
{{#if has_asi_summary}}
  ASI: {{asi_summary}}
{{/if}}
{{#if has_deviations}}
  Modified outside scope: {{deviations}}{{#unless justified}} (no justification){{/unless}}
{{/if}}
{{#if flagged}}
  FLAGGED: {{flagged_reason}}
{{/if}}
{{/each}}
{{/if}}
{{#if has_unjustified_runs}}

### Unjustified deviations
{{#each unjustified_runs}}
- run `#{{run_number}}` modified `{{paths}}` outside scope without justification. Either accept it, justify it on the next log, or `flag_runs` it.
{{/each}}
{{/if}}
{{#if has_pending_run}}

### Pending run
An unlogged run is waiting:
- run: `#{{pending_run_number}}`
- command: `{{pending_run_command}}`
{{#if has_pending_run_metric}}
- parsed `{{metric_name}}`: `{{pending_run_metric_display}}`
{{/if}}
- result: {{#if pending_run_passed}}passed{{else}}failed{{/if}}

Finish the `log_experiment` step before starting another benchmark.
{{/if}}

### Guardrails
- Do not game the benchmark.
- Do not overfit to synthetic inputs if the real workload is broader.
- Preserve correctness.
- If the user sends another message while a run is in progress, finish the current run and logging cycle first, then address the new input in the next iteration.
```

**prompt.md 模板变量清单：**

| 变量 | 条件 | 说明 |
|--------|-----------|------|
| `base_system_prompt` | always | OpenCode 的基础 system prompt |
| `goal` | has_goal=true | 优化目标 |
| `has_goal` | always | 是否有 goal |
| `working_dir` | always | 工作目录 |
| `branch` | has_branch=true | 当前分支 |
| `has_branch` | always | 是否有分支 |
| `baseline_commit` | has_baseline_commit=true | 基线 commit（截断到 12 字符） |
| `has_baseline_commit` | always | 是否有基线 commit |
| `notes` | has_notes=true | Session 笔记 |
| `has_notes` | always | 是否有笔记内容 |
| `current_segment` | always | 当前 segment（1-based 显示） |
| `current_segment_run_count` | always | 当前 segment 的运行次数 |
| `baseline_metric_display` | has_baseline_metric=true | 格式化后的基线指标 |
| `has_baseline_metric` | always | 是否有基线指标 |
| `best_metric_display` | has_best_result=true | 格式化后的最佳指标 |
| `best_run_number` | has_best_result=true | 最佳指标对应的 run 编号 |
| `has_best_result` | always | 是否有最佳结果 |
| `recent_results` | has_recent_results=true | 最近 3 个 run 详情数组 |
| `has_recent_results` | always | 是否有最近结果 |
| `unjustified_runs` | has_unjustified_runs=true | 未提供理由的越界修改数组 |
| `has_unjustified_runs` | always | 是否有未提供理由的越界修改 |
| `pending_run_number` | has_pending_run=true | Pending run 编号 |
| `pending_run_command` | has_pending_run=true | Pending run 命令 |
| `pending_run_passed` | has_pending_run=true | Pending run 是否通过 |
| `pending_run_metric_display` | has_pending_run_metric=true | Pending run 解析的指标值 |
| `has_pending_run` | always | 是否有 pending run |
| `has_pending_run_metric` | always | Pending run 是否有解析指标 |

### 14.2 oh-my-pi/.../prompt-setup.md (43 行) — Phase 1 Harness 设置

```markdown
{{base_system_prompt}}

## Autoresearch Mode — Phase 1: Harness Setup

Autoresearch mode is active and there is no session yet. Your job in this turn is to **build the benchmark harness**, not to optimise anything. Optimisation starts only after you call `init_experiment`.

{{#if has_goal}}
Primary goal (for context — implement the harness so it can measure this):
{{goal}}
{{else}}
There is no goal recorded yet. Infer what to optimise from the latest user message and design the harness to measure that. Capture the goal when you call `init_experiment`.
{{/if}}

Working directory: `{{working_dir}}`
{{#if has_branch}}Active branch: `{{branch}}`{{/if}}
{{#if has_baseline_warning}}

{{baseline_warning}}
{{/if}}

### What you must produce

Write `./autoresearch.sh` at the working directory. It is the canonical benchmark entrypoint and must:

- exit 0 on success and non-zero on failure;
- print the primary metric as a single line `METRIC <name>=<value>`;
- print any secondary metrics as additional `METRIC <name>=<value>` lines;
- run the same workload deterministically every time (no live network, no time-of-day dependencies, fixed seeds where applicable).

You **may** edit anything else needed to make `autoresearch.sh` work — benchmark binaries, `Cargo.toml`, `package.json`, helper scripts, fixtures. All those edits are part of the harness baseline and will be committed for you when you call `init_experiment` on an autoresearch branch.

### Steps

1. Inspect the target. Read source, identify what to measure, decide on the workload.
2. Write `autoresearch.sh` plus any supporting files (benchmark binaries, fixtures, etc.).
3. Validate it: invoke `bash autoresearch.sh` through the regular `bash` tool. Confirm it exits 0 and emits at least one `METRIC` line. Iterate on the harness until it does.
4. Call `init_experiment` with the goal, primary metric (matching the `METRIC` name), and scope. This snapshots the worktree as the baseline and starts Phase 2 (the iteration loop).

### Rules

- Do **not** call `run_experiment`, `log_experiment`, or `update_notes` yet. They will error with "no active autoresearch session" until `init_experiment` runs.
- Do **not** treat a compile-only check as a benchmark. The harness must actually execute the workload and emit `METRIC`.
- Do **not** create `autoresearch.md`, `autoresearch.checks.sh`, `autoresearch.program.md`, `autoresearch.ideas.md`, `autoresearch.jsonl`, `.autoresearch/`, or `autoresearch.config.json`. Session state is tracked for you.
```

**prompt-setup.md 模板变量清单：**

| 变量 | 条件 | 说明 |
|--------|-----------|------|
| `base_system_prompt` | always | OpenCode 的基础 system prompt |
| `goal` | has_goal=true | 优化目标（供 harness 设计参考） |
| `has_goal` | always | 是否有 goal |
| `working_dir` | always | 工作目录 |
| `branch` | has_branch=true | 当前分支 |
| `has_branch` | always | 是否有分支 |
| `baseline_warning` | has_baseline_warning=true | 非 autoresearch 分支警告 |
| `has_baseline_warning` | always | 是否有警告 |

### 14.3 oh-my-pi/.../command-resume.md (14 行)

```markdown
Resume autoresearch on the active session.

{{branch_status_line}}
{{#if has_resume_context}}

Additional context from the user:

{{resume_context}}
{{/if}}

- Use the active session context above as the source of truth for goal, scope, constraints, and run history.
- Inspect recent git history for context.
- Continue the most promising unfinished direction.
- Keep iterating until interrupted or until the configured iteration cap is reached.
```

**command-resume.md 模板变量清单：**

| 变量 | 条件 | 说明 |
|--------|-----------|------|
| `branch_status_line` | always | 分支状态描述（创建/使用中/无分支） |
| `resume_context` | has_resume_context=true | 用户提供的恢复上下文 |
| `has_resume_context` | always | 是否有恢复上下文 |

### 14.4 oh-my-pi/.../resume-message.md (10 行)

```markdown
Continue the autoresearch loop now.

- Re-read your notes and the recent-runs context above before deciding the next direction.
- Inspect recent git history for context.
{{#if has_pending_run}}
- A previous benchmark run completed but was never logged. Finish `log_experiment` before starting a new run.
{{/if}}
- Continue from the most promising unfinished direction.
- Keep iterating until interrupted or until the configured iteration cap is reached.
- Preserve correctness and do not game the benchmark.
```

**resume-message.md 模板变量清单：**

| 变量 | 条件 | 说明 |
|--------|-----------|------|
| `has_pending_run` | always | 是否有 pending run 需要处理 |

### 14.5 模板渲染机制

所有 prompt 文件通过 `prompt.render(template, variables)` 渲染（来自 `@oh-my-pi/pi-utils`）。渲染发生在 `before_agent_start` hook 中（`index.ts:294-412`），渲染结果作为 `event.systemPrompt` 的替换内容。

关键特性：
- **Handlebars 兼容语法**：`{{var}}`、`{{#if}}...{{/if}}`、`{{#each}}...{{/each}}`
- **条件注入**：使用 `has_*` 前缀变量控制可选区块
- **数组迭代**：`{{#each recent_results}}...{{/each}}` 渲染多行结果
- **base_system_prompt 始终保留**：prompt 的第一行总是 `{{base_system_prompt}}`，确保基础行为指令不丢失

---

### 14.6 示例 autoresearch.sh 模板

benchmark 脚本是 Phase 1 的核心产物。以下是一个典型的 `autoresearch.sh` 模板：

```bash
#!/usr/bin/env bash
# autoresearch.sh — 基准测试入口
# 必须: exit 0 + 输出 METRIC <name>=<value>
# 约定: 确定性运行（固定 seed，无网络依赖）

set -euo pipefail

# === 配置 ===
WARMUP=3
ITERATIONS=10

# === 编译（如需要） ===
# cargo build --release 2>/dev/null
# npm run build 2>/dev/null

# === Warmup ===
for i in $(seq 1 $WARMUP); do
  ./my-benchmark --seed 42 > /dev/null 2>&1
done

# === Benchmark ===
total=0
for i in $(seq 1 $ITERATIONS); do
  start=$(date +%s%N)
  ./my-benchmark --seed 42
  end=$(date +%s%N)
  elapsed=$(( (end - start) / 1000000 ))  # 毫秒
  total=$(( total + elapsed ))
done

avg=$(( total / ITERATIONS ))

# === 输出 METRIC ===
echo "METRIC latency_ms=${avg}"

# === 可选：输出次要指标 ===
# 也可在程序直接输出 METRIC/ASI 行
# echo "METRIC memory_mb=256"
# echo "ASI hypothesis=baseline established"
```

### 示例 METRIC/ASI 输出

```bash
$ bash autoresearch.sh
Compiling project...
Running benchmark iteration 1/10...
Running benchmark iteration 10/10...
METRIC latency_ms=42.5
METRIC memory_mb=256.0
ASI hypothesis=baseline run with default configuration
```

### 多指标/多命令场景

对于需要多个测试用例的场景，可以在 `autoresearch.sh` 中聚合多个 benchmark：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 测试用例 1: 小数据量
result_small=$(./bench --size small --seed 42 2>/dev/null)
echo "METRIC small_latency_ms=${result_small}"

# 测试用例 2: 大数据量
result_large=$(./bench --size large --seed 42 2>/dev/null)
echo "METRIC large_latency_ms=${result_large}"

# 聚合主指标
echo "METRIC avg_latency_ms=$(( (result_small + result_large) / 2 ))"
```

### Benchmark 脚本设计准则

| 准则 | 说明 |
|--------|-----------|
| **确定性** | 固定 seed、禁用网络/时间依赖，确保可复现 |
| **Warmup** | JIT 编译、缓存预热后再测量 |
| **多次运行** | 至少 3 次，便于 MAD 计算噪声底限 |
| **稳定输出格式** | `METRIC name=value` 每行一个，无多余空格 |
| **退出码** | 成功 0，失败非 0（crash 时自动标记） |
| **日志友好** | 标准输出 = 测量数据，标准错误 = 调试信息 |

---

## 15. 关键设计决策

### 15.1 后验问责 vs. 编辑防护

**选择:** 不阻止越界编辑，而是在 `log_experiment` 时记录偏差并要求合理性说明。

**理由:** Agent 的自主性不应被硬限制束缚；实际优化中，意料之外的文件修改有时是必要的。问责制在保持灵活性的同时提供了透明度。通过 `flag_runs` 可以后续修正标记错误的 run。

### 15.2 MAD 置信度 vs. 标准差

**选择:** Median Absolute Deviation (MAD) 而非标准差作为噪声底限。

**理由:** MAD 对异常值鲁棒——单个极端测量值不会大幅膨胀噪声底限。对于 LLM agent 运行 benchmark 这种经常出现偶发异常值的场景，MAD 更可靠。

### 15.3 SQLite vs. JSON 文件

**选择:** SQLite，非 JSON 文件。

**理由:** 结构化查询能力（按 session/branch/segment 过滤）、事务安全、跨进程持久化、无需处理并发写入冲突。

### 15.4 分支隔离策略

**选择:** 为每个 session 创建 `autoresearch/{slug}-{yyyymmdd}` 分支。

**理由:**
- **干净的回滚:** `discard` 时 `git reset --hard HEAD` + `git clean`
- **清晰的提交历史:** 每次 `keep` 生成一个原子 commit，result JSON 在 commit message 中
- **并行实验:** 不同分支互不干扰
- **易于放弃:** 切换分支即可退出，session 数据保留

### 15.5 Segment 模型

**选择:** 用 segment 将迭代分组，每个 segment 有独立基线。

**理由:** 当 benchmark 本身需要更改（如添加新测试用例、切换 workload）时，bump segment 可以捕获新基线并归档旧结果。历史数据保留但不影响当前分析。

### 15.6 METRIC / ASI 协议

**选择:** 基于标准输出的文本协议，无需库依赖。

**理由:** 任何语言/工具都可以通过简单的 `echo METRIC name=value` 输出指标。ASI 支持自由格式结构化元数据（递归 JSON），无需预定义 schema。这种约定优于配置的模式降低了集成门槛。

### 15.7 自动恢复触发时机

**选择:** `agent_end` hook，而非 `tool_result` 或其他同步点。

**理由:**
- 解耦于特定工具执行
- 支持过夜运行——无需人类在中间步骤介入
- 通过 `nextTurn` + `triggerTurn` 无缝衔接下一次 LLM 调用
- `lastAutoResumePendingRunNumber` 防重复机制

---

## 16. 测试策略

有两个测试文件，共约 1431 行测试代码。

### 测试基础设施（完整模式）

测试使用 `bun:test` 框架，以下是核心基础设施模式：

#### 临时目录创建

```typescript
// autoresearch-state.test.ts:28-32 — 每次测试独立临时目录
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `pi-autoresearch-test-${Snowflake.next()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
```

#### Git 仓库初始化（测试 keep/discard 时使用）

```typescript
// autoresearch-tools.test.ts:71-81 — 测试用 git 仓库
async function initGitRepo(dir: string): Promise<{ baselineCommit: string }> {
  await Bun.write(path.join(dir, "README.md"), "# baseline\n");
  await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline`
    .cwd(dir).quiet();
  const sha = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
  return { baselineCommit: sha };
}
```

#### Harness stub 创建

```typescript
// autoresearch-tools.test.ts:87-89 — 创建测试用 bench 脚本
async function writeHarnessStub(dir: string, body = "echo METRIC m=1"): Promise<void> {
  await Bun.write(path.join(dir, "autoresearch.sh"), `#!/usr/bin/env bash\n${body}\n`);
}
```

#### Mock ExtensionAPI 模式

```typescript
// autoresearch-tools.test.ts:53-69 — 最小 mock API
function createPiHarness(initialTools: string[] = []): PiHarness {
  const activeTools = [...initialTools];
  const api = {
    appendEntry: (customType: string, data?: unknown) => { /* track */ },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    getActiveTools: () => [...activeTools],
    setActiveTools: async (toolNames: string[]) => { /* track & update */ },
    // ...
  } as unknown as ExtensionAPI;
  return { api, activeTools, appendEntries, setActiveToolsCalls };
}
```

#### Dashboard Stub

```typescript
// autoresearch-tools.test.ts:33-40 — 最小 dashboard mock
function dashboardStub() {
  return {
    clear(): void {},
    requestRender(): void {},
    showOverlay: async (): Promise<void> => {},
    updateWidget(): void {},
  };
}
```

### autraresearch-state.test.ts (623 行)

#### State math 基础测试

```typescript
// autoresearch-state.test.ts:54-113
describe("autoresearch state math", () => {
  it("findBaselineMetric returns the first kept run in the segment", () => {
    const results: ExperimentResult[] = [
      makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep" }),
      makeResult({ runNumber: 2, segment: 0, metric: 80, status: "keep" }),
      makeResult({ runNumber: 3, segment: 1, metric: 50, status: "keep" }),
    ];
    expect(findBaselineMetric(results, 0)).toBe(100);
    expect(findBaselineMetric(results, 1)).toBe(50);
    expect(findBaselineRunNumber(results, 0)).toBe(1);
  });

  it("findBaselineMetric ignores flagged results", () => {
    const results = [
      makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep", flagged: true }),
      makeResult({ runNumber: 2, segment: 0, metric: 90, status: "keep" }),
    ];
    expect(findBaselineMetric(results, 0)).toBe(90);
  });

  it("computeConfidence returns null with fewer than three valid runs", () => {
    const results = [
      makeResult({ runNumber: 1, segment: 0, metric: 10, status: "keep" }),
      makeResult({ runNumber: 2, segment: 0, metric: 12, status: "keep" }),
    ];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("computeConfidence is null when noise floor is zero", () => {
    // 所有值相同 → MAD = 0 → null
    const results = [
      makeResult({ runNumber: 1, segment: 0, metric: 10, status: "keep" }),
      makeResult({ runNumber: 2, segment: 0, metric: 10, status: "keep" }),
      makeResult({ runNumber: 3, segment: 0, metric: 10, status: "keep" }),
    ];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("computeConfidence excludes flagged runs from noise floor", () => {
    // flagged 的 run 不参与 MAD 计算
    const noiseyAndKept = [
      makeResult({ runNumber: 1, segment: 0, metric: 100, status: "keep" }),
      makeResult({ runNumber: 2, segment: 0, metric: 99, status: "keep" }),
      // ...
    ];
    const baseConfidence = computeConfidence(noiseyAndKept, 0, "lower");
    const flagged = noiseyAndKept.map((r, i) => (i === 1 ? { ...r, flagged: true } : r));
    expect(computeConfidence(flagged, 0, "lower")).not.toBe(baseConfidence);
  });
});
```

#### Storage round-trip 测试

```typescript
// autoresearch-state.test.ts:115-372
describe("AutoresearchStorage round-trip", () => {
  // 使用 makeTempDir 创建独立数据库目录

  it("persists sessions and exposes the active session", () => {
    const storage = openStorage();
    const session = storage.openSession({
      name: "speed", goal: "make it fast", primaryMetric: "runtime_ms",
      direction: "lower", scopePaths: ["src"], offLimits: ["test"],
      secondaryMetrics: ["memory_mb"],
    });
    const active = storage.getActiveSession();
    expect(active?.name).toBe("speed");
    expect(active?.scopePaths).toEqual(["src"]);
    storage.close();
  });

  it("inserts a run, marks it completed, then logs and flags it", () => {
    // 完整 CRUD 流程验证
  });

  it("abandonPendingRuns marks pending rows abandoned", () => {
    // 验证 pending run 被正确覆盖标记
    const a = storage.insertRun({ /* ... */ });
    const b = storage.insertRun({ /* ... */ });
    expect(storage.abandonPendingRuns(session.id)).toBe(2);
    expect(storage.getPendingRun(session.id)).toBeNull();
  });
});
```

#### Control state 重建测试

```typescript
// autoresearch-state.test.ts:375-393
describe("autoresearch control state", () => {
  it("treats the most recent control entry as authoritative", () => {
    const result = reconstructControlState([
      { type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } } as never,
      { type: "custom", customType: "autoresearch-control", data: { mode: "off" } } as never,
    ]);
    expect(result.autoresearchMode).toBe(false);
    expect(result.lastMode).toBe("off");
  });
});
```

### autoresearch-tools.test.ts (808 行)

#### init_experiment 测试

```typescript
// autoresearch-tools.test.ts:91-269
describe("init_experiment", () => {
  // 每次测试设置环境变量 OMP_AUTORESEARCH_DB_DIR

  it("opens a new session and persists scope and metric metadata", async () => {
    const dir = makeTempDir();
    await writeHarnessStub(dir);
    const runtime = createSessionRuntime();
    const tool = createInitExperimentTool({
      dashboard: dashboardStub(),
      getRuntime: () => runtime,
      pi: createPiHarness().api,
    });
    const result = await tool.execute("call-1", {
      name: "speed", primary_metric: "runtime_ms",
      scope_paths: ["src"], off_limits: ["test"],
    }, undefined, undefined, createCtx(dir));
    expect(firstTextBlockText(result.content)).toContain("Started session");
    expect(result.details?.createdSession).toBe(true);

    const storage = await openAutoresearchStorage(dir);
    const session = storage.getActiveSession();
    expect(session?.primaryMetric).toBe("runtime_ms");
    expect(session?.scopePaths).toEqual(["src"]);
  });

  it("rejects when autoresearch.sh is missing on first init", async () => {
    const dir = makeTempDir();
    const tool = createInitExperimentTool({...});
    const result = await tool.execute("call-1",
      { name: "x", primary_metric: "m" }, ...);
    expect(firstTextBlockText(result.content)).toContain("autoresearch.sh");
    const storage = await openAutoresearchStorage(dir);
    expect(storage.getActiveSession()).toBeNull();  // no session created
  });

  it("auto-commits pending harness changes on an autoresearch branch", async () => {
    // 完整 git 流程验证: harness.sh write → init → auto commit
    const { baselineCommit: initialBaseline } = await initGitRepo(dir);
    await checkoutBranch(dir, "autoresearch/setup-test");
    await writeHarnessStub(dir);
    // ... call tool.execute
    expect(result.details?.harnessCommitted).toBe(true);
    const newHead = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
    expect(newHead).not.toBe(initialBaseline);
  });
});
```

#### run_experiment 测试

```typescript
// autoresearch-tools.test.ts:271-375
describe("run_experiment", () => {
  it("rejects when no session is active", async () => {
    const result = await run.execute("call-1", {}, undefined, undefined, createCtx(dir));
    expect(firstTextBlockText(result.content)).toContain("no active autoresearch session");
  });

  it("accepts arbitrary commands, parses METRIC/ASI, and stores a run", async () => {
    await writeHarnessStub(dir,
      "echo METRIC runtime_ms=42; echo METRIC memory_mb=12; echo ASI hypothesis=baseline");
    // init → run → verify
    const details = result.details as RunDetails;
    expect(details.parsedPrimary).toBe(42);
    expect(details.parsedMetrics).toMatchObject({ runtime_ms: 42, memory_mb: 12 });
    expect(details.parsedAsi).toMatchObject({ hypothesis: "baseline" });
    expect(fs.existsSync(details.benchmarkLogPath)).toBe(true);
  });

  it("abandons a prior pending run instead of blocking", async () => {
    // 连续两次 run_experiment → 第一次的 run 被覆盖标记
    await run.execute("r1", ...);
    const result = await run.execute("r2", ...);
    expect((result.details as RunDetails).abandonedPriorRun).not.toBeNull();
  });
});
```

#### log_experiment 测试

```typescript
// autoresearch-tools.test.ts:377-802
describe("log_experiment", () => {
  // setupRun 辅助函数: init → run → return (runtime, log, harness)

  it("rejects when no pending run exists", async () => {
    const result = await log.execute("l",
      { metric: 1, status: "keep", description: "x" }, ...);
    expect(firstTextBlockText(result.content)).toContain("no pending run");
  });

  it("stores keep with metric and updates baseline", async () => {
    const { log, runtime } = await setupRun(dir);
    const result = await log.execute("l",
      { metric: 10, status: "keep", description: "baseline" }, ...);
    expect(runtime.state.bestMetric).toBe(10);
  });

  it("flags scope deviations and warns when justification is missing", async () => {
    // 编辑 off_limits 内的文件后 keep → 检测到 deviations + 无 justification 警告
    const result = await log.execute("l",
      { metric: 10, status: "keep", description: "wrote forbidden" }, ...);
    expect(firstTextBlockText(result.content)).toContain("unjustified");
  });

  it("on a non-autoresearch branch, discard reverts only run-modified files", async () => {
    // 非分支模式: pre-existing 文件不受影响, run 新增文件被删除
    await Bun.write(path.join(dir, "preexisting.txt"), "leave me\n");
    await run.execute("r", ...);
    await Bun.write(path.join(dir, "src", "new.ts"), "...");
    await log.execute("l", { metric: 12, status: "discard", ...}, ...);
    expect(fs.existsSync(path.join(dir, "src", "new.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "preexisting.txt"), "utf8")).toBe("leave me\n");
  });

  it("on an autoresearch branch, discard reverts uncommitted changes but preserves prior commits", async () => {
    // 分支模式: 之前 keep commit 不可变, 本次未 commit 修改被清理
    await Bun.write(path.join(dir, "src", "kept.ts"), "export const v = 1;\n");
    await $`git add -A && git commit -m "kept iteration"`.cwd(dir).quiet();
    const headBefore = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
    // ... run, edit, log_experiment discard
    expect(headAfter).toBe(headBefore);  // prior commit survives
    expect(fs.existsSync(path.join(dir, "scratch.ts"))).toBe(false);
  });

  it("on an autoresearch branch, keep commits files that were dirty before run_experiment", async () => {
    // agent 在 run_experiment 之前编辑了文件 → 这些修改也应该被 commit
    await Bun.write(path.join(dir, "src", "store.ts"), "export const v = 2;\n");
    await run.execute("r", ...);
    const result = await log.execute("l",
      { metric: 42, status: "keep", description: "improvement" }, ...);
    expect((result.details as LogDetails).experiment.modifiedPaths).toContain("src/store.ts");
    const status = (await $`git status --porcelain`.cwd(dir).text()).trim();
    expect(status).toBe("");  // clean after commit
  });
});
```

#### update_notes 测试

```typescript
// autoresearch-tools.test.ts:804-847
describe("update_notes", () => {
  it("replaces session notes and refreshes runtime state", async () => {
    // init → update_notes body → verify DB + runtime state
    const result = await notes.execute("n",
      { body: "## Plan\n- step one\n" }, ...);
    expect(result.details?.notes).toContain("step one");
    expect(runtime.state.notes).toContain("step one");

    // append_idea 模式
    const append = await notes.execute("n2",
      { body: "", append_idea: "try caching" }, ...);
    expect(append.details?.notes).toContain("- try caching");
  });
});
```

### 测试模式总结

| 模式 | 说明 | 代码示例 |
|------|------|---------|
| **临时目录隔离** | 每个测试独立 `os.tmpdir()` 目录，`beforeEach`/`afterEach` 清理 | `makeTempDir()` |
| **数据库覆盖** | `OMP_AUTORESEARCH_DB_DIR` 环境变量控制 SQLite 位置 | `beforeEach` 设置，`afterEach` 删除 |
| **Git 仓库** | `initGitRepo()` + `checkoutBranch()` + `Bun.$() shell` | `$` git 命令操作 |
| **API Mock** | `createPiHarness()` 追踪工具注册/激活 | `activeTools`, `appendEntries` |
| **Dashboard Stub** | `dashboardStub()` 空实现，无 UI 副作用 | `{ clear(), requestRender(), ... }` |
| **结果检查** | `firstTextBlockText()` 提取工具 text content | `result.content.find(...).text` |
| **Git 状态验证** | shell 命令检查 `git status`, `git log`, `git rev-parse` | `$` `git ...` |

---

## 17. 配置参数

### 环境变量

| 变量 | 默认值 | 用途 | 位置 |
|--------|---------|---------|--------|
| `OMP_AUTORESEARCH_DB_DIR` | `~/.omp/autoresearch/` | 覆盖 SQLite DB 存储目录 | `storage.ts:574` |

### 代码内常量

| 常量 | 值 | 用途 | 位置 |
|----------|-------|---------|--------|
| `EXPERIMENT_MAX_LINES` | 10 | LLM 输出截断行数 | `helpers.ts:6` |
| `EXPERIMENT_MAX_BYTES` | 4096 (4KB) | LLM 输出截断字节数 | `helpers.ts:7` |
| `timeout_seconds` (默认) | 600 (10 分钟) | benchmark 运行超时 | `run-experiment.ts:115` |
| `AUTORESEARCH_BRANCH_PREFIX` | `"autoresearch/"` | 分支名前缀 | `git.ts:5` |
| `BRANCH_NAME_MAX_LENGTH` | 48 | 分支名 slug 最大长度 | `git.ts:6` |

### 可调参数（通过工具参数）

| 参数 | 默认值 | 调优位置 |
|-----------|---------|----------------|
| `init_experiment.max_iterations` | null (无限制) | Agent 调用时指定 |
| `run_experiment.timeout_seconds` | 600 | 每次运行时可指定 |

---

## 18. 已知局限与关注点

### 18.1 MAD null 合并

`computeConfidence` (state.ts:144-170) 在多种边界条件下返回 `null`：样本 < 3、MAD=0、bestKept=baseline、bestKept=null。这些情况的区分在日志中丢失——调用者只知道"置信度不可用"，不知具体原因。

### 18.2 启发式指标单位推断

`inferMetricUnitFromName` (helpers.ts:120-127) 通过后缀启发式推断单位（`_ms` → "ms"、`_kb` → "kb" 等）。这不是完备的，可能产生误导性显示（例如 `memory_usage_kb` 会匹配 `_kb` 规则，但 `inference_time_ms` 也匹配 `_ms` 规则——这些都是正确的，但模式枚举不完整）。

### 18.3 无迁移策略

Schema 版本通过 `PRAGMA user_version` 跟踪（当前为 1, storage.ts:192），但 `SCHEMA_SQL` 使用 `CREATE TABLE IF NOT EXISTS` 而非迁移脚本。如果添加新列，现有数据库不会自动升级。

### 18.4 JSON 列的脆弱性

数组列（`pre_run_dirty_paths_json`、`scope_deviations_json` 等）以 JSON 字符串存储，使得:
- 无法在 SQL 中查询特定路径
- `parseAsiData` (storage.ts:690-698) 使用裸 `as ASIData` 断言而非递归验证
- `structuredClone` 在 ASI 递归类型上的脆弱性（state.ts:71）

### 18.5 双轨跟踪：lastRunSummary 与 pendingRun

`AutoresearchRuntime` 同时包含 `lastRunSummary` (PendingRunSummary type) 和通过 SQLite 查询的 `pendingRun`——两者表示同一概念但来源不同，存在不一致风险。`index.ts:272` 的 `??=` 回退逻辑可能隐藏问题。

### 18.6 Dashboard Spinner 泄漏

`dashboard.ts:9` `spinnerTimer` 是一个模块级变量，在 overlay 关闭时通过 `clear()` (line 16-22) 清理。如果在 `clear()` 之前 TUI 断开，interval 可能泄漏。当前设计假设 TUI 生命周期严格匹配 overlay 显示周期。

### 18.7 分支分配的小概率碰撞

`encodeProjectKey` (storage.ts:17-19) 将 `/a/b` 和 `/a-b` 都编码为 `--a-b--`。这在实践中极少发生，但理论上存在碰撞风险。

### 18.8 无原生进程看门狗

`executeProcess` (run-experiment.ts:269-341) 使用 JS `setInterval` 推送进度更新。如果 `executeBash` 挂起（不响应 SIGTERM），看门狗无法强制终止——依赖外部的 `AbortSignal`。

---

## 19. ZooKeeper 实现路线

### 19.1 三阶段路线图

**Phase 1: 移植**
- 从 omp 的 autoresearch 模块提取核心代码
- 适配到 ZooKeeper 的 TypeScript 插件架构 (`src/`)
- 保留 4 个工具 + SQLite 持久化 + segment + MAD confidence
- 目标: ZooKeeper 也有 `/autoresearch` 命令
- 预计改动文件: `src/index.ts`, `src/hooks/autoresearch/` (新目录)

**Phase 2: 内核调优特化**
- 定义 `perf-tuner` agent (config.toml + core/prompts/perf-tuner.md)
- 定义 `perf-tuning` skill (core/skills/perf-tuning/SKILL.md)
- 调整超时 (内核编译 > 600s)
- 定义内核 benchmark 指标约定 (METRIC throughput_mbps, latency_p99_us, ...)
- 定义 scope/off-limits 约束模板

**Phase 3: 蒸馏 + 知识积累**
- 跑几轮内核调优实验
- 记录调优轨迹
- 蒸馏为 `wiki/analysis/` 页面（为什么 RCU 比 spinlock 快、cache line 对齐的实际效果等）
- 形成稳定的 `perf-tuning` skill (方法论沉淀)

### 19.2 需要从 omp 移植的核心组件

| 组件 | 源文件 | 行数 | 移植难度 |
|------|--------|------|---------|
| 类型定义 | `types.ts` | 168 | 低 — 直接复制 |
| 状态管理 + MAD 算法 | `state.ts` | 273 | 低 — 直接复制 |
| SQLite 存储层 | `storage.ts` | 699 | 中 — 适配 Bun→Bun/Node SQLite |
| Git 操作 | `git.ts` | 319 | 中 — 适配 git 工具调用 |
| METRIC/ASI 解析 | `helpers.ts` | 218 | 低 — 直接复制 |
| 4 个实验工具 | `tools/*.ts` | 1312 | 中 — 适配 OpenCode 工具 API |
| Plugin hooks | `index.ts` | 536 | 高 — 适配 ZooKeeper 插件架构 |
| Dashboard | `dashboard.ts` | 436 | 高 — 适配 Ink/Blessed TUI |
| Prompt 模板 | `*.md` (4个) | ~170 | 低 — 适配模板变量 |
| **总计** | | **~4131** | |

### 19.3 ZooKeeper 与 omp 的关键差异（移植时注意）

| 维度 | omp (Pi 自身) | ZooKeeper | 影响 |
|------|---------------|-----------|------|
| 运行时 | Bun | Bun | 相同 ✅ |
| SQLite | `bun:sqlite` | `bun:sqlite` | 直接复用 ✅ |
| **运行时身份** | **Pi 自身代码**（fork/演进） | **OpenCode 插件** | ⚠️ omp 的 autoresearch 有 Pi 运行时的深度访问权；ZooKeeper 是外挂插件，访问面受限 |
| **Extension API** | Pi 专有 Extension Bridge（`appendEntry`、`sendMessage`、`on`） | OpenCode SDK client API（`getSession`、`session.todo`） | ⚠️ **关键差异** — omp 可写入自定义 session entry 并监听深度生命周期事件；ZooKeeper 目前只能读取 |
| **Session 管理** | Pi 原生 `SessionManager`（3622 行）+ `session-storage.ts`（529 行）+ JSONL/SQL/Redis 多后端 | OpenCode SDK 内置 session 管理，ZooKeeper 仅通过 `client.getSession()` / `client.session.todo()` 访问 | 🔴 **最关键差异** — 见下方"Session 管理差异深度分析" |
| **Session 文件** | `~/.local/share/omp/sessions/<encoded-cwd>/*.jsonl`（Pi 自己管理，支持 tree-based entries） | `~/.local/share/opencode/`（OpenCode 管理，ZooKeeper 插件不直接访问） | omp 的 session 文件可被 plugin 直接读写；ZooKeeper 只能通过 SDK API 读取 |
| TUI 框架 | Ink (React for CLI) | ? | 需要确认 ZooKeeper 的 TUI 方案 |
| Git 工具 | Bun shell (`Bun.$()`) | bash / Bun shell | 需适配 |
| 多 agent | 单 agent 编排器 | build 编排器 + 多个 subagent | autoresearch 工具需注入到 perf-tuner 而非 build |

#### Session 管理差异深度分析

**omp（Pi 自身）的 Session 架构**：

```
packages/coding-agent/src/session/
├── session-manager.ts       3622 行   ← 核心，tree-based entries，appendCustomEntry
├── session-storage.ts        529 行   ← SessionStorage 接口 + FileSessionStorage
├── session-dump-format.ts              ← dump 格式
├── indexed-session-storage.ts          ← IndexedSessionStorage 抽象
├── sql-session-storage.ts              ← SQL 后端 (PostgreSQL/MySQL/SQLite)
└── redis-session-storage.ts            ← Redis 后端

存储: ~/.local/share/omp/sessions/<encoded-cwd>/*.jsonl
  写入机制: NdjsonFileWriter (fs.writeSync → kernel page cache, 可抗 OOM/SIGKILL)
  Entry 结构: tree-based (id + parentId, 可遍历)
  Entry 类型: message / custom / custom_message / compaction / model_change / mode_change / branch_summary / label / session_init 等
```

**autoresearch 对 Pi session 的依赖**（无法直接用 OpenCode 插件 API 替代）：

| omp API | 用途 | ZooKeeper 现状 |
|---------|------|----------------|
| `ExtensionAPI.on("session_start" \| "session_switch" \| "session_branch" \| "session_tree")` | 状态恢复 rehydrate() | ❌ 无对应 hook |
| `ExtensionAPI.on("agent_end")` | 自动恢复 auto-resume | ❌ 无对应 hook |
| `ExtensionAPI.on("before_agent_start")` | 注入 prompt | ❌ 无对应 hook |
| `ExtensionAPI.appendEntry("autoresearch-control", data)` | 写入自定义 session entry | ❌ 无对应 API |
| `ExtensionAPI.sendMessage({ customType: "autoresearch-resume", ... })` | 发送 LLM 上下文消息 | ❌ 无对应 API |
| `sessionManager.getBranch()` | 遍历 tree entries 重建状态 | ❌ 无对应 API |

**ZooKeeper 的 Session 访问能力**（当前）：

```
src/hooks/utils/agent.ts:
  export async function getAgentName(client, sessionId) {
    const session = await client.getSession(sessionId);
    return session?.agent;             ← 只读 session.agent 字段
  }

src/hooks/utils/todo-state.ts:
  const response = await client.session.todo({ path: { id: sessionID } });
  const todos = response.data;         ← 只读 todo 列表
```

ZooKeeper plugin 自身从不直接访问 `~/.local/share/opencode/` 下的 SQLite 数据库。该数据库仅被 `tools/zoo-find`、`tools/zoo-trace` 等**离线 Python CLI 工具**以只读方式查询，用于事后分析。

#### 移植的关键障碍

基于以上差异，autoresearch 的以下核心机制无法直接移植到 ZooKeeper：

1. **`reconstructControlState`** — 依赖 `sessionManager.getBranch()` 扫描 `autoresearch-control` 类型的 custom entries（ZooKeeper 无法写入 custom entries，也无法在 plugin 内读取）
2. **auto-resume 循环** — 依赖 `agent_end` hook 发送 `autoresearch-resume` 消息触发下一轮迭代（ZooKeeper 插件当前无法监听 agent_end）
3. **prompt 注入** — 依赖 `before_agent_start` hook 注入 `prompt.md` / `prompt-setup.md`（ZooKeeper 的 config hook 只能在 LLM 启动前注入一次，非每 turn 动态）

**可能的移植路径**：

| 方案 | 描述 | 难度 |
|------|------|------|
| **A. 增强 OpenCode SDK** | 向 OpenCode 贡献/扩展 SDK，支持 `appendCustomEntry`、session lifecycle hooks | 高 — 需修改 OpenCode 平台本身 |
| **B. 降级循环模式** | 不依赖 session entry 持久化，改用独立的 SQLite + 由 build 在每个 turn 显式触发 rehydrate | 中 — 可移植但丧失 auto-resume 等高级特性 |
| **C. 基于 ZooKeeper 自建循环协议** | 让 build 通过 bash 脚本（`bash autoresearch.sh` + 自研 Python 工具）驱动循环，不集成进 OpenCode 的 agent 运行时 | 低 — 可立即实现，但丧失 TUI dashboard 和 LLM 交互深度 |
| **D. Fork OpenCode 或演进到 Pi** | ZooKeeper 改用 Pi 作为运行时基线 | 战略级决策 |

### 19.4 perf-tuner agent 设计概要

```toml
[agent.perf-tuner]
mode  = "subagent"
model = "{env:ZOO_MODEL}"       # 强模型
[agent.perf-tuner.permission]
task = "deny"                   # 不委派，专注执行
webfetch = "deny"               # 不查 web
websearch = "deny"
# 其余默认 allow（read/write/edit/bash/grep/glob）
```

Prompt 关键要素:
- 身份: "You are the kernel performance tuning expert"
- 关注点: 热点分析、汇编解读、pipeline 行为、cache 行为、锁竞争
- 工作模式: 通过 autoresearch 工具进入自主循环
- 输出: METRIC (通过 benchmark.sh) + ASI (hypothesis, rollback_reason)

### 19.5 perf-tuning skill 设计概要

```yaml
name: perf-tuning
description: 内核性能调优方法论。由 build 在收到性能相关请求时加载，决定是否委派给 perf-tuner。
```

内容:
- 调优哲学: measure first, profile → analyze → change → verify → measure again
- 工具链约定: perf、ftrace、BPF 的使用规范和输出解析
- 决策树: 什么情况下委派 perf-tuner、什么情况下用 general + explore
- 报告模板: 调优成果如何记录到 wiki/analysis/

### 19.6 典型工作流

```
用户: "优化 e1000 网卡驱动的 RX 处理延迟"
  │
  ▼
build (加载 perf-tuning skill):
  1. 判断: 这是典型的迭代优化任务 → 委派 perf-tuner
  2. 构造 prompt: SUMMARY + CONTEXT + ACCEPTANCE
  │
  ▼
perf-tuner (接收 autoresearch 工具):
  Phase 1:
    - 读内核源码，理解 e1000 RX 路径
    - 写 autoresearch.sh (编译模块 + 跑 benchmark + 输出 METRIC)
    - 调用 init_experiment
  Phase 2 (自主循环):
    LOOP:
    - 读 perf 数据，识别热点
    - 修改代码 (如: batch processing, napi 优化)
    - run_experiment → 5-30 分钟编译 + 跑分
    - log_experiment keep/discard
    - ASI hypothesis=..., rollback_reason=...
    - 如果 conf ≥ 2.0 → 改善可信
  │
  ▼
build: 审查结果 + 汇总给用户
kiwi (可选): 将调优经验 ingest 到 wiki/analysis/
```

---

> **延伸阅读:**
> - [Karpathy 的原始 autoresearch 项目](https://github.com/karpathy/autoresearch)
> - OpenCode 扩展系统文档: [`docs/extensions.md`](./extensions.md)
> - Hook 系统文档: [`docs/hooks.md`](./hooks.md)