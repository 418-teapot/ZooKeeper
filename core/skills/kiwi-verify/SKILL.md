---
name: kiwi-verify
description: 用于比较两个已有 wiki 页面，判断衍生页（analysis/synthesis）的主张是否被源页面支持。只读操作，不创建或修改任何页面。kiwi 在收到验证请求时加载此技能。
---

# Kiwi Verify — 源回溯验证工作流

## Phase 1 — Load 加载页面

调用方会在 CONTEXT 中提供两个页面路径：`source_path`（源页面）和 `derived_path`（衍生分析/综合页面）。

用 `read` 工具读取两个页面的完整内容（含 frontmatter）。

---

## Phase 2 — Verify 主张验证

从衍生页中提取所有关键主张（claims）——即关于系统工作方式、设计决策或原则的陈述。对每条主张，检查源页面是否支持它，归入以下三种 verdict：

### validated（已验证）
源页面以显式声明或证据清晰支持该主张。衍生页的陈述是对源页面的忠实反映或合理推论，未超出源页面提供的信息范围。

### drifted（已漂移）
该主张超出了源页面所支持的范围，与源页面相矛盾，或做出了源页面未提供依据的引申。这可能包括：夸大源页面的结论、引入源页面未提及的假设、或遗漏了源页面中的重要限定条件。

### uncertain（不确定）
主张与源页面的关系过于间接，无法确定源页面是否支持它。例如：主张过于笼统无法定位到具体原文、涉及源页面未覆盖的侧面、或需要外部知识才能判断。

---

## Phase 3 — Return 返回结果

向调用方返回结构化发现报告。包含：

### 逐条主张结果

对每条主张，提供：
1. **Claim** — 主张原文（衍生页中的具体陈述）
2. **Verdict** — `validated` | `drifted` | `uncertain`
3. **Reasoning** — 一条简洁的判断理由

### 页面级总体 verdict

基于所有主张的 verdict 分布，给出总体评价：

| 全部 validated | `consistent` — 衍生页完全忠实于源页面 |
| 至少一条 drifted | `inconsistent` — 衍生页与源页面存在偏差 |
| 无 drifted，有 uncertain | `inconclusive` — 部分主张无法确认 |
| 无主张可提取 | `empty` — 衍生页不含可验证的主张 |

### 约束

- **切勿写入任何文件。** 不得调用 `write`、`edit` 或任何 `zwiki` 写入命令（`zwiki create`、`zwiki property`、`zwiki log`、`zwiki supersede`、`zwiki contradictions apply` 等）。
- 源页面和衍生页面的路径由调用方在 CONTEXT 中提供，kiwi 不应自行搜索或猜测。
