---
name: wiki-query
description: 从 ~/.zoo/wiki/ 中查询知识并合成答案。查询 wiki 覆盖的项目知识时加载此技能，替代盲目委派 explore 或 spider。
---

# Wiki Query 技能

从 `~/.zoo/wiki/` 中查询知识并合成答案。
查询 wiki 覆盖的项目知识时加载此技能，替代盲目委派 explore 或 spider。

---

## Phase 0 — 覆盖判断

判断问题是否可能被 wiki 覆盖，并确定建议的 `--type` 过滤器值。

| 问题类型 | 示例 | 建议 `--type` |
|----------|------|---------------|
| 概念解释 | "prompt injection 怎么工作的" | `concept` |
| 实体行为 | "build agent 有哪些权限" | `entity` |
| 外部来源 | "OpenCode 文档怎么说的" | `source` |
| 历史决策/分析 | "为什么选 ruff 而不是 eslint" | `analysis` |
| 已归档问答 | "上次讨论的 lint 工具对比" | `synthesis` |
| 跨类型混合 | "lint 工具的配置和对比" | 不加 `--type`，全量搜索 |
| 明显不在 wiki 覆盖范围 | "今天的天气" | 不查 wiki，直接委派 explore/spider |

`--type` 对应 frontmatter `type` 字段的五值枚举：`concept` / `entity` / `source` / `analysis` / `synthesis`。

---

## Phase 1 — 定向：读取根索引

读取根索引 `~/.zoo/wiki/index.md`，提取所有 domain 名称。

**根 index.md 格式示例：**

```markdown
* [autoresearch](autoresearch/index.md) — AI agent 自主实验框架相关概念
* [wiki-system](wiki-system/index.md) — Wiki 系统自身的设计概念
* [shared](shared/index.md) — 跨领域通用的概念与分析
```

**Domain 提取规则：** 从链接 **PATH** 中提取，而非 bracket 文字。
- 链接 `(autoresearch/index.md)` → domain = `autoresearch`
- 链接 `(wiki-system/index.md)` → domain = `wiki-system`
- 链接 `(shared/index.md)` → domain = `shared`

根 index.md 的行数并不多，是理解 wiki 覆盖范围的唯一起点。提取出的 domain 名用于后续 `--domain` 过滤器。

---

## Phase 2 — 检索：zwiki search 为主，三级失败重试

### 默认方式：`zwiki search`

```bash
zwiki search "<query>" [--type <type>] [--domain <domain>]
```

- 过滤条件 AND 语义：`--type` 大小写不敏感子串匹配，`--domain` 精确匹配顶级目录
- 输出格式：`  {path} — {title} [score: {n}]`
- 支持 `--json` 输出结构化数组

### 三级失败重试级联

如果 Phase 0 判断了 `--type`、Phase 1 确定了 `--domain`，第一级带上全部过滤器。

**Level 1:** `zwiki search "<query>" --type X --domain Y`
- 结果 ≥ 3 条且内容明显匹配 → 直接进入 Phase 3

**Level 2:** 移除过滤器重试
- 条件：Level 1 结果 < 3 条，或结果明显不匹配问题
- 命令：`zwiki search "<query>"`
- 结果 ≥ 3 条且内容明显匹配 → 直接进入 Phase 3

**Level 3:** 读域索引导航
- 条件：Level 2 结果仍 < 3 条
- 读取 `~/.zoo/wiki/<domain>/index.md` 按结构化分类浏览，定位相关页面后直接 `read`

---

## Phase 3 — 短路 + 合成

### 读取页面

从搜索结果按分数降序读取页面（软上限 10 篇），每篇先解析 YAML frontmatter。

### 生命周期短路（每页必检）

读取 frontmatter 后按以下行为表处理：

| status | superseded_by | timeliness | 行为 |
|--------|--------------|------------|------|
| `deprecated` | * | * | ✗ 跳过，不引用 |
| * | 非空 | * | ✗ 不引用该页面；读取 `superseded_by` 指向的页面，引用取代者 |
| `stable` | 无 | `current` | ✓ 直接引用，无免责 |
| `stable` | 无 | `stale` | ⚠ 引用并附加"N 天未验证"（N = 当前日期距 `last_validated` 的天数） |
| `review` | 无 | `current` | ✎ 引用并附加"未经充分审查" |
| `review` | 无 | `stale` | ⚠✎ 双重附注 |
| `draft` | 无 | * | ✎ 引用并附加"草稿状态" |

**注意：** `superseded_by` 是短路守卫——只要非空，`timeliness` 和 `status` 不再参与判断，行为固定为指向取代者。

### 矛盾感知（正交检查）

`contradictions` 与生命周期表正交——无论 `status`/`timeliness` 如何，只要页面 `contradictions` 非空，引用时必须附加矛盾标注：

| contradictions | 行为 |
|----------------|------|
| 非空 | 引用时附加"↯ 声明存在争议（与 {target} 等 N 个页面矛盾）" |
| 空 | 无额外标注 |

> `zwiki search --json` 输出中每个结果的 `contradictions` 字段为 `[{target, claims, detected, resolution}]` 数组。矛盾不改变引用决策（不跳过页面），仅标注。

### Relations 递归

如果页面有 `relations` frontmatter（domain-prefixed 路径如 `shared/concepts/foo.md`），可递归读取。agent 根据上下文预算自行判断何时停止。

### 合成答案

合成时标注来源路径 + 生命周期状态。三种覆盖层级：

| 覆盖度 | 行为 |
|--------|------|
| **完整** | wiki 有完整答案 → 基于 wiki 内容直接回答，标注来源页面 |
| **部分** | wiki 内容作为上下文，委派 explore 补充探索缺失部分 |
| **无** | 委派 explore 或 spider 探索，必要时触发 ingest |

---

## Phase 4 — 归档 + 呈现

### 判断是否归档

答案如果是可复用知识（非一次性问答），加载 wiki-ingest skill 走 ingest 流程。一次性问答、时效性内容跳过归档。

### 呈现答案

向用户呈现合成答案，包含来源标注和生命周期附注。如果归档了，简要提及创建的 synthesis 页面。
