---
title: Wiki Ingest 工作流 — 源材料的增量整合
type: concept
created: 2026-06-18
updated: 2026-06-18
tags: [wiki, workflow, ingest]
related:
  - concepts/compounding-knowledge.md
  - concepts/wiki-query-synthesis.md
  - concepts/wiki-health-check.md
  - sources/notes/llm-wiki-karpathy.md
status: stable
---

## Overview

> Ingest 是 LLM Wiki 的核心写入操作：将一个新源材料**结构性整合**进已有知识库，而非简单追加。一个源的摄入可能触碰 10-15 个页面——这不是 bug，是 feature。它体现了[复利知识](concepts/compounding-knowledge.md)的核心理念：每个新输入都通过交叉引用和摘要更新让整个知识库更丰富。

## Details

### Ingest 流程（最小完整路径）

1. **读取源材料** — 理解完整内容，非分块检索
2. **提取关键信息** — 识别概念、实体、决策、矛盾
3. **创建源摘要页** — `sources/` 下记录原始材料元信息和摘要
4. **创建/更新实体页和概念页** — 把提取的知识分配到对应目录
5. **更新交叉引用** — 新页面链接到已有页面，已有页面反向链接
6. **更新 index.md** — 追加新页面条目
7. **追加 log.md** — 记录摄入操作
8. **判断 overview.md** — 如果新知识显著改变整体认知，重写综合摘要

### 设计要点

- **一次一源（推荐）** — Karpathy 偏好逐个摄入并参与审查，而非批量摄入。调用方自行决定策略。
- **触碰多页面是预期行为** — 一个源材料的知识分布在多个概念域中是常态，不是过度工程
- **调用方参与度可变** — 从"LLM 全自动"到"每步审查"，取决于调用方偏好
- **复杂源材料委派蒸馏专家** — 非结构化或复杂的源材料应委派专门的蒸馏 agent（如 ZooKeeper 的 kiwi）处理，而非由调用方 agent 直接写入。详见 `sources/notes/llm-wiki-karpathy.md`

## Relations

- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md) — ingest 是复利积累的主要执行机制
- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md) — query 的结果也可以触发类似 ingest 的归档操作
- [Wiki 健康检查 — 知识库的持续质量维护](concepts/wiki-health-check.md) — [lint](concepts/wiki-health-check.md) 是 ingest 质量的事后验证


## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](analysis/distillation-example-karpathy.md)
- [LLM Wiki vs RAG — 两种知识管理范式的对比](analysis/llm-wiki-vs-rag.md)
- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md)
- [Wiki 健康检查 — 知识库的持续质量维护](concepts/wiki-health-check.md)
- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md)
- [LLM Wiki — 用 LLM 构建个人知识库的模式](sources/notes/llm-wiki-karpathy.md)

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
