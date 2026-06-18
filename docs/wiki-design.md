# LLM Wiki — 轻量文件知识库设计文档

**版本:** 2.0
**日期:** 2026-06-18

---

## 目录

1. [概览](#1-概览)
2. [目录结构](#2-目录结构)
3. [SCHEMA.md 规范](#3-schemamd-规范)
4. [kiwi Agent](#4-kiwi-agent)
5. [wiki-ingest Skill](#5-wiki-ingest-skill)
6. [wiki-query Skill](#6-wiki-query-skill)
7. [工作流](#7-工作流)
8. [注入机制](#8-注入机制)
9. [index.md 与 log.md 格式](#9-indexmd-与-logmd-格式)
10. [页面模板](#10-页面模板)
11. [集成点](#11-集成点)
12. [Wiki 工具 API 设计](#12-wiki-工具-api-设计)
13. [迁移路径](#13-迁移路径)
14. [附录：架构图](#14-附录架构图)
15. [附录：与类似方案对比（OMO / SLIM / OMP）](#15-附录与类似方案对比omo--slim--omp)
16. [架构决策：只读专家](#16-架构决策只读专家read-only-specialist)

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
| 冷启动 | 需要预先 embedding 所有源文档 | 随用随建，按需 ingest |
| 规模上限 | 可扩展至百万级文档 | 适合 ~100 个源 / 数百页（Karpathy 经验值） |

ZooKeeper 是编排器插件项目，知识范围有限（~5 个 agent，~50 个 prompt 和技能文件）。纯 Markdown 方案足够覆盖。

### 1.3 关键设计原则

1. **Knowledge Compiled Once** — 知识在 ingest 时编译为结构化页面，而不是每次 query 时从原始源重新推导。
2. **Query Back to Wiki** — 好的 query 答案被归档回 wiki，实现知识累积增长而非每次重新生成。
3. **Three-Layer Architecture** — 原始源（不可变）→ 结构化 Wiki（LLM 生成）→ SCHEMA（定义规范），层间单向依赖。
4. **index.md First** — LLM 阅读 index.md 决定要读哪些页面，代替 RAG 的向量检索。
5. **Minimal Infrastructure** — 纯 Markdown + git，零外部服务，零运行时依赖。
6. **Shared Tools, Specialist Agents** — 简单操作（CRUD、查询、维护）通过工具脚本由任意 agent 直接完成；复杂蒸馏（非结构化源 → 结构化页面）委派 kiwi 专家。没有"kiwi owns the wiki"约束。
7. **SCHEMA Auto-Injection** — SCHEMA.md 内容由 config hook 自动注入到相关 agent 的 system prompt 中，确保所有 agent 知晓 wiki 存在和使用方式。

### 1.4 架构路径概览

本设计包含两条并行的演进路径：

| 路径 | 描述 | 状态 |
|------|------|------|
| **Plan B（主路径）** | 通过 Skill 作为过渡层，逐步演进到 MCP 工具 | **当前实现** |
| **Plan A（备用）** | 跳过 Skill，直接实现 MCP 工具 | 如果 Phase 1 Skill 被证明不必要的后备方案 |

两条路径最终汇合于 **Phase 2+ MCP 化**（见 §13）。

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
| `wiki/concepts/` | 抽象知识、机制原理、设计模式 | 任意 agent / kiwi | 否 — 随理解加深可更新 |
| `wiki/entities/` | 具象事物、工具、角色、API | 任意 agent / kiwi | 否 — 随行为变更可更新 |
| `wiki/analysis/` | 结构化决策/权衡文档（非 query 归档） | 任意 agent / kiwi | 否 — 定期审查更新 |
| `wiki/syntheses/` | 归档的 query 答案，问题→答案映射 | 任意 agent / kiwi | 否 — 定期审查更新 |

> **变化说明：** 相比 v1，"生成者"不再限定为 kiwi。concepts/entities/analysis/syntheses 可以由任意 agent 通过工具脚本直接写入。只有 sources/ 的首次创建和 overview.md 的重写仍经由 kiwi（因其需要 distillation 能力）。

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
- **更新方式**：**重写而非追加** — 每次 ingest 时，kiwi 判断是否有实质变化需要更新 overview，在分析报告中给出建议；如果建议重写，由调用方执行重写
- **触发条件**：ingest 完成后，由 kiwi 分析新知识并给出是否 warrant overview 更新的建议（LLM 决定），调用方根据建议执行
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
- source 页面命名：`sources/<type>/<short-title>.md`，其中 `<type>` 为 `adr` / `rfc` / `notes`

### 交叉引用规则

- 使用基于 **wiki 根目录**的相对路径（不带 `wiki/` 前缀）：`[prompt injection](concepts/prompt-injection.md)`
- 在 related / sources frontmatter 字段中列出 wiki-root-relative 路径
- index.md 中的摘要应反映页面间的关联关系
- overview.md 应引用各目录中最重要的页面，但不替代 index.md 的完整索引

### 写作风格指南

- **中文撰写**，技术术语保留英文（如 "prompt injection"、"deny list"）
- **段落短小**，每段不超过 5 句
- **列表优先**，枚举关系用列表而非长段落
- **避免冗余**，同一事实只在一个页面中详细描述，其他页面交叉引用
- **标注不确定性**：未确认的信息用 `> **待确认：** ...` 标注

## 操作工作流

（见 §7 工作流）

## 索引与日志

（见 §9 index.md 和 log.md 格式）
```

### 3.3 注入方式

SCHEMA.md 的内容（至少缩略版本）在插件 `config` hook 中被注入到 `build`、`explore`、`general` 和 `kiwi` agent 的 prompt 尾部。见 §8。

---

## 4. kiwi Agent

### 4.1 角色定义

Kiwi 是 **只读知识蒸馏专家**（read-only knowledge distillation expert），而非 wiki 管理器。它不参与代码编写、代码搜索或 web 研究——它专注于一件事：**将非结构化的复杂源材料分析为结构化分析报告，返回给调用方执行写入**。

Kiwi 不负责简单的 wiki CRUD 操作（那些由工具脚本处理），也不负责日常维护（由 health/lint 脚本处理）。Kiwi 的触发条件是：源材料是 **非结构化、复杂、需要摘要/重写/组织** 的原始内容（如会议记录、设计文档、API 规范），而不仅仅是简单的条目追加。

Kiwi 是叶子节点 agent（无 `task` 权限），通过 `read` 工具分析 `wiki/` 目录内容。它不能写入文件（`write` 和 `edit` 被 deny），确保它只读不写。Kiwi 将结构化分析结果通过 task() 返回值返回给调用方，由调用方执行所有写入操作。

### 4.2 config.toml 条目

```toml
[agent.kiwi]
mode  = "subagent"
model = "{env:ZOO_SMALL_MODEL}"
[agent.kiwi.permission]
task = "deny"
webfetch = "deny"
websearch = "deny"
write = "deny"
edit = "deny"
```

Kiwi 有 5 条 deny 规则（task、webfetch、websearch、write、edit），其余工具均继承默认 allow 状态。注意 kiwi 使用小模型（`ZOO_SMALL_MODEL`），这是成本效率选择。

### 4.3 模型选择理由

Phase 1 选择小模型（`ZOO_SMALL_MODEL`）驱动 kiwi，主要考虑成本效率：

- Kiwi 的生成任务（摘要、页面创建）对 generation quality 要求低于编排和代码审查
- 小模型在结构化 Markdown 生成上表现足够，且 token 消耗低（每次 ingest ~2-5K tokens）
- 允许在频繁的 ingest 操作中控制成本

**已知权衡：** 小模型在复杂 cross-reference 推理、overview.md 重写判断、语义一致性检查上可能不如大模型。如果实践中发现质量瓶颈，后续可升级至 `ZOO_MODEL`。

### 4.4 Prompt 内容大纲

`core/prompts/kiwi.md` 的最终结构包含 4 个 XML 块：

```markdown
<Role>
You are kiwi — the knowledge distillation expert for the ZooKeeper project.
Your job is to convert unstructured, complex source material into structured,
well-organized wiki pages in `wiki/`. You do NOT do simple CRUD — those are
handled by tool scripts that any agent can call directly. You activate only
when the source material is complex enough to warrant expert distillation.

You never write code, search the web, or delegate work.
</Role>

<Context>
Your task prompt contains three sections:

- **SUMMARY** — what distillation to perform (1 sentence)
- **CONTEXT** — source material, existing wiki state, constraints
- **ACCEPTANCE** — verifiable outcomes that define "done"
</Context>

<Workflow>
## Phase 0: Read SCHEMA.md

Before any operation, read `wiki/SCHEMA.md` to confirm formatting
conventions, page templates, and naming rules. If you already read it
earlier in this session and remember the rules, don't re-read
unnecessarily.

## Phase 1: Load Existing State

Read `wiki/index.md` and any existing related pages to understand:
- Where the new page fits in the category hierarchy
- Whether a similar page already exists (dedup check)
- What cross-references are already present

## Phase 2: Distill Source Material

Analyze the source material and produce structured analysis:
- Extract key concepts, entities, decisions from unstructured content
- Organize into the appropriate wiki category
- Apply the page template and frontmatter conventions from SCHEMA.md

## Phase 3: Return Structured Analysis

Explain to the calling agent what should be created/updated:
- What pages to create or update (full paths, frontmatter, page content)
- What index entries to add to `wiki/index.md`
- What cross-references to update (add new page to existing pages'
  `related` field)
- What `wiki/overview.md` changes may be needed
- What log entries to append via `wiki_log.py`

Do NOT perform any writes yourself. Return a complete, actionable analysis.
</Workflow>

<Contract>
- NEVER modify files outside `wiki/`
- NEVER create duplicate pages — always check `wiki/index.md` first
- NEVER break an existing cross-reference — when recommending a new
  page, describe what related pages need their `related` field updated
- NEVER use `write` or `edit` tools — you are read-only
- NEVER call `wiki_log.py` — the calling agent handles logging
- NEVER update `index.md` or `overview.md` directly — describe the
  change in your analysis return
- ALWAYS read existing content before analyzing — understand the full
  page first
- Use wiki-root-relative paths for all cross-references
  (e.g. `[text](concepts/foo.md)`, not `wiki/concepts/foo.md`)
</Contract>
```

**相比 v1 的变更：**
- Role 从"wiki kiwi — dedicated knowledge curator"改为"knowledge distillation expert"
- 明确说明"不做简单 CRUD — 那些由工具脚本处理"
- **Kiwi 改为只读** — deny write/edit，返回结构化分析给调用方执行写入
- Phase 2 从"Perform Operation"改为"Distill Source Material"
- Phase 3 从"Write Pages"改为"Return Structured Analysis"
- **删除 Phase 4**（Update Cross-References）— 写入操作由调用方完成
- Contract 移除 `new_page.py` 和 `wiki_log.py` 使用要求，新增只读约束

---

## 5. wiki-ingest Skill

### 5.1 文件位置

`core/skills/wiki-ingest/SKILL.md`

### 5.2 设计思路

wiki-ingest skill 提供两条执行路径：

```
源材料到达
     │
     ├── 结构化 / 已 wiki 格式化 ──→ 简单路径：任意 agent 直接调用
     │                              wiki_ingest.py / wiki_log.py
     │
     └── 非结构化 / 复杂源材料 ──→ 复杂路径：委派 kiwi 蒸馏
                                    → kiwi 返回分析报告
                                    → 调用方根据分析执行写入
```

**无 caller 约束：** 任何 agent（build、explore、eagle、general）均可触发 ingest，不限定必须是 build。

### 5.3 Skill 元数据

```yaml
---
name: wiki-ingest
description: 用于将外部源文档或对话知识 ingest 到项目 wiki 中。由任意 agent 在获得值得归档的知识时调用。结构化内容直接写入，复杂源材料委派 kiwi 蒸馏。
---
```

### 5.4 SKILL.md 内容大纲

```markdown
# Wiki Ingest 技能

将外部源文档或对话发现的知识 ingest 到 `wiki/` 中。
可由任意 agent 在获得值得归档的知识时加载。

---

## Phase 0 — 判断路径

根据源材料的性质选择执行路径：

| 特征 | 路径 | 说明 |
|------|------|------|
| 结构化内容、已 wiki 格式化的文本、简短的摘要 | **简单路径** | 直接调用工具脚本写入 |
| 非结构化原始源、会议记录、外部 RFC、设计文档 | **复杂路径** | 委派 kiwi 蒸馏 |

**结构化判定标准：**
- 内容已按 wiki 页面节结构组织（Overview / Details / Relations）
- 已知目标目录和文件名
- 不需要摘要/重写/组织

**非结构化判定标准：**
- 聊天记录、会议转录、原始 API 文档
- 需要分类、摘要、提取要点
- 需要跨多个 wiki 目录组织

---

## Phase 1 — 简单路径：直接写入

适用于结构化/已格式化的内容。

1. 使用 `new_page.py` 脚手架创建骨架页面（如果需要新页面）：
   ```bash
   python wiki/tools/new_page.py \
       --type <concept|entity|analysis|synthesis> \
       --title "<页面标题>"
   ```
   对于 source 类型：
   ```bash
   python wiki/tools/new_page.py \
       --type source \
       --title "<页面标题>" \
       --source-type <adr|rfc|notes>
   ```
2. 使用 `write` 或 `edit` 工具填充页面内容
3. 更新 `wiki/index.md` — 在对应类别追加条目
4. 调用 `wiki_log.py` 追加日志：
   ```bash
   python wiki/tools/wiki_log.py \
       --op ingest \
       --path "wiki/<dir>/<file>.md" \
       --action create \
       --note "<简短说明>"
   ```
5. （可选）更新相关页面的 `related` 字段

不需要委派 kiwi，不需要 task() 调用。

---

## Phase 2 — 复杂路径：委派 kiwi 蒸馏

适用于非结构化复杂源材料。

1. **分类源材料** — 根据源材料的性质确定目标目录和页面类型：

   | 类型 | 特征 | 目标目录 | 页面类型 |
   |------|------|---------|---------|
   | 架构决策记录 | ADR、设计文档、RFC | `wiki/sources/adr/` | source |
   | 外部规范 | 第三方 API 文档、标准、指南 | `wiki/sources/rfc/` | source |
   | 会议记录 | 讨论总结、决策会议笔记 | `wiki/sources/notes/` | source |
   | 概念知识 | 关于某机制或原理的说明 | `wiki/concepts/` | concept |
   | 实体行为 | 某工具、agent、模块的行为 | `wiki/entities/` | entity |
   | 分析对比 | 多个选项的权衡、经验总结 | `wiki/analysis/` | analysis |

   如果源材料无法明确归入以上类型 → 归类为 `wiki/concepts/`，页面类型为 concept。

2. **检查重复** — 读取 `wiki/index.md` 搜索已有页面是否覆盖了相同主题

3. **准备源材料** — 根据输入形式执行对应的获取步骤

4. **构造三段式 Prompt**：

   ```
   **SUMMARY:** 将 [源材料简要描述] 蒸馏到 wiki 中

   **CONTEXT:**
   [源内容摘要]
   [已有 wiki 状态：index.md 当前条目、相关页面摘要、约束条件]

   **ACCEPTANCE:**
   - 分析源材料，确定需要创建或更新哪些 wiki 页面
   - 返回完整的结构化分析报告，包括：
     * 页面路径和页面类型
     * 页面完整内容（按 SCHEMA.md 模板）
     * 需要对 wiki/index.md 做的变更
     * 需要更新的相关页面 related 字段
     * 需要追加的 wiki_log.py 日志条目
     * 是否需要重写 overview.md
   - 不执行任何写入操作
   ```

5. **委派 kiwi** — 调用 `task()` 将三段式 prompt 传给 kiwi subagent：

   ```
   task(subagent="kiwi", prompt=<Phase 2 步骤 4 构造的三段式 prompt>)
   ```

6. **处理 kiwi 返回的分析** — kiwi 返回分析报告后，调用方根据报告执行写入：

   - 使用 `new_page.py` + `write`/`edit` 创建或更新页面
   - 更新 `wiki/index.md`
   - 更新相关页面的 `related` 字段
   - 调用 `wiki_log.py` 追加日志
   - 判断是否需要重写 `wiki/overview.md`

7. **验证** — 写入完成后执行验证

---

## Phase 3 — Log 与通知

无论哪条路径，完成后：

1. 确认 `wiki/log.md` 中有对应的日志条目
2. 如果创建了 sources/ 页面，确认 `wiki/index.md` 的 Sources 类别已更新
3. 向用户报告创建的页面列表和摘要（可选）
```

**架构说明：** 职责分离清晰——**工具脚本处理简单写入**，**kiwi 处理复杂蒸馏但只读不写**，**调用方根据 kiwi 的分析执行写入**。三条路径共享同一份日志和索引更新规范。

---

## 6. wiki-query Skill

### 6.1 文件位置

`core/skills/wiki-query/SKILL.md`

### 6.2 设计思路

Wiki 查询不需要委派 kiwi——任何 agent 自行读取 `wiki/index.md` 导航，然后用 `read`/`grep` 读取具体页面。这与其他文件操作无异。

### 6.3 Skill 元数据

```yaml
---
name: wiki-query
description: 用于从项目 wiki 中检索知识。任意 agent 可直接读取 index.md 导航 + read/grep 查询，无需委派 kiwi。
---
```

### 6.4 SKILL.md 内容大纲

```markdown
# Wiki Query 技能

从项目 wiki 中检索知识。不需要委派 kiwi——直接读取即可。

---

## Phase 0 — 导航入口

示例：`wiki/index.md` — 按类别列出所有页面，含单行摘要。
先读 index.md 确定哪些页面可能包含相关信息。

## Phase 1 — 读取页面

用 `read` 工具读取具体页面内容。按需递归读取 `related` 字段指向的页面。

## Phase 2 — 搜索

如果 index.md 不足以定位，使用 `grep` 在 wiki/ 目录中搜索关键词：
`grep -r "<关键词>" wiki/`

## Phase 3 — 合成答案

将读取的 wiki 内容与当前上下文合成回答。如果 wiki 内容不足，继续其他探索路径。
```

---

## 7. 工作流

### 7.1 Ingest 工作流（两条路径）

#### 7.1.1 简单路径（结构化内容 → 直接写入）

```
任意 agent 获得结构化/已 wiki 格式化的知识
     │
     ▼
┌─ 任意 agent ─────────────────────────────────────────────────┐
│  1. 使用 new_page.py 创建骨架页面（如需新页面）               │
│  2. 用 write/edit 填充内容                                    │
│  3. 更新 wiki/index.md                                        │
│  4. 调用 wiki_log.py 追加日志                                 │
│  5. （可选）更新相关页面的 related 字段                       │
└──────────────────────────────────────────────────────────────┘
```

**示例场景：** build 在探索后发现"lint-tradeoffs"的决策，已知目标目录和分析结论，直接写入 `wiki/analysis/lint-tradeoffs.md`。无需 kiwi。

#### 7.1.2 复杂路径（非结构化源 → kiwi 蒸馏 → 调用方写入）

```
任意 agent 获得非结构化复杂源材料
     │
     ▼
┌─ 任意 agent（加载 wiki-ingest skill）─────────────────────────┐
│  1. 分类源材料 → 确定目标目录                                  │
│  2. 检查 wiki/index.md 避免重复                               │
│  3. 准备源材料（read/webfetch）                                │
│  4. 构造三段式 prompt（SUMMARY/CONTEXT/ACCEPTANCE）            │
│  5. 调用 task(subagent="kiwi", prompt=...)                    │
└──────────────────────────────────────────────────────────────┘
     │
     ▼
┌─ kiwi ──────────────────────────────────────────────────────┐
│  1. 读取 SCHEMA.md 确认格式规范                                │
│  2. 读取 index.md 确认位置和避免重复                           │
│  3. 蒸馏源材料 → 生成结构化分析报告                            │
│  4. 返回分析报告给调用方（页面内容、索引变更、日志建议）        │
└──────────────────────────────────────────────────────────────┘
     │
     ▼
┌─ 调用 agent ──────────────────────────────────────────────────┐
│  6. 根据 kiwi 返回的分析报告执行写入：                          │
│     a. 使用 new_page.py + write/edit 创建或更新页面            │
│     b. 更新 wiki/index.md                                      │
│     c. 更新关联页面的 related 字段                             │
│     d. 调用 wiki_log.py 追加日志                               │
│     e. 判断是否需要重写 overview.md                            │
│  7. 可选：运行 health.py --json 验证 wiki 状态                 │
│  8. 向用户报告做了什么（可选）                                 │
└──────────────────────────────────────────────────────────────┘
```

> **overview.md 重写决策：** kiwi 在每次蒸馏后分析现有 overview.md，在返回的分析报告中建议是否需要重写。调用方根据 kiwi 的建议和自身判断决定是否执行重写。

### 7.2 Query 工作流

```
任意 agent 需要 wiki 知识
     │
     ▼
┌─ 任意 agent ──────────────────────────────────────────────────┐
│  1. 通过注入的 SCHEMA 知识知道存在 wiki                       │
│  2. 读取 wiki/index.md 了解 wiki 覆盖范围                     │
│  3. 判断问题是否可能被 wiki 覆盖                              │
│     ├─ 是 → 读取相关 wiki 页面                                │
│     │        ├─ 有答案 → 合成回答                             │
│     │        └─ 无答案 → 继续其他探索路径                     │
│     └─ 否 → 继续其他探索路径                                  │
│                                                               │
│  4. 如果探索产生了有价值的答案：                               │
│     ├─ 结构化/简单 → 直接写入工具脚本（走简单路径）           │
│     └─ 非结构化/复杂 → 委派 kiwi 蒸馏（走复杂路径）           │
│  5. 向用户合成最终答案                                        │
└──────────────────────────────────────────────────────────────┘
```

**关键变更：** 查询不再通过 build 作为枢纽。任何 agent（eagle、explore、general）均可直接读取 wiki。答案归档也不再必须经过 build → kiwi，而是由发现知识的 agent 自行决定走简单或复杂路径。

### 7.3 Health Check 工作流（两层级）

Wiki 维护分为两个层级：**health**（零 LLM，每次会话运行）和 **lint**（深度结构检查，每 10-15 次 ingest 运行）。

#### 7.3.1 Health 工作流（Phase 0 — 零 LLM）

```
触发方式：每次会话开始、每次 ingest 完成后由任意 agent 触发
     │
     ▼
运行: python wiki/tools/health.py

工具脚本 health.py（零 LLM 调用）:

检查项:
1. Empty/stub files — 文件存在但内容为空或仅骨架
2. Index sync — 对比 wiki/ 目录下的文件和 index.md
   中的条目，发现缺少或多余的条目
3. Log coverage — 检查 sources/ 下所有页面是否都有
   对应的 log.md 条目
4. Frontmatter completeness — 检查所有页面是否都有
   必需的 frontmatter 字段（title/type/created/updated/
   tags/status），以及 type 和 status 枚举值是否合法

输出:
- stdout: 每个检查项通过/失败，失败项附详情
- --save: 写入 wiki/health-report.md
- --json: JSON 格式输出供 agent 程序化消费

CLI 用法:
python wiki/tools/health.py [--save]
    [--json]
```

#### 7.3.2 Lint 工作流（Phase 0.5 — 深度结构检查（确定性））

```
触发方式：每 10-15 次 ingest 后，或 health 检查发现问题时
     │
     ▼
运行: python wiki/tools/lint.py

工具脚本 lint.py（纯确定性检查，无 LLM 调用）:

检查项:（4 项）
1. Broken links — frontmatter `related` 字段或正文中的
   Markdown 链接指向不存在或已被移动的页面
2. Orphan pages — 零入链且未在 index.md 中列出的页面
3. Sparse pages — 内容过少的页面（正文 < 50 字符）
4. Stale pages — updated 超过 90 天且状态非 deprecated

两层级配合方式：
1. 每次会话开始：health.py 运行（零成本，~毫秒级）
2. 如果 health 发现问题：阻止 ingest，提示用户先修复
3. 每 10-15 次 ingest：lint.py 运行（确定性检查，低成本）
4. lint 发现的 orphan/missing 问题 -> 触发 heal 工作流
```

### 7.4 Heal 工作流

自动修复 lint 发现的结构性问题。

```
触发方式：lint 发现 orphan 或 missing 页面后，由任意 agent 触发
     │
     ▼
运行: python wiki/tools/heal.py

工具脚本 heal.py:
- 读取 lint-report.md 或接受 stdin JSON
- 对每种问题类型：
  ├─ Orphan page → 自动寻找相关页面并补充 cross-ref
  ├─ Missing entity page → 根据引用上下文创建
  │  骨架页面（frontmatter + stub content）
  └─ Broken link → 如果目标页面确定已删除，移除引用
- 不处理的：contradictions（需人工介入或 kiwi 审查）

输出: 修复摘要，记录到 log.md

CLI 用法:
python wiki/tools/heal.py [--report
    <path>]

审查: 可选运行 health.py --json 验证修复后状态
```

### 7.5 Refresh 工作流

检测原始源文档的变更并重新 ingest。

```
触发方式：手动触发或检测到原始源文件变更
     │
     ▼
运行: python wiki/tools/refresh.py

工具脚本 refresh.py:
- 扫描 wiki/sources/ 中所有页面的 frontmatter `source`
  字段，对比文件修改时间
- 对每个已变更的源：
  ├─ 备份旧页面（可选 --backup）
  ├─ 调用 kiwi 重新 ingest（复杂蒸馏路径）
  └─ 更新页面版本号 / updated 日期
- 报告：哪些源已变更、哪些已重新 ingest

CLI 用法:
python wiki/tools/refresh.py
    [--backup] [--dry-run]

--dry-run: 只检测变更，不实际 ingest
```

---

## 8. 注入机制

### 8.1 SCHEMA.md 自动注入

**Phase 1 注：** SCHEMA 自动注入已**推迟到 Phase 2**。Phase 1 中改用 `wiki/tools/wiki_status.py` 工具由任意 agent 按需调用。本节的注入设计保留为 Phase 2 的目标方案。

> **运行时路径：** wiki 目录通过 `~/.zoo/wiki` 软链接访问。`install.py` 创建 `~/.zoo/wiki → <ZooKeeper-source>/wiki/` 的符号链接，确保插件作为外部依赖安装时工具脚本和 agent 仍可正确解析 wiki 路径。所有 Python 工具脚本（health.py、lint.py、new_page.py、wiki_log.py）均从 `Path.home() / ".zoo" / "wiki"` 解析 wiki 目录。

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
- 工具调用约定：什么时候用工具直接操作，什么时候委派 kiwi

完整 SCHEMA.md 只注入到 kiwi 的 prompt 中（因为 kiwi 需要完整的格式规范来生成页面）。

**方案 B：按 agent 选择性注入（推荐 Phase 2）**

| Agent | 注入内容 |
|-------|---------|
| build | SCHEMA 缩略版（目录 + index.md 导航方式 + 工具 vs kiwi 决策标准） |
| explore | SCHEMA 缩略版（目录 + index.md 导航方式 + 工具用法） |
| general | SCHEMA 缩略版（目录 + 可读 wiki 页面 + 工具用法） |
| kiwi | 完整 SCHEMA.md |
| eagle | SCHEMA 缩略版（目录 + 可查阅 wiki 参考） |
| spider | 无（不操作用户项目文件） |

### 8.2 工具调用约定（新增）

SCHEMA 缩略版中应包含以下决策指南，帮助 agent 判断使用工具还是委派 kiwi：

```
## 工具调用指南

### 何时使用工具脚本（直接操作）
- 内容是结构化的、已 wiki 格式化的
- 操作是简单的 CRUD（创建/更新/删除页面）
- 操作是维护性的（health、lint、heal、refresh）
- 只需要追加日志条目

### 何时委派 kiwi（复杂蒸馏）
- 源材料是非结构化文本、聊天记录、会议转录
- 需要分类、摘要、要点提取
- 需要跨多个 wiki 目录组织内容
- 需要判断是否重写 overview.md

> **注意：** kiwi 是只读 agent，在委派时 task() prompt 应要求 kiwi 返回结构化分析报告而非直接写入。所有写入（new_page.py、wiki_log.py、更新 index.md 等）由调用方在收到分析报告后执行。

### 可用工具
- `health.py --json` — 快速检查 wiki 结构完整性
- `new_page.py --type <type> --title <title>` — 创建新页面的骨架（source 类型加 `--source-type <adr|rfc|notes>`）
- `wiki_log.py --op <op> --path <path> --action <action> --note <note>` — 追加日志
```

### 8.3 按需读取机制

SCHEMA.md 提供的是"元知识"（wiki 存在、如何用），具体页面内容通过 agent 自身的 `read` / `grep` 工具按需读取：

1. **入口点：** 任何 agent 在收到可能由 wiki 覆盖的问题时，先尝试读取 `wiki/index.md`
2. **导航：** 从 index.md 中找到相关页面路径
3. **读取：** 用 `read` 工具读取具体页面内容
4. **交叉引用：** 如果页面有 `related` 指向其他页面，按需递归读取

```
用户: "How does the task prompt validation work?"
     │
agent: read wiki/index.md
     │
     ├─ 在 Concepts 下找到 "task-prompt-validation" 条目
     │
agent: read wiki/concepts/task-prompt-validation.md
     │
     ├─ 页面给出概览 + 指向 src/hooks/task-prompt/ 的引用
     │
agent: 合成回答或继续探索
```

### 8.4 为何不将完整 wiki 注入 prompt

- **上下文窗口有限：** 随着 wiki 增长，完整注入会快速消耗 context
- **信息稀疏：** 大多数页面与当前任务无关，完整注入带来噪声
- **按需读取更高效：** LLM 自己决定读什么，基于 index.md 导航
- **SCHEMA 缩略版足够小：** 目录结构 + 使用方式通常 < 1K tokens，注入成本可忽略

### 8.5 工具脚本的 programmatic 访问

所有 `wiki/tools/` 下的 Python 工具脚本（health.py、lint.py、wiki_log.py 等）支持 `--json` 标志，输出结构化 JSON 到 stdout。这使得 agent 可以通过 `bash` 工具调用脚本并解析结果，而无需解析人类可读文本。例如：

```
python wiki/tools/health.py --json
```

返回 JSON 包含 `{ "passed": bool, "checks": [{ "name": str, "status": "pass"|"fail", "details": str }] }`。

---

## 9. index.md 与 log.md 格式

### 9.1 index.md 格式规范

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
- [Kiwi Agent](wiki/entities/kiwi-agent.md) — wiki 蒸馏专家 agent 的角色和职责
- [Task Tool](wiki/entities/task-tool.md) — task() 工具的行为规范和参数说明

## Sources（源文档）

### ADR
- [ADR-001: Permission Deny List](wiki/sources/adr/adr-001-permission-deny-list.md) — 为何选择 deny 而非 allow
- [ADR-002: Prompt Injection via Config Hook](wiki/sources/adr/adr-002-prompt-injection.md) — 运行时注入 vs 编译时注入

### Meeting Notes
- [2026-06-10: Wiki Design Sync](wiki/sources/notes/2026-06-10-wiki-design-sync.md) — LLM Wiki 架构确认和职责分配

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

### 9.2 log.md 格式规范

每条记录是一个 Markdown 二级标题，格式如下：

```
## [<YYYY-MM-DD>] <op> | <path> | <action> — <note>
```

其中：

- `<op>`：**触发操作**，即触发本次变更的上游流程。取值 `ingest` / `query` / `update` / `delete` / `health` / `lint` / `heal` / `refresh` / `tool`
- `<path>`：页面路径（相对于项目根），如 `wiki/concepts/permission.md`。非页面事件写 `—`
- `<action>`：**变更结果**，即对页面的实际操作。取值 `create` / `edit` / `delete` / `pass` / `fail`
- `<note>`：简短说明（不超过 60 字）

示例：

```
## [2026-06-17] ingest | wiki/concepts/prompt-injection.md | create — 摘要来自 ADR-003
## [2026-06-17] ingest | wiki/entities/install-py.md | create — 来自 install.py 分析
## [2026-06-18] update | wiki/concepts/prompt-injection.md | edit — 补充 Phase 2 实施方案
## [2026-06-19] query | wiki/syntheses/linter-comparison.md | create — 来自 "which linter" 问答
## [2026-06-16] health | — | pass — 所有检查通过，无 orphan/missing
## [2026-06-18] tool | wiki/entities/build-agent.md | edit — 直接工具写入（简单路径）
```

**格式规则：**

| 部分 | 规则 |
|------|------|
| 前缀 | `## [` + `YYYY-MM-DD` + `]` 空格 |
| 操作 | `ingest` / `update` / `delete` / `query` / `health` / `lint` / `heal` / `refresh` / `tool` |
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

**log.md 由 `wiki_log.py` 脚本写入，而非 LLM 手动格式化。** 所有 agent 必须通过 `wiki_log.py` 工具追加日志，以确保格式一致性和 grep 兼容性。注意：kiwi 是只读 agent，不调用 wiki_log.py——kiwi 在分析报告中建议日志内容，由调用方执行 wiki_log.py 追加日志。

---

## 10. 页面模板

### 10.0 模板目录与脚手架工具

`wiki/templates/` 目录包含 5 个模板文件，每种页面类型一个：

| 模板文件 | 页面类型 |
|----------|---------|
| `wiki/templates/concept.md` | concept |
| `wiki/templates/entity.md` | entity |
| `wiki/templates/source.md` | source |
| `wiki/templates/analysis.md` | analysis |
| `wiki/templates/synthesis.md` | synthesis |

`wiki/tools/new_page.py` 是脚手架 CLI 工具，从模板生成带完整 frontmatter 和骨架节的页面：

```
python3 wiki/tools/new_page.py \
    --type <concept|entity|source|analysis|synthesis> \
    --title "<页面标题>"
```

对于 source 类型，额外指定 `--source-type`：

```
python3 wiki/tools/new_page.py \
    --type source \
    --title "<页面标题>" \
    --source-type <adr|rfc|notes>
```

调用方（任意 agent）在创建页面时应先使用 `new_page.py` 生成骨架，然后 `write`/`edit` 填充各节的实际内容。这样可以保证 frontmatter 字段齐全、格式一致。SCHEMA.md 中已引用此工具作为标准流程。

### 10.1 概念页面（Concepts）

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

### 10.2 实体页面（Entities）

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

### 10.3 源摘要页面（Sources）

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

### 10.4 分析页面（Analysis）

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

### 10.5 合成页面（Synthesis）

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

## 11. 集成点

### 11.1 对 build Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 在 `core/prompts/build.md` 尾部或由 hook 注入 |
| 新增 wiki 感知阶段 | 行为变化 | 在 Phase 0 Intent Gate 之后、Phase 1 之前检查 wiki/index.md |
| 工具脚本直接调用 | 行为变化 | 可通过 bash 直接调用 health.py / new_page.py / wiki_log.py |
| kiwi 委派仅用于复杂蒸馏 | 行为变化 | 结构化内容不需委派 kiwi，直接工具写入 |

build.md 中新增的 wiki 感知阶段（插入在 Phase 0 和 Phase 1 之间）：

```markdown
## Phase 0.5: Wiki Check

Before planning or delegating, check if the wiki already covers this
question. Read `wiki/index.md` — if a relevant page exists, read it
and skip unnecessary exploration. If the answer is sufficient, use it.
If the answer is partial, use it as context for further exploration.
```

### 11.2 对 explore Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 告知 explore wiki 的存在 |
| 可直接读取 wiki | 行为提示 | explore 可自主读取 wiki 作为探索上下文 |
| 探索结果可直接写入 | 行为提示 | 结构化发现可通过工具直接写入 wiki，无需经过 build |

### 11.3 对 general Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 告知 general wiki 的存在 |
| 实现时可查阅 wiki 约定 | 行为提示 | 在实现前可先读 wiki 确认项目约定 |
| 发现可写入 wiki | 行为提示 | 发现新约定时可直接调用工具写入 |

### 11.4 对 spider Agent 的影响

无直接影响。Spider 是纯 web research agent，不操作项目文件。但如果 spider 的研究结果值得存档，结果接收 agent 可自行触发 ingest。

### 11.5 对 eagle Agent 的影响

| 变更 | 类型 | 说明 |
|------|------|------|
| Prompt 尾部追加 SCHEMA 缩略版 | prompt 修改 | 告知 eagle wiki 的存在 |
| Review 时可查阅 wiki 约束 | 行为提示 | 在代码审查时，可读取 wiki 中的架构决策作为审查依据 |

### 11.6 插件层变更（src/index.ts）

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
      // 为目标 agent 注入缩略版
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

### 11.7 Skills 注册

`wiki-ingest` 和 `wiki-query` skill 需要在 `config.toml` 的 `[zoo.skills]` 中注册：

```toml
[zoo.skills]
git-commit = "enable"
code-review = "enable"
wiki-ingest = "enable"
wiki-query = "enable"
```

并在 `src/index.ts` 的 skill 注册循环中自动发现（现有逻辑已支持从 `core/skills/` 目录自动注册所有 enabled skill）。

### 11.8 工具脚本集成

任意 agent 可通过 `bash` 工具直接调用 `wiki/tools/` 下的 Python 脚本：

```python
# 健康检查（任何 agent 在任何阶段）
python wiki/tools/health.py --json
# → 返回 {"passed": true, "checks": [...]}

# 深度检查
python wiki/tools/lint.py --json
# → 返回 {"issues": [...], "summary": {...}}

# 创建新页面骨架
python wiki/tools/new_page.py \
    --type concept --title "My Concept"
# source 类型：
python wiki/tools/new_page.py \
    --type source --title "ADR-001" --source-type adr

# 追加日志
python wiki/tools/wiki_log.py \
    --op ingest --path "wiki/concepts/my-concept.md" \
    --action create --note "来源：设计讨论"
```

---

## 12. Wiki 工具 API 设计

### 12.1 wiki_log.py — 日志记录工具

**用途：** 以规范格式追加日志到 `wiki/log.md`。所有 agent（不含 kiwi）必须通过此工具（而非 LLM 字符串拼接）写日志。kiwi 是只读 agent，不调用 wiki_log.py——kiwi 在分析报告中建议日志内容，由调用方执行。

**CLI 用法：**

```bash
python wiki/tools/wiki_log.py \
    --op <ingest|update|delete|query|health|lint|heal|refresh|tool> \
    --path "<wiki/相对路径|—>" \
    --action <create|edit|delete|pass|fail> \
    --note "<不超过 60 字的说明>"
```

**示例：**

```bash
# 记录页面创建
python wiki/tools/wiki_log.py \
    --op ingest --path "wiki/concepts/permission-model.md" \
    --action create --note "来自架构文档 ADR-001"

# 记录健康检查
python wiki/tools/wiki_log.py \
    --op health --path "—" \
    --action pass --note "所有检查通过"

# 记录工具直接写入
python wiki/tools/wiki_log.py \
    --op tool --path "wiki/entities/build-agent.md" \
    --action edit --note "补充 Phase 0.5 wiki check 说明"
```

**输出：** 成功时无输出（静默），失败时打印错误到 stderr。返回 0（成功）或 1（失败）。

**格式保证：** 脚本内部确保：
- 新行插入在最顶部
- 日期格式为 `YYYY-MM-DD`
- 分隔符正确使用 ` | `（空格包围管道符）
- 不会修改已有行

### 12.2 wiki_ingest.py（未来 — MCP 版本）

**用途（Phase 2+）：** 作为 MCP 工具的 `wiki_remember` 入口，处理所有写入操作。在 Phase 1 中，此角色由 `new_page.py` + `write`/`edit` + `wiki_log.py` 组合完成。

**Phase 2+ 设想 CLI：**

```bash
# 简单写入（结构化内容）
python wiki/tools/wiki_ingest.py \
    --path "wiki/concepts/my-concept.md" \
    --content "content.md" \
    --update-index \
    --log "来源：设计讨论"

# 批量生成（通过模板）
python wiki/tools/wiki_ingest.py \
    --type concept \
    --title "My Concept" \
    --content "content.md" \
    --update-index --log
```

**MCP 工具映射（Phase 2+）：**

| MCP 工具 | 对应操作 |
|----------|---------|
| `wiki_remember` | 写入/更新 wiki 页面，更新 index，追加日志 |
| `wiki_recall` | 读取 wiki 页面，搜索 wiki 内容 |
| `wiki_health` | 运行 health/lint 检查并返回结果 |

### 12.3 决策标准：工具 vs kiwi

| 条件 | 使用工具 | 委派 kiwi |
|------|---------|-----------|
| 内容是结构化、已 wiki 格式化 | ✅ | ❌ |
| 需要从非结构化文本提取要点 | ❌ | ✅ |
| 需要分类（确定目标目录和页面类型） | ❌ | ✅ |
| 简单的 CRUD（更新已有页面） | ✅ | ❌ |
| 需要跨目录组织多页面 | ❌ | ✅ |
| 源材料是简短的已知事实 | ✅ | ❌ |
| 源材料是长篇会议记录或设计文档 | ❌ | ✅ |
| 需要创建 sources/ 页面 | ⚠️ 仅限简单追加 | ✅ 推荐 |
| 只需要追加日志 | ✅ (wiki_log.py) | ❌ |
| kiwi 返回的是分析报告而非写入结果 | ✅ 调用方根据分析执行写入 | ✅ kiwi 只做分析与蒸馏 |

---

## 13. 迁移路径

### 概述

本设计包含两条并行的演进路径：

```
Phase 1（当前实现）
  ├─ Plan B（主路径）: wiki-ingest skill + wiki-query skill + kiwi（蒸馏专家）
  └─ Plan A（备用）: 跳过 skill，直接 Phase 2 MCP 工具

         ▼
Phase 2（MCP 化）
  删除 wiki-ingest / wiki-query skills
  新增 MCP 工具：wiki_remember / wiki_recall / wiki_health
  保留 kiwi 作为"复杂蒸馏专家"
```

### Phase 1: 过渡实现 — Skill 层（当前）

**目标：** 通过 Skill 作为过渡层，快速建立 wiki 能力。

**主路径（Plan B）：**

| 工作项 | 文件 | 估算 |
|--------|------|------|
| 创建 `wiki/` 目录和 `wiki/index.md`（仅骨架） | `wiki/index.md` | 小 |
| 创建 `wiki/SCHEMA.md`（完整规范） | `wiki/SCHEMA.md` | 中 |
| 创建 `wiki/log.md`（空日志） | `wiki/log.md` | 小 |
| 创建 `wiki/overview.md`（骨架） | `wiki/overview.md` | 小 |
| 编写 `core/prompts/kiwi.md` | `core/prompts/kiwi.md` | 中 |
| 编写 `core/skills/wiki-ingest/SKILL.md`（含两条路径） | `core/skills/wiki-ingest/SKILL.md` | 中 |
| 编写 `core/skills/wiki-query/SKILL.md` | `core/skills/wiki-query/SKILL.md` | 小 |
| 编写 `wiki/tools/health.py` | 结构检查脚本，4 项确定性检查 | 中 |
| 编写 `wiki/tools/lint.py` | 深度结构检查脚本，4 项确定性检查 | 中 |
| 编写 `wiki/tools/new_page.py` | 页面脚手架 CLI 工具 | 小 |
| 编写 `wiki/tools/wiki_log.py` | 日志追加 CLI 工具 | 小 |
| 创建 `wiki/templates/` 和 5 个模板文件 | `wiki/templates/{concept,entity,source,analysis,synthesis}.md` | 小 |
| 在 `config.toml` 中添加 `[agent.kiwi]` | `config.toml` | 小 |
| 在 `config.toml` 中添加 `wiki-ingest` 和 `wiki-query` skill 启用 | `config.toml` | 小 |
| 在 `src/index.ts` 的 `config` hook 中添加 SCHEMA 注入 | `src/index.ts` | 中 |
| 创建 1-2 个示例 wiki 页面用于验证 | `wiki/concepts/`, `wiki/entities/` | 小 |
| 端到端验证：agent 通过工具路径完成一次 ingest | — | 中 |
| 端到端验证：agent 通过 kiwi 路径完成一次复杂蒸馏 | — | 中 |

**备用路径（Plan A）：**
如果 Phase 1 的 wiki-ingest / wiki-query skills 在实践中被证明不必要（agent 完全可以直接调用工具脚本），则跳过技能层，直接进入 Phase 2 的 MCP 工具阶段。届时：
- 不创建 `core/skills/wiki-ingest/` 和 `core/skills/wiki-query/` 目录
- 在 `config.toml` 中移除 `wiki-ingest` 和 `wiki-query` skill 注册
- 直接设计 `wiki_remember` / `wiki_recall` / `wiki_health` MCP 工具

**Phase 1 验收条件：**

Plan B 验收条件：
- `python3 install.py` 运行成功，`opencode.json` 中包含 kiwi agent 配置
- `src/index.ts` 的 `config` hook 正确注入 SCHEMA 缩略版到 build/explore/general/eagle
- `src/index.ts` 的 `config` hook 正确注入完整 SCHEMA.md 到 kiwi
- `python wiki/tools/health.py --json` 返回有效 JSON 且无报错
- `python wiki/tools/lint.py --save` 可运行
- `python wiki/tools/wiki_log.py --op health --path "—" --action pass --note test` 正确追加日志
- 可通过工具路径（new_page.py → write → wiki_log.py）完成一次直接写入
- 可通过 skill + kiwi 路径完成一次复杂蒸馏

Plan A 启动条件（任一满足）：
- wiki-ingest skill 在实践中被重复绕过（agent 总是直接调工具）
- wiki-query skill 被证明多余（agent 直接 read/grep 即可，不需要 skill 指导）
- 维护成本（两个 skill 文件）超过收益

### Phase 2: MCP 化（未来目标）

**目标：** 将 wiki 操作封装为标准的 MCP 工具，取代 Phase 1 的技能层。

| 变更 | 说明 |
|------|------|
| 删除 `core/skills/wiki-ingest/SKILL.md` | 不再需要技能层 |
| 删除 `core/skills/wiki-query/SKILL.md` | 不再需要技能层 |
| 新增 MCP 工具 `wiki_remember` | 合并 new_page.py + write + wiki_log.py 的功能 |
| 新增 MCP 工具 `wiki_recall` | 封装 index.md 导航 + read/grep 的模式 |
| 新增 MCP 工具 `wiki_health` | 封装 health.py + lint.py 的功能 |
| 保留 kiwi（复杂蒸馏专家） | 仅处理非结构化 → 结构化蒸馏；MCP 工具处理简单操作 |
| 更新 SCHEMA 注入内容 | 反映 MCP 工具的存在和用法 |

**MCP 工具 vs kiwi 的协作模式（Phase 2+）：**

```
任意 agent
     │
     ├── 结构化/简单操作 ──→ wiki_remember / wiki_recall / wiki_health
     │                       （MCP 工具，直接调用）
     │
     └── 非结构化/复杂源 ──→ task(subagent="kiwi", prompt=...)
                             （kiwi 只读返回分析报告，调用方通过 MCP 工具写入）
```

**Phase 2 验收条件：**
- `wiki_remember` / `wiki_recall` / `wiki_health` 三个 MCP 工具可用
- 技能目录和注册已清理干净
- 端到端验证：任意 agent 通过 MCP 工具完成 wiki 操作
- kiwi 仍可通过 MCP 工具写入结果（而非直接文件操作）

---

## 14. 附录：架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          LLM Wiki 架构（v2）                              │
│                                                                          │
│  ┌────────────┐    ┌──────────────────────┐    ┌────────────────────┐   │
│  │  Raw Sources│───▶│  Wiki Pages          │◀───│   SCHEMA.md        │   │
│  │ (immutable) │    │ (structured)         │    │   (conventions)    │   │
│  │  files/URLs │    │  concepts/           │    └────────┬───────────┘   │
│  │  ADR/notes  │    │  entities/           │             │               │
│  └────────────┘    │  sources/             │             │ auto-inject   │
│                    │  analysis/            │             ▼               │
│                    │  syntheses/           │    ┌────────────────────┐   │
│                    │  overview.md          │    │  Plugin Config Hook│   │
│                    └──────────┬────────────┘    │  (src/index.ts)   │   │
│                               │                 │  → all agents     │   │
│                               │ on-demand       └────────────────────┘   │
│                               ▼                                          │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                  操作模式（两条路径）                           │       │
│  │                                                                │       │
│  │  简单路径（任意 agent 直接操作）                                │       │
│  │  ┌──────────┐    ┌───────────────────────┐                    │       │
│  │  │ 任意 agent│───▶│ 工具脚本               │                    │       │
│  │  │          │    │  health.py / lint.py  │                    │       │
│  │  │          │    │  new_page.py          │                    │       │
│  │  │          │    │  wiki_log.py          │                    │       │
│  │  └──────────┘    └───────────────────────┘                    │       │
│  │                                                                │       │
│  │  复杂路径（需要蒸馏时委派 kiwi，kiwi 只读返回分析，调用方执行写入）│       │
│  │  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐   │       │
│  │  │ 任意 agent│───▶│  kiwi       │───▶│ 调用方根据分析执行  │   │       │
│  │  │ (load skill)│   │ (只读蒸馏专家)│    │  new_page.py / write  │   │       │
│  │  └──────────┘    └──────────────┘    │  / wiki_log.py 等   │   │       │
│  │                                      └────────────────────┘   │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────┐           │
│  │                     Storage                               │           │
│  │  wiki/ directory on filesystem + git for version history  │           │
│  │  Zero external services, no vector DB, no RAG pipeline   │           │
│  └──────────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────┘

  Phase 2+（MCP 化）:
  ┌──────────────────────────────────────────────────────────────┐
  │  工具脚本 ──→ MCP 工具: wiki_remember / wiki_recall        │
  │                        / wiki_health                        │
  │  Skills: 删除 wiki-ingest / wiki-query                      │
  │  kiwi: 仅复杂蒸馏（只读），结果通过分析报告返回，由调用方通过 MCP 工具写入                    │
  └──────────────────────────────────────────────────────────────┘
```

---

## 15. 附录：与类似方案对比（OMO / SLIM / OMP）

### 15.1 项目正确定位

| 方案 | 全称 / 项目 | 核心机制 | 知识角色 |
|------|------------|---------|---------|
| **OMO** | oh-my-openagent | Librarian（研究专员）+ mnemopi 记忆层 | 研究专员 + 记忆工具 |
| **OMP** | oh-my-pi (Pi) | Librarian（只读研究专员）+ Sisyphus-Junior（写入）+ Memory 工具 | 只读研究专员 + 写入 agent + 记忆工具 |
| **SLIM** | oh-my-opencode-slim | 纯外部文档研究者，无持久知识库 | 一次性研究专员 |
| **ZooKeeper（本文）** | OpenCode 编排器插件 | Skill 过渡 → MCP 工具 + kiwi（只读蒸馏专家） | 共享工具 + 只读蒸馏专家 |

> **勘误：** 早期版本将 OMP 误标为 OMO。正确对应关系：OMO = oh-my-openagent（全功能 agent 框架），OMP = oh-my-pi（编排式多 agent 系统），SLIM = oh-my-opencode-slim（精简版 OpenCode 配置）。

### 15.2 专家 agent 读写权限对比

所有三个参考项目都要求知识 specialist **只读**，以下是各项目的具体权限控制方式：

| 维度 | OMO Librarian | OMP Librarian | SLIM Librarian | ZooKeeper kiwi |
|------|--------------|--------------|----------------|----------------|
| **允许的工具** | read、search、find、grep | read、search、find、bash、lsp、web_search、ast_grep | read、search、webfetch | read、glob、grep |
| **明确禁止** | write、edit、apply_patch | 白名单制 — 未列入的工具均不可用 | write、edit、bash、task | write、edit、task、webfetch、websearch |
| **输出格式** | 自由格式 Markdown | 结构化 JSON（通过 `yield` 工具） | 自由格式 Markdown | 自由格式 Markdown |
| **写入执行者** | 编排器（orchestrator） | Sisyphus-Junior（专用写入 agent） | 无（SLIM 不写知识库） | 调用方（任意 agent） |
| **只读保证方式** | 权限 deny | 工具白名单 | 权限 deny | 权限 deny |

**关键发现：** 三个项目独立得出了相同的结论——**知识 specialist agent 必须只读**。最严格的是 OMP，使用白名单机制只放行 7 个工具；最宽松的是 OMO，通过 deny write/edit/apply_patch 实现。无论哪种方式，specialist 都不调用 memory 工具或文件写入工具。

### 15.3 输出格式与协约机制

#### OMP Librarian 的 yield 工具

OMP 实现了一个 OpenCode 框架层不存在的机制——`yield` 工具：

1. Librarian 在执行完只读研究后，调用 `yield` 工具将结论以结构化 JSON 格式输出
2. `yield` 工具通过 OpenCode 的 `shouldTerminate` 回调实现，在工具返回后终止 subagent
3. Sisyphus-Junior（主 agent）收到结构化 JSON 后解析并执行对应的写入操作

**OpenCode 限制：** OpenCode 插件 API 不支持 `shouldTerminate` 回调或 `extractData` 机制。这意味着 ZooKeeper 无法在框架层面保证 kiwi 输出结构化 JSON。因此 ZooKeeper 采用不同方案：kiwi 返回自由格式 Markdown 分析报告，由调用方 agent 自行理解和执行。Phase 2 MCP 化后，写入操作封装为标准化 MCP 工具，specialist 不需要产生机器可解析的输出。

#### OMO Librarian 的自由 Markdown

OMO 的 Librarian 使用更简单的方式：直接以自由格式 Markdown 返回分析结果。编排器读取 Markdown 后，通过 `task` 工具或 `write` 工具将知识写入 mnemopi 记忆层。这种方式实现简单，但依赖编排器的理解能力。

#### SLIM 的无持久化方案

SLIM 的 Librarian 最轻量：只做一次性外部文档研究，返回分析结果后即结束。没有持久化知识库，没有 wiki 写入。这适合不需要跨会话知识积累的场景。

### 15.4 写入模式对比

| 方案 | 谁写入 | 写入方式 | 持久化介质 |
|------|-------|---------|-----------|
| **OMO** | 编排器（orchestrator） | 通过 mnemopi 工具调用 | mnemopi 记忆层 |
| **OMP** | Sisyphus-Junior（主 agent） | 解析 yield JSON → 调用 Memory 工具 | Memory 工具 |
| **SLIM** | 无写入 | 无 | 无 |
| **ZooKeeper Phase 1** | 调用方（任意 agent） | new_page.py + write/edit + wiki_log.py | 纯 Markdown 文件 + git |
| **ZooKeeper Phase 2+** | 调用方（任意 agent） | MCP 工具（wiki_remember / wiki_recall / wiki_health） | 纯 Markdown 文件 + git |

### 15.5 为什么 kiwi 是只读的（Phase 1）

综合研究发现，三个参考项目独立得出了相同的架构结论：

1. **关注点分离：** 知识 specialist 的职责是分析、蒸馏、研究——不是写入管理。写入涉及索引同步、交叉引用一致性、日志记录等簿记工作，应由调用方统一处理。
2. **工具权限最小化：** 只读 specialist 不可能意外破坏 wiki 结构。write/edit 权限被 deny，从根本上防止了错误写入。
3. **输出灵活性：** 只读 specialist 可以用最自然的方式（自由格式 Markdown 或结构化 JSON）输出分析，不需要关心如何调用写入 API。

### 15.6 Phase 2 MCP 如何解决写入问题

Phase 2 引入 MCP 工具后，写入问题的性质发生了变化：

- **MCP 工具成为标准接口：** `wiki_remember` / `wiki_recall` / `wiki_health` 成为所有 agent 可调用的标准化工具
- **specialist 不需要产生结构化输出：** kiwi 的分析报告仍然是自由格式 Markdown，但调用方执行写入时使用 MCP 工具而非直接文件操作
- **写入逻辑封装化：** 索引更新、日志追加、交叉引用一致性检查全部封装在 MCP 工具内部，调用方只需调用 `wiki_remember` 即可完成所有写入

这意味着即使 kiwi 始终只读，Phase 2 的写入路径变得更简单可靠。

---

## 16. 架构决策：只读专家（Read-Only Specialist）

### 16.1 问题陈述

ZooKeeper 需要为知识蒸馏设计一个 specialist agent（kiwi）。一个核心设计问题是：kiwi 是否应该拥有写入 `wiki/` 目录的权限？如果允许写入，kiwi 可以直接生成页面、更新索引、追加日志，流程更短。如果不允许写入，则需要调用方在 kiwi 返回分析报告后执行所有写入，流程更长但更安全。

### 16.2 考虑过的方案

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A: kiwi 可读写** | kiwi 有 write/edit 权限，直接创建和更新 wiki 页面 | 流程最短；kiwi 一步完成蒸馏+写入 | 可能意外破坏 wiki 结构；职责模糊（蒸馏 vs 写入混在一起）；难以审计 |
| **B: kiwi 只读 + 调用方写入** | kiwi 返回分析报告，调用方执行所有写入（当前方案） | 职责清晰；安全（kiwi 不可能破坏 wiki）；分析报告可复读 | 流程多一步；调用方需要理解 kiwi 的分析 |
| **C: kiwi 只读 + MCP 工具写入（Phase 2）** | kiwi 返回分析报告，调用方通过 MCP 工具执行写入 | 方案 B 的所有优点 + MCP 封装写入逻辑，调用更简单 | 需要等待 Phase 2 MCP 实现 |

### 16.3 决策

选择 **方案 B**（Phase 1）+ **方案 C**（Phase 2 演进目标）。

Kiwi 是**只读 agent**，`write` 和 `edit` 被 deny。它在收到 task() 调用后，执行只读分析（read、glob、grep），返回结构化 Markdown 分析报告。所有写入操作——创建页面、更新 index.md、追加日志——由调用方 agent 根据分析报告执行。

### 16.4 决策依据

#### 研究驱动的结论

在做出决策前，我们研究了三个类似项目：

1. **OMO (oh-my-openagent)** — Librarian 是只读的（deny write/edit/apply_patch），返回自由格式 Markdown。编排器负责将知识写入 mnemopi 记忆层。
2. **OMP (oh-my-pi)** — Librarian 是只读的（白名单机制 — 只放行 read/search/find/bash/lsp/web_search/ast_grep），通过 `yield` 工具返回结构化 JSON。Sisyphus-Junior 负责解析 JSON 并执行写入。
3. **SLIM (oh-my-opencode-slim)** — 同样是只读外部文档研究者，无持久知识库写入。

**关键发现：** 三个项目独立得出了相同的架构结论——**知识 specialist agent 必须只读**。没有例外。

#### OpenCode 框架限制

OMP 的 `yield` 工具依赖 OpenCode 的 `shouldTerminate` 回调和 `extractData` 机制——这两个 API 在插件层不可用。因此 ZooKeeper 无法在框架层面保证 kiwi 输出机器可解析的结构化 JSON。如果要求 kiwi 写入，则写入质量完全依赖 kiwi 对 SCHEMA.md 的理解，无法在框架层面校验。

#### 安全与审计

- **最小权限原则：** kiwi 不需要 write/edit 来完成其核心职责（分析、蒸馏）
- **变更可追溯：** 所有写入由调用方 agent 执行，调用方有完整的工具调用日志，可追溯每次写入的来源
- **错误隔离：** kiwi 的分析错误不会直接破坏 wiki 文件——调用方在写入前会审查 kiwi 的分析

### 16.5 影响

| 维度 | 影响 |
|------|------|
| **Process** | 复杂路径增加一个步骤：kiwi 返回分析 → 调用方审查 → 调用方写入 |
| **Prompt** | kiwi.md 的 Workflow 结束于 Phase 3（Return Analysis），Contract 包含 NEVER use write/edit |
| **Permission** | kiwi 有 5 条 deny 规则（task、webfetch、websearch、write、edit） |
| **工具脚本** | kiwi 不调用 new_page.py 或 wiki_log.py——这些由调用方使用 |
| **Phase 2 演进** | MCP 工具（wiki_remember/wiki_recall/wiki_health）将进一步简化写入路径，但 kiwi 仍然只读 |

### 16.6 Phase 2 MCP 如何让写入问题消失

Phase 2 引入 MCP 工具后：

1. **写入操作标准化：** `wiki_remember` 成为所有 agent 写入 wiki 的唯一入口，封装了页面创建、索引更新、日志追加等逻辑
2. **specialist 不需要结构化输出：** kiwi 可以继续用自由格式 Markdown 返回分析报告，因为调用方不再直接操作文件，而是调用 `wiki_remember`——MCP 工具内部处理格式校验
3. **更安全的协作模式：** 即使 kiwi 的分析报告有错误，MCP 工具的参数校验和 SCHEMA 验证层可以捕获问题
4. **调用方仍然负责写入：** kiwi 始终只读——写入责任始终在调用方，只是工具从 new_page.py + write/edit + wiki_log.py 变成了 `wiki_remember`

---

## 附录：与现有工具的关系

| 工具/文件 | 与 wiki 的关系 |
|-----------|---------------|
| `config.toml` | 声明 kiwi agent 配置和 wiki-ingest/wiki-query skill 启用状态 |
| `src/index.ts` | 在 `config` hook 中注入 SCHEMA.md 缩略版 |
| `core/prompts/build.md` | 新增 Phase 0.5 Wiki Check 阶段 |
| `core/prompts/explore.md` | prompt 尾部注入 SCHEMA 缩略版 |
| `core/prompts/general.md` | prompt 尾部注入 SCHEMA 缩略版 |
| `core/prompts/eagle.md` | prompt 尾部注入 SCHEMA 缩略版 |
| `core/prompts/kiwi.md` | 新建 — kiwi agent 的 prompt |
| `core/skills/wiki-ingest/SKILL.md` | 新建 — ingest 工作流定义（含两条路径） |
| `core/skills/wiki-query/SKILL.md` | 新建 — query 工作流定义 |
| `wiki/tools/health.py` | 新建 — 零 LLM 结构检查工具 |
| `wiki/tools/lint.py` | 新建 — 确定性深度结构检查工具 |
| `wiki/tools/heal.py` | 新建 — 自动修复工具 |
| `wiki/tools/new_page.py` | 新建 — 页面脚手架 CLI 工具 |
| `wiki/tools/wiki_log.py` | 新建 — 日志追加 CLI 工具 |
| `docs/` 文档 | wiki 存放可操作的知识，docs/ 存放静态设计文档 |
| `.env` | 无直接影响（kiwi 复用 `ZOO_SMALL_MODEL` 配置） |

---

*本文档定义了 LLM Wiki 的完整设计（v2）。实施从 Phase 1 Skill 过渡方案（Plan B 主路径）开始，如果 Skill 层被证明不必要则启用 Plan A 直接进入 MCP 工具阶段。最终汇合于 Phase 2+ 的 MCP 化目标。*