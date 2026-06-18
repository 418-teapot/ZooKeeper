---
title: 蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程
type: analysis
created: 2026-06-18
updated: 2026-06-18
tags: [distillation, example, methodology]
sources:
  - sources/notes/llm-wiki-karpathy.md
related:
  - concepts/compounding-knowledge.md
  - concepts/wiki-ingest-workflow.md
  - concepts/wiki-query-synthesis.md
  - concepts/wiki-health-check.md
  - analysis/llm-wiki-vs-rag.md
status: stable
---

## Overview

> 本文以 Karpathy 的 LLM Wiki gist 为例，完整展示一次蒸馏的决策过程：原始文章怎么拆、什么东西被丢弃、为什么这样分类、内联链接放在哪。是一份"蒸馏过程的蒸馏"——meta 级别的示例，供后续蒸馏任务参考。

## Details

### 原始文章结构

Karpathy 原文约 1500 词，自然段落结构如下：

```
1. The core idea          — 核心主张：wiki vs RAG
2. 五个应用场景           — Personal / Research / Reading / Business / etc.
3. Architecture           — 三层架构（raw sources / wiki / schema）
4. Operations             — 三个操作（ingest / query / lint）
5. Indexing and logging   — index.md + log.md 的格式约定
6. Optional: CLI tools    — qmd 等工具推荐
7. Tips and tricks        — Obsidian Web Clipper / 图片下载 / Marp / Dataview
8. Why this works         — LLM 不厌其烦 + Memex 类比
```

### 蒸馏决策逐段说明

#### 第 1 段：核心主张 → `concepts/compounding-knowledge.md`

**保留：** "每次查询从零推导 vs 知识编译一次持续维护"的对比、编译 vs 解释的类比结构

**丢弃：** "Most people's experience with LLMs and documents looks like RAG"——这是引导读者进入话题的叙事铺垫，不承载独立知识。NotebookLM / ChatGPT file uploads 的具体举例——文章发表后这些产品可能已变化，属于时效性细节

**转换：** 把原文的线性叙事（"RAG 是这样的…但是这有问题…所以我们这样做…"）重组为"问题→方案→类比"的结构。"编译 vs 解释"的类比是原文第 8 段的片段，被提前到 concept 页的 Details 中，因为它对理解核心理念的支撑作用远大于在 Why this works 段落中作为点缀

#### 第 2 段：应用场景

**整段丢弃。** 六个场景（Personal / Research / Reading / Business / Competitive analysis）是"这个模式可以用在哪"的列举，不是知识结构本身。它们对理解 wiki 的工作机制没有增量信息。保留在 source 页面的 Details 中作为一句总结即可

#### 第 3 段：三层架构 + 第 5 段：索引日志

**合并融入 `concepts/compounding-knowledge.md` 和 `overview.md`。** 三层架构（raw / wiki / schema）没有独立成页，因为与 ZooKeeper 自身的架构高度重叠——config.toml 对应 schema，src/ 和 prompts/ 对应 wiki。独立成页会产生大量与已有知识冗余的内容

index.md 和 log.md 的格式约定也没有独立成页——它们属于 SCHEMA.md 的范畴，在 schema 中已有完整定义。蒸馏时的判断：如果原文描述的东西在已有 wiki 中已有更规范的版本，不重复创建

#### 第 4 段：三个操作 → 拆为 3 个 concept 页面

这是本文最有信息密度的段落，也是拆页的核心依据：

| 原文子节 | 蒸馏为 | 原因 |
|----------|--------|------|
| Ingest | `concepts/wiki-ingest-workflow.md` | 流程步骤 + 设计考量，是独立知识单元 |
| Query | `concepts/wiki-query-synthesis.md` | "回答归档"是 Karpathy 文章中最独特的洞察，值得独立成页 |
| Lint | `concepts/wiki-health-check.md` | 检查维度 + 与工具分工，是独立知识单元 |

为什么拆而不是合？三个操作虽然在原文同一段落，但互相之间的依赖是"顺序调用"而非"概念耦合"——理解 ingest 不需要理解 lint。拆开后每个页面可以独立被查阅和引用。

#### 第 6 段：CLI 工具 + 第 7 段：Tips and tricks

**整段丢弃。** 这是在践行 kiwi Contract 的规则：DISCARD tool/plugin recommendations that are ecosystem-specific。qmd、Obsidian Web Clipper、Marp、Dataview 都是 Obsidian 生态的工具，与 ZooKeeper 项目无直接关系。如果丢弃的内容中包含可泛化的原则（如"下载图片到本地以备 LLM 阅读"），则应提炼原则而非保留工具推荐。本次蒸馏中判断该原则属于操作细节而非设计知识，一并丢弃

#### 第 8 段：Why this works → 分散融入

- "LLM 不厌其烦"的论点 → 融入 `concepts/wiki-health-check.md` 的 Overview（"用 LLM 的不厌其烦对抗知识库的熵增"）
- Memex 类比 → 保留在 `sources/notes/llm-wiki-karpathy.md` 的 References 中，不在 concept 页面展开（历史类比属于源材料的上下文，不是可操作的知识）
- "人类的职责是策展、LLM 的职责是维护"——编辑性叙事，与第 1 段表达的核心主张重复，丢弃

### 跨页结构设计

最终产出的 6 个页面的依赖关系：

```
sources/notes/llm-wiki-karpathy.md        ← 原始材料记录（所有页面的上游）
         │
         ▼
concepts/compounding-knowledge.md         ← 核心概念（被所有其他页面引用）
    │              │              │
    ▼              ▼              ▼
concepts/        concepts/       concepts/
wiki-ingest-     wiki-query-     wiki-health-
workflow.md     synthesis.md    check.md
    │              │
    └──────┬───────┘
           ▼
analysis/llm-wiki-vs-rag.md              ← 综合对比（消费 concepts 而生产 analysis）
```

这个结构反映了一条设计原则：**concept 页面是被引用的基础单元，analysis 页面是消费 concept 的产物。** 这种分层让不同读者可以按需深入：想了解"怎么用"读 concept，想做"该选哪个"读 analysis。

### 内联链接放置策略

内联链接遵循两条规则：

1. **每个独立阅读入口至少一个链接** — 短页面（一屏内）首次出现即链接；长页面每个可独立跳入的节（通过搜索或目录）内首次出现时也应链接
2. **跨语境重用的链接不省** — 同一个概念在不同节中承担不同角色时，各自保留独立的链接入口

当前 wiki 全部为短页面，因此表现上等价于"首次出现即链接"，但规则本身不绑定页面长度

## References

- 原文全文（不可变副本）：`raw/2026-06-18-karpathy-llm-wiki.md`
- 原文 URL：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## Relations

- [LLM Wiki — 用 LLM 构建个人知识库的模式](sources/notes/llm-wiki-karpathy.md) — 被蒸馏的原始材料
- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md) — 蒸馏出的核心概念页面之一
- [Wiki Ingest 工作流 — 源材料的增量整合](concepts/wiki-ingest-workflow.md) — 蒸馏出的操作页面之一
- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md) — 蒸馏出的操作页面之一
- [Wiki 健康检查 — 知识库的持续质量维护](concepts/wiki-health-check.md) — 蒸馏出的操作页面之一
- [LLM Wiki vs RAG — 两种知识管理范式的对比](analysis/llm-wiki-vs-rag.md) — 蒸馏出的综合对比页面

## Notes

> **蒸馏不是机械拆分。** 本文中"三层架构"没有独立成页、"索引日志格式"没有独立成页——这些是**有意识的合并而非遗漏**。蒸馏的判断标准是"这个知识单元是否在已有 wiki 中有更规范的表达？是否与其他已有页面高度重叠？"——如果答案是 yes，则不创建新页面，即使原文给了它独立的段落。
>
> **内联链接的首次 vs 重复：** 当前 wiki 页面都很短，因此"每个独立阅读入口至少一个链接"在表现上等价于"首次出现即链接"。随着页面增长（如 synthesis 页面可能达到数百行），规则的自然延伸是：每个二级标题下的节作为一个独立阅读入口，各自维护首次出现链接。`## Relations` 节保证无论读者从哪跳入都能发现交叉引用。
