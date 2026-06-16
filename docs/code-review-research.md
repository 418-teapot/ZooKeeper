# Code Review 实现横向对比：技术路线分析

> 调研范围：oh-my-openagent (omo)、oh-my-opencode-slim (slim)、oh-my-pi (omp)、superpowers
> 对比对象：ZooKeeper Eagle Code Review Skill（设计阶段）
> 日期：2026-06-16

## 一、调研概览

Code Review 是 agent 编码流程中的关键质量门禁。不同框架对"谁来做 review、何时触发、怎么组织"的答案截然不同，反映了对编排哲学、token 预算和 LLM 行为特性的不同权衡。

本次调研覆盖 4 个项目，外加 ZooKeeper 的设计方案：

| 项目 | 定位 | Review 架构关键词 |
|------|------|------------------|
| **oh-my-openagent (omo)** | OpenCode 完整多 agent 编排框架 | 5 并行子 agent、Skill 封装、XML 结构化输出 |
| **oh-my-opencode-slim (slim)** | OpenCode 轻量编排层 | 编排器手动委托 @oracle、Multi-model council |
| **oh-my-pi (omp)** | 独立全栈编码代理 | `/review` 命令、1-16 并行 reviewer、schema 校验输出 |
| **superpowers** | 纯方法论行为塑形框架 | 4 层 review 类型、质疑框架、反谄媚校准、接收 review 行为技能 |
| **ZooKeeper (设计)** | OpenCode 编排器插件 | Skill 封装 2 并行 Eagle、read-only 权限声明、混源设计 |

```
                       手动触发 ←───────────────→ 自动触发
                            │                        │
   omp (/review 命令) ──────┤                        │
   slim (编排器决策) ────────┤                        │
   omo (Ralph-loop hook) ───┼───────────────────────┤
   superpowers (内嵌 self-review) ─┤                │
   ZooKeeper (Skill, 用户调用) ──┤                  │
                            │                        │
                      用户决策                  编排器决策
```

---

## 二、四个项目的 Review 实现分析

### 2.1 oh-my-openagent (omo) — Skill 封装的 5 并行子 agent

**核心机制：** `review-work` Skill（SKILL.md，592 行）——review 编排器

#### 架构：Skill 包裹 5 并行子 agent

| # | Agent | 类型 | 专注领域 |
|---|-------|------|---------|
| 1 | Goal Verifier | Oracle（只读） | Did we build what was asked? |
| 2 | QA Executor | unspecified-high（自主） | Does it actually work? |
| 3 | Code Reviewer | Oracle（只读） | Is the code well-written? |
| 4 | Security Auditor | Oracle（只读） | Is it secure? |
| 5 | Context Miner | unspecified-high（自主） | Did we miss context? |

#### 关键设计决策

1. **Oracle 与自主 agent 的权限分界：** Oracle 类型 agent 禁止 write/edit/apply_patch，只能读；unspecified-high agent 可执行命令、运行应用。两类 agent 收到的上下文也不同——Oracle 收到完整 DIFF + FILE_CONTENTS；自主 agent 只收到目标 + 提示。

2. **全并行启动：** 5 个 agent 在同一 turn 中以 `run_in_background=true` 启动，互不等待。

3. **XML 结构化输出：** 每个 reviewer 输出 `<verdict>PASS/FAIL</verdict>`、`<confidence>`、`<blocking_issues>` 标签，供后续汇聚解析。

4. **INCONCLUSIVE 处理机制：** Phase 2 独立汇总各 lane 结果（PASS / FAIL / INCONCLUSIVE）。INCONCLUSIVE lane 获得一次小模型重试；重试后仍 INCONCLUSIVE 则保持，不阻塞流程。

5. **Phase 3 汇聚逻辑：** ALL 5 必须 PASS 才通过。任一 FAIL → review 失败。

#### 附加 review 机制

- **`pre-publish-review` Skill：** 16 agent 发布门禁（逐个文件深度审查 + 整体审查 + 发布综合），内部组合 `review-work`。
- **`work-with-pr` Skill：** 3 门循环（CI → review-work → 外部 bot），失败重新进入。
- **Momus agent：** 实现前计划审查（找 blockers 而非完美主义）。
- **Ralph-loop hook：** ultrawork 循环检测到完成时自动触发 Oracle 验证——唯一 hook 驱动的自动 review。

#### Pros / Cons

| 优势 | 劣势 |
|------|------|
| 并行度高，5 agent 同时工作 | Token 成本极高（5 个完整 agent） |
| 只读 agent 安全隔离好 | 无增量 review（每次都完整过） |
| Skill 可组合（`pre-publish-review` 组合 `review-work`） | 无通用实现的自动触发 |
| INCONCLUSIVE 不 deadlock | XML 解析脆弱 |
| 汇聚逻辑清晰（ALL PASS） | 只有 Ralph-loop 一种自动模式 |

---

### 2.2 oh-my-opencode-slim (slim) — 编排器驱动的子 agent 委托

**核心机制：** `@oracle` 只读子 agent（战略顾问）

#### 架构：编排器手动委托

编排器 system prompt 包含验证路由规则：

```
- Route code review + simplification → @oracle
- Route UI/UX validation → @designer
- Route test writing → @fixer
```

`@oracle` 的约束：
- 只读（无 write/edit/apply_patch/task 权限）
- temperature 0.1
- 使用最强模型（GPT-5.5）
- 叶节点（不能再 spawn 子 agent）

#### 附加 review 机制

1. **`@council` 多模型共识 review：** 3+ 独立 councillor（不同模型）+ 合成器，用于高权重决策。Token 成本 3× 并发。
2. **自定义 reviewer agent：** 用户可定义带 `orchestratorPrompt` 字段的 agent，教导编排器何时委托。
3. **`/review` 命令：** OpenCode 内置功能，通过 @build 子 agent 做 diff 感知 review。
4. **`simplify` Skill：** 行为保持简化，oracle review 时使用。
5. **`requesting-code-review` Skill：** 权限限制 Skill，仅授予 oracle。

#### 关键特点

- **无自动 review hook：** review 始终是编排器的显式决策。编排器可能跳过 review。
- **Session 连续性：** Session manager 记住最近的 oracle 会话，支持上下文复用。

#### Pros / Cons

| 优势 | 劣势 |
|------|------|
| oracle 只读 + fixer 只写，职责清晰 | 依赖编排器判断（可能跳过 review） |
| 简单变更开销低 | 无自动 review 安全网 |
| council 可扩展高权重场景 | @oracle 无内置 diff 感知 |
| 用户可自定义 reviewer agent | |

---

### 2.3 oh-my-pi (omp) — 命令驱动的并行 reviewer

**核心机制：** `/review` 命令 → N 并行 reviewer 子 agent

#### 架构：用户触发，按 diff 权重扩缩容

```
/review 命令
    │
    ├── 计算 diff weight（行数 + 文件数）
    │
    ├── < 100 行 或 1-2 文件  → 1 agent
    ├── < 500 行               → 1-2 agents
    ├── < 2000 行              → 2-4 agents
    ├── < 5000 行              → 4-8 agents
    └── > 5000 行              → 8-16 agents
    │
    └── 每个 reviewer 子 agent 并行执行
         ├── 只读工具（read, search, find, bash*）
         ├── report_finding 工具（隐藏，仅 reviewer 可用）
         └── 可选 spawn explore 子 agent 深入调查
```

#### Reviewer agent 定义

- **模型：** `pi/slow`（最强大模型）
- **工具：** read, search, find, bash, lsp, web_search, ast_grep, report_finding
- **bash 限制：** 仅限于 `git diff`、`git log`、`git show`、`jj diff`、`gh pr diff`
- **`report_finding` 隐藏工具：** schema 约束（title/body/priority/confidence/file_path/line_start/line_end）
- **`thinking-level`：** high
- **`blocking`：** true

#### Prompt 工程亮点

1. **跨边界 dispatch 点校验：** 对于每个跨越函数/模块边界的新类型、变体或值，reviewer 必须在消费侧定位 dispatch 点（switch/router/filter/handler registry），确认存在显式分支处理。dispatch 点通常在 diff 之外，**必须主动读取相关文件**。
2. **六条件噪声过滤：** 仅报告同时满足以下条件的 issues：
   - 有可证明的影响（provable impact）
   - 可操作的（actionable）
   - 非故意的（unintentional）
   - 本次 patch 引入的（introduced in patch）
   - 无未声明假设（no unstated assumptions）— reviewer 不得依赖关于代码库或作者意图的未声明假设
   - 有相应严格度的证据（proportionate rigor）— 修复方案不得要求超出代码库其余部分的严格度
3. **行范围约束：** `report_finding` 的 `line_end - line_start` 不得超过 10 行，且必须与 diff hunk 重叠。防止 reviewer 报告与本次变更无关的远处问题。

#### 附加机制

- **workflowz eval bridge：** 程序化 spawn reviewer 子 agent（`agent_type="reviewer"`）
- **Swarm 扩展：** 声明式 YAML 模式（Fan-In 并行 specialist、Sequential chain）
- **多种调用模式：** 交互式（`/review` 菜单）、headless（CI）、程序化（eval）

#### Pros / Cons

| 优势 | 劣势 |
|------|------|
| 结构化输出（schema 校验保证质量） | 必须用户显式触发 |
| diff 权重感知的并行扩缩容 | 每 reviewer 用最强模型，token 极高 |
| 噪声过滤（六条件） | 无编码后自动 review |
| 跨边界 dispatch 点校验 | |
| 多种调用模式（CI/交互/程序化） | |

---

### 2.4 superpowers — Prompt 工程 + 行为塑形

**核心机制：** 4 层 review 类型 + 接收 review 行为技能

#### 架构：顺序两阶段 review

```
实现任务
    │
    ├── 1. Self-review（实现者 prompt 内嵌，4 轴自查）
    │
    └── 2. Spec compliance review（子 agent，循环直到批准）
         │  ⚠ 必须通过后才能进入下一阶段
         └── 3. Code quality review（子 agent，循环直到批准）
              │  （code-quality-reviewer-prompt.md: "Only dispatch after spec compliance review passes"）
              └── 4. Final full review（所有任务完成后）
```

#### 关键设计模式

**A. 质疑框架（skeptical framing）** — `spec-reviewer-prompt.md`

开头声明 **"CRITICAL: Do Not Trust the Report"**，核心 prompt 语句：

> "The implementer finished suspiciously quickly. Their report may be incomplete, inaccurate, or optimistic. You MUST verify everything independently."

显式 DO / DON'T 区分清单：
> DO NOT: Take their word for what they implemented
> DO: Read the actual code they wrote

**B. 反 Nitpick 校准** — `code-reviewer.md`（**模板文件**，含 4 个占位符 {DESCRIPTION}、{PLAN_OR_REQUIREMENTS}、{BASE_SHA}、{HEAD_SHA}，每次 review 渲染为完整 prompt，非独立可用的 prompt）

> "Categorize issues by actual severity. Not everything is Critical."
> "Acknowledge what was done well before listing issues"

**C. 三级严重度：** Critical（必须修） / Important（应该修） / Minor（Nice to Have）

**D. 必填裁决：** **Ready to merge?** [Yes \| No \| With fixes] + **Reasoning**

**E. 接收 Review 行为技能** — `receiving-code-review/SKILL.md`（213 行）

工作流：
```
READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT
```

关键约束：
- **禁止用语：** "You're absolutely right!"、"Great point!"、"Excellent feedback!"——阻止谄媚同意
- **YAGNI check：** 实现前 grep 代码库确认建议的功能确实被用到
- **外部 Reviewer 怀疑清单：** 5 点检查表，在实现任何建议前验证
- **实现顺序：** blocking → 简单修复 → 复杂修复，逐个独立测试

**F. 验证前置完成 Skill**（139 行）

核心规则：
- **铁律：** 没有最新验证证据，不得声称完成
- **Gate 函数：** IDENTIFY → RUN → READ → VERIFY → ONLY THEN claim
- **反理性化表：** "Should work" → RUN the verification. "I'm confident" → Confidence ≠ evidence.
- **红色警戒词：** should, probably, seems to, Great!, Perfect!, Done!

**G. Self-review 检查表**（实现者 prompt 内嵌）

4 轴：Completeness / Quality / Discipline / Testing。发现 issues 先修复再报告。

#### 进化历史（关键教训）

- **v5.0.2：** 引入子 agent review 循环（spec/plan 文档）
- **v5.0.6：** **回退**到内联 self-review——证据显示无质量提升，但节省 25× 时间
- **v5.1.0：** 移除命名 code-reviewer agent，合并到 prompt 模板文件
- **教训：** 子 agent dispatch 只有对**代码 review** 才有价值，文档 review 不值得

#### Pros / Cons

| 优势 | 劣势 |
|------|------|
| 质疑框架减少假阳性批准 | 单 reviewer 每阶段，顺序执行 |
| 反谄媚校准 + 反 sycophancy | 无并行 fan-out |
| 完整的接收 review 行为培训 | 高度依赖 prompt 纪律 |
| 验证 gate 防提前完成 | |
| 有进化迭代证据（25× 时间节省） | |

---

## 三、横向对比

### 3.1 全景对比表

| 维度 | oh-my-openagent | oh-my-opencode-slim | oh-my-pi | superpowers | ZooKeeper (设计) |
|------|:-:|:-:|:-:|:-:|:-:|
| **触发机制** | Skill 调用 + Ralph-loop hook | 编排器显式委托 | `/review` 命令 | Self-review 内嵌 + 子 agent 循环 | Skill 调用 |
| **Reviewer 数量** | 5 | 1 (oracle) / 3+ (council) | 1-16 (按 diff 权重) | 1/阶段 | 2 |
| **并行度** | ✅ 5 全并行 | ❌ 单 agent | ✅ N 全并行 | ❌ 顺序 | ✅ 2 并行 |
| **只读强制** | 权限级（deny write/edit） | 权限级（deny * + allow read） | 工具级（bash 限制 + report_finding） | Prompt 级 | 权限级（deny write/edit/apply_patch） |
| **模型选择** | Oracle 用最强模型 | @oracle 用最强模型 | pi/slow（最强大模型） | 同主 agent | Pro 模型（两 Eagle 同规格） |
| **输出格式** | XML 标签 | 自然语言 | 结构化 Schema | 自然语言 + 裁决 | 自然语言 + 裁决 |
| **严重度层级** | 无（verdict 仅 PASS/FAIL） | 无 | priority 字段 | 3 级（Critical/Important/Minor） | 3 级（Must Fix / Should Fix / Could Fix + 分层过滤） |
| **自动触发** | ✅ Ralph-loop 自动（仅 ultrawork 模式） | ❌ 无 | ❌ 无 | ✅ Self-review 内嵌 | ❌（设计阶段暂定 Skill 调用） |
| **Review 循环** | ✅ INCONCLUSIVE retry（1 次） | ❌ 无 | ❌ 无（一次审查） | ✅ 子 agent 循环直到批准 | ✅ INCONCLUSIVE retry（1 次） |
| **Self-review** | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 4 轴内嵌 | ✅ 4 轴内嵌（轻量版，不做子 agent） |
| **接收 review 行为** | ❌ 无 | ❌ 无 | ❌ 无 | ✅ 完整 Skill（213 行） | ✅ 嵌入 SKILL.md |
| **Skill 可组合** | ✅ `pre-publish-review` 组合 `review-work` | ❌ | ❌ | ❌ | ✅ SKILL.md 封装 |

### 3.2 关键维度的 trade-off 分析

#### 并行 vs 顺序

```
并行模型（omo / omp / ZooKeeper）
          时间 ────►
Reviewer 1 │██████████████████│
Reviewer 2 │██████████████████│  ← 同一 turn
Reviewer 3 │██████████████████│
           └──── 总延迟 = 最大单个延迟 ────►

顺序模型（slim / superpowers）
          时间 ────►
Phase 1    │████████████████████████│
Phase 2    │                        ████████████████████████│
Phase 3    │                                               ████████████│
           └──── 总延迟 = 各阶段之和 ────────────────────────────────►
```

并行模型延迟更低但 token 成本更高（多 agent 上下文）。顺序模型 token 成本可控但总延迟线性累加。

#### 自动触发 vs 显式触发

每个项目对"谁决定 review"的答案不同：

| 触发模式 | 代表 | 风险 | 收益 |
|---------|------|------|------|
| 自动（行为检测） | omo Ralph-loop | 可能误触发 | 不掉 review |
| 编排器显式决策 | slim | 可能跳过 | 成本可控 |
| 用户手动触发 | omp / ZooKeeper | 用户可能忘 | 用户掌控 |
| 内嵌自动化 | superpowers | 增加主 prompt 体积 | 低成本安全网 |

#### Token 成本估计

假设一次 review 的粗略 token 消耗对比：

| 项目 | Agent 数 | 模型 | 上下文 | 相对成本 |
|------|---------|------|--------|---------|
| omo | 5 | 最强（Oracle）+ 中等 | 完整 DIFF + FILE_CONTENTS | ★★★★★ 极高 |
| slim (oracle) | 1 | 最强 | 由编排器选择 | ★★ 低 |
| slim (council) | 3+ | 不同强模型 | 同 oracle | ★★★★ 高 |
| omp | 1-16 | 最强 | diff + 上下文 | ★★~★★★★★ 动态 |
| superpowers | 1 | 同主 agent | diff + context | ★★ 低 |
| ZooKeeper | 2 | Pro 模型 | 完整 GOAL + DIFF + FILE_CONTENTS | ★★★ 中 |

omp 的 diff 权重扩缩容是最 token 智能的策略——小变更 1 个 agent，大变更 16 个。

### 3.3 omp 的动态 diff 扩缩容机制

omp 的 `/review` 命令实现了目前最 token 智能的并行 reviewer 扩缩容机制。其核心代码位于 `packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts`，关键设计如下。

#### 噪声过滤（权重计算前）

在计算 diff 权重之前，omp 先对变更文件进行噪声过滤。共 22 条 glob 模式，按类别分布：

| 类别 | 模式数 | 示例 |
|------|--------|------|
| 锁文件 | 10 | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Gemfile.lock`, `Cargo.lock`, `poetry.lock`, `go.sum`, `composer.lock`, `gradle.lockfile`, `Pipfile.lock` |
| 生成/构建产物 | 7-9 | `dist/`, `build/`, `*.generated.*`, `*.pb.*`, `__pycache__/`, `*.pyc`, `node_modules/`, `vendor/`, `.next/` |
| 二进制文件 | 5 | `*.png`, `*.jpg`, `*.ico`, `*.pdf`, `*.whl` |

过滤在 weight 计算之前执行，确保权重只反映有意义的代码变更。

#### 权重计算公式

```
weight = totalAdded + totalRemoved           # 源码变量名 totalAdded/totalRemoved
# fileCount 上限分 tier 计算，非简单的 Math.min(fileCount, weight)
# tier 1: Math.ceil(fileCount / 3)
# tier 2: Math.ceil(fileCount / 2)
# tier 3: fileCount（无额外约束）
```

- **`totalAdded`** + **`totalRemoved`** 之和直接作为 weight（源码中变量名为 `totalAdded`/`totalRemoved`，非 `linesAdded`/`linesRemoved`）
- **`fileCount`** 的上限分 tier 约束，而非简单的 `Math.min(fileCount, weight)`：低 tier 用 `Math.ceil(fileCount / 3)`，中 tier 用 `Math.ceil(fileCount / 2)`，高 tier 无额外 fileCount 约束

#### 5 级扩缩容 & 硬上限

| 区间 | Reviewer 数 | 典型场景 |
|------|------------|---------|
| weight < 100 行 | 1 | 简单 bug 修复、文档修改 |
| 100 <= weight < 500 | 1-2 | 中等功能实现 |
| 500 <= weight < 2000 | 2-4 | 跨文件重构 |
| 2000 <= weight < 5000 | 4-8 | 大功能模块 |
| weight >= 5000 | 8-16 | 大规模变更 |

**硬上限 16**：即使 weight 极大（如 > 50000），reviewer 数量也不会超过 16 个，防止 token 成本失控。

#### skipDiff 快通路

当满足以下任一条件时，omp 跳过 diff 计算，直接走轻量路径：

| 条件 | 阈值 | 效果 |
|------|------|------|
| diff 字符数 > 50000 | 超大 diff | 跳过权重计算，使用默认配置 |
| 变更文件数 > 20 | 大范围变更 | 同上 |

#### Preview budget 算法

当 diff 过大时，omp 未给 reviewer 注入完整 diff，而是分配一个预览预算：

```
preview_per_file = max(5, floor(100 / fileCount))
```

即每个文件至少 5 行上下文，总预览行数随文件数增加而减少。Reviewers 通过 `git diff` 命令自行拉取完整 diff——这确保了 reviewer 在需要时仍能获取完整信息，而不会因 preview budget 遗漏关键上下文。

#### Pros & Cons

| 优势 | 劣势 |
|------|------|
| **Token 智能** — 小变更 1 agent，大变更 16，动态适配 | **fileCount 多 tier 约束** — `Math.ceil(fileCount / 3)` / `Math.ceil(fileCount / 2)` 等 tier 级上限在单文件超大变更时可能低估 |
| **Locality grouping** — 变更集中的文件自然被更多 reviewer 覆盖 | **无复杂度启发** — 纯按行数，不考虑变更的语义复杂度或跨模块影响范围 |
| **噪声提前过滤** — 22 条模式在权重前拦截，避免 lock 文件等占用 reviewer | **固定 preview budget** — `max(5, floor(100/fileCount))` 不区分文件的重要性层级 |
| **skipDiff 快通路** — 超大 diff 不阻塞，reviewer 自行 git diff 兜底 | |
| **硬上限 16** — 即使大规模变更也保证 token 可预测 | |

### 3.4 OpenCode Plugin SDK 能力盘点

基于 OpenCode plugin SDK（`@opencode-ai/plugin`，类型定义位于 `index.d.ts` lines 170-313），以下是所有可用 hook 及其在 ZooKeeper 和相关项目中的使用情况。

#### 完整 Hook 清单

| Hook | 签名 | 功能 | ZooKeeper 使用 | DCP 使用 |
|------|------|------|---------------|----------|
| `tool.execute.before` | `(input: {tool, sessionID, callID}, output: {args})` | 修改工具入参、校验 | ✅ task-prompt 注入 SUMMARY/CONTEXT/ACCEPTANCE | ❌ |
| `tool.execute.after` | `(input: {tool, sessionID, args}, output: {title, output, metadata})` | 拦截/修改工具输出（string） | ✅ post-task-nudge 追加提示 | ❌ |
| `tool.schema` (zod) | 通过 `tool()` factory | 工具输入侧 zod 校验 | ❌（无自定义工具） | ❌ |
| `tool.definition` | `(input: {toolID}, output: {description, parameters})` | 修改 LLM 侧工具描述/参数 | ✅ task-prompt 注入格式提示 | ❌ |
| `experimental.chat.messages.transform` | `(input: {}, output: {messages})` | 向最后一条用户消息追加文本 | ✅ focus-reminder 每 turn 提醒 | ✅ DCP 注入预计算结果 |
| `experimental.chat.system.transform` | `(input: {sessionID, model}, output: {system})` | 向 system prompt 数组追加内容 | ❌（暂未使用；权重高于 user message） | ❌ |
| `chat.params` | `(input: {sessionID, agent, model}, output: {temperature, topP, topK, maxOutputTokens})` | 覆盖每 session 的 LLM 参数 | ✅ | ❌ |
| `command.execute.before` | `(input: {command, sessionID, arguments}, output: {parts})` | 拦截自定义命令 | ❌ | ✅ DCP 的 `/dcp` 分发 |
| `chat.message` | `(input: {sessionID, agent, messageID}, output: {message, parts})` | 用户新消息时触发 | ❌ | ❌ |
| `permission.ask` | `(input: Permission, output: {status})` | 自定义权限决策 | ❌ | ❌ |
| `experimental.session.compacting` | `(input: {sessionID}, output: {context, prompt?})` | 自定义压缩提示 | ❌ | ❌ |

#### 关键发现

**1. `command.execute.before` 与 `experimental.chat.messages.transform` 的组合威力**

DCP 的 `/dcp compress` 工作流展示了这种模式的强大：

```
用户输入 /dcp compress <target>
    |
    +-- command.execute.before 拦截 "/dcp"
    |   +-- 解析子命令 (compress)
    |   +-- execute compress logic (pre-computation)
    |   +-- 存储计算结果到闭包状态
    |   +-- return parts = [] (不占用消息流)
    |
    +-- 后续 chat turn
        +-- experimental.chat.messages.transform
            +-- 从闭包读取预计算结果
            +-- 注入到用户消息末尾
```

模式优势：**预计算在 TypeScript 层完成，不消耗 LLM token**，再通过 hook 将结果注入消息流。这为 review 场景的 pre-computation（diff weight + agent count 计算）提供了已验证的架构参考。

**2. ZooKeeper 的 hook 使用策略**

ZooKeeper 当前仅使用了有限的 hook 子集：
- **`tool.execute.before`** — task-prompt 校验 + 注入
- **`tool.execute.after`** — post-task nudge
- **`tool.definition`** — 格式提示注入
- **`chat.params`** — 参数覆盖
- **`experimental.chat.messages.transform`** — focus-reminder

不注册自定义工具（仅使用 hook），与 slim 的策略不同——slim 注册了 `council_session`、`webfetch`、`ast_grep` 三个自定义工具。

**3. OpenCode 的固有局限**

- 子 agent 输出始终为 string（`task()` 返回 `string | { output: string; metadata? }`）
- 无法强制 agent 调用特定工具（只能 prompt 引导）
- 无隐藏工具机制（slim 通过 permission deny 手动实现 agent 隔离）
- 无结构化输出 schema 类型（无 `output:` / `response_format` 字段）

这与 3.3 的结论一致——OpenCode 插件平台的程序化保证能力弱于 omp，需要以 prompt 约束为主、工具校验为辅。

### 3.5 程序化输出校验能力：omp vs OpenCode

本节对比 omp 的内置 schema 校验 + 隐藏 `report_finding` 工具与 OpenCode 插件平台的可用能力，说明 ZooKeeper 采用"先 prompt 约束、再工具兜底"两阶段策略的原因。

#### omp 的完整流水线

omp 实现了四层程序化保证，从输入到输出全覆盖：

1. **Agent frontmatter 声明 `output:` schema（JTD 格式）** — 定义 reviewer 的最终输出结构，字段类型支持 enum/string/number
2. **隐藏 `report_finding` 工具** — 使用 zod schema 校验每条 finding 的 title/body/priority/confidence/file_path/line_start/line_end；工具声明 `intent: "omit"` 使其不出现在默认工具列表中
3. **Subagent 调用 `yield` 结束** — 框架自动校验最终输出是否符合 JTD schema
4. **Findings 自动注入输出** — 所有通过 `report_finding` 报告的 findings 自动汇入最终结构，无法手动伪造

结果：每条 finding 和最终 verdict 都经过程序化校验，格式一致、结构稳固。

#### OpenCode 插件平台能力

基于 OpenCode plugin SDK 调研：

- **`tool()` factory** — 可用 zod schema 定义自定义工具，但校验仅限输入侧
- **`Hooks.tool` 注册** — 可在 `Hooks.tool` 对象中注册工具（如 slim 注册了 ast_grep_search、council_session、webfetch）
- **`tool.execute.after` hook** — 可以检查/修改工具输出（输出为 string 类型）
- **`AgentConfig` 类型** — 无 output/schema/response_format 字段
- **`task()` 返回类型** — `string | { output: string; metadata? }`，始终为 string，无 schema 约束
- **子 agent 输出** — 无法强制要求使用特定工具（无"必须调用 X"机制）
- **隐藏工具** — 不存在 `intent: "omit"` 等价物；所有插件工具对所有 agent 可见（通过 permission deny 手动屏蔽）

#### 对比表

| 能力 | omp | OpenCode plugin |
|------|-----|-----------------|
| 注册自定义工具 | ✅ | ✅ |
| zod schema 校验输入 | ✅ | ✅ |
| 隐藏工具（默认不可见） | ✅ intent: omit | ❌ 无此机制 |
| 工具级 agent 隔离 | ✅ frontmatter 声明 | ⚠️ permission deny 手动 |
| 工具内检查调用者 agent | N/A | ✅ context.agent |
| 强制使用指定工具 | ❌（omp 也没有） | ❌（都不行） |
| 结构化 output schema | ✅ JTD | ❌ 无 |
| 覆盖 yield/最终输出 | ✅ | ❌ 无 |

#### 结论

omp 的 `report_finding` 本质是**"隐藏工具 + zod 输入校验 + 全局 registry + JTD 最终校验"**四层组合。OpenCode 插件只能做到第二层（zod 输入校验）。

因此，ZooKeeper 采用两阶段策略：
- **第一阶段：** 纯 prompt 约束（质疑框架 + 3 级严重度 + Ready to merge? 格式要求），依靠 LLM 对格式的遵循
- **第二阶段（备选）：** 注册 `report_finding` + `submit_verdict` 工具，用 zod 校验 + hook 检测提供程序化保证

---

## 四、关键设计模式提炼

以下 6 个模式是从四个项目中提取的可复用设计，不绑定到任何实现。

### 4.1 质疑框架（Skeptical Framing）

**来源：** superpowers
**核心思想：** 给 reviewer 的 prompt 预设"实现者可能出错"的立场，而不是"帮忙检查一下"。

```markdown
<!-- 典型 vs 质疑框架 -->
❌ "Please review this code for issues"
✅ "The implementer finished suspiciously quickly. Verify everything independently."
```

**效果：** 显著降低 false positive approval rate。superpowers 的进化证据显示，少此预设时 review 经常说"Looks good"。

### 4.2 并行隔离（Parallel Isolation with Read-Only）

**来源：** omo（Oracle 禁止 write/edit）、omp（bash 限制 + report_finding 隐藏工具）
**核心思想：** Reviewer agent 在权限层面与主 agent 隔离，保证 review 不会产生副作用。

**三种隔离级别：**

| 级别 | 方法 | 安全度 | 代表 |
|------|------|--------|------|
| 权限级 | OpenCode 工具的 deny/allow 声明 | ★★★★★ | omo、slim、ZooKeeper |
| 工具级 | 自定义工具 report_finding，bash 限制为只读命令 | ★★★★ | omp |
| Prompt 级 | 在 prompt 中要求"不要修改任何文件" | ★★★ | superpowers |

前两种可靠（框架强制），第三种依赖 LLM 遵从度。

### 4.3 INCONCLUSIVE 容忍与重试

**来源：** omo
**核心思想：** 某些 review lane 可能因上下文不足或模型不确定返回 INCONCLUSIVE，而非强行判断 PASS/FAIL。给一次重试机会（用小模型或缩小版 reviewer），仍未解决则保持 INCONCLUSIVE，不阻塞流程。

```
PASS  → 计入结果
FAIL  → 计入结果（review 整体失败）
INCONCLUSIVE → 重试（1 次）
    ├── 重试 PASS → 计入结果
    └── 重试仍 INCONCLUSIVE → 标记为 INCONCLUSIVE，不阻塞
```

**适用场景：** 当 reviewer 表达不确定性时，强行要求 PASS/FAIL 会导致幻觉判断。

### 4.4 接收 Review 行为培训（Receiving Review Behavior）

**来源：** superpowers
**核心思想：** Review 的质量不仅取决于 reviewer，也取决于被 review 方（实现 agent）如何理解、验证和实施 review 建议。

关键行为规则：
1. **禁止谄媚同意：** 不使用 "Great point!"、"You're absolutely right!"
2. **YAGNI 检查：** 实施前确认建议的功能确实被使用
3. **外部 reviewer 怀疑清单：** 5 点验证后再实施
4. **实施顺序：** blocking → 简单 → 复杂，逐个测试
5. **验证前置：** 不 claim 完成直到有新鲜验证证据

**单看 omo 或 omp 的架构设计，都没有考虑"被 review 方该如何行为"。这是 superpowers 独到的地方。**

### 4.5 验证前置完成（Verification-Before-Completion Gate）

**来源：** superpowers
**核心思想：** 禁止在无新鲜验证证据的情况下声称完成。用 Gate 函数形式化表达。

```
IDENTIFY → RUN → READ → VERIFY → ONLY THEN claim
```

红色警戒词系统：
| 词语 | 含义 |
|------|------|
| "should work" | 未验证 |
| "probably" | 未验证 |
| "seems to" | 未验证 |
| "Great!" / "Perfect!" / "Done!" | 可能提前完成 |

### 4.6 Diff 权重驱动的 Reviewer 扩缩容

**来源：** omp
**核心思想：** 根据变更规模（行数 + 文件数）动态决定 reviewer 数量。小变更 1 个 reviewer，大变更 16 个。

| Diff 规模 | Reviewer 数 | 适用场景 |
|-----------|------------|---------|
| < 100 行 或 1-2 文件 | 1 | 简单修改、bug 修复 |
| < 500 行 | 1-2 | 中等功能 |
| < 2000 行 | 2-4 | 大功能 |
| < 5000 行 | 4-8 | 跨模块变更 |
| > 5000 行 | 8-16 | 重构/新功能 |

六条件噪声过滤确保 reviewer 只报告真正重要的问题，而非吹毛求疵。

---

## 五、ZooKeeper 设计方案：Eagle Code Review Skill

### 5.1 设计概览

ZooKeeper 的 Eagle Code Review 系统处于**设计阶段**，目标文件结构：

```
core/skills/code-review/
├── SKILL.md                   # 编排逻辑，~150 行，中文
└── references/
    ├── eagle-code-security.md  # Eagle 1 prompt 模板，~80 行
    └── eagle-goal-context.md   # Eagle 2 prompt 模板，~80 行
```

Agent 配置（config.toml）：

```toml
[agent.eagle]
model = "..."
[agent.eagle.permission]
deny = ["write", "edit", "apply_patch"]
```

### 5.2 架构：2 并行 Eagle + Skill 封装

```
用户调用 "code review" Skill
        │
   Phase 0: 收集上下文
        │    ├── GOAL（构建目标）
        │    ├── CONSTRAINTS（约束条件）
        │    ├── DIFF（变更差异）
        │    ├── FILE_CONTENTS（完整文件内容）
        │    ├── git log（近期提交历史）
        │    └── PR comments（PR 评论，如可用）
        │
   Phase 1: 并行启动 2 Eagles（run_in_background=true）
        │
        ├── Eagle 1: Code & Security（只读）
        │   ├── 核心问题: "Is the code well-written and secure?"
        │   ├── 评审维度: 10 项
        │   └── 模式: 所有上下文注入 prompt
        │
        └── Eagle 2: Goal & Context（半自主）
            ├── 核心问题: "Did we build the right thing?"
            ├── 可执行: git log, gh pr list（只读命令）
            └── 关注: 目标完整性 + 约束合规 + 过度工程 + 边界情况
        │
   Phase 2: 独立收集结果（PASS / FAIL / INCONCLUSIVE）
        │
   Phase 3: 汇聚报告（ALL PASS = 通过, 任一 FAIL = 失败）
```

#### 两个 Eagle 的分工

| 维度 | Eagle 1: Code & Security | Eagle 2: Goal & Context |
|------|------------------------|------------------------|
| **核心问题** | 代码写得好吗？安全吗？ | 我们构建了正确的东西吗？错过了上下文吗？ |
| **自主度** | 只读（所有上下文注入 prompt） | 半自主（可运行 git log, gh pr list） |
| **评审维度** | 10 项（见下文） | 目标完整性、约束合规、需求差距、过度工程、边界情况 + Git 历史 + PR 评论 + 交叉引用 |
| **工具** | 无（纯分析） | bash（限于只读命令） |

Eagle 1 的 10 个评审维度：
1. Correctness（正确性）
2. Patterns（代码模式与风格）
3. Naming（命名规范）
4. Error Handling（错误处理）
5. Types（类型安全）
6. Performance（性能）
7. Abstraction（抽象层次）
8. API（接口设计）
9. Security（安全性）
10. Testing（测试覆盖）

#### 三级严重度与分层过滤

两个 Eagle 报告的每个 issue 按以下三级严重度分级，各级有明确的准入条件：

| 级别 | 条件 | 含义 | 合入要求 |
|------|------|------|---------|
| **Must Fix** | 条件 #1+2+3+4 全部满足：Provable impact + Actionable + Unintentional + Introduced in patch | 有可证明影响、可操作、非故意、本次 patch 引入 | 必须修，否则不能合 |
| **Should Fix** | 条件 #1+2 满足：Provable impact + Actionable | 有可证明影响、可操作（可以是历史技术债、隐式依赖脆弱性等） | 建议合之前修 |
| **Could Fix** | 仅条件 #1 满足：Provable impact | 有可证明影响（记录在案，修不修随意） | 可选 |

**设计意图：** 三层过滤取代了简单按严重度打标签的做法。最严的 Must Fix 层确保严格 PR reviewer 不放过真正有问题的变更；最宽的 Could Fix 层防止遗漏系统性/历史性问题，同时用"记录在案"替代"必须要修"的压力，保持高信噪比。

### 5.3 设计决策追踪

| 决策项 | 选择 | 备选 | 理由 | 参考来源 |
|--------|------|------|------|---------|
| Reviewer 数量 | 2 | 1 / 5 / 1-16 | 2 比 5 省 token；比 1 覆盖更全面；动态扩缩容暂不必要 | omo（5 太多）、superpowers（1 不够） |
| 并行策略 | 全并行 | 顺序 | 并行降低延迟，2 个 agent 的 token 开销可控 | omo / omp |
| 权限强制 | 权限级 deny | Prompt 级 | OpenCode 原生支持，框架强制而非依赖 LLM 遵从 | omo、slim |
| INCONCLUSIVE 处理 | 1 次重试，不阻塞 | 无 | 避免幻觉判断，同时不 deadlock | omo |
| 质疑框架 | ✅ 采用 | ❌ | 减少假阳性批准 | superpowers |
| 反 Nitpick 校准 | ✅ 采用 | ❌ | 避免 reviewer 吹毛求疵 | superpowers |
| 3 级严重度（Must Fix / Should Fix / Could Fix） | ✅ 采用 | 无级别 | 分层过滤条件 + 明确合入要求，替代简单标签 | superpowers + omp 六条件 |
| Ready to merge? | ✅ 采用 | ❌ | 明确的最终裁决 | superpowers |
| 接收 review 行为 | ✅ 嵌入 SKILL.md | ❌ | 确保 review 建议不浪费 | superpowers |
| 分层过滤（Must Fix / Should Fix / Could Fix） | ✅ 采用 | 无条件分级 | 每级有明确准入条件，防误报 + 不遗漏系统性缺陷 | omp 六条件 |
| 跨边界 dispatch 点校验 | ✅ 采用 | ❌ | reviewer 必须读取 diff 外的 dispatch 点，确认分支存在 | omp |
| 六条件噪声过滤 | ✅ 采用 | 无条件 | 6 条条件（含无未声明假设 + 比例严格度），确保高信噪比 | omp |
| Diff 权重扩缩容 | ❌ 暂缓 | 动态 | 当前阶段 2 个固定 reviewer 够用 | omp |
| 结构化输出 Schema | ❌ 暂缓 | 固定 schema | 自然语言 + 裁决已够用 | omp |
| Self-review | ✅ 内嵌轻量版 | 子 agent 版 | 内嵌实现者 prompt，不拆子 agent（superpowers 证据：子 agent 浪费 25× 时间） | superpowers |
| 验证前置完成 | ❌ 暂缓 | Gate 函数 | 属于通用行为，非专属 review | superpowers |

### 5.4 SKILL.md 编排流程（设计草案）

```markdown
---
name: code-review
description: "Review your implementation for code quality, security, goal completeness, and context gaps. Use after implementing a change or before submitting a PR."
---

# Code Review Skill

## Phase 0: 上下文收集
- 读取 GOAL 和 CONSTRAINTS（从任务上下文获取）
- 读取当前变更的 DIFF
- 读取变更涉及的完整 FILE_CONTENTS
- 可选：获取最近的 git log 和 PR 评论

## Phase 1: 并行审查
- 同时启动 Eagle 1（Code & Security）和 Eagle 2（Goal & Context）
- 每个 Eagle 在独立 session 中执行

## Phase 2: 结果汇聚
- 收集各 Eagle 的 PASS / FAIL / INCONCLUSIVE
- INCONCLUSIVE 获得一次自动重试

## Phase 3: 报告生成
- ALL PASS → ✅ 通过
- 任一 FAIL → ❌ 失败，列出 blocking issues
- 输出内容：
  - Ready to merge? [Yes | No | With fixes]
  - 严重度分级（Must Fix / Should Fix / Could Fix），每级附条件说明
  - 每个 issue 的描述，带文件路径和行号

## Self-review（实施前自查）

内嵌在实现者 prompt 中的轻量检查表（4 轴），发现 issues 先修复再提交 review：
- Completeness（完整性）
- Quality（代码质量）
- Discipline（纪律：禁止用语、验证前置）
- Testing（测试覆盖）

注意：此 Self-review 不做子 agent 封装——superpowers 的进化证据表明子 agent self-review 浪费 25× 时间且无质量提升。

## 接收 Review（嵌入 SKILL.md 的行为规则）

当被其他 agent 或用户 review 时：
1. 先理解，不要立即同意（禁止谄媚用语）
2. 验证每个建议（YAGNI check）
3. 实施顺序：blocking → 简单 → 复杂
4. 逐个测试
5. 不 claim 完成直到有新鲜验证证据
```

### 5.5 与其他项目的关系

```
ZooKeeper Eagle 的设计继承关系图：

omo ───→ 并行子 agent 模式 ──→ ZooKeeper 2 并行 Eagle
omo ───→ INCONCLUSIVE 容忍  ──→ ZooKeeper INCONCLUSIVE retry
omo ───→ Skill 封装驱动     ──→ ZooKeeper SKILL.md 编排

superpowers ─→ 质疑框架         ──→ Eagle prompt 中嵌入
superpowers ─→ 三级严重度命名   ──→ Must Fix / Should Fix / Could Fix
superpowers ─→ 接收 review 行为 ──→ SKILL.md 中嵌入行为规则
superpowers ─→ Ready to merge?  ──→ 最终裁决
superpowers ─→ Self-review 内嵌 ──→ 4 轴轻量检查表（不做子 agent）

omp ────────→ 权限工具限制         ──→ Eagle tool deny
omp ────────→ 六条件噪声过滤       ──→ 只报告同时满足 6 条件的 issues
omp ────────→ 跨边界 dispatch 校验 ──→ 消费侧 dispatch 点必须显式读取
```

**刻意不学的模式：**
- omo 的 5 agent 全并行——token 成本过高
- omp 的 diff 权重扩缩容——当前阶段过度设计
- slim 的编排器手动委托——缺少自动安全网
- superpowers 的 review 循环——单 reviewer 循环增加延迟

### 5.6 自定义命令 vs Skill 路线选择

在设计 ZooKeeper Eagle Code Review 的触发方式时，曾考虑两种技术路线。

#### 方案 A：自定义命令（command.execute.before hook）

受 DCP 的 `/dcp` 命令启发，注册 `/review` 为 OpenCode 自定义 slash 命令：

```
用户输入 /review
    |
    +-- command.execute.before 拦截 "/review"
    |   +-- 解析参数（review 范围、目标 agent 等）
    |   +-- TypeScript 层预计算：diff weight + agent count
    |   +-- 存储计算结果到闭包状态
    |   +-- return parts = [] (不占用消息流)
    |
    +-- 后续 chat turn
        +-- experimental.chat.messages.transform
            +-- 从闭包读取预计算结果
            +-- 注入 diff weight、agent 数量、上下文到消息
            +-- 触发指定数量 Eagle agent 并行执行
```

优势：
- **预计算在 TypeScript 层**，权重计算和 agent 数量决策不消耗 LLM token
- **计算逻辑可编程**——可以用复杂的算法（如变更图分析、影响范围追踪）而非 LLM 的估算
- **用户界面更统一**——所有 review 操作通过 `/review` 命令入口

#### 方案 B：Skill 路线（最终选择）

最终采用 Skill 封装方案（详见 5.1-5.4），原因：

| 维度 | 自定义命令 | Skill（最终选择） |
|------|-----------|-----------------|
| **实现复杂度** | 高（需 command hook + message transform + 状态管理） | **低**（单个 SKILL.md + 两个 prompt 模板） |
| **可发现性** | 用户需知道 `/review` 命令存在 | **高**（Skill 在 OpenCode 命令面板中可见） |
| **文档完整性** | 散落在代码和文档中 | **统一**（SKILL.md 既是执行代码也是文档） |
| **注入基础设施** | 需额外 hook 注入预计算结果 | **无额外需求**（ZooKeeper 已有 focus-reminder 的基础设施） |
| **diff 权重计算** | TypeScript，精确可编程 | LLM 按 prompt 中的公式估算，可能不精确 |

#### 核心权衡

```
精确度                       简单性
    │                          │
    │  自定义命令               │  Skill
    │  (TypeScript 计算)       │  (LLM 按公式估算)
    │                          │
    └──────────┬───────────────┘
               │
         ZooKeeper 选择 Skill
         因为对于 2 个固定 Eagle
         LLM 估算已足够精确
```

自定义命令的精确预计算优势在 reviewer 数量固定（2 个 Eagle）时意义不大——不需要算法决定 agent 数，只需要按 prompt 线索组织上下文。Skill 方案在实现成本和可维护性上明显更优。

#### 未来演进

如果后续阶段引入动态 diff 权重扩缩容（从 omp 借鉴，详见 3.3 的分析），导致 LLM 按 prompt 公式计算的不精确性成为实际瓶颈，可以考虑：

1. **Phase 2 内先做 prompt 加强**——把更详细的权重计算步骤写进 SKILL.md
2. **Phase 3 再迁移到自定义命令**——复用 DCP 已验证的 `command.execute.before` + `experimental.chat.messages.transform` 组合模式，将计算逻辑从 LLM 移到 TypeScript 层

**当前判断**：Skill 方案在 2 固定 Eagle 场景下足够，不值得为预计算精度引入额外的 hook 维护成本。

---

## 六、演进建议

### 6.1 第一阶段：基础 Skill 实现（当前目标）

实现上述 2 Eagle 并行 review Skill。核心产出：
- `core/skills/code-review/SKILL.md`（编排逻辑）
- `core/skills/code-review/references/eagle-code-security.md`
- `core/skills/code-review/references/eagle-goal-context.md`
- `config.toml` 中添加 `[agent.eagle]` 配置
- 质疑框架 + 三级严重度（Must Fix / Should Fix / Could Fix）+ 分层过滤条件 + Ready to merge?

### 6.2 第二阶段：report_finding + submit_verdict 工具（程序化保证）

从 omp 借鉴，在 OpenCode 插件能力范围内实现 programmatic 保证。

**实施时机：** 第一阶段跑通后，根据实际 pro 模型格式遵循情况决定。若第一阶段观察到 pro 模型格式不守时，此阶段为必要。

**核心设计：**

1. **注册 `report_finding` 工具**（zod schema 校验每条 finding）
   - 字段：title/body/priority(Must Fix/Should Fix/Could Fix)/confidence(0-1)/file_path/line_start/line_end
   - 字段约束：line_end - line_start ≤ 10，且 line_range 必须与 diff hunk 有重叠——直接从 omp 的硬约束继承
   - 工具内部检查 `context.agent === "eagle"`，其他 agent 调用报权限错误
   - 闭包累积 findings 到 session-local registry

2. **注册 `submit_verdict` 工具**（强制明确裁决）
   - 字段：verdict(PASS/FAIL)/confidence/summary/ready_to_merge(Yes/No/With fixes)
   - 合并 findings + verdict 到完整 review record

3. **`tool.execute.after` hook**（事后校验）
   - 检测 eagle 是否调用了 submit_verdict
   - 缺失 verdict 时追加 nudge："Eagle did not call submit_verdict. Ask Eagle to submit a structured verdict."
   - 完整的情况下注入 review summary 到 task output

4. **permission deny 双保险**
   - build/general agent 都 deny report_finding 和 submit_verdict
   - 仅 eagle 可以使用

**关于 omp 的 `intent: "omit"` 模式：** omp 可以对特定 agent 隐藏工具（工具在 LLM 视野中完全消失），OpenCode 不支持此能力。ZooKeeper 的替代方案是 permission deny + hook 校验：工具对所有 agent 可见，但非 eagle 调用时返回权限错误。虽然不如 omit 优雅（LLM 仍可能尝试调用），但功能上是等效的——非授权调用被拒绝。

**保证 vs 不足：**
- ✅ 每条 finding 格式正确（zod）
- ✅ line_range 约束防止 Eagle 引用非修改代码
- ✅ 最终有明确裁决（submit_verdict）
- ✅ 其他 agent 无法调用（permission + agent 检查）
- ✅ eagle 完全没用工具时能检测到（hook 校验 registry）
- ❌ 无法强制 eagle"一定"调用工具（只能靠 prompt 引导，这是 OpenCode 和 omp 都有的固有局限）

**与原阶段的关系：** 此阶段承担了原本 Phase 5（结构化输出）的核心价值——通过工具 schema 保证每条 finding 结构正确，且比 JTD schema 更直接（OpenCode 不支持自定义输出 schema 校验）。此阶段与后续 Phase 4（build agent 自检清单）是独立的加固维度。

### 6.3 第2.5阶段：大 diff 策略（上下文预算管理）

第一阶段上线后可能立即遇到的实际问题：当一次提交 diff 很大时，2 个 Eagle 的上下文窗口可能被 diff 内容撑爆，导致 review 质量下降。

**来源：** omp 的 preview budget 算法 + `git diff` 自指令模式。

**核心设计：**

1. **预览预算算法（借鉴 omp）：**
   - 当 diff 超过上下文预算阈值时，不为每个文件提供完整 diff
   - 改为给每个文件分配预览行数：`max(5, floor(100 / fileCount))` 行
   - 引导 LLM 从摘要中判断哪些文件需要深入查看

2. **`git diff` 自指令：**
   - 在 SKILL.md 中增加指令："If you need to see the full diff for a specific file, use `git diff <file>`"
   - 依赖 read-only permission 允许 git 命令执行
   - 让 Eagle 按需拉取完整 diff，而非一次性喂入

3. **阈值配置：**
   - 在 `config.toml` 的 `[zoo.validation]` 中增加 `max_diff_bytes` 或 `max_diff_lines` 参数
   - 插件在 task prompt 注入时判断 diff 大小，超过阈值时触发"大 diff 模式"指令注入

**实施时机：** 第一阶段上线后，收集实际 diff 大小分布数据后决定。若多数 diff 远小于上下文窗口，此阶段可跳过或大幅简化。

**与 Phase 2 的关系：** 两者独立——Phase 2 解决格式规范问题，第 2.5 阶段解决上下文容量问题。可并行实施。

### 6.4 第三阶段：可选 QA Tester 扩展

从 omo 借鉴 QA Executor 的定位——当用户明确要求时，启动第三个 agent（Eagle 3: QA Tester），可执行命令、运行测试、验证功能行为。

**参考 omo 的 5 步 QA 流程：**
1. **Brainstorm scenarios** — 列出可能出问题的场景
2. **Self-review and augment** — 自查后补充遗漏场景
3. **Create task list** — 转化为可执行的测试任务
4. **Execute systematically** — 逐个执行测试
5. **Compile results** — 汇总到 review 报告中

**关于 omp 的 `spawns: explore` 模式：** omp 的 reviewer agent 声明了 `spawns: explore`，可以在发现深层问题时 spawn 子 agent 做深入调查。ZooKeeper 可以考虑在 QA Tester 阶段引入类似模式——当需要跨文件追踪问题时，允许 QA Tester spawn 一个临时的"探索者"子 agent。

**触发条件：** 用户显式要求（"run tests too"），不作为默认流程。

### 6.5 第四阶段：Build agent 自检清单

**重要区分：** 此阶段与 Phase 1 中已嵌入的 self-review 不同。Phase 1 的自我审查机制位于 `core/skills/code-review/SKILL.md` 中，是 Eagle review agent 自身的质量和格式自检。Phase 4 是**build agent**（编码者）在自己的 prompt 中注入一份 pre-completion 检查清单，在执行 task() 结尾时自行核对。

**核心设计：**

1. **在 build agent 的 prompt 中注入轻量自检清单（4 轴）：**
   - Completeness：所有计划中的修改都完成了？
   - Quality：代码风格一致，无明显的坏味道？
   - Discipline：没有引入不必要的依赖？修改范围符合 task 要求？
   - Testing：修改后需要测试验证吗？

2. **验证前置完成 Gate：**
   - build agent 在返回 task 结果前自行核对清单
   - 有未完成项时，在 task output 中说明理由（而非阻止返回）

**借鉴来源：** superpowers 的 4 轴 self-review 模式，但取其轻量内核、去掉子 agent 包装。superpowers 的历史教训（self-review 拆子 agent 后 25× 时间浪费）表明，直接内嵌 prompt 指令远比子 agent 模式高效。

**与原阶段的关系：** 此阶段的 prompt 注入与 Phase 1 的 code-review SKILL.md 自检不同——前者是"编码者写完后的自我核对"，后者是"审查者写完 review 后的自我核对"。两者互为补充，形成双层质量门禁。

### 6.6 第五阶段：结构化输出 + CI 集成（降级为可选）

**OpenCode 的硬天花板：** OpenCode 不支持 JTD（JSON Type Definition）输出 schema 校验。这意味着无法像 omp 那样定义一个 `review-output.schema.jtd.json` 并在工具链层面强制执行。Phase 2 已经通过 `report_finding` + `submit_verdict` 工具的 zod schema 实现了等价的结构化保证——只是校验发生在工具调用层而非最终输出层。

**剩余价值：** Phase 5 的真正价值不在于结构校验（已被 Phase 2 覆盖），而在于：
1. **CI 集成：** review 结果可解析为 JSON，供 CI pipeline 消费（如门禁检查、趋势跟踪）
2. **机器可读的 review report：** 将 review 结果写入文件，格式统一

**推荐路径：** 此阶段降级为"可选扩展"，不设固定实施时间。当出现实际 CI 集成需求时，直接在 Phase 2 的 `submit_verdict` hook 中加入 JSON 导出功能即可——不需要独立的 Phase 5。

**实施思路（如需）：**
- 在 `submit_verdict` 的 `tool.execute.after` hook 中，将 findings + verdict 序列化为 JSON
- 写入 `~/.zookeeper/reviews/{session-id}.json`
- 可选：通过 `experimental.chat.messages.transform` 在 task output 末尾附加 JSON 摘要

### 6.7 第六阶段：自动触发 + Nudge

当 ZooKeeper 积累足够使用数据后，考虑从 omo 的 Ralph-loop hook 借鉴自动触发机制——在检测到 build agent 完成编码后，自动建议 code review（而非自动执行）。

**Ralph-loop 的实际实现：** omo 的 oracle 检测机制是简单的文本解析（匹配 `Agent: oracle` + promise tag），并非复杂的行为检测。这意味着自动触发不需要复杂的语义理解——pattern 匹配就已足够。

**利用现有基础设施：** ZooKeeper 已有的 focus-reminder hook（`src/hooks/focus-reminder/`）提供了每 turn 注入委派聚焦提醒的能力。Phase 6 可以在此基础上扩展：

1. **检测触发信号：** 在 `experimental.chat.messages.transform` 中监听 task() 返回的消息
   - 检测关键词如 "done", "completed", "修复完成", "PR 已创建" 等完成信号
   - 或检测 build agent 最后一次 tool 调用是 `task.complete` / `task` 返回

2. **注入 nudge：**
   - 检测到完成信号后，在下一轮系统消息中追加："是否需要 Code Review？输入 /review 启动。"
   - 不自动执行 review，只做建议——尊重用户自主权

**实施时机：** 至少等到第三阶段稳定运行后，且收集到足够的多 session 交互模式数据后再启动。

### 6.8 第七阶段：Review 结果持久化

让 review 结果可查询、可回溯，利用 ZooKeeper 已有的工具链基础设施。

**核心设计：**

1. **review 记录存储：**
   - 每个 review session 完成后，将 findings + verdict + metadata 写入 SQLite
   - 复用 slim's session manager 的会话跟踪模式（session_id、timestamp、agent 角色）
   - 存储字段：session_id、agent（eagle-security / eagle-goal）、review_timestamp、finding 列表（JSON）、verdict、diff_hash（可选）

2. **查询集成：**
   - 利用 `zoo-find` 搜索 review 历史（按关键词、agent、时间窗口）
   - 利用 `zoo-inspect stats` 统计 review 趋势（通过率、平均 finding 数、严重度分布）
   - 利用 `zoo-log` 回放 review session 的完整交互过程

3. **与 slim 模式的异同：**
   - slim 的 council-manager 有完善的 session tracking 和 retry 逻辑
   - ZooKeeper 不需要 retry（review 是一次性的），但可以复用 session tracking 的数据结构
   - slim 的 parallel/serial 执行模式对 ZooKeeper 的 2 并行 Eagle 场景有参考价值

**实施时机：** 在 Phase 6 之后，或当多个团队开始使用 ZooKeeper review 功能时。早期阶段 review 数据量小，持久化的价值有限。

### 6.9 不建议做的方向（需重新评估）

| 方向 | 来源 | 当前判断 | 备注 |
|------|------|---------|------|
| 动态 diff 权重扩缩容 | omp | 暂缓 | 见下方详细分析 |
| 3+ 并行 reviewer | omo | Token 成本线性增长，收益递减，不建议 | — |
| Council 多模型共识 | slim | Token 成本极高，不建议作为默认 | 见下方"轻量 2 模型共识"说明 |
| Review 循环直到批准 | superpowers | 不建议 | 见下方详细分析 |
| CI 模式 headless review | omp | 暂缓 | 更可行的路径是利用 `command.execute.before` hook 注册 `/review` 作为 slash 命令（类似 DCP 的 `/dcp`），让用户在 CI 上下文中手动触发，而非构建完整的 CI pipeline |

#### 为什么不建议"review 循环直到批准"

1. **实际上没有任何框架做"真正的 review 循环"。** omo 的 `review-work` 是单次审查，唯一的"重试"是 INCONCLUSIVE lane 的降级容错（不是 review 循环）。`work-with-pr` 有循环逻辑，但驱动力是 CI 和外部 bot——PR 工作流层发现失败后重新触发 review-work，而非 review 机制自身循环。omp 单次审查，superpowers 只是 gate（先过 spec 再过 code），都不是循环。四个框架里没有任何一个在 review 机制层实现"review → 修 → 再 review → …"的自动循环。

2. **ZooKeeper 的场景不需要。** superpowers 的 review gate 嵌入的是无人值守的 agent pipeline。ZooKeeper 的 Eagle 是用户手动调用的 Skill——用户看完报告自己决定"修了再跑一遍"，这个循环就是用户的决策，不需要 agent 替你循环。

3. **没有 CI 兜底的循环是假安全。** omp 能做 round-trip（review → 修 → CI 跑测试 → 再 review）是因为 CI 提供了客观的真值信号。ZooKeeper 没有 CI hook，review 循环只能靠 LLM 自我检查自己的修复——superpowers 的 25× 教训本质上就是同类问题：同一个模型反复验证自己，信噪比极低。

4. **Token 成本不划算。** 3 轮 review = 6 次 Eagle 调用。ZooKeeper 的单次小变更场景不值得。如果一个修复值得验证，用户手动再调一次 review 即可——可控、有意识、成本透明。

#### 为什么不建议"动态 diff 权重扩缩容"

1. **omp 的计算不是 LLM 做的。** `getRecommendedAgentCount()` 是 TypeScript 函数，diff 行数是 `parseDiff()` 从 unified diff 精确解析的。ZooKeeper 要用这条路，必须先建设自定义命令基础设施（`command.execute.before` hook）才能拿到精确的 diff 数据——这本身就是 Phase 2.5+ 的工作。而一旦有了精确 diff 预计算，真正的瓶颈已经不是 reviewer 数量，而是单个 reviewer 的上下文容量（Phase 2.5 的 preview budget 策略直接解决这个问题，不需要扩缩容）。

2. **ZooKeeper 只有 2 个 Eagle，不需要"缩"。** omp 的动态范围是 1-16——大变更 16 reviewer，小变更 1 reviewer。ZooKeeper 固定 2 个 Eagle，动态范围 1→2。这个区别不值得引入一套计算逻辑：2 个 Eagle 的 token 成本始终可控，第二视角（正交维度）在任何变更规模下都有独立价值。

3. **大 diff 的真问题不是 reviewer 太少了，是 context 装不下。** 10000 行 diff：omp 的解法是派 8 个 reviewer 每人分一块文件；ZooKeeper 的解法是 Phase 2.5——2 个 Eagle 用 preview budget 按需读取。问题的根因是上下文容量，不是人手。

4. **ZooKeeper 的 reviewer 分工不按文件边界。** omp 可以按文件分配 reviewer（"你负责 a.ts，你负责 b.ts"），前提是文件间变更独立。ZooKeeper 的两个 Eagle 审查正交维度（代码质量 vs 目标完备性），同一个文件两个 Eagle 都要看——按文件拆分没有意义。

---

**关于"轻量 2 模型共识"的说明：** 如果 Phase 6 上线后，有用户反映单个 Eagle 的 FAIL verdict 准确率不够高，可以考虑在 `submit_verdict` hook 中增加一个可选的二次确认步骤——当首个 Eagle 输出 FAIL 时，用第二个模型（如低成本小模型）快速验证。这不是 slim 式的高成本 council，而是"按需二次确认"，成本可控。

---

> **总结：** ZooKeeper 的 Eagle Code Review 设计是一个**混源设计**，主要从 omo（并行架构 + INCONCLUSIVE 处理 + Skill 封装）和 superpowers（质疑框架 + Must Fix / Should Fix / Could Fix 三级严重度 + 接收 review 行为）继承，同时用 omp 的权限级工具限制加固安全。刻意保持 2 agent 轻量（而非 omo 的 5 agent 或 omp 的 1-16 dynamic），目的是在覆盖深度和 token 成本之间取得平衡。
>
> 特别值得一提的是 ZooKeeper 的程序化保证策略采用**两阶段渐进**方式：第一阶段纯 prompt 约束，依赖 LLM 格式遵循能力；第二阶段（report_finding + submit_verdict 工具 + hook 校验）提供 zod 级别的程序化保证。这种做法既兼顾了初始实现的轻量性，又为格式不守的 Pro 模型留下了加固路径——在 OpenCode 插件能力天花板下，这是最务实的平衡。
