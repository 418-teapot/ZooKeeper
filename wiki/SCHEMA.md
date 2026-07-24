# Wiki Schema

> 本文件位于 `~/.zoo/wiki/SCHEMA.md`（软链接到 ZooKeeper 插件源目录）。
> 它是 LLM Wiki 系统的唯一权威引用。Ingest 和 query 流程中所有页面生成、格式化、命名、交叉引用操作均须遵循本 schema 的规定。LLM 在读取或写入 wiki 前应先阅读此文件。

---

## 目录结构

```
wiki/
├── index.md               # 根索引，列出三个领域 + overview.md
├── logs/                  # 按月变更日志文件（logs/YYYY-MM.md）
├── overview.md            # 项目知识概览，living synthesis
├── SCHEMA.md              # 本文件，schema 定义
├── raw/                   # 原始源材料（不可变，LLM 只读，不在索引中）
├── templates/             # 页面模板
├── autoresearch/          # autoresearch 领域（AI agent 自主实验框架）
│   ├── index.md           # 领域索引
│   ├── concepts/          # 概念页面
│   ├── entities/          # 实体页面
│   ├── sources/           # 源文档
│   │   ├── adr/           # Architecture Decision Records
│   │   ├── rfc/           # RFC / 设计文档
│   │   └── notes/         # 会议纪要、调研笔记
│   ├── analysis/          # 分析页面
│   └── syntheses/         # 合成页面
├── wiki-system/           # wiki-system 领域（结构同上）
│   ├── index.md           # 领域索引
│   ├── concepts/          # 概念页面
│   ├── entities/          # 实体页面
│   ├── sources/           # 源文档
│   │   ├── adr/           # Architecture Decision Records
│   │   ├── rfc/           # RFC / 设计文档
│   │   └── notes/         # 会议纪要、调研笔记
│   ├── analysis/          # 分析页面
│   └── syntheses/         # 合成页面
└── shared/                # shared 领域（结构同上）
    ├── index.md           # 领域索引
    ├── concepts/          # 概念页面
    ├── entities/          # 实体页面
    ├── sources/           # 源文档
    │   ├── adr/           # Architecture Decision Records
    │   ├── rfc/           # RFC / 设计文档
    │   └── notes/         # 会议纪要、调研笔记
    ├── analysis/          # 分析页面
    └── syntheses/         # 合成页面
```

每个子目录下的文件使用 `.md` 扩展名。空目录含 `.gitkeep` 以纳入版本控制。

### raw/ 目录约定

`raw/` 存放摄入源的**完整原文副本**。与 `sources/` 的区别：

| | `raw/` | `sources/` |
|---|---|---|
| 内容 | 原文全文，未经 LLM 修改 | LLM 生成的摘要和元信息 |
| 可变性 | 不可变 — 摄入后不修改 | 可变 — LLM 可更新摘要 |
| 索引 | 不在 index.md 中 | 在 index.md 中 |
| 写入者 | 调用方 agent（抓取原文存入） | LLM 蒸馏 agent |
| 用途 | 蒸馏忠实度的事后可验证依据 | 人类快速了解来源 |

- **文件命名：** `<YYYY-MM-DD>-<source-slug>.md`，日期为摄入日期
- **源更新时：** 不覆盖旧版本，以新文件名追加（如 `2026-06-18-karpathy-llm-wiki.md` → `2026-07-01-karpathy-llm-wiki.md`）
- **LLM 行为：** 只读。蒸馏 agent 应读取 `raw/` 下对应的原文进行蒸馏，而非依赖 `sources/` 摘要

---

## 页面格式约定

### Frontmatter

每个 wiki 页面必须以 YAML frontmatter 开头，包含以下字段：

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `title` | 是 | string | 页面标题，中文为主 |
| `type` | 是 | string | 页面类型：`concept` / `entity` / `source` / `analysis` / `synthesis` |
| `description` | 否 | string | 一句话摘要 |
| `timestamp` | 否 | string | 最后更新日期时间，格式 `YYYY-MM-DDTHH:mm:ssZ` |
| `resource` | 否 | string | 外部资产 URI |
| `sources` | 否 | string[] | 参考的源文档标识列表（用于 analysis / synthesis 类型） |
| `tags` | 是 | string[] | 标签列表，如 `[permission, config]` |
| `relations` | 否 | string[] | 相关 wiki 页面路径列表（相对 wiki 根目录），以 Markdown 链接格式，如 `- "[标题](concepts/permission.md)"` |
| `status` | 是 | string | 状态：`draft` / `review` / `stable` / `deprecated` |
| `last_validated` | 是 | string | 验证时间，ISO 8601 datetime，区别于 timestamp（编辑≠验证） |
| `timeliness` | 是 | string | 时效性标记：`current` / `stale`（仅两档，新页面默认 current） |
| `supersedes` | 否 | object[] | 取代关系：本页推翻哪些页面，每项含 `path`（相对 wiki 根目录）和 `reason` |
| `superseded_by` | 否 | object[] | 被取代关系：本页被哪些页面推翻，每项含 `path` 和 `reason` |
| `contradictions` | 否 | object[] | 矛盾记录，每项含 `path`（冲突页面路径）、`claims`（冲突声明列表）、`detected`（发现日期）、`resolution`（`unresolved` 或具体解决说明） |
| `freshness_days` | 否 | integer | 时效阈值覆写（天数），默认 180 天，`source` 类型永不过期 |

示例：

```yaml
---
title: 权限系统
description: <一句话摘要>。
type: concept
timestamp: 2026-06-17T00:00:00Z
tags: [permission, security]
relations:
  - "[foo 实体](autoresearch/entities/foo.md)"
  - "[bar 概念](shared/concepts/bar.md)"
status: stable
last_validated: 2026-06-19T00:00:00Z
timeliness: current
# 以下为可选字段
supersedes:
  - path: autoresearch/concepts/old-permission.md
    reason: "新设计覆盖了旧的权限模型"
superseded_by: []
contradictions:
  - path: shared/concepts/security-model.md
    claims:
      - "声称权限由 X 控制"
      - "声称权限由 Y 控制"
    detected: 2026-06-19
    resolution: unresolved
freshness_days: 90
---
```

### 节结构

所有页面遵循统一的五段式结构（非必需段落可省略）：

1. **Overview** — 一句话概括和一节概述（blockquote），说明该页面回答的核心问题
2. **Details** — 详细展开，可使用二级/三级标题细分
3. **Backlinks** — 反向链接列表，由 `zwiki check` 自动维护，列出引用本页面的其他页面。
4. **References** — 引用来源（外部链接、代码路径、文档路径）
5. **Notes** — 补充说明、待确认事项、边缘情况

每个段落用 `##` 二级标题开始。

### 命名规则

- **格式：** 全小写 kebab-case，如 `permission-system.md`、`deny-list.md`
- **禁止：** 数字前缀（如 `01-permission.md`）、空格、大写字母
- **语言：** 文件名必须是英文 kebab-case，禁止中文或非 ASCII 字符。中文标题需要用英文翻译或缩写作为文件名
- **唯一性：** 同一 `<domain>/<type>/` 下文件名唯一。不同 `<domain>/<type>/` 之间可以重名（如 `autoresearch/concepts/plugin.md` 和 `autoresearch/entities/plugin.md` 含义不同）

### 路径与交叉引用规则

本页内交叉引用（Markdown 链接、frontmatter `relations`/`sources`、日志条目中的路径）一律**相对 wiki 根目录**，不带 `wiki/` 或 `~/.zoo/wiki/` 前缀：

- **内联链接：**
  ```
  [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
  [train.py](autoresearch/entities/autoresearch-train-py.md)
  ```
- **Frontmatter `relations`：**
  ```yaml
relations:
  - "[foo 实体](autoresearch/entities/foo.md)"
  - "[bar 概念](shared/concepts/bar.md)"
  ```
- **Frontmatter `sources`（synthesis 页面）：**
  ```yaml
  sources: [autoresearch/concepts/foo.md, wiki-system/entities/bar.md]
  ```

Agent 直接读写文件时（`read` / `write` / `edit` / `bash` 指令）使用绝对路径 `~/.zoo/wiki/<path>`。

### 写作风格

- **语言：** 正文使用中文，技术术语保留英文原文（如 `config.toml`、`OpenCode`、`hook`、`nudge`）
- **段落：** 短段落为主，每段不超过 5 行
- **列表优先：** 能用列表时优先使用列表而非长段落
- **避免冗余：** 不重复 frontmatter 中已有的信息（如标题、日期）
- **不确定性标记：** 未确认或推测性内容使用 blockquote 标注：
  ```
  > **待确认：** 此行为在 OpenCode 0.5.x 中可能有变化。
  ```
- **代码引用：** 文件路径、函数名、配置项等使用行内代码 `` ` ``
- **内联链接：** 页面正文中首次出现已被其他 wiki 页面定义的概念/实体/分析时，使用内联 Markdown 链接指向该页面。此外，当页面存在多个可通过搜索或目录独立进入的节时，每个节内首次出现该概念也应链接——原则是**每个独立阅读入口至少一个链接入口**。Frontmatter 的 `relations` 字段列出所有关联页面，确保无论从哪开始读都能发现交叉引用

### overview.md 规范

- **类型：** `type: synthesis`，但具有特殊地位
- **性质：** living synthesis（活文档），非 append-only
- **更新策略：** 每次 ingest 后由 kiwi 判断是否需要重写，而非追加
- **内容范围：** 覆盖整个项目的知识，是其他 wiki 页面的精华提炼
- **格式：** 遵循 synthesis 页面模板，但不需要 `sources` 字段（自动从 wiki 中汇总）

---

## 页面模板

每种页面类型有对应的模板文件位于 `~/.zoo/wiki/templates/`，由 `zwiki page create` 命令
用于创建骨架页面。kiwi 在创建新页面时应使用脚本生成骨架，然后 `edit` 填充内容。

| 类型 | 模板文件 | 用途 |
|------|---------|------|
| concept | `~/.zoo/wiki/templates/concept.md` | 概念页面：定义和解释领域概念、术语、抽象机制 |
| entity | `~/.zoo/wiki/templates/entity.md` | 实体页面：具体的模块、类、文件、角色、组件 |
| source | `~/.zoo/wiki/templates/source.md` | 源摘要页面：对原始材料的摘要 |
| analysis | `~/.zoo/wiki/templates/analysis.md` | 分析页面：方案对比、利弊权衡 |
| synthesis | `~/.zoo/wiki/templates/synthesis.md` | 合成页面：对 query 的结构化回答 |

创建新页面时使用 `zwiki page create` 生成骨架，然后 `edit` 填充内容。**禁止手动创建页面**以保证格式一致性。用法见 `zwiki page create --help`。

---

## 索引与日志

### index.md 格式

`~/.zoo/wiki/index.md` 是 wiki 的入口索引。根目录 index.md 以 `#` 一级标题列出所有领域（wiki 根下的子目录，每个子目录是一个域）和 overview.md 的条目，每条指向领域子目录的 `index.md` 或页面。团队可通过在 wiki 根下新建子目录来增加域。

各领域子目录也可有自己的 `index.md`，实现渐进式披露——读者从根 index 进入领域，再通过领域 index 找到具体页面。

格式规范（OKF §6）：

```markdown
# <领域标题>

## <分类标题>

* [页面标题](相对路径.md) - 一行摘要（不超过 30 字）
* [页面标题](相对路径.md) - 一行摘要（不超过 30 字）
```

条目格式：
- 使用星号 `*` 作为列表标记
- 链接路径相对该 index.md 所在目录
- 摘要与链接之间用 ` - `（空格 + 连字符 + 空格）分隔
- 条目按主题相关性排列（非按时间）

### 日志格式（logs/ 目录）

变更日志按月份分割存储在 `~/.zoo/wiki/logs/YYYY-MM.md` 文件中（如 `logs/2026-06.md`），每个文件是一个独立月份的追加式变更日志（OKF §7），记录该月内所有 wiki 页面的增删改和运维检查事件。

格式规范（每个 `logs/YYYY-MM.md` 文件内部）：

```markdown
# 目录更新日志

## YYYY-MM-DD

* **<动词>**: <路径> — <说明>
* **<动词>**: <路径> — <说明>
```

其中：

- 标题：以 `# 目录更新日志` 开头
- 日期分组：`## YYYY-MM-DD` 二级标题，按时间倒序排列（最新在前）
- 条目：`* **动词**: 路径 — 说明`，每条占一行
- `<动词>`：`创建` / `编辑` / `通过` / `失败`，对应旧格式的 `action` 字段
- `<路径>`：被操作对象的路径，相对 wiki 根目录（含 wiki 页面与 `raw/` 原始源材料）。非文件事件写 `—`
- `<说明>`：简短说明（不超过 60 字）

示例：

```
## 2026-06-17

* **创建**: autoresearch/concepts/autonomous-experiment-loop.md — 自主实验循环核心概念
* **编辑**: overview.md — 更新知识版图与外部参考
```

日志按时间倒序排列，最新记录在最上方。查询日志时应读取当前月份及目标时间段对应的 `logs/YYYY-MM.md` 文件。

---

> **操作工作流（ingest / query）** 由 `wiki-ingest` skill 和 `kiwi` prompt 定义。SCHEMA.md 仅覆盖格式规范。执行写入前请阅读对应 skill 或 agent prompt。
