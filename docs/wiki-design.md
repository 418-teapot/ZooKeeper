# LLM Wiki — 轻量文件知识库设计文档

**版本:** 1.0
**日期:** 2026-06-17

---

## 目录

1. [概览](#1-概览)
2. [目录结构](#2-目录结构)
3. [SCHEMA.md 规范](#3-schemamd-规范)
4. [kiwi Agent](#4-kiwi-agent)
5. [wiki-ingest Skill](#5-wiki-ingest-skill)
6. [工作流](#6-工作流)
7. [注入机制](#7-注入机制)
8. [index.md 与 log.md 格式](#8-indexmd-与-logmd-格式)
9. [页面模板](#9-页面模板)
10. [集成点](#10-集成点)
11. [迁移路径](#11-迁移路径)

---

## 1. 概览

### 1.1 问题陈述

ZooKeeper 目前缺乏持久化的知识积累机制。每次对话中 agent 发现的项目知识（架构决策、约定惯例、已知问题、第三方集成配置）都随着会话结束而丢失。导致：

- 同一类问题在不同会话中被反复研究
- build（编排器）无法利用之前探索中发现的上下文
- 项目知识隐式存在于 agent prompt 中，但无法被显式查询和更新
- 随着 agent 数量和场景增加，prompt 膨胀而知识碎片化

### 1.2 为什么 LLM Wiki 而非 RAG

| 维度 | RAG（向量数据库） | LLM Wiki（纯文件） |
|------|------------------|-------------------|
| 基础设施 | 需要 embedding 服务、向量存储、检索管道 | 零依赖 — 只有 Markdown + git |
| 维护成本 | 索引更新、chunk 策略调优、embedding 模型选择 | 纯文件操作（CRUD），git diff 可审计 |
| 检索质量 | 依赖 embedding 质量 + 检索算法 | LLM 自己决定读什么（通过 index.md 导航） |
| 确定性 | 语义搜索有不确定性，同一 query 可能返回不同 chunk | 确定性路径 — 读 index → 选页面 → 读内容 |
| 冷启动 | 需要预先 embedding 所有源文档 | 随用随建，kiwi 按需 ingest |
| 规模上限 | 可扩展至百万级文档 | 适合 ~100 个源 / 数百页（Karpathy 经验值） |

ZooKeeper 是编排器插件项目，知识范围有限（~5 个 agent，~50 个 prompt 和技能文件）。纯 Markdown 方案足够覆盖。

### 1.3 关键设计原则

1. **Knowledge Compiled Once** — 知识在 ingest 时编译为结构化页面，而不是每次 query 时从原始源重新推导。
2. **Query Back to Wiki** — 好的 query 答案被归档回 wiki，实现知识累积增长而非每次重新生成。
3. **Three-Layer Architecture** — 原始源（不可变）→ 结构化 Wiki（LLM 生成）→ SCHEMA（定义规范），层间单向依赖。
4. **index.md First** — LLM 阅读 index.md 决定要读哪些页面，代替 RAG 的向量检索。
5. **Minimal Infrastructure** — 纯 Markdown + git，零外部服务，零运行时依赖。
6. **Kiwi Owns the Wiki** — 专用的 kiwi agent 负责所有 wiki CRUD 操作，build（编排器）不直接编辑 wiki 文件。
7. **SCHEMA Auto-Injection** — SCHEMA.md 内容由 config hook 自动注入到相关 agent 的 system prompt 中，确保所有 agent 知晓 wiki 存在和使用方式。

---

## 2. 目录结构

```
wiki/
├── index.md                  # 类别组织的目录，含单行摘要
├── log.md                    # 追加式日志，记录 ingest/query/check 事件
├── overview.md               # 活的综合页面，随 ingest 更新
├── SCHEMA.md                 # 定义约定、工作流、页面格式
│
├── sources/                  # 原始源摘要（不可变的参考文档）
│   ├── adr/                  # 架构决策记录摘要
│   ├── rfc/                  # 外部 RFC / 规范摘要
│   └── notes/                # 会议记录、设计讨论摘要
│
├── concepts/                 # 概念页面（抽象知识）
│   ├── prompt-injection.md   # e.g. prompt 注入机制说明
│   ├── permission-model.md   # e.g. 权限 deny list 模型
│   └── ...
│
├── entities/                 # 实体页面（具象事物）
│   ├── build-agent.md        # build agent 角色说明
│   ├── task-tool.md          # task() 工具行为说明
│   └── ...
│
├── analysis/                 # 分析页面（结构化决策/权衡文档）
│   ├── lint-tradeoffs.md     # 各语言 lint 工具对比结论
│   └── ...
│
└── syntheses/                # 合成页面（归档的 query 答案）
    └── ...
```

### 各目录说明

| 路径 | 内容类型 | 生成者 | 不可变？ |
|------|---------|--------|---------|
| `wiki/overview.md` | 活的综合页面，项目级知识快照 | kiwi（ingest 时重写） | 否 — 每次 ingest 可能重写 |
| `wiki/sources/` | 对原始参考文档的人类可读摘要 | kiwi（ingest 时创建） | 是 — 追加新版本而非修改旧版本 |
| `wiki/concepts/` | 抽象知识、机制原理、设计模式 | kiwi（ingest 或分析时创建） | 否 — 随理解加深可更新 |
| `wiki/entities/` | 具象事物、工具、角色、API | kiwi（ingest 或 query 归档时创建） | 否 — 随行为变更可更新 |
| `wiki/analysis/` | 结构化决策/权衡文档（非 query 归档） | kiwi（ingest 或 health check 时创建） | 否 — 定期审查更新 |
| `wiki/syntheses/` | 归档的 query 答案，问题→答案映射 | kiwi（query 归档时创建） | 否 — 定期审查更新 |

---

## 3. SCHEMA.md 规范

### 3.1 文件位置

`wiki/SCHEMA.md` — 所有 wiki 操作（创建、更新、交叉引用、健康检查）的权威参考。

### 3.2 SCHEMA.md 内容大纲

```markdown
# Wiki Schema

> Wiki 的结构规范、页面格式约定和操作工作流。
> 所有 agent 在操作 wiki 前必须阅读本文档。

## 目录结构

（描述 wiki/ 下各目录用途，见 §2）

## 页面格式约定

### 前置元数据（Frontmatter）

每个 wiki 页面必须以 YAML frontmatter 开头：

---
title: <页面标题>
type: <concept | entity | source | analysis | synthesis>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
source: <原始源路径或 URL>（可选）
sources: [<slug>, ...]（可选 — 本页信息来源的源 slug 列表）
tags: [<tag1>, <tag2>]
related: [<相对路径>, ...]（可选）
status: <draft | review | stable | deprecated>
---

### overview.md 规范

`wiki/overview.md` 是一个特殊的**活的综合页面**（type: synthesis）：

- **目的**：提供项目级知识快照，让读者快速了解 wiki 中最重要的知识点
- **更新方式**：**重写而非追加** — 每次 ingest 时，kiwi 判断是否有实质变化需要更新 overview；如果更新，直接重写整个文件
- **触发条件**：ingest 完成后，由 kiwi 判断新知识是否足以 warrant 一次 overview 更新（LLM 决定）
- **内容**：高度凝练的摘要 + 指向详细页面的交叉引用，不包含完整细节
- **位置**：`wiki/overview.md`，wiki/ 根目录，与 index.md 同级

### 节结构

正文应包含以下标准节（按顺序，可省略不适用的）：

1. **Overview** — 一句话说明本页内容
2. **Details** — 主要知识内容
3. **Relations** — 关联的其他 wiki 页面（带链接和关系描述）
4. **References** — 外部引用（URL、文件路径、源文档）
5. **Notes** — 临时备注、待确认事项

### 命名规则

- 文件名：小写 kebab-case，如 `permission-model.md`
- 无序号前缀（排序由 index.md 的类别分组决定）
- 同类型页面不重名
- source 页面命名：`wiki/sources/<type>/<short-title>.md`，其中 `<type>` 为 `adr` / `rfc` / `notes`

### 交叉引用规则

- 使用基于项目根目录的路径：`[prompt injection](wiki/concepts/prompt-injection.md)`
- 在 related frontmatter 字段中列出直接关联页面的项目根目录路径
- index.md 中的摘要应反映页面间的关联关系
- overview.md 应引用各目录中最重要的页面，但不替代 index.md 的完整索引

### 写作风格指南

- **中文撰写**，技术术语保留英文（如 "prompt injection"、"deny list"）
- **段落短小**，每段不超过 5 句
- **列表优先**，枚举关系用列表而非长段落
- **避免冗余**，同一事实只在一个页面中详细描述，其他页面交叉引用
- **标注不确定性**：未确认的信息用 `> **待确认：** ...` 标注

## 操作工作流

（见 §6 工作流）

## 索引与日志

（见 §8 index.md 和 log.md 格式）
```

### 3.3 注入方式

SCHEMA.md 的内容（至少缩略版本）在插件 `config` hook 中被注入到 `build`、`explore`、`general` 和 `kiwi` agent 的 prompt 尾部。见 §7。

---

## 4. kiwi Agent

### 4.1 角色定义

Kiwi 是 wiki 的专属维护 agent。它不参与代码编写、代码搜索或 web 研究——它只做三件事：**ingest**（吸收源文档生成页面）、**update**（维护 wiki 页面的一致性）、**check**（健康检查）。Kiwi 是叶子节点 agent（无 `task` 权限），通过 `read` / `write` / `edit` 工具操作 `wiki/` 目录。

### 4.2 config.toml 条目

```toml
[agent.kiwi]
mode  = "subagent"
model = "{env:ZOO_MODEL}"       # 使用大模型以保证生成质量
[agent.kiwi.permission]
task = "deny"                   # 叶子节点，不委派
webfetch = "deny"               # 不负责 web 研究
websearch = "deny"
bash = "deny"                   # 不执行任意命令
grep = "allow"                  # 需搜索 wiki 内容
glob = "allow"                  # 需发现 wiki 文件
read = "allow"                  # 需读取 wiki 页面和源文档
write = "allow"                 # 需创建新 wiki 页面
edit = "allow"                  # 需更新已有 wiki 页面
```

### 4.3 模型选择理由

使用大模型（`ZOO_MODEL`，与 build、eagle 同级）而非小模型，因为 wiki 页面生成需要：
- 准确理解源文档的结构化信息
- 生成清晰、一致、格式正确的 Markdown
- 维护 cross-reference 的连贯性
- 评估健康检查中的语义矛盾

### 4.4 Prompt 内容大纲

`core/prompts/kiwi.md` 的预期结构：

```markdown
<Role>
You are the wiki kiwi — the dedicated knowledge curator for the ZooKeeper
project. You create, update, and maintain structured Markdown pages in
`wiki/`. You never write code, search the web, or delegate work.
</Role>

<Context>
Your task prompt contains three sections:

- **SUMMARY** — what wiki operation to perform (1 sentence)
- **CONTEXT** — source material, existing wiki state, constraints
- **ACCEPTANCE** — verifiable outcomes that define "done"

Read wiki/SCHEMA.md before any operation. It defines all formatting
conventions, page templates, and naming rules.
</Context>

<Workflow>
## Phase 0: Read SCHEMA.md

Before any operation, re-read wiki/SCHEMA.md to confirm conventions.
If SCHEMA.md was already read earlier in this session, confirm you
remember the rules — do not re-read unnecessarily.

## Phase 1: Load Existing State

Read index.md and any existing related pages to understand:
- Where the new page fits in the category hierarchy
- What cross-references are already present
- Whether a similar page already exists (dedup check)

## Phase 2: Perform Operation

See workflow-specific instructions in your task's CONTEXT.

## Phase 3: Update index.md and log.md

After any create/update operation:
1. Add/update the entry in index.md under the correct category
2. Append a line to log.md with the event
</Workflow>

<Contract>
- NEVER modify files outside wiki/
- NEVER create duplicate pages — always check index.md first
- NEVER break an existing cross-reference — when updating, update
  all related pages' related: field
- ALWAYS read existing content before editing — understand the full page
- ALWAYS append to log.md after any mutation
</Contract>
```

---

## 5. wiki-ingest Skill

### 5.1 文件位置

`core/skills/wiki-ingest/SKILL.md`

### 5.2 Skill 元数据

```yaml
---
name: wiki-ingest
description: 用于将外部源文档或对话知识 ingest 到项目 wiki 中。由 build（编排器）在用户提供参考文档、会议记录、架构决策时调用，委派给 kiwi agent 执行。
---
```

### 5.3 SKILL.md 内容大纲

```markdown
# Wiki Ingest 技能

将外部源文档或对话发现的知识 ingest 到 `wiki/` 中。由 build agent 在收到源材料时加载本技能，生成三段式 prompt 后委派给 kiwi 执行。

---

## Phase 0 — 分类源材料

先确定源材料的类型：

| 类型 | 特征 | 目标目录 | 页面类型 |
|------|------|---------|---------|
| 架构决策记录 | ADR、设计文档、RFC | `wiki/sources/adr/` | source |
| 外部规范 | 第三方 API 文档、标准、指南 | `wiki/sources/rfc/` | source |
| 会议记录 | 讨论总结、决策会议笔记 | `wiki/sources/notes/` | source |
| 概念知识 | 关于某机制或原理的说明 | `wiki/concepts/` | concept |
| 实体行为 | 某工具、agent、模块的行为 | `wiki/entities/` | entity |
| 分析对比 | 多个选项的权衡、经验总结 | `wiki/analysis/` | analysis |

## Phase 1 — 检查重复

- 读取 `wiki/index.md`
- 搜索已有页面是否覆盖了相同主题
- 如果重复：在已有页面补充信息，不创建新页面

## Phase 2 — 读取源材料

- 如果源是文件路径 → 用 `read` 读取
- 如果源是文字描述 → 直接使用

## Phase 3 — 生成 Wiki 页面

按照 `wiki/SCHEMA.md` 中的页面模板创建新页面：

### Source 页面要求

- 保持对原始文档的忠实摘要，不引入推测
- 标注原始源路径/URL 在 frontmatter 的 `source` 字段
- 摘要有足够上下文让读者（LLM 或人类）判断是否需要读原始文档

### 概念 / 实体页面要求

- 提取跨源的一致抽象
- 标注信息来源（指向具体 source 页面或源文档）
- 建立与相关页面的交叉引用

## Phase 4 — 更新 index.md

在 `wiki/index.md` 的对应类别下添加条目：
- 格式：`- [页面标题](相对路径) — 单行摘要`
- 摘要不超过 30 字

## Phase 5 — 更新关联页面

如果新页面与已有页面相关：
- 在新页面的 `related` frontmatter 中列出关联页面
- 在每个关联页面的 `related` frontmatter 中添加新页面的引用

## Phase 5.5 — 决定是否更新 overview.md

判断新 ingest 的知识是否有实质变化需要反映到 `wiki/overview.md`：

- 读取现有 `wiki/overview.md`（如存在）
- 评估新知识是否 warrant 一次重写（LLM 判断）
- 如果 warrant：重写 `wiki/overview.md`（直接覆盖，不追加）
- 如果不 warrant：跳过，保留现有 overview

## Phase 6 — 记录日志

在 `wiki/log.md` 追加一条新格式日志：

```
## [2026-06-17] ingest | wiki/concepts/prompt-injection.md | created — 摘要来自 ADR-003
```

## Phase 7 — 报告

向编排器报告：
- 创建/更新了哪些页面
- 更新了哪些关联页面
- 任何需要注意的事项（待确认、不完整的信息）
```

---

## 6. 工作流

### 6.1 Ingest 工作流

```
用户提供源材料（文件路径、URL、或文字描述）
    │
    ▼
┌─ build（编排器）────────────────────────────────────────────┐
│  1. 加载 wiki-ingest skill                                   │
│  2. 读取 wiki/SCHEMA.md（通过注入的 schema 知识确认格式）    │
│  3. 读取 wiki/index.md 检查是否已有重复                     │
│  4. 可选择运行 health.py 检查当前 wiki 状态                  │
│  5. 构造三段式 prompt：                                      │
│     SUMMARY: 将 [源材料] ingest到wiki中                       │
│     CONTEXT: 源内容 + 已有 wiki 状态                         │
│     ACCEPTANCE: 创建 [N] 个页面，更新 index.md，追加 log.md  │
│  6. 调用 task(subagent="kiwi", prompt=...)                 │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ kiwi ─────────────────────────────────────────────────────┐
│  1. 读取 SCHEMA.md 确认格式规范                              │
│  2. 读取 index.md 确认位置和避免重复                         │
│  3. 读取源材料                                                │
│  4. 创建 wiki 页面（按页面模板）                              │
│  5. 更新 index.md（追加条目到对应类别）                      │
│  6. 更新关联页面的 related 字段                              │
│  7. 判断是否需要更新 overview.md（LLM 决定是否重写）          │
│  8. 追加 log.md 条目                                         │
│  9. 向 build 报告完成情况                                    │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ build ──────────────────────────────────────────────────────┐
│  7. 确认 kiwi 完成                                             │
│  8. 可选：运行 health.py --save 生成 post-ingest 健康报告    │
│  9. 向用户报告做了什么（可选）                                │
└──────────────────────────────────────────────────────────────┘
```

> **overview.md 重写决策**：kiwi 在每次 ingest 后读取现有 overview.md，判断新知识是否有实质变化。如果 warrant，直接重写整个文件（不是追加）。如果只是增量变化，跳过。

### 6.2 Query 工作流

```
用户提问
    │
    ▼
┌─ build（编排器）──────────────────────────────────────────────┐
│  1. 通过注入的 SCHEMA 知识知道存在 wiki                     │
│  2. 读取 wiki/index.md 了解 wiki 覆盖范围                    │
│  3. 判断问题是否可能被 wiki 覆盖                             │
│     ├─ 是 → 读取相关 wiki 页面                               │
│     │        ├─ 有答案 → 合成回答                            │
│     │        └─ 无答案 → 委派 explore 或 spider 探索         │
│     └─ 否 → 委派 explore 或 spider 探索                      │
│                                                              │
│  4. 如果探索产生了有价值的答案：                              │
│     ├─ 构造 SUMMARY: 将 [答案] 归档到 wiki                   │
│     ├─ 调用 task(subagent="kiwi", prompt=...)              │
│     └─ kiwi 创建 synthesis 页面到 wiki/syntheses/ 或         │
│        更新已有页面（视答案类型决定目录）                    │
│  5. 向用户合成最终答案                                       │
└──────────────────────────────────────────────────────────────┘
```

**关键在于步骤 4：** 好的 query 答案被归档回 wiki。答案如果是一次性问答（问题→答案），存入 `wiki/syntheses/`；如果是结构化决策/权衡，存入 `wiki/analysis/`。这是"Knowledge Compiled Once"原则的体现。

### 6.3 Health Check 工作流（两层级）

Wiki 维护分为两个层级：**health**（零 LLM，每次会话运行）和 **lint**（基于 LLM，每 10-15 次 ingest 运行）。

#### 6.3.1 Health 工作流（Phase 0 — 零 LLM）

```
触发方式：每次会话开始、每次 ingest 完成后自动触发
    │
    ▼
┌─ build ──────────────────────────────────────────────────────┐
│  运行: python core/skills/wiki-maintain/tools/health.py      │
│                                                              │
│  工具脚本 health.py（零 LLM 调用）:                          │
│                                                              │
│  检查项:                                                     │
│  1. Empty/stub files — 文件存在但内容为空或仅骨架            │
│  2. index.md sync — 对比 wiki/ 目录下的文件和 index.md       │
│     中的条目，发现缺少或多余的条目                          │
│  3. Log coverage — 检查 index.md 中所有页面是否都有          │
│     对应的 log.md 条目                                      │
│  4. Frontmatter completeness — 检查所有页面是否都有          │
│     必需的 frontmatter 字段                                 │
│                                                              │
│  输出:                                                      │
│  - stdout: 每个检查项通过/失败，失败项附详情                 │
│  - --save: 写入 wiki/health-report.md                        │
│  - --json: JSON 格式输出供 agent 程序化消费                  │
│                                                              │
│  CLI 用法:                                                   │
│  python core/skills/wiki-maintain/tools/health.py [--save]   │
│      [--json]                                                │
│                                                              │
│  根据 --json 结果决定是否继续 ingest 或提示用户修复          │
└──────────────────────────────────────────────────────────────┘
```

#### 6.3.2 Lint 工作流（Phase 0.5 — 基于 LLM）

```
触发方式：每 10-15 次 ingest 后，或 health 检查发现问题时
    │
    ▼
┌─ build ──────────────────────────────────────────────────────┐
│  运行: python core/skills/wiki-maintain/tools/lint.py       │
│                                                              │
│  工具脚本 lint.py（使用 LLM 进行语义检查）:                 │
│                                                              │
│  检查项:                                                    │
│  1. Orphan pages — newly created pages not yet referenced    │
│      by any existing page                                    │
│  2. Broken links — related frontmatter 或正文中的链接       │
│     指向不存在或已被移动的页面                              │
│  3. Contradictions — 两个页面对同一事实的声明矛盾           │
│  4. Sparse pages — 内容过少的页面（< 50 字正文）            │
│  5. Missing cross-refs — 语义相关的页面未互相引用           │
│                                                              │
│  可选增强（--graph）:                                       │
│  - Graph-aware orphan detection (pages not reachable        │
│     from index.md in 3 hops)                                │
│                                                              │
│  输出:                                                     │
│  - stdout: 每个检查项的详细信息                             │
│  - --save: 写入 wiki/lint-report.md                         │
│                                                              │
│  CLI 用法:                                                  │
│  python core/skills/wiki-maintain/tools/lint.py [--save]    │
│      [--graph]                                              │
│                                                              │
│  lint 发现问题后，build 决定是否调用 heal 工作流           │
└──────────────────────────────────────────────────────────────┘
```

**两层级配合方式：**
1. 每次会话开始：`health.py` 运行（零成本，~毫秒级）
2. 如果 health 发现问题：阻止 ingest，提示用户先修复
3. 每 10-15 次 ingest：`lint.py` 运行（调用 LLM，成本较高）
4. lint 发现的 orphan/missing 问题 -> 触发 heal 工作流

### 6.4 Heal 工作流

自动修复 lint 发现的结构性问题。

```
触发方式：lint 发现 orphan 或 missing 页面后，由 build 触发
    │
    ▼
┌─ build ──────────────────────────────────────────────────────┐
│  运行: python core/skills/wiki-maintain/tools/heal.py       │
│                                                              │
│  工具脚本 heal.py:                                          │
│  - 读取 lint-report.md 或接受 stdin JSON                    │
│  - 对每种问题类型：                                         │
│    ├─ Orphan page → 自动寻找相关页面并补充 cross-ref         │
│    ├─ Missing entity page → 根据引用上下文创建            │
│    │  骨架页面（frontmatter + stub content）                │
│    └─ Broken link → 如果目标页面确定已删除，移除引用        │
│  - 不处理的：contradictions（需人工介入或 kiwi 审查）        │
│                                                              │
│  输出: 修复摘要，记录到 log.md                              │
│                                                              │
│  CLI 用法:                                                  │
│  python core/skills/wiki-maintain/tools/heal.py [--report    │
│      <path>]                                                 │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ build ──────────────────────────────────────────────────────┐
│  审查 heal 的修复结果                                       │
│  可选：运行 health.py --json 验证修复后状态                 │
└──────────────────────────────────────────────────────────────┘
```

### 6.5 Refresh 工作流

检测原始源文档的变更并重新 ingest。

```
触发方式：手动触发或检测到原始源文件变更
    │
    ▼
┌─ build ──────────────────────────────────────────────────────┐
│  运行: python core/skills/wiki-maintain/tools/refresh.py    │
│                                                              │
│  工具脚本 refresh.py:                                       │
│  - 扫描 wiki/sources/ 中所有页面的 frontmatter `source`    │
│    字段，对比文件修改时间                                   │
│  - 对每个已变更的源：                                      │
│    ├─ 备份旧页面（可选 --backup）                          │
│    ├─ 调用 kiwi 重新 ingest                                 │
│    └─ 更新页面版本号 / updated 日期                        │
│  - 报告：哪些源已变更、哪些已重新 ingest                    │
│                                                              │
│  CLI 用法:                                                  │
│  python core/skills/wiki-maintain/tools/refresh.py          │
│      [--backup] [--dry-run]                                 │
│                                                              │
│  --dry-run: 只检测变更，不实际 ingest                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. 注入机制

### 7.1 SCHEMA.md 自动注入

在 `src/index.ts` 的 `config` hook 中，除了注入各 agent 的 prompt 文件外，额外注入 SCHEMA.md 内容。实现方式有两种可选：

**方案 A：SCHEMA 缩略版注入（推荐 MVP）**

在 `config` hook 的 agent 循环中，为所有 agent 的 prompt 追加一段 wiki SCHEMA 缩略信息：

```typescript
// 在 config hook 的 agent prompt 注入循环之后
const schemaPrompt = readFileSync(
  resolve(CORE_DIR, "../wiki/SCHEMA.md"), "utf-8"
);
// 提取缩略版（前 N 行 + 目录 + 页面格式约定）
const schemaBrief = extractSchemaBrief(schemaPrompt);

for (const [name, agent] of Object.entries(agents)) {
  if (typeof agent !== "object" || agent === null) continue;
  const existing = (agent as any).prompt ?? "";
  // 追加到 prompt 尾部（通过标记段）
  (agent as any).prompt = existing + `\n\n<WikiSchema>\n${schemaBrief}\n</WikiSchema>`;
}
```

注入内容（缩略版）包含：
- wiki 目录结构概览
- index.md 的存在和用途（"先读 index.md 再决定读哪些页面"）
- 页面命名规则
- 交叉引用规则

完整 SCHEMA.md 只注入到 kiwi 的 prompt 中（因为 kiwi 需要完整的格式规范来生成页面）。

**方案 B：按 agent 选择性注入（推荐 Phase 2）**

| Agent | 注入内容 |
|-------|---------|
| build | SCHEMA 缩略版（目录 + index.md 导航方式 + kiwi 委派方式） |
| explore | SCHEMA 缩略版（目录 + index.md 导航方式） |
| general | SCHEMA 缩略版（目录 + 可读 wiki 页面） |
| kiwi | 完整 SCHEMA.md |
| eagle | SCHEMA 缩略版（目录 + 可查阅 wiki 参考） |
| spider | 无（不操作用户项目文件） |

### 7.2 按需读取机制

SCHEMA.md 提供的是"元知识"（wiki 存在、如何用），具体页面内容通过 agent 自身的 `read` / `grep` 工具按需读取：

1. **入口点：** 任何 agent 在收到可能由 wiki 覆盖的问题时，先尝试读取 `wiki/index.md`
2. **导航：** 从 index.md 中找到相关页面路径
3. **读取：** 用 `read` 工具读取具体页面内容
4. **交叉引用：** 如果页面有 `related` 指向其他页面，按需递归读取

```
用户: "How does the task prompt validation work?"
    │
build: read wiki/index.md
    │
    ├─ 在 Concepts 下找到 "task-prompt-validation" 条目
    │
build: read wiki/concepts/task-prompt-validation.md
    │
    ├─ 页面给出概览 + 指向 src/hooks/task-prompt/ 的引用
    │
build: 合成回答或委派 explore 进一步探索代码
```

### 7.3 为何不将完整 wiki 注入 prompt

- **上下文窗口有限：** 随着 wiki 增长，完整注入会快速消耗 context
- **信息稀疏：** 大多数页面与当前任务无关，完整注入带来噪声
- **按需读取更高效：** LLM 自己决定读什么，基于 index.md 导航
- **SCHEMA 缩略版足够小：** 目录结构 + 使用方式通常 < 1K tokens，注入成本可忽略

### 7.4 工具脚本的 programmatic 访问

所有 `core/skills/wiki-maintain/tools/` 下的 Python 工具脚本（health.py、lint.py 等）支持 `--json` 标志，输出结构化 JSON 到 stdout。这使得 build agent 或其他 agent 可以通过 `bash` 工具调用脚本并解析结果，而无需解析人类可读文本。例如：

```
python core/skills/wiki-maintain/tools/health.py --json
```

返回 JSON 包含 `{ "passed": bool, "checks": [{ "name": str, "status": "pass"|"fail", "details": str }] }`。

build agent 可在 Phase 0 或 Phase 0.5 中直接调用这些脚本，根据 JSON 结果决定是否继续 ingest 或需要先修复。

---

## 8. index.md 与 log.md 格式

### 8.1 index.md 格式规范

```
# Wiki Index

> 按类别组织的 wiki 目录。LLM 在回答涉及项目知识的问题时，
> 应先阅读本文件确定哪些页面可能包含相关信息。

## Concepts（概念）

- [Prompt Injection](wiki/concepts/prompt-injection.md) — ZooKeeper 的 prompt 注入机制的工作原理
- [Permission Model](wiki/concepts/permission-model.md) — 基于 deny list 的权限控制模型
- [Validation Thresholds](wiki/concepts/validation-thresholds.md) — task prompt 长度和 context 限制

## Entities（实体）

- [Build Agent](wiki/entities/build-agent.md) — 编排器 agent 的角色、权限、工作流
- [Kiwi Agent](wiki/entities/kiwi-agent.md) — wiki 维护 agent 的角色和职责
- [Task Tool](wiki/entities/task-tool.md) — task() 工具的行为规范和参数说明

## Sources（源文档）

### ADR
- [ADR-001: Permission Deny List](wiki/sources/adr/adr-001-permission-deny-list.md) — 为何选择 deny 而非 allow
- [ADR-002: Prompt Injection via Config Hook](wiki/sources/adr/adr-002-prompt-injection.md) — 运行时注入 vs 编译时注入

### Meeting Notes
- [2026-06-10: Wiki Design Sync](wiki/sources/notes/2026-06-10-wiki-design-sync.md) — LLM Wiki 三层的确认和 kiwi 角色分配

## Analysis（分析）

- [Lint Tool Tradeoffs](wiki/analysis/lint-tradeoffs.md) — ruff vs biome vs eslint 的对比和选择结论
```

**格式规则：**

| 元素 | 规则 |
|------|------|
| 标题 | `# Wiki Index` 固定 |
| 引言 | `> ` 引用块，简述用途 |
| 类别标题 | `## <Category Name>（<中文名>）` — 英文类别名 + 中文解释 |
| 子类别 | `### <Subcategory>` — 仅 `Sources` 下需要子类别（adr/rfc/notes） |
| 条目 | `- [标题](路径) — 摘要` — 摘要不超过 30 字，末尾无句号 |
| 排序 | 每个类别内按主题相关性排列，不按字母或日期 |
| 路径 | 基于项目根目录的路径（`wiki/<dir>/file.md`） |

### 8.2 log.md 格式规范

```
# Wiki Change Log

> Heading-line 格式日志，每条记录是一个 Markdown 二级标题。
> Grep-parseable: grep "^## \[" wiki/log.md | tail -5
> 按时间倒序排列（最新在最上）。

---

## [2026-06-17] update | wiki/concepts/prompt-injection.md | edit — 补充 Phase 2 实施方案
## [2026-06-17] ingest | wiki/sources/adr/adr-003-prompt-validation.md | create — 来自 ADR-003 文档
## [2026-06-17] ingest | wiki/concepts/validation-thresholds.md | create — 基于 ADR-003 和设计讨论
## [2026-06-17] query | wiki/syntheses/linter-comparison.md | create — 来自 "which linter" 问答
## [2026-06-16] health | — | pass — 所有检查通过，无 orphan/missing
## [2026-06-15] ingest | wiki/entities/build-agent.md | create — 来自 build.md prompt 文档
```

**格式规则：**

| 部分 | 规则 |
|------|------|
| 前缀 | `## [` + `YYYY-MM-DD` + `]` 空格 |
| 操作 | `ingest` / `update` / `delete` / `query` / `health` / `lint` / `heal` / `refresh` / `check` |
| 分隔符 | `\|` 空格包围 |
| 页面 | 基于项目根目录的路径（`wiki/<dir>/file.md`），非页面事件写 `—` |
| 类型 | `create` / `edit` / `delete` / `pass` / `fail` |
| 备注 | `—` 后自由文本，说明触发原因或变更摘要 |

**行为规则：**
- 新条目**插入在最顶部**（紧接 `---` 分隔符之后第一行）
- 永远不修改已有行（追加式日志）
- 每次 mutate 操作（create/edit/delete）都必须记录
- health / lint 无论是否发现问题都记录一行
- Grep 友好：`grep "^## \[" wiki/log.md | head -5` 获取最近 5 条

---

## 9. 页面模板

### 9.1 概念页面（Concepts）

```markdown
---
title: <概念名称>
type: concept
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [<tag1>, <tag2>]
sources: [<source-slug-1>, <source-slug-2>]（可选）
related: [<wiki/entities/related-entity.md>, ...]
status: <draft | review | stable | deprecated>
---

# <概念名称>

## Overview

<一句话说明此概念是什么，为什么重要>

## Details

<主体内容。使用小标题分节，每节聚焦一个子主题>

### <子主题 1>

<详细说明>

### <子主题 2>

<详细说明>

## Relations

- **[关联页面 1](wiki/entities/page1.md)** — 关系描述（如何关联）
- **[关联页面 2](wiki/concepts/page2.md)** — 关系描述

## References

- <源文档路径或 URL> — 说明
- <源文档路径或 URL> — 说明

## Notes

> **待确认：** <未确认的信息>
```

### 9.2 实体页面（Entities）

```markdown
---
title: <实体名称>
type: entity
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [agent, tool]
sources: [<source-slug-1>, <source-slug-2>]（可选）
related: [<wiki/concepts/related-concept.md>, ...]
status: <draft | review | stable | deprecated>
---

# <实体名称>

## Overview

<一句话说明此实体是什么，它的职责范围>

## Role

<在 ZooKeeper 系统中的角色和定位>

## Behavior

<关键行为描述，可以用列表>

- **行为 1：** <描述>
- **行为 2：** <描述>

## Permissions

<如果适用，描述该实体的权限模型>

## Relations

- **[关联页面 1](wiki/concepts/page1.md)** — 关系描述
```

### 9.3 源摘要页面（Sources）

```markdown
---
title: <原始文档标题>
type: source
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
source: <原始文件路径或 URL>
sources: [<source-slug>]（可选 — 衍生此页的源 slug）
tags: [adr, decision]
related: [<wiki/concepts/derived-concept.md>, ...]
status: <draft | review | stable | deprecated>
---

# <原始文档标题>

## Overview

<一句话说明此源文档内容>

## Key Points

<从源文档中提取的要点列表>

- **要点 1：** <说明>
- **要点 2：** <说明>

## Decisions Made

<如果有，记录文档中做出的决策>

## Impact

<此源文档对项目的影响>

## References

- <原始源路径>
```

### 9.4 分析页面（Analysis）

用于结构化决策/权衡文档，如工具对比、方案选型。**非 query 归档**（query 归档请用 synthesis 模板）。

```markdown
---
title: <分析主题>
type: analysis
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [tradeoff, comparison]
sources: [<source-slug-1>, <source-slug-2>]（可选）
related: [<wiki/entities/page1.md>, <wiki/concepts/page2.md>]
status: <draft | review | stable | deprecated>
---

# <分析主题>

## Overview

<此分析解决的问题>

## Options Considered

### Option A: <名称>
- **优点：** <列表>
- **缺点：** <列表>
- **适用场景：** <说明>

### Option B: <名称>
- **优点：** <列表>
- **缺点：** <列表>
- **适用场景：** <说明>

## Conclusion

<最终选择及理由>

## References

- <来源 1>
```

### 9.5 合成页面（Synthesis）

用于归档 query 答案（一次性问答），位于 `wiki/syntheses/<slug>.md`。

```markdown
---
title: <合成主题>
type: synthesis
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [query, qa]
sources: [<source-slug-1>, <source-slug-2>]（可选）
related: [<wiki/entities/page1.md>, <wiki/concepts/page2.md>]
status: <draft | review | stable | deprecated>
---

# <合成主题>

## Question

<原始用户问题>

## Answer

<完整答案>

## Sources Consulted

<在回答此问题时参考了哪些 wiki 页面或外部源>

## Related

<相关的其他 wiki 页面链接>
```

---

## 10. 集成点

### 10.1 对 build Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 在 `core/prompts/build.md` 尾部或由 hook 注入 |
| 新增 wiki 感知阶段 | 行为变化 | 在 Phase 0 Intent Gate 之后、Phase 1 之前检查 wiki/index.md |
| 新增 kiwi 委派路径 | 行为变化 | 在 Implementation / Diagnosis / Exploration 流程中，当问题可能由 wiki 覆盖时先查 wiki |
| 委派前不再盲目探索 | 优化 | 对于已知知识，先读 wiki 再决定是否需要委派 explore |

build.md 中新增的 wiki 感知阶段（插入在 Phase 0 和 Phase 1 之间）：

```markdown
## Phase 0.5: Wiki Check

Before planning or delegating, check if the wiki already covers this
question. Read `wiki/index.md` — if a relevant page exists, read it
and skip unnecessary exploration. If the answer is sufficient, use it.
If the answer is partial, use it as context for further exploration.
```

### 10.2 对 explore Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 告知 explore wiki 的存在 |
| 探索时可引用 wiki 知识 | 行为提示 | 如果探索时发现已有 wiki 页面，可引用而非重新发现 |
| 探索结果可触发 ingest | 间接影响 | 如果探索结果有价值且 wiki 未覆盖，建议 build 触发 ingest |

### 10.3 对 general Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 告知 general wiki 的存在 |
| 实现时可查阅 wiki 约定 | 行为提示 | 在实现前可先读 wiki 确认项目约定（如编码规范、测试约定） |

### 10.4 对 spider Agent 的影响

无直接影响。Spider 是纯 web research agent，不操作项目文件。但如果 spider 的研究结果值得存档，build 可触发 ingest。

### 10.5 对 eagle Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 告知 eagle wiki 的存在 |
| Review 时可查阅 wiki 约束 | 行为提示 | 在代码审查时，可读取 wiki 中的架构决策作为审查依据 |

### 10.6 插件层变更（src/index.ts）

```typescript
// 在 config hook 中新增 SCHEMA 注入逻辑
async config(config: any) {
  const agents = config.agent ?? {};

  // 现有 prompt 注入逻辑...

  // 新增：wiki SCHEMA 注入
  const schemaPath = resolve(CORE_DIR, "../wiki/SCHEMA.md");
  let schemaBrief: string | undefined;
  try {
    const full = readFileSync(schemaPath, "utf-8");
    schemaBrief = extractSchemaBrief(full); // 提取缩略版
  } catch {
    // wiki/ 尚未创建 — 跳过
  }

  if (schemaBrief) {
    for (const [name, agent] of Object.entries(agents)) {
      if (typeof agent !== "object" || agent === null) continue;
      const existing = (agent as any).prompt ?? "";
      // 只为目标 agent 注入
      if (["build", "explore", "general", "eagle"].includes(name)) {
        (agent as any).prompt =
          existing + `\n\n<WikiSchema>\n${schemaBrief}\n</WikiSchema>`;
      }
      // kiwi 获得完整 schema
      if (name === "kiwi") {
        (agent as any).prompt =
          existing + `\n\n<WikiSchema>\n${full}\n</WikiSchema>`;
      }
    }
  }
}
```

### 10.7 Skills 注册

`wiki-ingest` skill 需要在 `config.toml` 的 `[zoo.skills]` 中注册：

```toml
[zoo.skills]
git-commit = "enable"
code-review = "enable"
wiki-ingest = "enable"
```

并在 `src/index.ts` 的 skill 注册循环中自动发现（现有逻辑已支持从 `core/skills/` 目录自动注册所有 enabled skill）。

### 10.8 工具脚本集成

build agent 可通过 `bash` 工具直接调用 `core/skills/wiki-maintain/tools/` 下的 Python 脚本，在委派 kiwi 之前获取结构化结果：

```python
# build 在 Phase 0 中
python core/skills/wiki-maintain/tools/health.py --json
# → 返回 {"passed": true, "checks": [...]}
# → 如果 passed=false，先修复再继续 ingest

# build 在 Phase 0.5 中
python core/skills/wiki-maintain/tools/lint.py --json
# → 返回 {"issues": [...], "summary": {...}}
# → 根据 issues 决定是否触发 heal 工作流
```

这种模式允许 build agent **不依赖 kiwi** 即可完成结构检查（health），仅在需要 LLM 语义分析（lint）或页面创建（ingest/heal）时委派给 kiwi。

---

## 11. 迁移路径

### Phase 1: MVP（最小可行产品）

**目标：** 可用的基础 wiki 结构 + kiwi agent + ingest 能力

| 工作项 | 文件 | 估算 |
|--------|------|------|
| 创建 `wiki/` 目录和 `wiki/index.md`（仅骨架） | `wiki/index.md` | 小 |
| 创建 `wiki/SCHEMA.md`（完整规范） | `wiki/SCHEMA.md` | 中 |
| 创建 `wiki/log.md`（空日志） | `wiki/log.md` | 小 |
| 创建 `wiki/overview.md`（骨架） | `wiki/overview.md` | 小 |
| 编写 `core/prompts/kiwi.md` | `core/prompts/kiwi.md` | 中 |
| 编写 `core/skills/wiki-ingest/SKILL.md` | `core/skills/wiki-ingest/SKILL.md` | 中 |
| 编写 `core/skills/wiki-maintain/tools/health.py` | 结构检查脚本，零 LLM | 中 |
| 编写 `core/skills/wiki-maintain/tools/lint.py` | 语义检查脚本，使用 LLM | 中 |
| 编写 `core/skills/wiki-maintain/tools/heal.py` | 自动创建缺失页面 | 中 |
| 在 `config.toml` 中添加 `[agent.kiwi]` | `config.toml` | 小 |
| 在 `config.toml` 中添加 `wiki-ingest` skill 启用 | `config.toml` | 小 |
| 在 `src/index.ts` 的 `config` hook 中添加 SCHEMA 注入 | `src/index.ts` | 中 |
| 创建 1-2 个示例 wiki 页面用于验证 | `wiki/concepts/`, `wiki/entities/` | 小 |
| 端到端验证：build 委派 kiwi 完成一次 ingest | — | 中 |

**MVP 验收条件：**
- `python3 install.py` 运行成功，`opencode.json` 中包含 kiwi agent 配置
- `src/index.ts` 的 `config` hook 正确注入 SCHEMA 缩略版到 build/explore/general/eagle
- `src/index.ts` 的 `config` hook 正确注入完整 SCHEMA.md 到 kiwi
- `python core/skills/wiki-maintain/tools/health.py --json` 返回有效 JSON 且无报错
- `python core/skills/wiki-maintain/tools/lint.py --save` 可运行（即使未发现问题）
- 通过学习 wiki-ingest skill 并恰当填写 prompt，可手动验证 build → task(kiwi) 的 ingest 流程

### Phase 2: Query 归档 + 健康检查 + 工具链

**目标：** 完整的读写循环 + 维护能力

| 工作项 | 说明 |
|--------|------|
| 在 build.md 中添加 Phase 0.5 Wiki Check 阶段 | 使 build 在规划前自动检查 wiki |
| 实现 query-archive 流程 | build 在回答用户后判断是否需要归档到 wiki，答案存入 syntheses/ |
| 编写 `core/skills/wiki-maintain/tools/build_graph.py` | 知识图谱构建（可选，用于 lint --graph 模式） |
| 编写 `core/skills/wiki-maintain/tools/refresh.py` | 检测原始源变更并重新 ingest |
| 编写 `core/skills/wiki-maintain/tools/query.py` | 带图谱展开的 query 查询 |
| 补齐更多 wiki 页面模板 | 基于 MVP 使用经验完善 frontmatter 和节结构 |
| 添加 `wiki-ingest` 技能对 hashnode 的支持 | 对于已有的 wiki-ingest prompt 场景，增加在 python 工具中的自动校验 |

### Phase 3: 自动化与集成

**目标：** 更紧密的集成和自动维护

| 工作项 | 说明 |
|--------|------|
| CI 中的自动健康检查 | 在 PR 或定时任务中自动运行 kiwi 健康检查 |
| 自动检测对话中的可归档知识 | build 在对话中自动判断何时触发 ingest |
| wiki 老化机制 | 标记长期未更新的页面为 `stale`，提示审查 |
| 多版本 wiki | 支持按 git tag 的快照视图 |

---

## 附录：架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          LLM Wiki 架构                               │
│                                                                     │
│  ┌────────────┐    ┌──────────────────────┐    ┌────────────────────┐      │
│  │  Raw Sources│───▶│  Wiki Pages          │◀───│   SCHEMA.md        │      │
│  │ (immutable) │    │ (structured)         │    │   (conventions)    │      │
│  │  files/URLs │    │  concepts/           │    └────────┬───────────┘      │
│  │  ADR/notes  │    │  entities/           │             │                   │
│  └────────────┘    │  sources/             │             │ auto-inject       │
│                    │  analysis/            │             ▼                   │
│                    │  syntheses/           │    ┌────────────────────┐      │
│                    │  overview.md          │    │  Plugin Config Hook │      │
│                    └──────────┬────────────┘    │  (src/index.ts)    │      │
│                               │                 │  → build/explore/  │      │
│                               │ on-demand       │    general/eagle   │      │
│                               ▼                 └────────────────────┘      │
│                    └──────────────┘                                 │
│                                                                     │
│  ┌──────────┐     ┌──────────────┐    ┌────────────────────┐      │
│  │  build   │────▶│  kiwi      │    │  wiki-ingest skill  │      │
│  │(orchestr.)│    │  (wiki CRUD) │    │  (workflow spec)    │      │
│  └──────────┘     └──────────────┘    └────────────────────┘      │
│       │                                                            │
│       ├──▶ explore (read wiki for context)                         │
│       ├──▶ general (read wiki for conventions)                     │
│       └──▶ eagle   (read wiki for review criteria)                 │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │                     Storage                               │      │
│  │  wiki/ directory on filesystem + git for version history │      │
│  │  Zero external services, no vector DB, no RAG pipeline   │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 附录：与现有工具的关系

| 工具/文件 | 与 wiki 的关系 |
|-----------|---------------|
| `config.toml` | 声明 kiwi agent 配置和 wiki-ingest skill 启用状态 |
| `src/index.ts` | 在 `config` hook 中注入 SCHEMA.md 缩略版 |
| `core/prompts/build.md` | 新增 Phase 0.5 Wiki Check 阶段 |
| `core/prompts/explore.md` | prompt 尾部注入 SCHEMA 缩略版 |
| `core/prompts/general.md` | prompt 尾部注入 SCHEMA 缩略版 |
| `core/prompts/eagle.md` | prompt 尾部注入 SCHEMA 缩略版 |
| `core/prompts/kiwi.md` | 新建 — kiwi agent 的 prompt |
| `core/skills/wiki-ingest/SKILL.md` | 新建 — ingest 工作流定义 |
| `core/skills/wiki-maintain/tools/health.py` | 新建 — 零 LLM 结构检查工具 |
| `core/skills/wiki-maintain/tools/lint.py` | 新建 — LLM 语义检查工具 |
| `core/skills/wiki-maintain/tools/heal.py` | 新建 — 自动创建缺失页面工具 |
| `docs/` 文档 | wiki 存放可操作的知识，docs/ 存放静态设计文档 |
| `.env` | 无直接影响（kiwi 复用 `ZOO_MODEL` 配置） |

---

*本文档定义了 LLM Wiki 的完整设计。实施从 MVP 开始，逐步推进到 query 归档和自动化健康检查。*