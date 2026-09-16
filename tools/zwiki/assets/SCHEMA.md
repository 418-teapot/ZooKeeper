# Wiki Schema

> 本文件内嵌于 zwiki，是 wiki 页面格式的唯一权威引用。安装 bundle 时由 zwiki 物化到 store 根 `~/.zoo/wiki/SCHEMA.md`；也可随时运行 `zwiki schema` 查看。Ingest 和 query 流程中所有页面生成、格式化、命名、交叉引用操作均须遵循本文件的规定。

---

## 两个概念：bundle 与 store

- **bundle 源**：一个含 `bundle.toml` 的目录，是知识的唯一可写形态。可以放在任何位置，纳入 git 管理、打包分发。
- **store**：`~/.zoo/wiki/`，已安装 bundle 的只读聚合视图，含 `zwiki.lock`（登记表）、`index.md` 与 `SCHEMA.md`（均由 zwiki 生成）。store 不直接写入；写入走 bundle 源，随后 `zwiki bundle install` 同步。

## bundle 目录结构

```
<bundle 源>/
├── bundle.toml            # bundle 清单（name / version / description）
├── index.md               # 根索引（frontmatter 手工、正文生成）
├── logs/                  # 按月变更日志（logs/YYYY-MM.md，zwiki 自动写入）
├── raw/                   # 原始源材料（不可变，LLM 只读，不在索引中）
└── <domain>/              # 领域目录，可多个
    ├── index.md           # 领域索引（frontmatter 手工、正文生成）
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
- **源更新时：** 不覆盖旧版本，以新文件名追加
- **LLM 行为：** 只读。蒸馏 agent 应读取 `raw/` 下对应的原文进行蒸馏，而非依赖 `sources/` 摘要

---

## 页面格式约定

### Frontmatter

每个 wiki 页面必须以 YAML frontmatter 开头，包含以下字段：

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `title` | 是 | string | 页面标题，中文为主 |
| `type` | 是 | string | 页面类型：`concept` / `entity` / `source` / `analysis` / `synthesis` |
| `description` | 否 | string | 一句话摘要，用于各级索引条目 |
| `timestamp` | 否 | string | 最后更新日期时间，格式 `YYYY-MM-DDTHH:mm:ssZ` |
| `resource` | 否 | string | 外部资产 URI |
| `sources` | 否 | string[] | 参考的源文档标识列表（用于 analysis / synthesis 类型） |
| `tags` | 是 | string[] | 标签列表，如 `[permission, config]` |
| `status` | 是 | string | 状态：`draft` / `review` / `stable` / `deprecated` |
| `last_validated` | 是 | string | 验证时间，ISO 8601 datetime，区别于 timestamp（编辑≠验证） |
| `timeliness` | 是 | string | 时效性标记：`current` / `stale`（仅两档，新页面默认 current） |
| `supersedes` | 否 | object[] | 取代关系：本页推翻哪些页面，每项含 `path`（相对 bundle 根目录）和 `reason` |
| `superseded_by` | 否 | object[] | 被取代关系：本页被哪些页面推翻，每项含 `path` 和 `reason` |
| `contradictions` | 否 | object[] | 矛盾记录，每项含 `path`（冲突页面路径）、`claims`（冲突声明列表）、`detected`（发现日期）、`resolution`（`unresolved` 或具体解决说明） |
| `freshness_days` | 否 | integer | 时效阈值覆写（天数），默认 180 天，`source` 类型永不过期 |

示例：

```yaml
---
title: 权限系统
description: 基于 deny 列表的权限判定模型。
type: concept
timestamp: 2026-06-17T00:00:00Z
tags: [permission, security]
status: stable
last_validated: 2026-06-19T00:00:00Z
timeliness: current
# 以下为可选字段
supersedes:
  - path: security/concepts/old-permission.md
    reason: "新设计覆盖了旧的权限模型"
contradictions:
  - path: security/concepts/auth-model.md
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
- **唯一性：** 同一 `<domain>/<type>/` 下文件名唯一。不同 `<domain>/<type>/` 之间可以重名

### 路径与交叉引用规则

页面路径一律**相对所在 bundle 的根目录**、带域前缀（如 `<domain>/concepts/foo.md`），不带 store 或源目录前缀。页面间的关联通过正文内联链接表达，`zwiki check` 按需从正文派生关联关系；Backlinks 节由 `zwiki check` 自动维护：

- **内联链接：**
  ```
  [自主实验循环](research/concepts/experiment-loop.md)
  [train.py](research/entities/train-py.md)
  ```
- **Frontmatter `sources`（synthesis 页面）：**
  ```yaml
  sources: [research/concepts/foo.md, design/entities/bar.md]
  ```

读取页面时从 store 访问：`~/.zoo/wiki/<bundle>/<domain>/...`；写入一律通过 zwiki 写命令并显式指定 `--root <bundle 源>`，不直接编辑 store 内文件。

### 写作风格

- **语言：** 正文使用中文，技术术语保留英文原文（如 `config.toml`、`hook`、`nudge`）
- **段落：** 短段落为主，每段不超过 5 行
- **列表优先：** 能用列表时优先使用列表而非长段落
- **避免冗余：** 不重复 frontmatter 中已有的信息（如标题、日期）
- **不确定性标记：** 未确认或推测性内容使用 blockquote 标注：
  ```
  > **待确认：** 此行为在新版本中可能有变化。
  ```
- **代码引用：** 文件路径、函数名、配置项等使用行内代码 `` ` ``
- **内联链接：** 页面正文中首次出现已被其他 wiki 页面定义的概念/实体/分析时，使用内联 Markdown 链接指向该页面。此外，当页面存在多个可通过搜索或目录独立进入的节时，每个节内首次出现该概念也应链接——原则是**每个独立阅读入口至少一个链接入口**
- **链接句式：** 内联链接必须作为句子成分（主语、宾语或定语），句子本身须传递目标页面的相关信息；禁止把裸指针钉在句尾或括号里。反例：「……评估闭环见[X]」「（见[X]）」——读者不点链接就不知道为何相关。正例：让链接页成为句子主语并说明它贡献了什么，如「[X]展开了工具边界、响应格式和评估闭环」「……——[X]将这些维度展开为评分 rubric」

### overview.md 规范

- **类型：** `type: synthesis`，但具有特殊地位
- **性质：** living synthesis（活文档），非 append-only
- **更新策略：** 每次 ingest 后由蒸馏 agent 判断是否需要重写，而非追加
- **内容范围：** 覆盖整个 bundle 的知识，是其他页面的精华提炼
- **格式：** 遵循 synthesis 页面结构（见 `zwiki template synthesis`），但不需要 `sources` 字段

---

## 页面模板

五种页面类型的骨架模板内嵌于 zwiki。创建页面用 `zwiki page create` 生成骨架再填充内容；查看某类型的模板运行 `zwiki template <type>`。

| 类型 | 用途 |
|------|------|
| concept | 概念页面：定义和解释领域概念、术语、抽象机制 |
| entity | 实体页面：具体的模块、类、文件、角色、组件 |
| source | 源摘要页面：对原始材料的摘要 |
| analysis | 分析页面：方案对比、利弊权衡 |
| synthesis | 合成页面：对 query 的结构化回答 |

**禁止手动创建页面文件**以保证格式一致性。用法见 `zwiki page create --help`。

---

## 索引与日志

### index.md 格式

各级 index.md 的 **frontmatter 手工维护**（`title`、可选 `description`），**正文由 zwiki 自动生成**，勿手工编辑：域 index 按类型分节列出本域页面（条目附页面的 `description`），根 index 列出所有域（条目附域 index 的 `description`），store 根的 index.md 列出已安装 bundle（条目附 bundle.toml 的 `description`）。`page create`/`page move` 即时更新受影响的域 index；`zwiki check` 重新生成全部索引。

### 日志格式（logs/ 目录）

变更日志按月份分割存储在 `logs/YYYY-MM.md` 文件中，每个文件是一个独立月份的追加式变更日志。日志条目由 zwiki 写命令（`page create`/`page set`/`page move` 等）自动追加，需要说明时在命令上加 `--note`，不手工编辑日志文件。

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
- `<动词>`：`创建` / `编辑` / `移动`
- `<路径>`：被操作对象的路径，相对 bundle 根目录。非文件事件写 `—`
- `<说明>`：简短说明，来自写命令的 `--note`，按原文完整记录

示例：

```
## 2026-06-17

* **创建**: research/concepts/experiment-loop.md — 自主实验循环核心概念
* **编辑**: overview.md — 更新知识版图与外部参考
```

查询日志时读取当前月份及目标时间段对应的 `logs/YYYY-MM.md` 文件。

---

> **操作工作流（ingest / query）** 由 `wiki-ingest` skill 和 `kiwi` prompt 定义。本文件仅覆盖格式规范。执行写入前请阅读对应 skill 或 agent prompt。
