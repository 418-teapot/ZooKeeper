# Wiki Schema

> 本文件位于 `~/.zoo/wiki/SCHEMA.md`（软链接到 ZooKeeper 插件源目录）。
> 它是 LLM Wiki 系统的唯一权威引用。Ingest 和 query 流程中所有页面生成、格式化、命名、交叉引用操作均须遵循本 schema 的规定。LLM 在读取或写入 wiki 前应先阅读此文件。

---

## 目录结构

```
wiki/
├── index.md               # 索引目录，按类别列出所有页面
├── log.md                 # 变更日志，append-only，grep-parseable
├── overview.md            # 项目知识概览，living synthesis
├── SCHEMA.md              # 本文件，schema 定义
├── concepts/              # 概念页面：项目中的领域概念、术语、抽象
├── entities/              # 实体页面：具体的模块、类、文件、角色
├── sources/               # 源文档：原始材料的摘要与引用
│   ├── adr/               # Architecture Decision Records
│   ├── rfc/               # RFC / 设计文档
│   └── notes/             # 会议纪要、调研笔记
├── analysis/              # 分析页面：方案对比、利弊权衡
└── syntheses/             # 合成页面：对 query 的结构化回答
```

每个子目录下的文件使用 `.md` 扩展名。空目录含 `.gitkeep` 以纳入版本控制。

---

## 页面格式约定

### Frontmatter

每个 wiki 页面必须以 YAML frontmatter 开头，包含以下字段：

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `title` | 是 | string | 页面标题，中文为主 |
| `type` | 是 | string | 页面类型：`concept` / `entity` / `source` / `analysis` / `synthesis` |
| `created` | 是 | string | 创建日期，格式 `YYYY-MM-DD` |
| `updated` | 是 | string | 最后更新日期，格式 `YYYY-MM-DD` |
| `source` | 否 | string | 来源标识（主要用于 source 类型，如 `adr-001`、`rfc-auth`） |
| `sources` | 否 | string[] | 参考的源文档标识列表（用于 analysis / synthesis 类型） |
| `tags` | 是 | string[] | 标签列表，如 `[permission, config]` |
| `related` | 否 | string[] | 相关 wiki 页面路径列表（相对 wiki 根目录），如 `["concepts/permission.md"]` |
| `status` | 是 | string | 状态：`draft` / `review` / `stable` / `deprecated` |

示例：

```yaml
---
title: 权限系统
type: concept
created: 2026-06-17
updated: 2026-06-17
tags: [permission, security]
related:
  - entities/install-py.md
  - concepts/deny-list.md
status: stable
---
```

### 节结构

所有页面遵循统一的五段式结构（非必需段落可省略）：

1. **Overview** — 一句话概括和一节概述（blockquote），说明该页面回答的核心问题
2. **Details** — 详细展开，可使用二级/三级标题细分
3. **Relations** — 与本页面相关的其他 wiki 页面列表，含简要关联说明
4. **References** — 引用来源（外部链接、代码路径、文档路径）
5. **Notes** — 补充说明、待确认事项、边缘情况

每个段落用 `##` 二级标题开始。

### 命名规则

- **格式：** 全小写 kebab-case，如 `permission-system.md`、`deny-list.md`
- **禁止：** 数字前缀（如 `01-permission.md`）、空格、大写字母
- **语言：** 文件名必须是英文 kebab-case，禁止中文或非 ASCII 字符。中文标题需要用英文翻译或缩写作为文件名
- **唯一性：** 同一 type 下文件名唯一。不同 type 之间可以重名（如 `concepts/plugin.md` 和 `entities/plugin.md` 含义不同）

### 路径与交叉引用规则

本页内交叉引用（Markdown 链接、frontmatter `related`/`sources`、log.md 的 `<path>` 字段）一律**相对 wiki 根目录**，不带 `wiki/` 或 `~/.zoo/wiki/` 前缀：

- **内联链接：**
  ```
  [权限系统](concepts/permission.md)
  [构建脚本](entities/build-script.md)
  ```
- **Frontmatter `related`：**
  ```yaml
  related: [entities/install-py.md, concepts/deny-list.md]
  ```
- **Frontmatter `sources`（synthesis 页面）：**
  ```yaml
  sources: [concepts/foo.md, entities/bar.md]
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

### overview.md 规范

- **类型：** `type: synthesis`，但具有特殊地位
- **性质：** living synthesis（活文档），非 append-only
- **更新策略：** 每次 ingest 后由 kiwi 判断是否需要重写，而非追加
- **内容范围：** 覆盖整个项目的知识，是其他 wiki 页面的精华提炼
- **格式：** 遵循 synthesis 页面模板，但不需要 `sources` 字段（自动从 wiki 中汇总）

---

## 页面模板

每种页面类型有对应的模板文件位于 `~/.zoo/wiki/templates/`，由 `new_page.py` 脚本
用于创建骨架页面。kiwi 在创建新页面时应使用脚本生成骨架，然后 `edit` 填充内容。

| 类型 | 模板文件 | 用途 |
|------|---------|------|
| concept | `~/.zoo/wiki/templates/concept.md` | 概念页面：定义和解释领域概念、术语、抽象机制 |
| entity | `~/.zoo/wiki/templates/entity.md` | 实体页面：具体的模块、类、文件、角色、组件 |
| source | `~/.zoo/wiki/templates/source.md` | 源摘要页面：对原始材料的摘要 |
| analysis | `~/.zoo/wiki/templates/analysis.md` | 分析页面：方案对比、利弊权衡 |
| synthesis | `~/.zoo/wiki/templates/synthesis.md` | 合成页面：对 query 的结构化回答 |

创建新页面的命令：

```
python3 ~/.zoo/wiki/tools/new_page.py \
    --type <concept|entity|source|analysis|synthesis> \
    --title "<页面标题>"
```

对于 source 类型，额外指定 `--source-type`：

```
python3 ~/.zoo/wiki/tools/new_page.py \
    --type source \
    --title "<页面标题>" \
    --source-type <adr|rfc|notes>
```

脚本会从模板生成带完整 frontmatter 和骨架节的页面，kiwi 只需 `edit` 填充
各节的实际内容。不要在未使用脚本的情况下手动创建页面，以保证格式一致性。

---

## 索引与日志

### index.md 格式

`~/.zoo/wiki/index.md` 是 wiki 的入口索引，按以下格式组织：

```markdown
## <Category>（<中文名称>）

- [页面标题](type/page.md) — 单行摘要（不超过 30 字）
- [页面标题](type/page.md) — 单行摘要（不超过 30 字）
```

分类与目录的对应关系：

| index 分类 | 对应目录 | type 值 |
|------------|----------|---------|
| Concepts | `concepts/` | `concept` |
| Entities | `entities/` | `entity` |
| Sources → ADR | `sources/adr/` | `source` |
| Sources → RFC | `sources/rfc/` | `source` |
| Sources → Notes | `sources/notes/` | `source` |
| Analysis | `analysis/` | `analysis` |
| Syntheses | `syntheses/` | `synthesis` |

同一分类下的条目按添加时间倒序排列（最新在最上）。

### log.md 格式

`~/.zoo/wiki/log.md` 是追加式变更日志，记录所有 wiki 页面的增删改和运维检查事件。

每条记录是一个 Markdown 二级标题，格式如下：

```
## [<YYYY-MM-DD>] <op> | <path> | <action> — <note>
```

其中：

- `<op>`：**触发操作**，即触发本次变更的上游流程。取值 `ingest` / `query` / `update` / `delete` / `health` / `lint` / `heal` / `refresh`
- `<path>`：页面路径，相对 wiki 根目录（不带 `wiki/` 前缀），如 `concepts/permission.md`。非页面事件写 `—`
- `<action>`：**变更结果**，即对页面的实际操作。取值 `create` / `edit` / `delete` / `pass` / `fail`
- `<note>`：简短说明（不超过 60 字）

示例：

```
## [2026-06-17] ingest | concepts/prompt-injection.md | create — 摘要来自 ADR-003
## [2026-06-17] ingest | entities/install-py.md | create — 来自 install.py 分析
## [2026-06-18] update | concepts/prompt-injection.md | edit — 补充 Phase 2 实施方案
## [2026-06-19] query | syntheses/linter-comparison.md | create — 来自 "which linter" 问答
## [2026-06-16] health | — | pass — 所有检查通过，无 orphan/missing
```

日志按时间倒序排列，最新记录在最上方。可使用以下命令快速查看最近操作：

```bash
grep "^## \[" ~/.zoo/wiki/log.md | head -5
```

---

## 操作工作流

### Ingest 工作流（kiwi 负责）

1. **读取 SCHEMA.md** — 确认格式规范
2. **更新 index.md** — 按分类添加新页面条目
3. **追加 log.md** — 记录 ingest 操作（`ingest | <path> | create/edit`）
4. **判断 overview.md** — 如果新知识显著改变项目概览，重写 overview.md
5. **跨页关联更新** — 在新页面中添加 `related` 引用到已有页面

### Query 工作流（kiwi 负责）

1. **读取 SCHEMA.md** — 确认格式规范
2. **读取 index.md** — 确定哪些页面可能包含相关信息
3. **读取相关页面** — 根据 index 和 cross-reference 导航
4. **生成 synthesis** — 创建 `syntheses/<query-slug>.md` 作为回答
5. **更新 index.md** — 在 Syntheses 分类下添加条目
6. **追加 log.md** — 记录 synthesis 的创建
