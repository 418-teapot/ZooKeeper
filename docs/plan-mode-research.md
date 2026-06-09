# Plan Mode Detection and Switching Research

**Version: 0.1 — Date: 2026-06-08 — Classification: 技术调研**

---

## 目录

1. [概述](#1-概述)
2. [OpenCode 原生 Plan Agent](#2-opencode-原生-plan-agent)
   - [2.1 内置 Plan Agent 机制](#21-内置-plan-agent-机制)
   - [2.2 Tab 切换交互](#22-tab-切换交互)
   - [2.3 ZooKeeper 当前缺口](#23-zookeeper-当前缺口)
3. [参考项目分析](#3-参考项目分析)
   - [3.1 Superpowers: Skill 自动门控](#31-superpowers-skill-自动门控)
   - [3.2 oh-my-openagent: 关键词意图检测](#32-oh-my-openagent-关键词意图检测)
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

本报告调研两种参考项目如何处理"先规划后实现"的问题——Superpowers 的 Skill 自动门控机制和 oh-my-openagent 的关键词意图检测——并针对 ZooKeeper 的架构特点提出三种适配方案。

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
| 是否有自定义 prompt | ❌ 无（无 `core/prompts/plan.md`） |
| 权限是否符合 ZooKeeper 风格 | ❌ 使用 ask 而不是 deny |
| 自动检测规划意图 | ❌ 无 |
| 与 build agent 的协作流程 | ❌ 无（各自独立） |

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

### 3.2 oh-my-openagent: 关键词意图检测

oh-my-openagent（OMA）是一个基于 OpenCode 插件构建的多 Agent 编排参考实现，采用关键词驱动的 IntentGate 机制实现模式切换。

#### 3.2.1 架构总览

```
OMA IntentGate 流水线
│
├─ chat.message hook (入口)
│   ├─ 拦截用户消息
│   ├─ 正则匹配关键词模式
│   ├─ 匹配成功 → 注入对应模式的 system prompt
│   └─ 匹配失败 → 继续默认行为
│
├─ 关键词注册表 (关键词 → 模式映射)
│   ├─ "ultrawork" / "ulw"      → 深度规划模式
│   ├─ "hyperplan" / "hpp"      → 对抗性多 agent 规划
│   ├─ "search" / "analyze"     → 调研分析模式
│   ├─ "team" / "team mode"     → 团队协作模式
│   └─ ... (可扩展)
│
└─ 模式系统
    ├─ ultrawork: 注入"慢思考"prompt，强制 agent 多步推理
    ├─ hyperplan: 启动 3 个以上独立 agent 并行生成方案，交叉评审
    ├─ search: 限制只使用搜索工具，禁止修改文件
    └─ team: 创建多个专业化 agent 协作执行
```

#### 3.2.2 关键词注册表

OMA 的模式匹配基于一个可配置的关键词注册表：

| 关键词 | 匹配模式 | 注入模式 | 说明 |
|--------|---------|---------|------|
| `ultrawork\|ulw` | 正则前缀匹配 | 深度规划 | 用户主动触发，要求渐进式推理 |
| `hyperplan\|hpp` | 正则前缀匹配 | 对抗规划 | 多 agent 辩论式规划，覆盖更多角度 |
| `search` | 精确匹配 | 搜索模式 | 仅搜索不修改 |
| `analyze` | 精确匹配 | 分析模式 | 深度分析但不实现 |
| `team` | 精确匹配 | 团队模式 | 分配合适 agent |

#### 3.2.3 Plan Agent 设计

OMA 定义了一个专用的 `plan` agent（在 `plan.toml` 中配置）：

- **纯规划**：该 agent 只负责规划，从不实施
- **结构输出**：规划结果以结构化计划文件输出，包含依赖矩阵、并行波次、验收标准
- **过渡机制**：用户通过 `/start-work` 命令从规划状态切换到执行状态

```
OMA 规划 → 执行流程

用户: "ultrawork 帮我想想怎么重构这个支付模块"
     │
     ▼
chat.message hook 匹配 "ultrawork"
     │
     ▼
注入 ultrawork 规划 prompt → agent 进入深度规划模式
     │
     ├─ 产出规划文档 (plan-xxx.md)
     │   ├─ 依赖矩阵 (A → B → C)
     │   ├─ 并行波次 (Wave 1: A+B, Wave 2: C)
     │   └─ 验收标准
     │
     └─ 等待用户确认

用户: "/start-work"
     │
     ▼
chat.message hook 匹配 "/start-work"
     │
     ▼
清除规划 prompt → agent 回到默认执行模式
     │
     └─ 按规划文档开始实现
```

#### 3.2.4 默认模式配置

OMA 支持配置 `default_mode.ultrawork: true`，使得所有会话默认启用规划模式，无需输入关键词：

```toml
[default_mode]
ultrawork = true  # 每次对话都先进入规划模式
```

#### 3.2.5 与 ZooKeeper 的适配性分析

| 维度 | 评估 |
|------|------|
| 轻量级，无需修改 agent 配置 | ✅ 仅需在插件中添加 chat.message hook |
| 用户显式控制模式切换 | ✅ 关键词触发 /start-work 切换 |
| 自动默认模式可配置 | ✅ 支持 default_mode 配置 |
| 对现有 ZooKeeper prompt 的影响 | 🟡 中（需新增 plan.md，但 build.md 等不需重写） |
| 与现有 plugin hooks 的兼容性 | ✅ 高（ZooKeeper 已有 tool.execute.before 和 config hook） |
| 实现复杂度 | 🟢 低（集中在插件层，约 100-200 行 TS） |

---

## 4. 对比分析

### 4.1 三种方案维度对比

| 维度 | OpenCode 原生 Plan | Superpowers Skill 门控 | OMA IntentGate |
|------|-------------------|----------------------|----------------|
| **触发方式** | 用户手动 Tab 切换 | 自动检测 + 规则门控 | 关键词匹配 / 默认模式 |
| **用户控制力** | 完全手动 | 低（系统自动门控） | 中（关键词主动触发） |
| **是否强制规划** | 否 | 是（HARD-GATE） | 条件性（可配置默认） |
| **实现位置** | 平台内置 | 独立 Skill 系统 | 插件 chat.message hook |
| **实现成本** | 零（已有） | 高（完整 Skill 框架） | 低（单 hook + prompt 注入） |
| **与 ZooKeeper 兼容性** | 🟡 风格不一致 | 🔴 架构冲突大 | ✅ 可增量接入 |
| **自定义 prompt 支持** | 需要手动加 config | 原生支持 | 通过注入实现 |
| **规划→执行过渡** | 手动 Tab 切回 | Skill 链自动流转 | `/start-work` 命令 |
| **对现有配置的影响** | 无（新增 agent 块） | 颠覆性 | 增量式 |

### 4.2 规划保障强度对比

| 模式 | 用户能否跳过规划 | 规划产出 | 过渡控制 | 安全性 |
|------|----------------|---------|---------|-------|
| OpenCode 原生 plan | ✅ 可跳过（不切 Tab 即可） | 无结构化要求 | 无 | 低 |
| Superpowers HARD-GATE | ❌ 不可跳过 | 结构化方案文档 | 用户批准 | 高 |
| OMA ultrawork | 🟡 可配置 | 结构化计划文件 | `/start-work` | 中 |

### 4.3 ZooKeeper 适配优先级矩阵

| 方案 | 实现成本 | 用户价值 | 风险 | 推荐度 |
|------|---------|---------|------|-------|
| Pure Prompt | 🟢 低 | 🟡 中 | 🟢 低 | ⭐⭐⭐ |
| Plan Subagent | 🟡 中 | ✅ 高 | 🟡 中 | ⭐⭐⭐⭐ |
| Plugin IntentGate | 🟡 中 | ✅ 高 | 🟢 低 | ⭐⭐⭐⭐⭐ |

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

### 🔴 短期（1-2 周，可独立实施）

| 序号 | 改进项 | 方案 | 优先级 |
|------|-------|------|--------|
| 1 | 创建 `core/prompts/plan.md` | 编写规划专用 prompt，定义规划工作流和产出规范 | 🔴 高 |
| 2 | 在 `config.toml` 中注册 plan agent | 添加 `[agent.plan]` 块，设置合理权限，作为默认 agent | 🔴 高 |
| 3 | 默认开启 plan 模式 | 插件在会话启动时自动进入规划模式，无需关键词检测 | 🔴 高 |

### 🟡 中期（2-4 周，涉及插件修改）

| 序号 | 改进项 | 方案 | 优先级 |
|------|-------|------|--------|
| 4 | 实现插件层默认 plan 模式 + 工具阻断（方案 C） | 在 `config` hook 中默认启用 plan 模式，`tool.execute.before` 阻断实现工具 | 🔴 高 |
| 5 | 实现 /go, /go-with-risk, /redirect 命令 | 在 chat.message hook 中检测命令，执行状态转换 | 🔴 高 |
| 6 | 规划产出验证 | 在 `/go` 前检查是否生成了有效的规划方案 | 🟡 中 |
| 7 | plan prompt 与现有 prompt 的一致性验证 | 确保 plan.md 与 build.md 在规划流程上不冲突 | 🟡 中 |

### 🟢 长期（4-8 周，需评估收益）

| 序号 | 改进项 | 方案 | 优先级 |
|------|-------|------|--------|
| 8 | 可配置的默认模式行为 | 允许高级用户通过 config.toml 配置某些项目类型跳过 plan 模式（如纯修复类任务） | 🟢 低 |
| 9 | HARD-GATE 实验 | 参考 Superpowers 的 HARD-GATE 设计，探索在 ZooKeeper 中实现"不规划不实现"的强制门控 | 🟢 低 |
| 10 | 规划产出自动化评估 | 使用 LLM-as-Judge 评估规划文档的完整性和质量 | 🟢 低 |
| 11 | 多轮规划对话支持 | 在 plan 模式中支持多轮对话迭代方案，而非一次产出就结束 | 🟢 低 |

### 推荐实施路线

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

---

## 7. 总结

### 7.1 核心发现

| 项目 | 核心机制 | 可借鉴到 ZooKeeper 的设计 |
|------|---------|--------------------------|
| OpenCode 原生 plan | Tab 切换 primary agent | 配置 `[agent.plan]` 即可获得基础规划能力 |
| Superpowers | Skill 自动门控 + HARD-GATE | Red Flags 表、Terminal State 模式可借鉴到 prompt 设计 |
| OMA | 关键词 IntentGate + 模式注入 | 轻量级 chat.message hook + 命令驱动的模式切换思路 |

### 7.2 推荐方案优先级

| 优先级 | 方案 | 理由 |
|--------|------|------|
| P0 | 默认 plan 模式 + 注册 plan agent + 创建 plan.md | TR 决策方向，默认规划 + 基础能力 |
| P1 | 方案 C: 插件层默认 plan 模式 + 命令驱动 | 硬约束阻断 + /go /go-with-risk /redirect 三命令体系 |
| P2 | 方案 B: Plan Subagent | 更强的流程管控，适合规划产出需要落地为文件的场景 |
| P3 | 方案 A: 纯 Prompt 引导 | 轻量补充，可与其他方案共存 |

### 7.3 关键决策点

1. **默认 plan + 命令退出**：TR 确定方向——不再是"是否自动检测规划意图"，而是"默认始终规划，通过显式命令退出"。这一反转简化了检测逻辑，把选择权交给用户。
2. **软约束 vs 硬约束**：Prompt 引导（方案 A）是软约束，LLM 可能绕过；工具阻断（方案 C）是硬约束，LLM 无法绕过。建议最终方案以硬约束为主。
3. **规划产出形式**：规划结果是对话讨论（方案 C）还是文件产出（方案 B）？对话方案更轻量，文件方案更适合复杂项目。建议初期用对话，复杂场景逐渐迁移到文件产出。
4. **TR 命令词汇表**：退出/重定向命令采用 `/go`（批准方案）、`/go-with-risk`（承担风险）和 `/redirect`（重新规划）。这套命名参考自 TR review opinion wording，三个命令覆盖了规划→实现、承担风险→实现、重新规划三种典型场景。

### 7.4 实施建议

按照 TR 确定的方向，从两个方向同时推进：(1) 立即实现默认 plan 模式——在 config hook 中设置默认 plan 模式并实现工具阻断，同时注册 plan agent 和创建 plan.md（1 周工作量）。(2) 实现 `/go`、`/go-with-risk`、`/redirect` 三命令状态机和 chat.message hook 检测逻辑（1 周工作量）。两项完成后即拥有完整的最小可行规划工作流。方案 B（Plan Subagent）作为后续增强，在需要更复杂的规划工作流时引入。

---

*本文档为技术性调研报告，基于对 OpenCode 平台、Superpowers 项目（https://github.com/obra/superpowers）源代码以及 oh-my-openagent 参考实现的事实性分析。所有方案均以 ZooKeeper 现有架构为基础，不包含虚构的 API 或机制。*

*报告日期：2026 年 6 月 8 日*