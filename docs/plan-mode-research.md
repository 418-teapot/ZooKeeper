# Plan Mode Detection and Switching Research

**Version: 0.2 — Date: 2026-06-10 — Classification: 技术调研**

> **实现状态更新 (2026-06-10)**: 本报告中的所有方案均处于纯设计阶段，尚未有任何代码实现。`core/prompts/plan.md` 不存在，`config.toml` 中无 `[agent.plan]` 块，`src/hooks/` 下无任何 plan mode 相关代码。Plan Mode 仍作为未来方向保留。

---

## 目录

1. [概述](#1-概述)
2. [OpenCode 原生 Plan Agent](#2-opencode-原生-plan-agent)
   - [2.1 内置 Plan Agent 机制](#21-内置-plan-agent-机制)
   - [2.2 Tab 切换交互](#22-tab-切换交互)
   - [2.3 ZooKeeper 当前缺口](#23-zookeeper-当前缺口)
3. [参考项目分析](#3-参考项目分析)
   - [3.1 Superpowers: Skill 自动门控](#31-superpowers-skill-自动门控)
   - [3.2 oh-my-openagent: Prometheus + demoted plan](#32-oh-my-openagent-prometheus--demoted-plan)
   - [3.3 oh-my-opencode-slim: 编排器即规划者](#33-oh-my-opencode-slim-编排器即规划者)
   - [3.4 oh-my-pi: plan subagent + /plan 双层设计](#34-oh-my-pi-plan-subagent--plan-双层设计)
4. [对比分析](#4-对比分析)
5. [ZooKeeper 适配方案](#5-zookeeper-适配方案)
   - [方案 A: 纯 Prompt 引导](#方案-a-纯-prompt-引导)
   - [方案 B: 新增 Plan Subagent](#方案-b-新增-plan-subagent)
   - [方案 C: 默认 Plan 模式 + 命令驱动状态机](#方案-c-默认-plan-模式--命令驱动状态机)
6. [改进方向](#6-改进方向)
7. [总结](#7-总结)

---

## 1. 概述

ZooKeeper 当前的工作流围绕 build（编排器）为主 agent、general/explore/spider/scout 为 subagent 的委派模式构建。用户通过 Tab 键在主 agent 和 build agent 之间切换，直接开始编码工作。这种模式在处理纯实现任务时高效流畅，但存在一个结构性缺口：**当用户需要讨论方案设计、架构决策或技术选型时，没有专门的"规划模式"引导 agent 先思考再实现。**

具体问题表现为：

- **缺乏规划触发器**：用户说"帮我想想怎么重构这个模块"时，build agent 会尝试直接调用 subagent 来实现，而不是先进行方案设计讨论。
- **实现冲动**：LLM 天然倾向于产生可运行的输出（代码、命令），在需要纯粹讨论和规划的场景中，agent 仍可能尝试执行工具调用。
- **无模式切换视口**：用户需要自行判断何时应该从"实现模式"切换到"规划模式"，并由自己按 Tab 键手动切换。

本报告调研四种参考项目如何处理"先规划后实现"的问题——Superpowers 的 Skill 自动门控机制、oh-my-openagent (omo) 的双层规划架构、oh-my-opencode-slim 的编排器即规划者模式以及 oh-my-pi (omp) 的 plan subagent + /plan 双层设计——并针对 ZooKeeper 的架构特点提出三种适配方案。

---

## 2. OpenCode 原生 Plan Agent

### 2.1 内置 Plan Agent 机制

OpenCode 内置了一个名为 `plan` 的 primary agent，其默认配置如下：

| 字段 | 值 | 说明 |
|------|-----|------|
| `mode` | `primary` | 主 agent，可通过 Tab 切换 |
| `permission.edit` | `ask` | 编辑前需用户确认 |
| `permission.bash` | `ask` | 执行命令前需用户确认 |

`plan` agent 的设计意图是：用户进入计划模式后，agent 仅进行方案分析和讨论，所有写操作都需要用户逐一确认，从而在"说"和"做"之间建立一道人工审批门禁。

**关键澄清**：OpenCode 的 `mode` 字段仅接受 `primary`、`subagent`、`all` 三个值。`plan` 是 agent 名称而非模式名称——不存在内置的 `"plan"` 模式类型。

### 2.2 Tab 切换交互

OpenCode 的 Tab 键切换机制作用于所有 `mode: "primary"` 的 agent：

```
┌─────────────────────────────────────────────────────────────┐
│                  OpenCode 主界面 (Tab 切换)                  │
│                                                             │
│  当前 agent: [build]                                        │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  用户消息: 帮我想想怎么重构这个模块                   │   │
│  │                                                     │   │
│  │  build agent: 好的，我来分析一下...                   │   │
│  │  (可能直接调用工具开始实现)                           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Tab → 切换到 plan agent                                    │
│                                                             │
│  当前 agent: [plan]                                         │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  用户消息: 帮我想想怎么重构这个模块                   │   │
│  │                                                     │   │
│  │  plan agent: 好的，我们先讨论设计方案...             │   │
│  │  (只讨论，edit/bash 需用户确认)                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

用户需要**手动**按 Tab 键在 primary agents 之间切换。OpenCode 不会自动检测用户意图并切换 agent。

### 2.3 ZooKeeper 当前缺口

ZooKeeper 的 `config.toml` 中未配置 `[agent.plan]` 块，因此 OpenCode 使用内置默认的 `plan` agent：

- **无自定义 prompt**：内置 plan agent 没有 ZooKeeper 风格的 prompt 文件（`core/prompts/plan.md` 不存在）
- **权限风格不一致**：内置 plan agent 使用 `edit: "ask"` 和 `bash: "ask"`，而非 ZooKeeper 的 deny-list 风格
- **无规划专用指令**：prompt 中未包含 ZooKeeper 特有的规划流程要求（如"必须先产出方案文档再批准实施"）
- **用户需主动 Tab 切换**：没有任何自动检测机制来提示用户进入 plan 模式

当前状态总结：

| 维度 | 状态 |
|------|------|
| plan agent 是否存在 | ✅ 存在（OpenCode 内置默认） |
| 是否有自定义 prompt | ❌ 无（`core/prompts/plan.md` 不存在） |
| 权限是否符合 ZooKeeper 风格 | ❌ 使用 ask 而不是 deny |
| 自动检测规划意图 | ❌ 无 |
| 与 build agent 的协作流程 | ❌ 无（各自独立） |
| **插件层 Plan Mode 实现** | **❌ 未实现** — 无 `src/hooks/plan-mode/`，无状态机，无工具阻断 |
| **/go /go-with-risk /redirect 命令** | **❌ 未实现** — 无 `chat.message` hook 检测逻辑 |

---

## 3. 参考项目分析

### 3.1 Superpowers: Skill 自动门控

Superpowers（https://github.com/superpowers）是一个基于 Skill 系统的 AI 智能体框架，其核心机制是"先规划后实现"的**强制门控**。

#### 3.1.1 架构总览

```
Superpowers 技能流水线
│
├─ 1. 会话启动注入 (hooks/session-start)
│   ├─ 注入"check skills before anything"基本原则
│   └─ 注册所有可用技能的元信息
│
├─ 2. brainstorming 技能（强制第一站）
│   ├─ 自动检测：任何需要创造性工作的请求
│   │   ├─ 架构设计 → 触发 brainstorming
│   │   ├─ 方案讨论 → 触发 brainstorming
│   │   ├─ 重构需求 → 触发 brainstorming
│   │   └─ 简单实现请求 → 跳过 (直接进入 writing-plans 或实现)
│   │
│   ├─ 工作流阶段:
│   │   ├─ 探索 (Explore) — 理解需求，收集约束
│   │   ├─ 澄清 (Clarify) — 确认假设，消除模糊性
│   │   ├─ 方案生成 — 产出 2-3 个候选方案
│   │   ├─ 设计评审 — 分析 trade-off
│   │   └─ 用户批准 — 用户确认方案后继续
│   │
│   └─ HARD-GATE: 用户必须显式批准方案才能进入下一阶段
│
├─ 3. writing-plans 技能
│   ├─ 将批准的设计转化为结构化计划
│   └─ 产出包含依赖关系、并行波次、验收标准的计划文件
│
└─ 4. 实现技能 (subagent-driven-development 等)
    └─ 按计划分派子智能体执行
```

#### 3.1.2 触发机制

Superpowers 的触发体系由三个层次构成：

| 层次 | 机制 | 说明 |
|------|------|------|
| L1 | 启动注入 | 在 session-start hook 中注入基本原则，确保所有后续行为都经过技能检查 |
| L2 | 规则门控 | "check skills before anything" 规则要求 agent 在采取任何行动前先评估适用的技能 |
| L3 | 自动检测 | brainstorming 技能内部实现自动检测逻辑，判断当前请求是否属于"创造性工作" |

**HARD-GATE 模式**：brainstorming 技能最核心的设计是——在用户明确批准设计方案之前，禁止任何实现工作。这通过在技能文件的 Red Flags 表和 Terminal State 模式中实现。

#### 3.1.3 关键设计模式

**Red Flags 表**：预设在技能文件中，列列举 LLM 可能用来跳过规划的常见合理化借口，以及对应的现实纠正：

```
| 合理化借口 | 现实 |
|-----------|------|
| "这个问题很简单" | 简单的问题也可能有复杂的隐含假设 |
| "用户急着要" | 越急越需要规划，否则返工更慢 |
| "我先试一下" | 试验应当在计划中被明确标记为实验步骤 |
```

**Terminal State 模式**：每个技能在执行完成后，必须显式命名下一个要执行的技能，形成不可跳过的链式依赖：

```
brainstorming: "→ 下一步：writing-plans"
writing-plans: "→ 下一步：subagent-driven-development"
subagent-driven-development: "→ 完成"
```

#### 3.1.4 与 ZooKeeper 的适配性分析

| 维度 | 评估 |
|------|------|
| 强门控确保先规划后实现 | ✅ 强力保证 |
| 用户交互负担 | 🟡 中（每次需显式批准方案） |
| 实现复杂度 | 🔴 高（需要完整的 Skill 系统和 hooks 链） |
| 与 OpenCode 现有机制的兼容性 | 🟡 中（Skill 系统需要额外适配） |
| 对现有 ZooKeeper prompt 的影响 | 🔴 大（需要重写 build.md 等） |

### 3.2 oh-my-openagent: Prometheus + demoted plan

oh-my-openagent（omo）是一个基于 OpenCode 插件构建的多 Agent 编排参考实现，采用"双 agent 规划架构"：Prometheus 作为主规划者（primary agent），原生 plan agent 被降级为隐藏 subagent。

#### 3.2.1 架构总览

```
omo 双 Agent 规划架构
│
├─ Prometheus（主规划者，mode: primary）
│   ├─ ~1200 行超长 prompt，内置完整规划方法论
│   ├─ 权限：edit=allow，bash=allow（可写可执行）
│   ├─ prometheus-md-only：tool.execute.before 中阻断
│   │   Writes/Edits，除非路径匹配 `.omo/*.md`
│   └─ 不可 task() plan agent（同属 PLAN_FAMILY_NAMES）
│
└─ plan agent（降级 subagent，hidden: true）
    ├─ 继承 Prometheus 的 MODEL_SETTINGS_KEYS（不含 prompt）
    ├─ 提示词注入方式：动态组装（非静态文件）
    ├─ 获取完整工具集（无 AGENT_RESTRICTIONS 条目）
    └─ 可见于 task() 通过 isDemotedPlanAgent() 特殊逻辑
```

#### 3.2.2 Plan Agent 降级机制

降级在 `agent-config-assembly.ts` 中实现，由两个配置字段控制：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `planner_enabled` | boolean | `true` | 是否启用 Prometheus 作为主规划者 |
| `replace_plan` | boolean | `true` | 是否将内置 plan agent 降级为 subagent |

核心逻辑 `buildPlanDemoteConfig()`：

```typescript
// src/agent-config-assembly.ts（概念示意）
function buildPlanDemoteConfig(): AgentConfig {
  return {
    mode: "subagent",
    hidden: true,
    // 仅继承 MODEL_SETTINGS_KEYS（model、temperature 等）
    // 不继承 prompt — plan 使用动态注入的提示词
    ...pick(primaryConfig, MODEL_SETTINGS_KEYS),
  };
}
```

降级后的 plan agent：
- `mode: "subagent"` — 不再是 Tab 可切换的 primary agent
- `hidden: true` — 在 agent 列表中不可见
- **仅继承** Prometheus 的 `MODEL_SETTINGS_KEYS`（模型名、temperature 等参数），**不继承** prompt

#### 3.2.3 动态 Prompt 注入

Plan agent 的提示词**不是静态文件**——它在 `task()` 调用时通过 `prompt-builder.ts` 动态组装：

```typescript
// src/prompt-builder.ts（概念示意）
function buildPlanAgentSystemPrepend(): string {
  return [
    BEFORE_SKILLS,       // 上下文收集指令
    buildSkillsSection(), // 动态技能列表（根据可用工具实时生成）
    AFTER_SKILLS,        // 输出格式要求
  ].join("\n\n");
}
```

关键设计：
- **仅 plan agent** 获得该 prepend——`isPlanAgent()` 守卫确保 Prometheus 不会被误注入
- **BEFORE_SKILLS**：引导 agent 在调用任何工具前先收集上下文
- **buildSkillsSection()**：动态列举可用技能，根据运行时工具注册情况生成
- **AFTER_SKILLS**：规定响应格式（如必须包含推理步骤）

#### 3.2.4 Prometheus 专属约束

**prometheus-md-only hook**（`tool.execute.before`）：

```typescript
// tool.execute.before 中
if (isPrometheusAgent(input.agent)) {
  if ((input.tool === "write" || input.tool === "edit") &&
      !input.args.path?.startsWith(".omo/") &&
      !input.args.path?.endsWith(".md")) {
    throw new Error("[Prometheus] 仅允许写入 .omo/*.md 文件");
  }
}
```

Prometheus 虽然拥有 `edit: allow` 和 `bash: allow` 权限，但通过此 hook **运行时限制**其写操作范围——只能写 `.omo/*.md` 文件，不能修改项目源码。

**互斥委派机制**：

```typescript
// 规划 agent 家族 — 互斥 task()
const PLAN_FAMILY_NAMES = ["plan", "prometheus"];

// 在 task() 调用时检测
if (PLAN_FAMILY_NAMES.includes(target) &&
    PLAN_FAMILY_NAMES.includes(current)) {
  throw new Error("规划 agent 之间不允许互相委派");
}
```

Prometheus 和 plan agent 属于同一"规划家族"（`PLAN_FAMILY_NAMES`），两者不能互相通过 `task()` 调用，防止循环委派。

#### 3.2.5 权限模型

| agent | permission.edit | permission.bash | AGENT_RESTRICTIONS | 运行时约束 |
|-------|----------------|-----------------|-------------------|-----------|
| Prometheus | allow | allow | PROMETHEUS_PERMISSION（显式条目） | prometheus-md-only：仅 .omo/*.md |
| plan | 无条目（继承全部） | 无条目（继承全部） | 无条目（全部允许） | 动态 prompt 引导行为 |

Prometheus 在 `AGENT_RESTRICTIONS` 中有显式条目（`PROMETHEUS_PERMISSION`），而 plan agent **没有对应条目**——这意味着 plan 默认获得全部工具权限。plan 的行为约束完全由动态注入的 prompt 控制，而非权限系统。

#### 3.2.6 Subagent 可见性

Plan agent 虽然被降级为 `hidden: true`，但仍然可被 `task()` 发现——`subagent-discovery.ts` 中的 `isDemotedPlanAgent()` 特殊逻辑将其从隐藏列表中"恢复"为可见：

```typescript
// src/subagent-discovery.ts（概念示意）
function isDemotedPlanAgent(agent: AgentConfig): boolean {
  return agent.name === "plan" && agent.hidden === true;
}
```

这使得 build 等编排 agent 仍然可以通过 `task(subagent_type="plan", ...)` 调用已降级的 plan agent，实现规划即服务的模式。

#### 3.2.7 与 ZooKeeper 的适配性分析

| 维度 | 评估 |
|------|------|
| 双 agent 规划架构（主规划者 + 降级 subagent） | ✅ 灵活分工：Prometheus 负责大局，plan 处理具体任务 |
| 动态 prompt 注入而非静态文件 | ✅ 可根据运行时上下文调整规划指令 |
| 运行时文件写保护（prometheus-md-only） | ✅ 防止规划 agent 意外修改源码 |
| 规划家族互斥委派 | ✅ 防止循环调用 |
| 实现复杂度 | 🔴 高（~1200 行 prompt + 多个 TS hook + 动态组装） |
| 与 ZooKeeper 现有架构的兼容性 | 🟡 中（需要引入动态 prompt 组装逻辑） |

### 3.3 oh-my-opencode-slim: 编排器即规划者

oh-my-opencode-slim（slim）是一个极简 OpenCode 配置参考实现，**没有独立的 plan agent，也没有 plan 模式**。规划能力完全嵌入编排器（orchestrator）的 prompt 中。

#### 3.3.1 架构总览

```
slim 规划体系
│
└─ Orchestrator（编排器，也是唯一的"规划者"）
    ├─ Prompt 内置 6 步工作流：
    │   1. Understand — 理解用户需求
    │   2. Path Selection — 选择实现路径
    │   3. "STOP. Review specialists before acting"
    │      （委派检查 — 隐式规划步骤）
    │   4. Split and Parallelize — 拆解并行任务
    │   5. Execute — 执行
    │   6. Verify — 验证
    │
    ├─ Delegation Check（第 3 步）：
    │   ─ 显式要求 agent "停下来，先审查可用的 specialists"
    │   ─ 这是 slim 中唯一的隐式规划机制
    │
    ├─ 工具集：完整（edit、bash、read 等全部可用）
    │
    └─ Subtask 工具 — 轻量级规划原语
        └─ src/tools/subtask/：
            ─ 创建独立上下文隔离的子会话
            ─ 每个 subtask 有独立的 prompt 和工具集
            ─ 可在 orchestrator 中并行执行
```

#### 3.3.2 Delegation Check：隐式规划

Slim 的规划能力不在于专门的规划 agent，而在于 orchestrator prompt 中的关键一步：

```markdown
## Workflow

3. **STOP. Review specialists before acting**
   - Before executing any task, review the available specialists
   - Determine if the task should be delegated to a specialist
   - Consider: complexity, domain expertise needed, parallelism opportunity
```

这一步强制编排器在采取任何行动之前**停下来**思考：
- 当前任务是否需要委派 specialists？
- 能否拆分为多个并行子任务？
- 哪个 specialist 最适合处理每个子任务？

这是 slim 中最接近"规划"的机制——虽然没有独立的规划步骤，但通过 prompt 指令在编排器中嵌入了规划思维。

#### 3.3.3 Subtask 工具：轻量规划原语

`src/tools/subtask/` 提供了 slim 的轻量级规划+执行原语：

```typescript
// src/tools/subtask/（概念示意）
interface SubtaskInput {
  goal: string;           // 子任务目标
  context: string;        // 上下文（文件路径、现有代码等）
  agent?: string;         // 指定 specialist
}

interface SubtaskOutput {
  result: string;         // 执行结果
  artifacts: string[];    // 产出文件列表
}
```

Subtask 的核心设计：
- **上下文隔离**：每个 subtask 运行在独立的会话中，互不干扰
- **并行执行**：多个 subtask 可以同时运行
- **可指定 specialist**：将子任务分配给最合适的 agent

#### 3.3.4 Designer：UI/UX 专家（非规划者）

Slim 中有一个 `designer` agent，但它的定位是 **UI/UX 专家**，而非规划者：

| 属性 | 值 |
|------|-----|
| mode | subagent |
| temperature | 0.7（比默认更高，鼓励创意） |
| delegation rules | 空（不委派任何子 agent） |
| 职责 | 前端 UI/UX 设计、组件结构规划 |
| 触发 | 由 orchestrator 通过 task() 手动调用 |

Designer 不触发规划流程，仅在 orchestrator 需要 UI/UX 专业知识时才被调用。

#### 3.3.5 权限模型

| agent | 工具集 | 子 agent | 规划能力 |
|-------|-------|---------|---------|
| orchestrator | 全部（edit、bash、read 等） | subtask + specialists | 隐式（prompt 内嵌） |
| specialists | 受限（取决于角色） | 无（leaf node） | 无 |
| designer | read、write、question | 无 | 无（仅 UI 设计） |

Slim 的权限模型是典型的**编排器全权限 + subagent 受限**：编排器拥有所有工具，subagent 是叶节点，不进一步委派。

#### 3.3.6 与 ZooKeeper 的适配性分析

| 维度 | 评估 |
|------|------|
| 零额外 agent、零额外模式 | ✅ 极简，无需新增任何 agent 配置 |
| 隐式规划嵌入编排器 prompt | 🟡 轻量但依赖 LLM 理解遵守 |
| Subtask 作为规划原语 | ✅ 轻量级上下文隔离并行执行 |
| 无需动态 prompt 注入 | ✅ 所有规划逻辑在静态 prompt 中 |
| 实现复杂度 | 🟢 低（仅修改 orchestrator prompt） |
| 规划保障强度 | 🟡 弱（纯 prompt 约束，LLM 可绕过） |

### 3.4 oh-my-pi: plan subagent + /plan 双层设计

oh-my-pi（omp）是一个基于 OpenCode 插件构建的深度规划参考实现，采用**双层规划体系**：静态的 plan subagent（可被编排器 task() 调用）+ 动态的 `/plan` 模式（会话级状态机）。

#### 3.4.1 架构总览

```
omp 双层规划体系
│
├─ Layer 1: Plan Subagent（静态）
│   ├─ 注册于 task/agents.ts，配置固定
│   ├─ 工具集：read/search/find/bash/lsp/web_search/ast_grep
│   │          （NO write/edit — 纯分析不产出代码）
│   ├─ spawns: explore agent（强制探索阶段）
│   ├─ model: pi/plan + pi/slow（双模型）
│   └─ thinking-level: high
│
└─ Layer 2: /plan 模式（动态状态机）
    ├─ #enterPlanMode() 入口
    │   ├─ 添加 "resolve" 工具到 active tools
    │   ├─ 设置 PlanModeState 状态
    │   └─ 注册 standing resolve handler
    │
    ├─ plan-mode-guard.ts：enforcePlanModeWrite()
    │   ├─ 阻断所有 write/edit/delete/move 操作
    │   └─ 仅允许 local:// 沙箱的 artifact 写入
    │
    ├─ 批准流程：resolve { action: "apply" }
    │   └─ 4 种选择：execute / compact context / keep context / refine plan
    │
    └─ 配套机制：
        ├─ plan-mode-active.md（109 行）：规划范式 prompt
        ├─ plan-protection.ts：保护 plan 文件不被 compaction 剪枝
        └─ plan-handoff.ts：将批准的 plan 传递给 subagent 作为共享上下文
```

#### 3.4.2 Plan Subagent（Layer 1）

在 `task/agents.ts` 中配置的 plan subagent：

```typescript
// task/agents.ts（概念示意）
const planAgent = {
  name: "plan",
  tools: [
    "read", "search", "find", "bash",
    "lsp", "web_search", "ast_grep",
    // 注意：没有 write/edit — plan 只分析不产出
  ],
  spawns: ["explore"],     // 强制进入探索阶段
  model: ["pi/plan", "pi/slow"], // 双模型：plan 专用 + 慢思考
  "thinking-level": "high",
};
```

**4 阶段工作流**（在 plan subagent 的 prompt 中定义）：

```
Phase 1: Understand
  ─ 分析需求，明确目标与约束

Phase 2: Explore（MUST spawn explore agents）
  ─ 强制：必须先 spawn explore agent 进行代码库调研
  ─ explore agent 使用 read/search/find 收集上下文
  ─ 返回调研报告给 plan agent

Phase 3: Design
  ─ 基于探索结果设计方案
  ─ 对比候选方案，分析 trade-off

Phase 4: Produce Plan
  ─ 输出 6 节结构规划文档：
    1. Summary — 方案概述
    2. Changes — 具体变更清单
    3. Sequence — 实施步骤与依赖关系
    4. Edge Cases — 边界情况与风险
    5. Verification — 验证策略
    6. Critical Files — 关键文件列表
```

#### 3.4.3 /plan 模式（Layer 2）

`/plan` 是一个会话级状态机，通过 `enterPlanMode()` 函数进入：

```typescript
// plan-mode.ts（概念示意）
function enterPlanMode(sessionID: string): void {
  // 1. 添加 resolve 工具到 active tools
  addTool(sessionID, "resolve", {
    handler: resolveHandler,
    // resolve 工具用于批准/拒绝/修改计划
  });

  // 2. 设置 PlanModeState
  setPlanModeState(sessionID, {
    active: true,
    phase: "planning",
    planFile: null,
    resolved: false,
  });

  // 3. 注册 standing resolve handler
  registerStandingHandler(sessionID, "resolve", handleResolve);
}
```

**plan-mode-guard.ts — 写保护**：

```typescript
// plan-mode-guard.ts（概念示意）
function enforcePlanModeWrite(tool: string, args: Record<string, unknown>): void {
  if (tool !== "write" && tool !== "edit" && tool !== "delete" && tool !== "move") {
    return; // 非写操作，放行
  }

  // 仅允许写入 local:// 沙箱的 artifact 文件
  const path = args.path as string;
  if (!path.startsWith("local://")) {
    throw new Error(
      "[Plan Mode] 规划模式下禁止修改工作区文件。\n" +
      "规划结果应输出到 local:// 沙箱路径。\n" +
      "如需退出规划模式，请使用 resolve 工具。"
    );
  }
}
```

在 `/plan` 模式下：
- 所有 `write`/`edit`/`delete`/`move` 操作被**阻断**
- 仅 `local://` 沙箱路径的 artifact 写入被允许
- 这确保规划阶段不会意外修改项目源码

#### 3.4.4 批准与移交流程

```typescript
// 批准流程：用户或 LLM 调用 resolve 工具
const resolution = {
  action: "apply",        // 批准规划
  extra: {
    title: "refactor-payment-module", // 规划文档 slug
  },
};

// resolve handler 提供 4 种选择：
// 1. execute        → 退出 plan 模式，按规划开始实现
// 2. compact context → 压缩上下文后继续
// 3. keep context    → 保持当前上下文继续
// 4. refine plan     → 留在 plan 模式，优化规划
```

**plan-handoff.ts**：批准的规划文档通过此模块传递给后续的 subagent：

```typescript
// plan-handoff.ts（概念示意）
function handoffPlan(planFile: string, targetAgent: string): void {
  // 将规划文档作为共享上下文注入 targetAgent
  injectSharedContext(targetAgent, {
    type: "plan",
    source: planFile,
    content: readPlanFile(planFile),
  });
}
```

**plan-protection.ts**：规划文档受保护，不会被上下文 compaction 机制剪枝：

```typescript
// plan-protection.ts（概念示意）
function isProtectedFile(path: string): boolean {
  return path.startsWith(".pi/plans/") || path.endsWith(".plan.md");
}
```

#### 3.4.5 规划范式 Prompt

`plan-mode-active.md`（109 行）定义了 `/plan` 模式下的核心范式：

> **规划文档是执行规范，不是设计文档。**
> - 必须自包含，不依赖历史对话上下文
> - 每条指令必须精确到文件路径、函数名
> - 子 agent 必须能独立理解并执行

该 prompt 强调规划的**可执行性**而非设计美感——规划文档应当能被其他 agent 直接理解并执行，不依赖对话上下文。

#### 3.4.6 权限与能力对比

| 层次 | 工具集 | 写操作 | 模型 | 思维层级 |
|------|-------|-------|------|---------|
| Plan Subagent (Layer 1) | read/search/find/bash/lsp/web_search/ast_grep | ❌ 禁止 | pi/plan + pi/slow | high |
| /plan 模式 (Layer 2) | 基础工具 + resolve 工具 | ❌ 阻断（仅 local://） | 可切换至 pi/plan | — |
| 执行阶段（退出 /plan 后） | 全部 | ✅ 允许 | 默认模型 | 默认 |

#### 3.4.7 与 ZooKeeper 的适配性分析

| 维度 | 评估 |
|------|------|
| 双层规划（subagent + 模式） | ✅ 灵活：task() 调用规划 + 手动进入规划模式 |
| 仅分析不产出（plan subagent 无 write/edit） | ✅ 纯规划 agent，不会意外修改代码 |
| 强制探索阶段（MUST spawn explore） | ✅ 规划前先充分理解代码库 |
| /plan 模式的写保护 | ✅ 硬约束，LLM 无法绕过 |
| resolve 工具 + 4 种后处理选择 | ✅ 灵活的批准/迭代流程 |
| 规划文档受 compaction 保护 | ✅ 避免长会话中规划被剪枝 |
| 实现复杂度 | 🔴 高（~5 个 TS 模块 + 专用 prompt + 状态机） |
| 与 ZooKeeper 现有架构的兼容性 | 🟡 中（需要新增 plan 模式状态机和写保护） |

---

## 4. 对比分析

### 4.1 六种方案维度对比

| 维度 | OpenCode 原生 Plan | Superpowers Skill 门控 | omo Prometheus+demoted plan | slim 编排器即规划者 | omp plan subagent + /plan |
|------|-------------------|----------------------|---------------------------|--------------------|---------------------------|
| **触发方式** | 用户手动 Tab 切换 | 自动检测 + 规则门控 | 双 agent 自动委派 | 编排器 prompt 内嵌 | subagent task() + /plan 命令 |
| **用户控制力** | 完全手动 | 低（系统自动门控） | 中（通过 task 调用） | 低（编排器自动判定） | 高（命令行 + resolve 工具） |
| **是否强制规划** | 否 | 是（HARD-GATE） | 是（双 agent 架构） | 条件性（prompt 指引） | 是（/plan 模式写保护） |
| **实现位置** | 平台内置 | 独立 Skill 系统 | 插件 + agent-config 组装 | 编排器 prompt + subtask 工具 | 插件 + 状态机 + 多 TS 模块 |
| **实现成本** | 零（已有） | 高（完整 Skill 框架） | 高（~1200 行 prompt + 多 hook） | 低（仅改 prompt） | 高（~5 TS 模块 + 状态机） |
| **与 ZooKeeper 兼容性** | 🟡 风格不一致 | 🔴 架构冲突大 | 🟡 需动态 prompt 注入 | ✅ 极简，无冲突 | 🟡 需新增状态机和写保护 |
| **自定义 prompt 支持** | 需要手动加 config | 原生支持 | 动态组装（非静态文件） | 静态 prompt 内嵌 | 静态 prompt + mode prompt |
| **规划→执行过渡** | 手动 Tab 切回 | Skill 链自动流转 | task() 委派 + 运行时约束 | 编排器自动流转 | resolve 工具 + 4 种选择 |
| **对现有配置的影响** | 无（新增 agent 块） | 颠覆性 | 中（需降级 plan agent） | 极小 | 中（需新增 plan 模式状态） |

### 4.2 规划保障强度对比

| 模式 | 用户能否跳过规划 | 规划产出 | 过渡控制 | 安全性 |
|------|----------------|---------|---------|-------|
| OpenCode 原生 plan | ✅ 可跳过（不切 Tab 即可） | 无结构化要求 | 无 | 低 |
| Superpowers HARD-GATE | ❌ 不可跳过 | 结构化方案文档 | 用户批准 | 高 |
| omo Prometheus+plan | ❌ 不可跳过（双 agent 架构） | 动态注入引导 | task() 委派 | 高（写保护 hook） |
| slim 编排器即规划者 | ✅ 可跳过（prompt 指引） | 无强制结构 | 编排器自动流转 | 低（纯 prompt） |
| omp /plan 模式 | ❌ 不可跳过（写保护阻断） | 6 节结构文档 | resolve 工具 | 高（硬约束） |

### 4.3 ZooKeeper 适配优先级矩阵

| 方案 | 实现成本 | 用户价值 | 风险 | 推荐度 |
|------|---------|---------|------|-------|
| Pure Prompt | 🟢 低 | 🟡 中 | 🟢 低 | ⭐⭐⭐ |
| Plan Subagent | 🟡 中 | ✅ 高 | 🟡 中 | ⭐⭐⭐⭐ |
| Plugin Plan Mode | 🟡 中 | ✅ 高 | 🟢 低 | ⭐⭐⭐⭐⭐ |

---

## 5. ZooKeeper 适配方案

以下三种方案从简到繁排列，每种方案都是独立的可实施方案。方案 C 为推荐首选。

### 方案 A: 纯 Prompt 引导

**思路**：在 `build.md` 中增加规划检测规则，当用户消息包含规划意图关键词时，prompt 引导 agent 提示用户按 Tab 切换到 plan agent。

**实现步骤**：
1. 新建 `core/prompts/plan.md`，定义规划专用 prompt
2. 在 `config.toml` 中添加 `[agent.plan]` 块，引用 plan.md 并设置合适权限
3. 在 `build.md` 末尾添加规划检测规则

**流程图示**：

```
用户: "帮我想想怎么重构这个模块"
     │
     ▼
build agent (via build.md prompt)
     │
     ├─ 检测到规划关键词 ("想想" / "重构" / "设计方案")
     │
     ├─ agent 回复:
     │   "看起来您需要先进行方案设计。我建议您按 Tab 切换到 Plan Agent，
     │    它可以帮您进行结构化方案讨论而不会直接修改代码。"
     │
     └─ 用户按 Tab → 切换到 plan agent
              │
              ▼
         plan agent (via plan.md prompt)
              │
              ├─ 仅进行方案讨论
              ├─ 产出方案文档 (纯讨论，无工具调用)
              └─ 用户确认方案后 Tab 切回 build agent
```

> **推荐演进**：TR 确定 `/go` 命令作为规划→实现的推荐过渡机制。当前方案使用 Tab 切换，后续可演进为：用户在 plan agent 中讨论完方案后输入 `/go` 触发切换，省去手动 Tab 操作。

**核心修改**：`build.md` 新增规则示例：

```
## Plan Mode Detection

When the user's message contains keywords like:
- "想想" / "设计方案" / "选型" / "对比"
- "architect" / "design" / "plan" / "approach" / "trade-off"
- "应该用什么" / "怎么实现" / "如何组织"

Respond with: "看起来您需要先进行方案设计。我建议您按 Tab 切换到 Plan Agent，
它可以帮您进行结构化方案讨论而不会直接修改代码。"

Do NOT attempt to design in the build agent — you are an implementation agent.
Design work belongs in the plan agent.
```

**新增 config.toml 配置**：

```toml
[agent.plan]
model = "{env:CAMBRICON_MODEL}"
[agent.plan.permission]
edit = "ask"
bash = "ask"
```

| 维度 | 评价 |
|------|------|
| 实现成本 | 🟢 低（仅改 prompt + config） |
| 保障强度 | 🟡 弱（依赖 agent 理解 prompt，可被绕过） |
| 用户体验 | 🟡 中（需手动 Tab 切换） |
| 维护成本 | 🟢 低 |

### 方案 B: 新增 Plan Subagent

**思路**：将 plan 作为 build 的一个 subagent，用户通过 `task()` 委托规划任务，规划产出文件后 build 再根据方案实施。

**实现步骤**：
1. 创建 `core/prompts/plan.md`（规划专用 prompt）
2. 在 `config.toml` 中添加 `[agent.plan]` 块，mode 设为 `subagent`
3. 在 `build.md` 中增加：当需要规划时，通过 `task(subagent_type="plan", prompt="...")` 委托
4. plan agent 只允许 write（方案文件）、read、question，禁止 edit/bash

**流程图示**：

```
用户: "帮我想想怎么重构这个模块"
     │
     ▼
build agent (编排器)
     │
     ├─ 识别到需要规划
     │
     ├─ task(subagent_type="plan", prompt="SUMMARY: ...")
     │     │
     │     ▼
     │  plan subagent
     │     │
     │     ├─ 仅使用 read 和 question 工具
     │     ├─ write 设计文档 (e.g., refactor-plan.md)
     │     │   ├─ 当前架构分析
     │     │   ├─ 候选方案 (2-3 个)
     │     │   ├─ 推荐方案 + 理由
     │     │   └─ 实施步骤
     │     └─ 返回完成状态给 build
     │
     ├─ 读取 plan 产出物
     │
     ├─ 向用户展示方案并等待确认
     │
     └─ 用户确认后 → 按 plan 开始实现 (task → general)
```

> **推荐演进**：TR 确定 `/go` 命令作为规划→实现的推荐过渡机制。当前方案由 build 编排器自动流转，用户确认后也可通过 `/go` 显式触发实现阶段，提供更明确的交接点。

**新增 config.toml 配置**：

```toml
[agent.plan]
mode  = "subagent"
model = "{env:CAMBRICON_MODEL}"
[agent.plan.permission]
edit  = "deny"
bash  = "deny"
task  = "deny"
# 允许 write 以产出规划文档，read/grep/glob 以分析代码
```

**plan.md 核心指令**：

```markdown
You are a **technical planning agent**. You NEVER implement code.
Your job is to produce structured design documents.

Workflow:
1. Use read/grep/glob to understand the current codebase
2. Ask the user clarifying questions if needed (use question tool)
3. Design 2-3 candidate approaches with trade-off analysis
4. Produce a plan file (.md) with:
   - Current architecture analysis
   - Candidate approaches (2-3)
   - Recommended approach with rationale
   - Implementation steps with dependencies
   - Acceptance criteria for each step

You may ONLY use: read, grep, glob, list, question, write (to create plan files)
You must NEVER: edit, bash, task, webfetch, websearch
```

| 维度 | 评价 |
|------|------|
| 实现成本 | 🟡 中（新增 agent 配置 + plan.md + build.md 修改） |
| 保障强度 | ✅ 高（权限 deny 确保 plan 不实现） |
| 用户体验 | ✅ 好（build 自动委派，用户无需 Tab 切换） |
| 维护成本 | 🟡 中 |

### 方案 C: 默认 Plan 模式 + 命令驱动状态机

**思路**：每个会话默认从规划模式开始，通过插件在会话启动时注入 plan prompt 并阻断实现类工具调用。用户通过专用命令退出规划模式进入实现阶段——参考 OMA 的 `default_mode.ultrawork` 设计，但作为默认行为而非可选项。

**实现步骤**：
1. 新建 `core/prompts/plan.md`
2. 在 `src/index.ts` 中扩展：
   - 在 `config` hook 中注册 plan agent 并设置为默认（如果未在 config.toml 中配置）
   - 在会话启动时自动进入 plan 模式，注入 plan prompt 并启用工具阻断
   - 在 `chat.message` hook 中实现命令检测（`/go`, `/go-with-risk`, `/redirect`）
3. 状态转换完全由命令驱动，无需关键词检测

**状态转换图**：

```
                        ┌─────────────────────────────┐
                        │    会话开始 (Session Start)   │
                        └─────────────┬───────────────┘
                                      │
                                      ▼
              ┌─────────────────────────────────────────────┐
              │  ★ Plan Mode（默认）                        │
              │  ├─ 注入 plan.md 到 system prompt            │
              │  ├─ 工具阻断: edit/bash/webfetch/websearch    │
              │  │           ❌（read/grep/glob/question ✅） │
              │  └─ agent 仅进行方案讨论和代码分析             │
              └────────┬──────────┬───────────┬─────────────┘
                       │          │           │
                       │          │           │
                       ▼          ▼           │
              ┌────────────┐ ┌───────────┐    │
              │  /go       │ │ /go-with- │    │
              │  批准方案   │ │ risk      │    │
              │  进入实现   │ │ 承担风险   │    │
              │            │ │ 进入实现   │    │
              └──────┬─────┘ └─────┬─────┘    │
                     │             │          │
                     ▼             ▼          │
              ┌──────────────────────────┐    │
              │  Implementation Mode     │    │
              │  ├─ 清除 plan prompt      │    │
              │  ├─ edit/bash ✅ 恢复     │    │
              │  └─ 按规划方案开始实现     │    │
              └──────────────────────────┘    │
                                              │
                                       ┌──────┘
                                       │ /redirect
                                       │ 需要重规划
                                       ▼
              ┌─────────────────────────────────────────────┐
              │  Plan Mode（重新开始）                       │
              │  ├─ 清除之前的规划上下文                       │
              │  ├─ 重新注入 plan prompt                      │
              │  └─ agent 重新收集上下文、重提方案              │
              └─────────────────────────────────────────────┘
```

**流程说明**：

- **默认规划模式**：每个新会话自动进入 Plan Mode，无需用户输入关键词或手动切换。这是与 OMA IntentGate 的核心差异——OMA 需要关键词触发或配置 `default_mode`，而 ZooKeeper 将此作为默认行为。
- **`/go` 命令**：用户确认方案后输入 `/go`，插件清除 plan prompt 并解除工具阻断，agent 进入实现模式按规划开展工作。
- **`/go-with-risk` 命令**：与 `/go` 类似，但会在会话中记录风险标记（例如跳过了某些安全检查或测试），agent 在实现时需要额外注意。适用于用户了解风险但仍想继续的场景。
- **`/redirect` 命令**：用户在讨论过程中发现方向偏差，输入 `/redirect` 回到 Plan Mode 重新开始——清除原上下文，重新注入 prompt，agent 重新收集信息并提出新方案。

**命令对比**：

| 命令 | 效果 | 适用场景 |
|------|------|---------|
| `/go` | 退出 Plan Mode，进入 Implementation | 方案已完善，用户批准 |
| `/go-with-risk` | 退出 Plan Mode，进入 Implementation（带风险标记） | 有已知风险但用户决定承担 |
| `/redirect` | 留在/回到 Plan Mode，重新规划 | 方向偏差、需要新方案 |

**代码实现框架**：

```typescript
// src/plan-mode.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../../../core");

// 进程内模式状态 —— 跨 Hook 调用共享
const planModeSessions = new Map<string, boolean>();
const PLAN_PROMPT = loadPrompt("plan");

// （可选）重规划意图关键词 —— 当用户自然语言表达方向调整时，可自动建议 /redirect
const REDIRECT_KEYWORDS = [
  // 中文
  /想想/u, /设计/u, /重构/u, /方案/u, /选型/u, /架构/u, /对比/u,
  /怎么组织/u, /如何实现/u, /应该用什么/u,
  // 英文
  /\barchitect\b/i, /\bdesign\b/i, /\bplan\b/i, /\bapproach\b/i,
  /\btrade.?off\b/i, /\brefactor\b/i, /\bpropose\b/i,
];

// 退出/重定向命令
const GO_PATTERN = /^\/go$/;
const GO_WITH_RISK_PATTERN = /^\/go-with-risk$/;
const REDIRECT_PATTERN = /^\/redirect$/;

/**
 * 检测是否为 /go 或 /go-with-risk 命令
 */
export function isGoCommand(message: string): boolean {
  return GO_PATTERN.test(message.trim()) || GO_WITH_RISK_PATTERN.test(message.trim());
}

/**
 * 检测是否为 /redirect 命令
 */
export function isRedirectCommand(message: string): boolean {
  return REDIRECT_PATTERN.test(message.trim());
}

/**
 * （可选）检测用户自然语言中的重规划意图
 * 当 plan 模式下用户间接表达方向调整意愿时，
 * 可用来自动建议 /redirect 命令
 */
export function detectRedirectIntent(message: string): boolean {
  return REDIRECT_KEYWORDS.some((re) => re.test(message));
}

/**
 * 进入 plan 模式
 */
export function enterPlanMode(sessionID: string): void {
  planModeSessions.set(sessionID, true);
}

/**
 * 退出 plan 模式
 */
export function exitPlanMode(sessionID: string): void {
  planModeSessions.delete(sessionID);
}

/**
 * 检查 session 是否在 plan 模式
 */
export function isPlanMode(sessionID: string): boolean {
  return planModeSessions.get(sessionID) ?? false;
}

/**
 * 获取 plan prompt 内容
 */
export function getPlanPrompt(): string | undefined {
  return PLAN_PROMPT;
}
```

**工具阻断实现**：

```typescript
// 在 tool.execute.before hook 中
async "tool.execute.before"(
  input: { tool: string; sessionID: string },
  _output: { args?: Record<string, unknown> },
) {
  if (!isPlanMode(input.sessionID)) return;

  const BLOCKED_IN_PLAN = new Set(["edit", "write", "bash"]);

  if (BLOCKED_IN_PLAN.has(input.tool)) {
    throw new Error(
      `[ZooKeeper Plan Mode] "${input.tool}" 在规划模式下已被阻断。` +
      "规划模式仅允许 read/grep/glob/question 等分析工具。\n" +
      "如需退出规划模式，请输入 /go（批准方案）或 /go-with-risk（承担风险）；\n" +
      "如需重新规划，请输入 /redirect。"
    );
  }
}
```

| 维度 | 评价 |
|------|------|
| 实现成本 | 🟡 中（约 150 行 TS，新增 plan.md） |
| 保障强度 | ✅ 高（工具阻断是硬约束，LLM 无法绕过） |
| 用户体验 | ✅ 好（默认规划 + 命令驱动退出） |
| 维护成本 | 🟢 低（命令可配置，阻断逻辑清晰） |
| 与现有架构兼容性 | ✅ 高（增量式修改，不改变现有 prompt 和 config） |

---

## 6. 改进方向

### 🔴 短期（1-2 周，可独立实施）— ❌ 全部未实现

| 序号 | 改进项 | 方案 | 优先级 |
|------|-------|------|--------|
| 1 | 创建 `core/prompts/plan.md` | 编写规划专用 prompt，定义规划工作流和产出规范 | 🔴 高 |
| 2 | 在 `config.toml` 中注册 plan agent | 添加 `[agent.plan]` 块，设置合理权限，作为默认 agent | 🔴 高 |
| 3 | 默认开启 plan 模式 | 插件在会话启动时自动进入规划模式，无需关键词检测 | 🔴 高 |

### 🟡 中期（2-4 周，涉及插件修改）— ❌ 全部未实现

| 序号 | 改进项 | 方案 | 优先级 |
|------|-------|------|--------|
| 4 | 实现插件层默认 plan 模式 + 工具阻断（方案 C） | 在 `config` hook 中默认启用 plan 模式，`tool.execute.before` 阻断实现工具 | 🔴 高 |
| 5 | 实现 /go, /go-with-risk, /redirect 命令 | 在 chat.message hook 中检测命令，执行状态转换 | 🔴 高 |
| 6 | 规划产出验证 | 在 `/go` 前检查是否生成了有效的规划方案 | 🟡 中 |
| 7 | plan prompt 与现有 prompt 的一致性验证 | 确保 plan.md 与 build.md 在规划流程上不冲突 | 🟡 中 |

### 🟢 长期（4-8 周，需评估收益）— ❌ 全部未实现

| 序号 | 改进项 | 方案 | 优先级 |
|------|-------|------|--------|
| 8 | 可配置的默认模式行为 | 允许高级用户通过 config.toml 配置某些项目类型跳过 plan 模式（如纯修复类任务） | 🟢 低 |
| 9 | HARD-GATE 实验 | 参考 Superpowers 的 HARD-GATE 设计，探索在 ZooKeeper 中实现"不规划不实现"的强制门控 | 🟢 低 |
| 10 | 规划产出自动化评估 | 使用 LLM-as-Judge 评估规划文档的完整性和质量 | 🟢 低 |
| 11 | 多轮规划对话支持 | 在 plan 模式中支持多轮对话迭代方案，而非一次产出就结束 | 🟢 低 |

### 推荐实施路线 — ❌ 全部未开始

```
短期             中期                   长期
─────────        ──────────           ──────────
创建 plan.md ──→ 默认 plan 模式    ──→ 可配置默认行为
                         │                  │
默认开启 plan           /go /go-with-risk    HARD-GATE
                         │      /redirect    │
plan.md refine ─────→ 规划产出验证 ───→ 自动化评估
                                              │
                                        多轮规划对话
```

> **当前状态 (2026-06-10)**: 以上路线图上的所有节点均未开始实施。`core/prompts/plan.md` 不存在，config.toml 中无 `[agent.plan]`，插件中无 plan mode 相关 hook。

---

## 7. 总结

### 7.1 核心发现

| 项目 | 核心机制 | 可借鉴到 ZooKeeper 的设计 |
|------|---------|--------------------------|
| OpenCode 原生 plan | Tab 切换 primary agent | 配置 `[agent.plan]` 即可获得基础规划能力 |
| Superpowers | Skill 自动门控 + HARD-GATE | Red Flags 表、Terminal State 模式可借鉴到 prompt 设计 |
| omo | Prometheus 主规划者 + demoted plan subagent | 双 agent 规划分工、动态 prompt 注入、规划家族互斥委派 |
| slim | 编排器即规划者（无独立 plan agent） | Subtask 轻量规划原语、Delegation Check 隐式规划步骤 |
| omp | Plan subagent + /plan 双层设计 | 写保护硬约束、resolve 工具批准流程、规划文档 compaction 保护 |

### 7.2 推荐方案优先级 — ❌ 全部未实现

| 优先级 | 方案 | 理由 |
|--------|------|------|
| P0 | 默认 plan 模式 + 注册 plan agent + 创建 plan.md | TR 决策方向，默认规划 + 基础能力 |
| P1 | 方案 C: 插件层默认 plan 模式 + 命令驱动 | 硬约束阻断 + /go /go-with-risk /redirect 三命令体系 |
| P2 | 方案 B: Plan Subagent | 更强的流程管控，适合规划产出需要落地为文件的场景 |
| P3 | 方案 A: 纯 Prompt 引导 | 轻量补充，可与其他方案共存 |

> **当前状态**: 以上所有方案均未开始实施。无 plan 相关代码、无 plan.md 文件、无 plan agent 配置。

### 7.3 关键决策点

1. **默认 plan + 命令退出**：TR 确定方向——不再是"是否自动检测规划意图"，而是"默认始终规划，通过显式命令退出"。这一反转简化了检测逻辑，把选择权交给用户。
2. **软约束 vs 硬约束**：Prompt 引导（方案 A）是软约束，LLM 可能绕过；工具阻断（方案 C）是硬约束，LLM 无法绕过。建议最终方案以硬约束为主。
3. **规划产出形式**：规划结果是对话讨论（方案 C）还是文件产出（方案 B）？对话方案更轻量，文件方案更适合复杂项目。建议初期用对话，复杂场景逐渐迁移到文件产出。
4. **TR 命令词汇表**：退出/重定向命令采用 `/go`（批准方案）、`/go-with-risk`（承担风险）和 `/redirect`（重新规划）。这套命名参考自 TR review opinion wording，三个命令覆盖了规划→实现、承担风险→实现、重新规划三种典型场景。

### 7.4 实施建议

按照 TR 确定的方向，从两个方向同时推进：(1) 立即实现默认 plan 模式——在 config hook 中设置默认 plan 模式并实现工具阻断，同时注册 plan agent 和创建 plan.md（1 周工作量）。(2) 实现 `/go`、`/go-with-risk`、`/redirect` 三命令状态机和 chat.message hook 检测逻辑（1 周工作量）。两项完成后即拥有完整的最小可行规划工作流。方案 B（Plan Subagent）作为后续增强，在需要更复杂的规划工作流时引入。

---

*本文档为技术性调研报告，基于对 OpenCode 平台、Superpowers 项目（https://github.com/obra/superpowers）源代码、oh-my-openagent 参考实现、oh-my-opencode-slim 极简配置以及 oh-my-pi 深度规划参考实现的事实性分析。所有方案均以 ZooKeeper 现有架构为基础，不包含虚构的 API 或机制。*

*报告日期：2026 年 6 月 10 日*