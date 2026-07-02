# ZooKeeper Wiki — 终极设计文档

**版本:** 3.0（统一版）
**日期:** 2026-07-01
**状态:** 活动设计文档 — 单一权威版本，对齐当前实现并规划后续路线

---

## 目录

1. [本文档的定位](#1-本文档的定位)
2. [现状基线：已实现 vs 仅设计](#2-现状基线已实现-vs-仅设计)
3. [核心设计哲学](#3-核心设计哲学)
4. [目标架构总览](#4-目标架构总览)
5. [数据模型与格式规范](#5-数据模型与格式规范)
6. [kiwi：只读蒸馏专家](#6-kiwi只读蒸馏专家)
7. [Ingest 工作流](#7-ingest-工作流)
8. [Query 工作流](#8-query-工作流)
9. [知识生命周期](#9-知识生命周期)
10. [数据检索](#10-数据检索)
11. [自动化策略](#11-自动化策略)
12. [zwiki 统一 CLI](#12-zwiki-统一-cli)
13. [大规模摄入与增量同步](#13-大规模摄入与增量同步)
14. [协同四层架构](#14-协同四层架构)
15. [注入机制](#15-注入机制)
16. [统一实施路线图](#16-统一实施路线图)
17. [设计取舍总表](#17-设计取舍总表)
18. [参考资料](#18-参考资料)

---

## 1. 本文档的定位

**要解决的问题：** 每次对话都会重新发现项目架构、约定、集成方式——这些知识在会话结束后丢失，下一个会话从零开始。wiki 系统把这些知识编译成结构化页面持久化，agent 查询时读 wiki 而非重新推导，好的查询答案再归档回 wiki 形成累积增长。

本文是 ZooKeeper Wiki 系统的**单一权威设计文档**，覆盖基础架构（目录、SCHEMA、kiwi、ingest/query、注入、模板）、知识生命周期、检索级联、自动化、zwiki CLI、大规模摄入、协同四层架构（L0 单机 → L1 覆盖 → L2 git → L3 联邦）。

§2 现状基线是事实锚点——明确区分"已实现"与"目标"。任何与代码冲突的设计声明以代码为准并回写本文档。

---

## 2. 现状基线：已实现 vs 仅设计

> 本节是整篇文档的事实锚点。任何与代码冲突的设计声明以此为准。

### 2.1 已实现（Layer 0 完整运转）

| 组件 | 实现形态 | 位置 |
|------|---------|------|
| wiki 目录结构 | **域优先**（`autoresearch/`、`wiki-system/`、`shared/`），每域含 `concepts/`/`entities/`/`sources/`/`analysis/`/`syntheses/` 子目录 + 独立 `index.md`（OKF §6 渐进式披露） | `wiki/` |
| index.md / log.md 格式 | **已对齐 OKF §6/§7**：index 用 `#` 一级标题 + `* [title](path) - desc`；log 用 `# 目录更新日志` + `## YYYY-MM-DD` + `* **动词**: path — note` | `wiki/index.md`、`wiki/log.md` |
| 页面模板 | 5 个模板（concept/entity/source/analysis/synthesis） | `wiki/templates/` |
| SCHEMA.md | **已全面对齐 OKF**：内容页面字段集 + index/log 格式 + 域优先目录结构规范 | `wiki/SCHEMA.md` |
| `okf_version` 标记 | 仅在 `index.md` frontmatter ✅（OKF §11 唯一允许 frontmatter 的位置） | `wiki/index.md` |
| 实际页面前置元数据 | 一致使用 `title`/`type`/`description`/`timestamp`/`tags`/`relations`/`status`，source 页用 `resource`，analysis/synthesis 用 `sources`（复数） | 抽查 wiki/autoresearch、wiki-system、shared 全部对齐 |
| zwiki CLI | **Rust 实现**，含 7 个子命令：`check`、`backlinks`、`log`、`page`、`property`、`create`（含 `--domain` 自动建域骨架） | `tools/zwiki/`（构建产物 `tools/bin/zwiki`） |
| 健康检查 | `zwiki check` 内含：empty files、index sync（递归 + indexed_anywhere 跨层豁免）、log coverage、frontmatter、relations field、**relations-body consistency（双向，error 级）**、source field、missing/duplicate inline links | `tools/zwiki/src/health.rs` |
| Lint 检查 | `zwiki check` 内含：broken links、orphan pages、sparse pages、**stale pages**（`timestamp` 超 90 天且非 deprecated） | `tools/zwiki/src/lint.rs` |
| `--save` / `--ci` / `--diff` | check 子命令支持 `--save`（写 health-report.md）、`--ci`（按阈值退出码）、`--diff`（git diff 检查） | `tools/zwiki/src/main.rs` |
| wiki-ingest skill | 4 阶段（Phase 0 分类 → Phase 1 委派 kiwi → Phase 2 通用写入 → Phase 3 验证） | `core/skills/wiki-ingest/SKILL.md` |
| wiki-query skill | 6 阶段（Phase 0 判断问题类型 → 1 读 index → 2 读页面 → 3 合成 → 4 判断归档 → 5 呈现） | `core/skills/wiki-query/SKILL.md` |
| kiwi agent | subagent，prompt 在 `src/agents/kiwi.ts`，明确"read-only"，5 阶段工作流 + QualityGate | `src/agents/kiwi.ts` |
| kiwi 权限 | `task=deny`、`edit=deny`、`skill "*"=deny`；用 `ZOO_MEDIUM_MODEL` | `config.toml` |

### 2.2 未实现（目标）

| 组件 | 当前状态 |
|------|---------|
| SCHEMA 自动注入到 agent prompt | **未实现**。`src/index.ts` config hook 只做 `injectAgentPrompts` + `registerSkills`，无 SCHEMA 读取/注入 |
| `last_validated` / `timeliness` / `supersedes` / `superseded_by` / `contradictions` / `freshness_days` 字段 | **字段已定义**。SCHEMA.md 已声明六字段；`last_validated`/`timeliness` 必选（含枚举校验），其余可选；28 现有页面已回填。stale 自动标记（`zwiki check --apply`）、三级短路、对账等逻辑属 P0 项 2/3，仍未实现 |
| `lint --apply` 自动标记 stale | **未实现**。stale 检测存在但仅报告，不自动标记 |
| 三阶段级联检索（index → tag → grep） | **未实现**。wiki-query skill 仍是 index.md 单路径 + grep 提示 |
| `zwiki search` / `move` / `ingest --idempotent` 子命令 | **部分实现**。`zwiki search` 已实现（rg 候选预筛 + 进程内 fallback，四级评分 title/tag/heading/body，`--type`/`--tag`/`--domain` 过滤）；`move`/`ingest --idempotent` 仍未实现 |
| 四阶段分块蒸馏（大规模摄入） | **未实现** |
| 六步增量同步 | **未实现** |
| 协同 Layer 1（personal/.org/.teams/.upstream 五级覆盖） | **未实现**。无任何分层目录、无 `teams.toml` |
| 协同 Layer 2（git 多 repo / sync / propose / log 分月） | **未实现** |
| 协同 Layer 3（bundle.toml / publish / install / @name/path） | **未实现** |
| `zwiki promote` / `consensus` / `bundle` / `sync` / `propose` 子命令 | **未实现** |

---

## 3. 核心设计哲学

三条贯穿全文的哲学，所有设计决策都从它们推导：

### 3.1 文件即协议
不引入数据库、不部署服务、不依赖外部平台。文件系统 + git + OKF 格式本身就是协议：
- L0 的文件路径就是协议——agent 解析 `~/.zoo/wiki/` 即得
- L1 的目录名就是协议——`personal/` > `.org/` > `.teams/<name>/` > `.upstream/` 优先级隐含在查询逻辑中
- L2 的 `teams.toml` + git remote 就是协议
- L3 的 `bundle.toml` 就是协议

### 3.2 机械活自动、判断活留人
画一条清晰的线，决定什么自动化、什么不：
- 确定性计算（时间戳比较、backlinks 重算、frontmatter 校验）→ 全自动（`--apply`/`--fix`）
- 语义判断（supersede、矛盾裁决、级联标记）→ LLM 提议 + 人确认
- **LLM 不能既当运动员又当裁判**——矛盾只发现不裁决，supersede 不自动应用

### 3.3 诚实的知识库，而非自治的知识库
不追求"人类只用不管"的 L5 自治。相反：
- 知道哪里不确定就标注不确定
- 知道哪里矛盾就呈现矛盾
- 完整仪表盘（lint/health/coverage 全可审计）+ 辅助驾驶（L2）
- 拒绝置信度浮点数（伪精度）、拒绝艾宾浩斯遗忘曲线（人类模型不适用文件）、拒绝全自动自我修复

---

## 4. 目标架构总览

```
┌────────────────────────────────────────────────────────────┐
│  Layer 3: OKF Bundle 联邦                                  │
│  bundle.toml → publish → install → @name/path              │
│  跨组织、跨项目知识分发；分层联邦拓扑                      │
├────────────────────────────────────────────────────────────┤
│  Layer 2: Git 团队同步                                     │
│  teams.toml → 多 repo → push/pull → PR/CI 门禁             │
├────────────────────────────────────────────────────────────┤
│  Layer 1: 分层覆盖（Overlay）                              │
│  personal/ → .org/ → .teams/<name>/ → .upstream/           │
│  五级查询级联，team role 决定冲突行为                      │
├────────────────────────────────────────────────────────────┤
│  Layer 0: 本地单机（当前实现）                             │
│  ~/.zoo/wiki/ → zwiki CLI → SCHEMA 注入 → kiwi 蒸馏        │
└────────────────────────────────────────────────────────────┘
```

四层**向下兼容**：L0 用户完全不感知上层存在；L1 不要求 git；L2 不要求 bundle；每层独立部署。

### 4.1 各层职责与边界

| 层 | 用户规模 | 数据流向 | 延迟 | 当前状态 |
|----|---------|---------|------|---------|
| L0 | 1 人 | 本地读写 | 即时 | ✅ 已实现 |
| L1 | 1-N 人试错 | 本地级联（五级） | 即时 | ⬜ 设计完成，未实现 |
| L2 | 2-20 人 | git push/pull | 分钟级 | ⬜ 设计完成，未实现 |
| L3 | 任意 | bundle publish/install | 小时级 | ⬜ 设计完成，未实现 |

---

## 5. 数据模型与格式规范

### 5.1 frontmatter 字段（当前 L0 实现）

所有 wiki 页面以 YAML frontmatter 开头。当前 SCHEMA.md 定义的字段集：

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `title` | 是 | string | 页面标题 |
| `type` | 是 | enum | `concept` / `entity` / `source` / `analysis` / `synthesis` |
| `description` | 否（推荐） | string | OKF 对齐；一句话摘要，用于检索排序 |
| `timestamp` | 是（代码强制） | ISO 8601 datetime | OKF 对齐；格式 `YYYY-MM-DDTHH:mm:ssZ`，未知时间默认 `T00:00:00Z`。"last meaningful change" |
| `resource` | 否 | string | 仅 `type: source`；外部资产 URI（URL 或 raw 路径） |
| `sources` | 否 | string[] | 仅 `analysis`/`synthesis`；引用的内部 source slug 列表 |
| `tags` | 是 | string[] | 自由标签，用于检索过滤 |
| `relations` | 否 | string[] | 关联页面（wiki-root-relative 路径） |
| `status` | 是 | enum | `draft` / `review` / `stable` / `deprecated` |

**命名事故已修正：** `resource`（单数，页面描述的外部对象）与 `sources`（复数，页面引用的内部材料）是两个独立概念，不再撞名。`created`/`updated`/`source`（单数旧名）已从 schema 移除。

### 5.2 OKF 对齐状态

当前实现已是 OKF v0.1 超集合规——内容页面和保留文件（`index.md` / `log.md`）均已对齐。域优先目录结构已迁移完成，各领域含独立 `index.md`（OKF §6 渐进式披露）。

#### 5.2.1 内容页面 — 已合规

OKF v0.1 §9 一致性三要求：
1. 每个非保留 `.md` 含可解析 YAML frontmatter ✅
2. 每个 frontmatter 含非空 `type`（五值枚举，OKF type 的有效子集）✅
3. 保留文件名遵循 §6/§7 结构 — ✅ **已合规**

扩展字段（`status`/`relations`/`sources` 复数/`description`/`resource`/`tags`）均为 OKF §4.1 允许的扩展。`okf_version: "0.1"` 标记在 `index.md` frontmatter ✅（§11 唯一允许 frontmatter 的位置）。

#### 5.2.2 index.md — 已合规

**OKF §6 规定：**
- 无 frontmatter（唯一例外：根 index.md 可含 `okf_version`，我们已满足）
- 正文用 `#` 一级标题作为章节/组标题
- 条目格式：`* [标题](相对路径) - 描述`（连字符 `-` 分隔标题与描述）
- 条目应包含目标概念的 `description` frontmatter 字段
- 推荐使用以 `/` 开头的 bundle-relative 链接（`/concepts/foo.md`）

**当前实现（`wiki/index.md` + 各领域 `index.md`）：**
- ✅ 根 index.md 含 `okf_version: "0.1"` frontmatter
- ✅ 用 `#` 一级标题作为领域标题
- ✅ 条目用 `* [标题](path) - 描述`（连字符 `-` 分隔）
- ✅ 各领域子目录有独立 `index.md`，实现渐进式披露
- ⚠️ 用相对路径 `concepts/foo.md`（OKF 推荐但非强制 `/concepts/foo.md`；两种均合法）

**排序规则：** 同一章节内条目按**主题相关性**排列（最相关的在前），不按字母或日期——agent 扫索引时优先看到最可能相关的条目。

#### 5.2.3 log.md — 已合规

**OKF §7 规定：**
- 文件以一个 `#` 一级标题开头（如 `# 目录更新日志`）
- 无 frontmatter
- 按日期分组，使用 `## YYYY-MM-DD` 二级标题（**ISO 8601 日期格式是强制要求**）
- 最新日期在前
- 每条目为自由散文，以 `* ` 开头；开头的粗体词（`**更新**`、`**创建**`、`**弃用**` 等）是约定而非要求

**当前实现（`wiki/log.md`）：** ✅ **已对齐 OKF §7**：
- ✅ 以 `# 目录更新日志` 一级标题开头
- ✅ 无 frontmatter
- ✅ 按日期分组 `## YYYY-MM-DD`，最新在前
- ✅ 条目格式 `* **<中文动词>**: <path> — <note>`
- ✅ `zwiki log` 的 `--op/--path/--action/--note` 接口保留，`--action` 映射为中文动词（create→创建，edit→编辑，pass→通过，fail→失败）
- ✅ 解析器向后兼容旧格式（`## [date] ...` 单行），写入器只产新格式

#### 5.2.4 目录结构 — 域优先（已迁移）

**OKF §6 关键能力：** `index.md` 可出现在**任意目录**，支持**渐进式披露**——agent 逐层深入，每层只面对少量条目。这天然倾向**域优先**结构。

**当前实现（域优先，已完成）：**
```
wiki/
├── index.md                    ← 根索引：只列领域 + overview.md
├── overview.md                 ← 项目知识概览（living synthesis）
├── autoresearch/               ← 领域：自主 LLM 训练实验
│   ├── index.md                ← 领域索引：仅列本领域条目
│   ├── concepts/
│   │   ├── autonomous-experiment-loop.md
│   │   ├── fixed-time-budget-evaluation.md
│   │   └── ...
│   ├── entities/
│   │   ├── autoresearch-train-py.md
│   │   ├── autoresearch-prepare-py.md
│   │   └── autoresearch-program-md.md
│   ├── analysis/
│   │   └── autoresearch-design-tradeoffs.md
│   └── sources/
│       └── notes/autoresearch.md
├── wiki-system/                ← 领域：wiki 系统自身
│   ├── index.md
│   ├── concepts/
│   │   ├── wiki-ingest-workflow.md
│   │   ├── wiki-health-check.md
│   │   └── ...
│   └── analysis/
│       └── llm-wiki-vs-rag.md
└── shared/                     ← 跨领域共享概念
    ├── index.md
    ├── concepts/
    │   ├── npc.md
    │   ├── simplicity-criterion.md
    │   └── post-hoc-accountability.md
    └── analysis/
        └── agent-skill-plugin-framework.md
```

新增领域只需 `zwiki create --domain <name> ...`，自动创建完整域骨架（concepts/entities/sources/{adr,rfc,notes}/analysis/syntheses + .gitkeep）。域名动态发现，不硬编码。

**为何域优先：**

| 维度 | 类型优先（当前） | 域优先（目标） |
|------|----------------|---------------|
| agent 导航 | 扫全索引找相关条目 | 先选领域 → 领域 index 只 5-10 条 |
| OKF 渐进式披露 | 不利用（单层 index） | 原生支持（每层 subdir 一个 index） |
| 打包分发（L3） | 打包子目录缺领域完整性 | 打包某领域子目录即合法 OKF bundle |
| 跨领域共享概念 | 无区分，混在 concepts/ | `shared/` 下单独管理，两边引用 |

**跨领域共享概念不阻碍域优先**——放 `shared/` 下两边引用即可。域优先不要求概念归属单一域，只要求**索引结构以域为第一级路由**。

**迁移要点（纳入 §16 P0 工作项 `OKF-LOG` 一并执行，见 §16.2）：**
- 现有页面按 `autoresearch-*` / `wiki-*` / 共享三类重归类
- 每个领域子目录新建 `index.md`（OKF §6 格式，无 frontmatter，`#` 一级标题 + `* [title](path) - desc` 条目）
- 根 `index.md` 缩减为领域列表 + `shared/` 条目
- `zwiki` 的 `all_wiki_pages()` / `check_index_sync` 需支持递归子目录 index

**页面类型语义：**
- `sources/` 页面**不可变**——记录"某时某地说过什么"，历史事实不变；新版本以新页面追加，不修改旧页面。
- `overview.md`（若存在）是**活的综合页**（living synthesis）——每次大规模摄入后由 kiwi 判断是否值得**重写**（非追加），是项目级知识快照。kiwi 在蒸馏分析报告里给出重写建议，调用方决定是否执行。
- 交叉引用路径从 `concepts/foo.md` 改为 `autoresearch/concepts/foo.md`（批量 `zwiki move` 可处理，P1 项 13）

### 5.3 目标扩展字段（未实现）

为支持知识生命周期（详见 §9.2），目标 schema 追加以下**全部可选、向后兼容**的字段：

```yaml
last_validated: 2026-06-19T00:00:00Z                    # 验证时间，区别于 timestamp（编辑≠验证）
timeliness: current | stale                             # 派生标记，由 zwiki check --apply 自动写入
supersedes:                                              # 关系：我推翻谁（agent 写入 B）
  - path: autoresearch/concepts/old.md
    reason: "新来源确认此结论已被推翻"
superseded_by:                                           # 关系：我被谁推翻（agent 写入 A）
  - path: autoresearch/concepts/new.md
contradictions:                                          # 矛盾记录
  - page: autoresearch/concepts/other.md
    claims: ["声称 X=1", "声称 X=2"]
    detected: 2026-06-19
    resolution: unresolved
```

**字段说明：**
- `last_validated` + `timeliness`（两档）表达时效性——`timeliness` 由 `now - last_validated > threshold` 派生，`zwiki check --apply` 自动写入 frontmatter 供 agent 一读即知
- `supersedes` / `superseded_by` 表达取代关系——两侧都是 agent 的合法写入入口，zwiki 对账补齐另一侧，保证互为镜像（详见 §9.2）
- `contradictions` 表达矛盾记录
- 不引入 `validation_level` 第三轴（验证层级作为 log.md 元数据，不进 frontmatter）
- 不把 `superseded` / `deprecated` 塞进 `timeliness`——前者由 `superseded_by` 非空表达，后者由 `status: deprecated` 表达

**查询行为（三级短路，详见 §9.2 行为表）：**
```
if status == deprecated:           不出现
elif superseded_by 非空:            不返回结论，指向取代者
elif timeliness == stale:           附"N 天未验证"
elif status == review:              附"未经充分审查"
elif status == draft:               附"草稿状态"
else (stable + current):            直接引用，无免责
```

### 5.4 协同层扩展字段（未实现）

L1 consensus 页面新增：

```yaml
type: synthesis
status: stable
consensus_of:
  - team: core
    version: 2026-06-15
  - team: security
    version: 2026-06-18
resolved: 2026-06-22
```

L2 contributors 字段：

```yaml
contributors:
  - user: alice
    role: author
    since: 2026-01-15
```

### 5.5 页面节结构

正文按以下顺序（可省略不适用的）：
1. **Overview** — 一句话说明本页内容
2. **Details** / **Role** / **Key Points**（按 type 不同）— 主体内容
3. **Backlinks** — 反向链接，由 `zwiki backlinks` 自动维护，勿手编
4. **References** — 外部引用
5. **Notes** — 临时备注、待确认事项（用 `> **待确认：** ...`）

页面关联图由 frontmatter `relations` 字段（Markdown 链接格式 `- "[标题](path.md)"`）单一声明，正文中以内联链接自然呈现；`zwiki check` 强制 `relations` 与正文内联链接双向一致。

### 5.6 命名与交叉引用规则

- 文件名：小写 kebab-case，无序号前缀
- source 页面：`sources/<type>/<short-title>.md`，`<type>` 为 `adr`/`rfc`/`notes`
- 交叉引用用 **wiki 根目录相对路径**（不带 `wiki/` 前缀）：`[text](concepts/foo.md)`
- frontmatter `relations` 用 Markdown 链接格式（YAML 需引号）：`- "[标题](concepts/foo.md)"`，链接文字取目标页 `title`
- L3 引入 `@name/path` 跨命名空间引用（见 §14.4）

### 5.7 写作风格

- 中文撰写，技术术语保留英文
- 段落短小（≤5 句），列表优先
- 同一事实只在一个页面详述，其他交叉引用
- 未确认信息用 `> **待确认：**` 标注

---

## 6. kiwi：只读蒸馏专家

### 6.1 角色定义（已实现）

Kiwi 是**只读知识蒸馏专家**，不是 wiki 管理器。它专注一件事：将非结构化的复杂源材料分析为结构化分析报告，返回给调用方执行写入。

- **触发条件：** 源材料是非结构化、复杂、需要摘要/重写/组织的原始内容（会议记录、设计文档、API 规范），而非简单条目追加
- **不做：** 简单 CRUD（由 zwiki CLI 处理）、日常维护（由 health/lint 处理）
- **叶子节点：** 无 `task` 权限，不能委派
- **只读保证：** `edit=deny`，prompt 明确 "You are read-only. You cannot write files, cannot log operations, and cannot update index files directly"

### 6.2 配置（当前实现）

```toml
[agent.kiwi]
mode  = "subagent"
model = "{env:ZOO_MEDIUM_MODEL}"
[agent.kiwi.permission]
task = "deny"
edit = "deny"
[agent.kiwi.permission.skill]
"*" = "deny"
```

开放 `read`/`glob`/`grep`/`webfetch`/`websearch`/`bash`，与 OMO/SLIM/OMP 的 librarian 能力对齐。

### 6.3 工作流（当前实现，5 阶段 + QualityGate）

| 阶段 | 职责 |
|------|------|
| Phase 0: Resolve Wiki Path and Read SCHEMA | 解析 wiki 路径，读 SCHEMA 确认格式 |
| Phase 1: Load Existing State | 读 index.md + 相关页面，做去重检查 |
| Phase 2: Analyze & Draft | 整体理解源 → 分配密度等级 → 识别知识单元 → 起草页面建议（含 2.1-2.4 子步） |
| Phase 3: Self-Review | 结构/类别/密度/噪声/交叉引用/自删除 六项检查（3.1-3.6） |
| Phase 4: Return Analysis | 返回完整分析报告给调用方，**不执行任何写入** |

### 6.4 只读原则的依据

三个参考项目独立得出相同结论——知识 specialist 必须只读：
- **OMO** Librarian：deny write/edit/apply_patch
- **OMP** Librarian：白名单只放行 7 个工具
- **SLIM** Librarian：deny write/edit/bash/task

OpenCode 框架不支持 OMP 的 `yield`/`shouldTerminate`，无法保证结构化 JSON 输出，故 kiwi 返回自由格式 Markdown 分析报告，由调用方执行写入。职责分离 + 最小权限 + 错误隔离。

---

## 7. Ingest 工作流

### 7.1 双路径设计（已实现于 skill）

```
源材料到达
     │
     ├── 结构化 / 已 wiki 格式化 ──→ 简单路径：任意 agent 直接调
     │                              zwiki create / property / log
     │
     └── 非结构化 / 复杂源材料 ──→ 复杂路径：委派 kiwi 蒸馏
                                     → kiwi 返回分析报告
                                     → 调用方根据分析执行写入
```

无 caller 约束：任何 agent 均可触发 ingest。

### 7.2 简单路径（已实现）

1. `zwiki create --type <type> --title "..."` 生成骨架（source 加 `--source-type`）
2. `write`/`edit` 填充内容（或 `zwiki property` 改单个字段）
3. 更新 `wiki/index.md`
4. `zwiki log --op ingest --path <path> --action create --note "..."`
5. （可选）更新相关页面 `relations` 字段

### 7.3 复杂路径（已实现于 skill）

1. **分类源材料** → 确定目标目录（concept/entity/source/analysis/synthesis）
2. **检查重复** → 读 `wiki/index.md`
3. **准备源材料** → `read`/`webfetch`
4. **构造三段式 prompt**（SUMMARY/CONTEXT/ACCEPTANCE）
5. **委派 kiwi** → `task(subagent="kiwi", prompt=...)`
6. **处理 kiwi 返回** → 调用方用 zwiki CLI + write/edit 执行写入、更新 index、log
7. **验证** → `zwiki check`

### 7.4 大规模摄入（未实现）

当源材料是 8 万行代码的仓库时，单次 ingest 撑爆上下文。目标方案是**四阶段分块蒸馏**：

| 阶段 | 输入 | 产出 | LLM 成本 |
|------|------|------|---------|
| Phase 1: 结构扫描 | 仓库文件系统 | 结构化摘要表（每模块一行：路径/大小/import/注释密度） | 零（纯确定性，AST 解析） |
| Phase 2: 内容地图 | Phase 1 摘要表（~500 行） | 模块分类 + 块划分方案 + 块间关系 | 1 次 LLM |
| Phase 3: 分块蒸馏 | 每块完整源码（~600 行/块） | 各块独立的概念/实体页 + 跨块引用声明 | N 次 LLM，**可并行** |
| Phase 4: 综合编织 | Phase 2 地图 + Phase 3 全部产出 | 匹配声明 → 建立准确 relations → 生成 overview.md + 更新 index.md | 1 次 LLM |

关键设计：Phase 1 纯确定性（借鉴 codemap 模式）；Phase 3 各块独立可并行；Phase 4 只补充关系不重写内容。

### 7.5 增量同步（未实现）

仓库每周变更 ~15% 模块，不全量重蒸馏。六步同步：

| 步 | 名称 | 性质 | 产出 |
|----|------|------|------|
| A | 哈希扫描 | 确定性，零 LLM | changed/unchanged 模块列表 |
| B | 变更量判断 | 确定性 | <10% 走差分(D)，>50% 走全量(E) |
| C | 概念依赖追踪 | 确定性 + 1 次 LLM | 标记 needs_review 页面（不自动改） |
| D | 差分蒸馏 | LLM | 增量操作列表（section + action + suggested_content） |
| E | 全量重蒸馏 | LLM | 新页面覆盖旧页面，保留人工维护节 |
| F | 报告 | — | 扫描/蒸馏/标记/跳过统计 |

始终不自动应用 LLM 的修改——只标记，等审查。

---

## 8. Query 工作流

### 8.1 当前实现（wiki-query skill，6 阶段）

| 阶段 | 职责 |
|------|------|
| Phase 0 | 判断问题类型（是否可能被 wiki 覆盖） |
| Phase 1 | 读 `wiki/index.md` 导航 |
| Phase 2 | 读相关页面（按需递归 `relations`） |
| Phase 3 | 合成答案 |
| Phase 4 | 判断是否归档（结构化走简单路径，复杂走 kiwi） |
| Phase 5 | 呈现答案 |

### 8.2 三阶段级联检索

`zwiki search`（P0 项 7，✅ 已实现）提供全文检索基础：rg 候选预筛 + 进程内 fallback，四级评分（title=4/tag=3/heading=2/body=1），支持 `--type`/`--tag`/`--domain` 过滤。三阶段级联（index → tag → grep 的 fallback 策略，P0 项 5）仍未实现——当前 `zwiki search` 是单层全文搜索，不包含 index.md 优先导航与 tag fallback 层级。目标级联如下：

```
Phase 1: index.md 导航（现有，优先级最高）
  按类别定位 → 读匹配页面 → 沿 relations 递归
  ↓ 如果结果 < 3 个页面

Phase 2: 标签过滤（新增）
  用户问题关键词匹配 frontmatter tags
  title 中的 tag 命中 > 正文中的 tag 命中
  ↓ 如果结果 < 3 个页面

Phase 3: 全文 grep（新增）
  ripgrep 扫全 wiki
  heading 匹配 > 段落匹配
```

排序规则：index 命中 > tag(title) > tag(body) > grep(heading) > grep(paragraph)

`zwiki search` 已实现底层评分（title/tag/heading/body 四级），但级联 fallback 策略（index.md 优先 → tag fallback → grep fallback，结果 < 3 个时逐级降级）属 P0 项 5，尚未实现。rg 通过随包分发安装到 `~/.zoo/tools/bin/`（install.py，后续任务），无 rg 时自动降级为进程内扫描。

### 8.3 远期扩展（按规模触发）

| 规模 | 功能 |
|------|------|
| 现在 | 三阶段级联 |
| > 100 页 | backlinks 反向查询 |
| > 200 页 | 轻量 embedding 向量搜索（不引入外部服务） |
| > 500 页 | RRF 多路径融合 |

---

## 9. 知识生命周期

### 9.1 当前状态

- `status` 字段四态：`draft` → `review` → `stable` → `deprecated` ✅
- stale 检测：`timestamp` 超 90 天且非 `deprecated` ✅（仅报告，不自动标记）
- 缺口：检测但不行动、无取代机制、无矛盾检测、`last_validated` 与 `timestamp` 未分离

### 9.2 目标：状态、时效与取代关系（未实现）

知识的新鲜度不是一个单一维度的渐变，而是三种独立机制的叠加：**置信度**（人/review 流程判）、**时效性**（时间衰减，自动可测）、**取代关系**（事件触发，需人声明）。把它们压成一条线性轴（如 `current → stale → superseded → deprecated`）是建模错误——`superseded` 不是 `stale` 的下一步，`deprecated` 与 `status: deprecated` 重复。

#### 模型

frontmatter 原始字段（人/工具直接写入）：

| 字段 | 性质 | 取值 | 谁写 |
|------|------|------|------|
| `status` | 已有，必选，置信度 | `draft\|review\|stable\|deprecated` | 人 / review 流程 |
| `last_validated` | 时间戳，必选，验证时间 | ISO 8601 datetime | 机械检查 / LLM / 人 |
| `supersedes` | 关系，可选，"我推翻谁" | `[path...]` | agent 写入 B |
| `superseded_by` | 关系，可选，"我被谁推翻" | `[path...]` | agent 写入 A |
| `contradictions` | 关系，可选，矛盾记录 | 见 §9.5 | 矛盾检测写入双方 |

`zwiki check --apply` 自动维护的派生标记（存 frontmatter 供 agent 一读即知）：

| 字段 | 派生自 | 取值 |
|------|--------|------|
| `timeliness` | 必选，`now - last_validated > threshold` | `current\|stale`（仅两档，新页面默认 `current`） |

**`supersedes` ↔ `superseded_by` 双向对账：** 两个字段都是 agent 的合法写入入口——agent 可以只写 B 的 `supersedes: [A]`，也可以只写 A 的 `superseded_by: [B]`，zwiki 发现只写了一边就补齐另一边，保证两边互为镜像。不要求 agent 原子写两个文件，zwiki 保证最终一致。这与 backlinks 不同：backlinks 是多对多、频繁变、噪声关系，不值得在 frontmatter 列全；取代关系是一次性、语义重要、agent 必须一读即知的关系，值得物化到 frontmatter 两侧。

**为何 `timeliness` 只有 `current\|stale` 两档：** `superseded` 由 `superseded_by` 非空表达，`deprecated` 由 `status: deprecated` 表达——两者不重复塞进 timeliness。

#### 查询行为：三级短路

`superseded_by` 和 `status: deprecated` 是**短路守卫**——触发即决定行为，不看后续字段。`timeliness` 和 `status`（置信度）只在前两者都不触发时才参与组合。

```
if status == deprecated:           不出现（历史存档）
elif superseded_by 非空:            不返回结论，提示"已被 B 取代，查 B"
elif timeliness == stale:           附"N 天未验证"
elif status == review:              附"未经充分审查"
elif status == draft:               附"草稿状态"
else (stable + current):            直接引用，无免责
```

#### 行为表

| status | superseded_by | timeliness | 查询行为 |
|--------|--------------|------------|---------|
| deprecated | * | * | 🚫 默认不出现（历史存档） |
| stable | 有 | * | 🚫 不返回结论，指向取代者 |
| stable | 无 | current | ✅ 直接引用，无免责 |
| stable | 无 | stale | ⚠️ 附"N 天未验证" |
| review | 有 | * | 🚫 不返回结论，指向取代者 |
| review | 无 | current | 📝 附"未经充分审查" |
| review | 无 | stale | ⚠️📝 双重附注 |
| draft | 有 | * | 🚫 不返回（草稿被取代，基本无效） |
| draft | 无 | * | 少用，附"草稿状态" |

观察：`superseded_by` 非空时 `timeliness` 和 `status` 都不重要——被取代就是被取代，`stable+superseded` 与 `draft+superseded` 行为相同。这印证了 `superseded` 不该是 timeliness 的一档：它优先级高于其他状态，是短路条件。

#### 时效阈值

默认统一 180 天。允许 `teams.toml` 或页面 frontmatter `freshness_days` 字段覆写——按 type 硬编码分档（entity=60d / concept=180d / ...）对不了，同 type 不同领域变更频率差异大。`source` 类型默认永不过期（记录历史事实）。

衰减用 `last_validated` 而非 `timestamp`——编辑时间不等于验证时间。改个 typo 不等于重新确认了内容正确。

### 9.3 状态迁移事件

| 事件 | 触发 | 迁移 | 自动化 |
|------|------|------|--------|
| 时间流逝 | `zwiki check` 比较 `last_validated` | `timeliness: current → stale`（自动写 frontmatter） | ✅ 全自动（`--apply`） |
| 新源摄入 | wiki-ingest | kiwi 提议取代关系（写 `supersedes` 或 `superseded_by` 任一侧）；`zwiki check --apply` 对账补齐另一侧 | ⚠️ 半自动（LLM 提议 + 人确认） |
| 定期审查 | 人/agent 审查 stale 页 | 刷新 `last_validated`（→current）或 `status: deprecated` | ❌ 人工 |
| 矛盾发现 | lint 语义检查 | 双方写 `contradictions`，`status` 对称降一级（stable→review / review→draft / draft 不降） | ⚠️ 半自动 |
| 级联过期 | 页面 A 的 `superseded_by` 变非空 | 扫描引用 A 的页面，按引用性质标记 needs_review | ⚠️ 半自动（扫描自动，标记需 LLM） |

### 9.4 验证机制

| 层级 | 方式 | 刷新 |
|------|------|------|
| 0 | 时间戳刷新（任何 edit 后） | 仅 `timestamp` |
| 1 | 机械检查（health/lint 通过） | `last_validated` |
| 2 | 来源回溯（source ↔ 衍生页比对） | `last_validated`，需 LLM |
| 3 | 交叉验证（两独立源互相确认） | 双方 `last_validated`，需 LLM |

验证层级不存为 frontmatter 字段——它是写入 `last_validated` 时的**元数据**（log.md 记录"此次验证由 level N 触发"），不进页面 frontmatter，避免第三根轴。

### 9.5 矛盾管理：发现不裁决

三阶段分离：
1. **发现**（半自动）— 图拓扑预筛选候选对 → LLM 提取冲突声明（只问"是否不一致"，不问"谁对"）
2. **记录**（自动）— 双方写 `contradictions`，`status` 对称降一级（stable→review / review→draft / draft 不降）
3. **呈现**（查询时）— 不采用任何一方结论，将矛盾本身作为知识呈现

**降级是标记非裁决：** 不判谁对谁错，只让冲突双方在查询时附"未经充分审查"（降成 `review` 后由三级短路触发），矛盾在引用行为上自动可见。这是对称操作，与"发现不裁决"一致。

**矛盾解决后由人恢复：** `contradictions.resolution` 从 `unresolved` 改为具体值时，由**人**恢复 `status`——zwiki 不自动升回，与"所有矛盾最终由人解决"一致。

LLM 不裁决。所有矛盾最终由人解决。系统职责是**保证矛盾不会在无人知晓的情况下共存**。

---

## 10. 数据检索

详见 §8。核心：三阶段级联（index → tag → grep），零新基础设施，按规模渐进扩展。

---

## 11. 自动化策略

### 11.1 自动化边界

| 操作性质 | 是否自动 | 判据 |
|----------|---------|------|
| 时间戳比较 → 标记 stale | ✅ 全自动 | 确定性计算 |
| backlinks 更新 | ✅ 全自动 | 确定性计算（zwiki check 已做） |
| frontmatter 格式检查 | ✅ 全自动 | 确定性规则 |
| index.md 条目追加 | ✅ 全自动 | 确定性，路径已知 |
| post-ingest 强制 backlinks + health | ✅ 全自动 | 阻止后续错误 |
| 断裂链接修复（目标改名） | ⚠️ 半自动 | 自动发现 + 建议修复 + 人确认 |
| 图拓扑筛选矛盾候选对 | ⚠️ 半自动 | 自动发现，LLM 提取，人不裁决 |
| supersede 判断 | ❌ 需人确认 | 语义判断，LLM 提议 |
| 矛盾裁决 | ❌ 人工 | LLM 不能当裁判 |
| 级联过期标记 | ❌ 需人确认 | 需判断引用性质 |
| 定期审查 stale 页 | ❌ 人工 | 需判断"旧结论还成立吗" |

### 11.2 should-do 清单

| 优先级 | 动作 | 效果 |
|--------|------|------|
| 🔴 立即 | post-ingest 强制 backlinks + health（zwiki check 已支持，skill 需强制调用） | 消除"忘记跑 backlinks" |
| 🔴 立即 | `zwiki check --apply` 自动标记 stale | lint 从报告变执行 |
| 🟡 之后 | wiki-query pre-query lint 注入（> 7 天自动触发） | 查询时自动感知时效性 |
| 🟡 之后 | `zwiki check --fix` 自动修复 index 不一致 | 减少手工维护 |

---

## 12. zwiki 统一 CLI

### 12.1 当前实现（Rust，6 子命令）

| 子命令 | 用途 | 状态 |
|--------|------|------|
| `check` | 运行 health + lint + 可选 diff；支持 `--save`/`--ci`/`--diff`/`--cached`/`--commit`/`--apply` | ✅ |
| `backlinks` | 反向链接查询/写入 | ✅ |
| `log` | 追加日志到 `wiki/log.md`（`--op`/`--path`/`--action`/`--note`） | ✅ |
| `page` | 读页面（`--property`/`--outline`） | ✅ |
| `property` | 读/写/删 frontmatter 属性（结构化，不手改 YAML） | ✅ |
| `create` | 从模板创建骨架页（`--domain`/`--type`/`--title`/`--slug`/`--source-type`）；新域自动建完整骨架 | ✅ |

### 12.2 目标扩展子命令（按路线图）

| 子命令 | 阶段 |
|--------|------|
| `check --fix` | P0 |
| `search "<query>"` | ✅ 已实现 |
| `okf export <dir>` | P0 |
| `move <old> <new>` | P1 |
| `list [--tag] [--type] [--domain]` | P1 |
| `status [--tag] [--type] [--domain]` | P1 |
| `ingest <source> --idempotent` | P1 |
| `sync pull/push/status` | L2-P1 |
| `promote --team <name>` | L1-P1 |
| `propose --team <name>` | L2-P2 |
| `consensus` | L1-P2 |
| `bundle publish/install/list/outdated/upgrade` | L3-P3 |

**`check --fix` 修复行为：** 自动修复确定性可修的问题——index.md 缺失条目补齐、broken links（已知目标路径）重连、orphan 页面加入 index、frontmatter 必填字段缺失补默认值。**不修**需要语义判断的问题（矛盾、supersede、sparse 页面内容）。

**`search "<query>"` 已实现行为：** rg 候选预筛（`--fixed-strings` 字面子串，`--ignore-case`）+ 进程内 fallback（无 rg 时扫描 `discover_pages` 结果）。四级评分：title=4、tag=3/个、heading=2/行、body=1/次，累加降序。过滤：`--type`（frontmatter type 子串）、`--tag`（tags 数组元素子串）、`--domain`（顶级目录精确匹配，不匹配时列出可用域）。输出：人读 `  {path} — {title} [score: {n}]` 或 `--json` 结构化数组。

### 12.3 内部架构原则

zwiki 是**薄路由层**，底层调用现有模块逻辑。新增能力以新内部模块挂载，不重写已验证的 health/lint/backlinks 逻辑。借鉴 Obsidian CLI（property 结构化操作、deadends 检测）、notesmd-cli（move + 批量更新链接）、llm-wiki-compiler（idempotent ingest、CI gating）。

---

## 13. 大规模摄入与增量同步

详见 §7.4-7.5。核心：首次四阶段分块蒸馏（扫描→地图→分块→缝合），持续六步增量同步（哈希→分大小→依赖追踪→差分或全量→报告）。借鉴 codemap 确定性扫描模式，kiwi 新增摘要表蒸馏 + 差分蒸馏两种模式。始终不自动应用 LLM 修改——只标记等审查。

---

## 14. 协同四层架构

### 14.1 Layer 0 — 本地单机（已实现，不动）

`~/.zoo/wiki/` 单人单机，install.py 创建软链接，zwiki CLI + SCHEMA 注入 + kiwi 蒸馏完整工作流。L0 用户不感知上层存在。

### 14.2 Layer 1 — 分层覆盖（未实现）

**核心矛盾：** 个人探索需要自由修改，团队知识需要稳定权威。借鉴 Docker overlay：上层覆盖下层，下层不变。

**五级目录：**

```
~/.zoo/wiki/
├── personal/              ← 最优先：当前 agent/用户的个人理解（无点前缀，用户主工作区）
├── .org/                  ← 组织级共识（跨团队 review 后合入，权威性最高）
├── .teams/                ← 各团队知识（按 teams.toml 中 priority 排列）
│   ├── core/              ← primary (priority=1)
│   ├── security/          ← advisory (priority=2)
│   └── infra/             ← supplementary (priority=3)
├── .upstream/             ← 最低优先：外部 bundle 提供的基础知识
├── index.md / log.md / SCHEMA.md
```

点前缀（`.org`/`.teams`/`.upstream`）暗示"框架维护，用户一般不直接操作"；`personal/` 无前缀是用户主工作区，与 dotfile 惯例一致。

**teams.toml：**

```toml
[[teams]]
name = "core"
repo = "git@github.com:org/zookeeper-wiki.git"
priority = 1
role = "primary"

[[teams]]
name = "security"
priority = 2
role = "advisory"
```

**Team role 决定查询冲突行为：**

| Role | 行为 |
|------|------|
| `primary` | 同名页面直接返回 |
| `advisory` | 不覆盖 primary，返回 primary 版本 + 附注"X 团队另有结论" |
| `supplementary` | 无重叠预期，重叠时警告 |

**查询级联：** personal → .org → .teams（按 priority）→ .upstream。同名覆盖时返回最高优先版本 + 跨层附注，提示 `zwiki check --layers <page>` 看差异。**不自动合并、不自动删除覆盖**——覆盖存在本身就是信息。

**Promote / Consensus 流程：**
- `zwiki promote --team <name>`：personal → team（本地复制，保留 personal 副本）
- `zwiki consensus concepts/X.md --teams core,security`：多团队共识 → 写入 `.org/`，需指定团队 approve（frontmatter 记录 `consensus_of`），共识页固定 `status: stable`

**L0 → L1 零中断迁移：** 创建 `.teams/default/` + `teams.toml`，现有内容搬入 `.teams/default/`，`personal/` 留空。查询语义完全一致。

### 14.3 Layer 2 — Git 团队同步（未实现）

每个团队独立 git repo（独立版本历史、独立权限、独立 CI），`teams.toml` 统一管理。wiki 生命周期与项目代码不同——知识积累持续低频，代码迭代周期高频，独立 repo 让 wiki 历史不被代码提交冲散。

- `install.py --wiki-repo <name> <url>`（可多次指定）管理多 remote
- `zwiki sync pull/push/status` 遍历 teams.toml 中所有 team
- `zwiki propose --team <name>`：personal → 指定团队走 PR + CI 门禁（`zwiki check --ci`）
- `personal/` 始终 `.gitignore`；`.org/` 在 primary team repo 中版本管理，非 primary team 的 repo 中 `.gitignore`
- **log.md 按月分文件**（`wiki/logs/2026-06.md`）避免高频 merge conflict
- contributors frontmatter 字段自动维护（PR merge 时从 git log 提取）

**跨团队冲突不在 git 层处理**——不同团队独立 repo，同名页面在不同命名空间，不触发 git conflict。冲突在**查询时**由 L1 role 逻辑处理。

### 14.4 Layer 3 — OKF Bundle 联邦（未实现）

跨项目、跨组织知识分发。`bundle.toml` 声明包规格 + 依赖 + 导出范围 + `[federation]` 可信列表：

```toml
[package]
name = "zookeeper-core"
version = "1.2.0"
okf_version = "0.1"

[dependencies]
opencode-plugin-system = ">=0.5"

[export]
include = ["concepts/", "entities/", "analysis/", "SCHEMA.md"]
exclude = ["concepts/internal-*", "personal/"]

[federation]
trusted = ["opencode-plugin-system"]
review_required = ["experimental-ml-wiki"]
blocked = ["deprecated-legacy-wiki"]
```

- `zwiki bundle publish/install/list/outdated/upgrade` 做分发
- `@name/path` 统一命名空间：`@` 前缀后可是 team（从 teams.toml）或 bundle（从 registry），解析时 team 优先
- 分层联邦拓扑：组织 registry → team bundles → shared consensus → external bundles（非扁平去中心化，信任可控）
- 三种 registry 类型：`git` / `http` / `directory`（`ipfs` 远期）

**为何不用 `okf://` URI？** `@name/path` 是 npm 几十年的约定，agent 和开发者都熟悉，文件系统路径转写方便。

### 14.5 协同层取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 四层递进，每层独立部署 | ❌ 必须全上线才能工作 |
| ✅ 每层向下兼容 L0 | ❌ 强制迁移 |
| ✅ 覆盖不摧毁 | ❌ 自动合并多版本 |
| ✅ promote/consensus 需人确认 | ❌ 自动 promote / 自动 consensus |
| ✅ 每团队独立 git repo | ❌ 嵌入项目 repo |
| ✅ `@name/path` 统一命名空间 | ❌ `okf://` URI |
| ✅ 分层联邦 + 可信列表 | ❌ 扁平去中心化 / 中心注册中心 |
| ✅ bundle 级 semver | ❌ 单页独立版本（远期考虑） |
| ✅ CRDT/P2P / Wiki-as-a-Service / Pub/Sub 已评估并放弃 | — |

---

## 15. 注入机制

### 15.1 当前状态

**未实现。** `src/index.ts` 的 config hook 只做 `injectAgentPrompts`（注入 `src/agents/<name>.ts` 的 prompt）和 `registerSkills`（自动发现 `core/skills/`）。无 SCHEMA 读取/注入。

### 15.2 目标：SCHEMA 缩略版注入（Phase 2）

在 config hook 中为 build/explore/general/eagle 追加 SCHEMA 缩略版（目录结构 + index.md 导航 + 工具 vs kiwi 决策标准），kiwi 获得完整 SCHEMA.md。注入内容 < 1K tokens，成本可忽略。

**为何不注入完整 wiki：** 上下文窗口有限、信息稀疏、按需读取更高效。SCHEMA 提供"元知识"（wiki 存在、如何用），具体页面由 agent 用 read/grep 按需读取。

### 15.3 按需读取流程

**集成点 — 规划前查 wiki：** 编排器（build）在 Phase 0（理解任务）和 Phase 1（规划/委派）之间插入一个 wiki 检查——先读 `wiki/index.md` 判断是否有相关已有知识，避免重复推导已有结论。这不是强制门禁（wiki 没有相关内容也正常推进），是"先查再规划"的习惯。

**通用按需读取流程：**

1. agent 收到可能由 wiki 覆盖的问题 → 读 `wiki/index.md`
2. 从 index 找相关页面路径
3. `read` 具体页面
4. 按 `relations` 递归读取

### 15.4 工具调用约定（注入内容应含）

```
何时用 zwiki CLI（直接操作）：
- 结构化、已 wiki 格式化的内容
- 简单 CRUD、维护性操作（check/backlinks/log）
- 只需追加日志

何时委派 kiwi（复杂蒸馏）：
- 非结构化文本、聊天记录、会议转录
- 需分类、摘要、要点提取
- 需跨多目录组织
- 需判断是否重写 overview.md

注意：kiwi 是只读 agent，委派时 task() prompt 应要求返回结构化分析报告，
所有写入（zwiki create/property/log、更新 index）由调用方执行。
```

---

## 16. 统一实施路线图

优先级原则：**L0 地基优先于协同层；机械活优先于语义活；已实现的不再重做。**

### P0-pre：OKF 字段对齐 + zwiki 骨架 ✅ 已完成

- ✅ `updated`→`timestamp`、`source`→`resource`、新增 `description`、`okf_version`、删除 `created`
- ✅ zwiki CLI 骨架（Rust，6 子命令）
- ✅ `zwiki property` 结构化读/写/删

### P0：L0 地基（纯机械，零 LLM）

| # | 改动 | 状态 |
|---|------|------|
| `OKF-LOG` | **index.md / log.md 对齐 OKF §6/§7**（见 §16.2） | ✅ 已完成 |
| `OKF-IDX` | index.md：`##` 章节改 `#` 一级标题；条目分隔符 `—` 改 `-`；各领域 subdir `index.md` | ✅ 已完成 |
| `OKF-DOMAIN` | **目录结构类型优先 → 域优先**（见 §5.2.4、§16.2）：各领域 subdir 新建 `index.md`，利用 OKF §6 渐进式披露 | ✅ 已完成 |
| 1 | 新增 `last_validated`/`timeliness`（必选）/`supersedes`/`superseded_by`/`contradictions`/`freshness_days`（可选）字段（详见 §5.3、§9.2）；28 现有页面已回填 | ✅ 已完成 |
| 2 | `zwiki check --apply` 自动标记 `timeliness: stale`（默认 180 天阈值，`source` 永不过期，frontmatter `freshness_days` 可覆写） | ✅ 已完成 |
| 3 | wiki-query skill 大改（生命周期三级短路 + 发现方式升级，详见 §9.2）：①发现层——`zwiki search` 作为首选发现工具（替代纯 index.md 手动定位），按问题类型加 `--type`/`--domain` 过滤缩小范围，index.md 导航降为补充/兜底；②短路层——读取页面后检查 `status: deprecated`（不出现）/`superseded_by` 非空（指向取代者）/`timeliness: stale`（附"N 天未验证"）/`status: review`/`draft`（附状态标注），规则见 §9.2 行为表；③合成层——基于过滤后页面合成答案，标注来源页面 + 生命周期状态 | ⬜ |
| 4 | 五个模板追加新字段（`last_validated`/`timeliness` 必选默认值；其余可选注释示例） | ✅ 已完成 |
| 5 | 三阶段级联检索：index → tag → grep。skill 侧（wiki-query）调用 `zwiki search` 时按 index.md 导航 → tag 过滤（`--tag`）→ 全文 grep 逐级 fallback，结果 < 3 个时降级到下一层 | ⬜ |
| 6 | post-ingest 强制 backlinks + health（skill 强制调用 zwiki check） | ✅ 已完成（wiki-ingest skill Phase 3 已含 `zwiki check`） |
| 7 | `zwiki search` CLI 化 | ✅ 已完成（rg 候选预筛 + 进程内 fallback，四级评分 title/tag/heading/body，`--type`/`--tag`/`--domain` 过滤，人读 + `--json` 输出） |
| 8 | `zwiki check` 内置 OKF 合规自检（含 §9 第 3 条：保留文件 §6/§7 结构校验），默认最严格、无开关 | ✅ 已完成（OKF check 已合并入 `zwiki check`，默认严格，含 relations-body 双向一致性检查） |

#### 16.2 OKF-LOG / OKF-DOMAIN 对齐记录（✅ 已完成）

**目标格式（OKF §7）：**

```markdown
# 目录更新日志

## 2026-06-19
* **创建**：shared/graph-link-prediction.md — 图链接预测理论知识蒸馏
* **编辑**：overview.md — 更新知识版图与外部参考
* **通过**：health 检查 — 所有检查通过
```

**改动清单：**

| 文件 | 改动 |
|------|------|
| `tools/zwiki/src/log.rs` | 重写 `format_entry()`：不再输出 `## [date] op \| path \| action — note` 单行；改为在当天 `## YYYY-MM-DD` 组下追加 `* **<action 中文动词>**: <path> — <note>`。需处理"当天组不存在则新建组并插在 `#` 标题后" |
| `tools/zwiki/src/health.rs` | 重写 `parse_log_entries()`：正则改为从 `## YYYY-MM-DD` 组下的 `* **verb**: <path> —` 行提取 path |
| `tools/zwiki/src/health.rs` 测试 | 更新 `test_log_coverage_*` 和 `test_parse_log_entries_*` 用例 |
| `wiki/SCHEMA.md` §索引与日志 | 重写 index.md 和 log.md 格式章节，引用 OKF §6/§7 |
| `wiki/SCHEMA.md` §目录结构 | 重写为域优先结构 + subdir index.md 约定 |
| `wiki/index.md` | `##` 章节标题改 `#`；条目 `—` 改 `-`；frontmatter `okf_version` 保留；**缩减为领域列表 + `shared/` 条目** |
| `wiki/log.md` | 迁移现有 33 条历史条目到 OKF 格式（一次性脚本或手工） |
| `zwiki log` CLI | `--op/--path/--action/--note` 参数接口保留；`--action` 值映射为中文动词（create→创建，edit→编辑，pass→通过，fail→失败）或保留英文粗体词 |

**域优先重构（`OKF-DOMAIN`，与 `OKF-LOG` 一并执行）：**

| 文件 | 改动 |
|------|------|
| `wiki/` 目录 | 类型优先 → 域优先：新建 `autoresearch/`、`wiki-system/`、`shared/` 三个顶级目录；现有页面按前缀归类（`autoresearch-*` → `autoresearch/`，`wiki-*` + `compounding-knowledge` + `llm-wiki-vs-rag` → `wiki-system/`，`npc`/`simplicity-criterion`/`post-hoc-accountability`/`agent-skill-plugin-framework`/`graph-link-prediction`/`metric-asi-protocol`/`mad-confidence`/`experiment-versioning`/`single-file-modification` → `shared/` 或对应领域） |
| 各领域子目录 | 每个领域 `autoresearch/`、`wiki-system/` 下新建 `index.md`（OKF §6 格式：无 frontmatter，`#` 一级标题，`* [title](path) - desc` 条目） |
| 各领域子目录 | 领域内保留 `concepts/`/`entities/`/`analysis/`/`sources/` 二级类型目录 |
| `tools/zwiki/src/wiki.rs` | `all_wiki_pages()` 已支持递归；`check_index_sync` 需扩展为校验各级 index.md 与对应子目录文件一致 |
| `tools/zwiki/src/health.rs` | `check_index_sync` 递归化：对每个含 `index.md` 的子目录独立校验 |
| 所有页面的交叉引用 | 路径从 `concepts/foo.md` 改为 `<domain>/concepts/foo.md`；可用 P1 项 13 `zwiki move` 批量更新（或在迁移脚本中一次性 `sed`） |

**归类判定规则（迁移时）：**
- 文件名或内容明确属于 autoresearch 项目 → `autoresearch/`
- 文件名或内容关于 wiki 系统自身（ingest/query/health/RAG 对比等）→ `wiki-system/`
- 跨领域通用概念（NPC 分工、简约准则、后验问责、Agent/Skill/Plugin 框架等）→ `shared/`
- 不确定时优先放 `shared/`，后续按引用密度移动

**向后兼容：** 解析器可暂时容忍旧格式（`## [date] ...`）以避免迁移期间报错，但写入器只产新格式。`zwiki check` 内置 OKF 合规自检（P0 项 8）上线后可加严格校验。交叉引用在 `zwiki move`（P1 项 13）上线前，迁移脚本需自行处理路径重写。

**估算工作量：** Rust 改动 ~60 行 + 测试更新 ~40 行 + SCHEMA/index/log 文件迁移 ~80 行 + 域优先重构（目录移动 + 交叉引用重写 + 各领域 index.md 生成）~120 行 ≈ 300 行。

### P1：半自动机制（LLM 辅助，调用量极小）

| # | 改动 |
|---|------|
| 9 | kiwi 蒸馏时判断新源是否推翻旧结论，声明 `supersedes` |
| 10 | `check_cascade_stale`：页面 superseded 后扫描引用者，生成候审列表 |
| 11 | 矛盾检测：图拓扑预筛选 → LLM 声明提取 → contradictions 写入 |
| 12 | wiki-query 矛盾感知 |
| 13 | `zwiki move`：重命名 + 自动更新所有引用链接 |
| 14 | `zwiki ingest --idempotent`：源身份匹配 + SHA-256 跳过 |
| 15 | SCHEMA 自动注入到 agent prompt（config hook） |
| 16 | `zwiki list`：按字段结构化浏览页面——`--tag <name>`/`--type <type>`/`--domain <domain>` 列匹配页面，无过滤时列全部页面路径 + 标题。与 `search`（全文检索）互补：`list` 是字段精确浏览，`search` 是内容子串匹配 + 评分排序 |
| 17 | `zwiki status`：wiki 整体健康概览——页面总数、各 type/domain 分布、stale/deprecated 计数、最近 last_validated 范围。`--tag`/`--type`/`--domain` 可选切片统计 |

### P2：验证体系 + 协同 L1/L2 起步

| # | 改动 |
|---|------|
| 16 | 交叉验证：ingest 新源时自动比对已有声明，一致则刷新 last_validated |
| 17 | 来源回溯验证：source ↔ 衍生页面一致性比对 |
| 18 | **L1-P0**：分层目录约定（personal/.org/.teams/.upstream 五级）+ teams.toml + `.org` consensus frontmatter |
| 19 | **L1-P1**：`zwiki promote --team <name>` |
| 20 | **L2-P0**：log.md 分月文件 |
| 21 | **L2-P1**：`--wiki-repo <name> <url>` 多 repo + `zwiki sync pull/push/status` |

### P3：全自动维护 + 大规模摄入 + 协同 L1/L2 深化 + L3

| # | 改动 |
|---|------|
| 22 | pre-query 自动 lint 注入（> 7 天触发） |
| 23 | `zwiki check --ci` 阈值 YAML → exit code |
| 24 | 结构扫描脚本（Phase 1，纯确定性） |
| 25 | 哈希快照脚本（Step A，codemap 风格） |
| 26 | kiwi 摘要表蒸馏模式（Phase 2） |
| 27 | kiwi 差分蒸馏模式（Step D） |
| 28 | `zwiki sync` 六步增量同步（Step A-F） |
| 29 | **L1-P2**：`zwiki consensus` |
| 30 | **L2-P2**：`zwiki propose --team <name>` + contributors 追踪 |
| 31 | **L3-P2**：bundle.toml + `[federation]` 可信列表 + `zwiki okf export` |
| 32 | **L3-P3**：`zwiki bundle publish/install` + `@name/path` 解析 + 分层联邦拓扑 |

### 路线图原则

- **L1-P0（分层目录 + teams.toml + log 分月）对现有系统完全无影响**，可从下一迭代立即开始
- **L3-P3（bundle 联邦）复杂度最高、收益最不确定**，待 L2 稳定运行后评估
- `zwiki consensus` 依赖多团队协作实际存在后再实施，前期可用手动协商替代
- 已实现的 zwiki 6 子命令不再重写，新能力以新子命令挂载

---

## 17. 设计取舍总表

所有"做什么 / 不做什么"决策，按维度归并：

| 维度 | ✅ 做 | ❌ 不做 |
|------|-------|--------|
| **基础设施** | 纯 Markdown + git + OKF，零外部服务 | 数据库、向量存储服务、知识图谱服务、Wiki-as-a-Service |
| **架构演进** | 四层递进，每层独立部署，向下兼容 L0 | 大爆炸式统一迁移、强制上更高层 |
| **kiwi 角色** | 只读蒸馏专家，返回分析报告，调用方写入 | kiwi 直接写入、kiwi 当裁判 |
| **知识状态** | 三级短路（`status` × `superseded_by` × `timeliness`）+ 取代关系双向可写、zwiki 对账 | 置信度浮点数、艾宾浩斯遗忘曲线、12 格正交矩阵、要求 agent 双写 |
| **时间语义** | `last_validated` ≠ `timestamp`（验证≠编辑） | "被访问=被验证" |
| **取代** | `supersedes`/`superseded_by` 双向可写 + zwiki 对账补齐 + 人确认 | 自动 supersede、要求 agent 双写两侧 |
| **时效阈值** | 默认统一 + frontmatter 可覆写 | 按 type 硬编码分档 |
| **矛盾** | 发现 + 记录 + 呈现，三阶段分离 | 自动修复矛盾、LLM 裁决 |
| **级联过期** | 扫描自动，标记需 LLM/人 | 级联全自动标记 |
| **检索** | 三阶段级联（index→tag→grep） | BM25 引擎、知识图谱、外部 embedding（当前规模） |
| **自动化** | 机械活全自动（`--apply`/`--fix`），语义活半自动 | 事件驱动全自动、会话级自动加载/压缩 |
| **协同冲突** | 覆盖不摧毁、role 决定冲突行为、检测不自动修 | 自动合并多版本、复杂权限矩阵 |
| **git 协作** | 每团队独立 repo、personal gitignore、log 分月 | 嵌入项目 repo、CRDT 冲突解决、定时 cron |
| **分发** | bundle.toml + semver + `@name/path` + 分层联邦 | `okf://` URI、扁平去中心化、自动信任、单页独立版本（远期） |
| **大规模摄入** | 四阶段分块蒸馏、六步增量、哈希快照 | 机械切片、全量重蒸馏、自动应用 LLM 修改 |
| **工具** | 统一 zwiki CLI（Rust，薄路由） | 重写已验证逻辑、工具脚本散落 |
| **注入** | SCHEMA 缩略版 + 按需 read/grep | 完整 wiki 注入 prompt（上下文爆炸） |

---

## 18. 参考资料

### 外部规范（权威来源）
- **Open Knowledge Format (OKF) v0.1** — https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
  - §5 链接语法（`/bundle-relative` 推荐，`./relative` 合法）
  - §6 index.md 格式（无 frontmatter 除根 `okf_version`；`#` 一级标题章节；`* [title](path) - desc` 条目）
  - §7 log.md 格式（`#` 一级标题；`## YYYY-MM-DD` ISO 8601 日期组；`* **verb**: desc` 散文条目）
  - §9 一致性三要求（保留文件 §6/§7 结构是 MUST）
  - §11 版本控制（`okf_version` 仅允许在根 index.md frontmatter）
- Google, "Knowledge Catalog": https://github.com/GoogleCloudPlatform/knowledge-catalog

### 设计灵感来源
- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Rohit Gupta, "LLM Wiki v2" (2026): https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2
- Docker Overlay Filesystem: https://docs.docker.com/storage/storagedriver/overlayfs-driver/
- npm 包管理: https://docs.npmjs.com/about-packages-and-modules
- Model Context Protocol (MCP): https://modelcontextprotocol.io/
- Semantic Versioning: https://semver.org/
- Obsidian CLI: https://help.obsidian.md/cli
- notesmd-cli: https://github.com/Yakitrak/notesmd-cli
- llm-wiki-compiler: https://github.com/atomicstrata/llm-wiki-compiler

### 参考项目（只读 specialist 架构验证）
- OMO (oh-my-openagent) — Librarian deny write/edit/apply_patch
- OMP (oh-my-pi) — Librarian 白名单 7 工具 + yield 结构化 JSON
- SLIM (oh-my-opencode-slim) — 只读外部文档研究者，无持久化

---

*本文档是 ZooKeeper Wiki 系统的单一权威设计。实施以 §16 统一路线图为准，现状以 §2 基线为锚点。任何与代码冲突的设计声明以代码为准并回写本文档。*
