---
title: 复利知识 — 持久化知识库的核心价值
description: 解释 LLM Wiki 通过预编译交叉引用和持久化中间产物实现知识复利增长的核心价值，区别于 RAG 每次查询从零推导的模式。
resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
type: concept
timestamp: 2026-06-18T00:00:00Z
tags: [wiki, knowledge-base, design-principle]
related:
  - concepts/wiki-ingest-workflow.md
  - concepts/wiki-query-synthesis.md
  - analysis/llm-wiki-vs-rag.md
  - concepts/graph-link-prediction.md
status: stable
---

## Overview

> RAG 的问题不是检索不准，而是**每次查询都从零推导**——知识没有积累。[LLM Wiki](sources/notes/llm-wiki-karpathy.md) 的核心转变在于：把知识编译一次、持续维护、复利增长。每[摄入](concepts/wiki-ingest-workflow.md)一个新源，不仅创建摘要，还同步更新所有相关页面。每提出一个好问题，[回答本身被归档](concepts/wiki-query-synthesis.md)为新知识。交叉引用、矛盾标记、综合摘要都是**预计算**的，查询时直接消费，而非实时拼凑。

## Details

### 问题：RAG 的"从零推导"模式

- 用户上传 n 个文档 → LLM 在查询时检索相关分块 → 实时拼凑答案
- 问题 1：**无积累**。问一个需要综合 5 个文档的问题，LLM 每次都要重新发现这些关系
- 问题 2：**无矛盾感知**。新文档说 X，旧文档说 Y，RAG 不会标记冲突
- 问题 3：**无增量更新**。新增一个文档不会触发已有知识的更新

详细的 RAG 与 LLM Wiki 的结构化对比见 [LLM Wiki vs RAG](analysis/llm-wiki-vs-rag.md)。

### 方案：持久化中间产物

LLM Wiki 在"源文档"和"查询"之间插入一个**持久化 wiki 层**：

- 源摄入时：提取关键信息 → 创建/更新实体页 → 更新主题摘要 → 标记矛盾 → 追加变更日志
- 查询时：直接导航已有结构（index → 相关页面 → 交叉引用），而非实时拼凑
- 好查询的结果：归档为 wiki 新页面，成为后续查询的数据库

### 类比：编译 vs 解释

| | RAG（解释执行） | LLM Wiki（编译） |
|---|---|---|
| 每次查询做什么 | 检索分块 → 实时综合 | 导航预建结构 → 补充推理 |
| 知识积累 | 无 | 每次 ingest/query 都沉淀 |
| 交叉引用 | 查询时发现 | 维护时建立，查询时复用 |

## Relations

- [Wiki Ingest 工作流 — 源材料的增量整合](concepts/wiki-ingest-workflow.md) — 摄入是复利积累的具体执行流程
- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md) — 查询→归档的闭环是复利机制的关键补充
- [LLM Wiki vs RAG — 两种知识管理范式的对比](analysis/llm-wiki-vs-rag.md) — 两种模式的结构化对比


## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](analysis/distillation-example-karpathy.md)
- [LLM Wiki vs RAG — 两种知识管理范式的对比](analysis/llm-wiki-vs-rag.md)
- [图链接预测 — 基于拓扑结构的缺失链接推断](concepts/graph-link-prediction.md)
- [Wiki 健康检查 — 知识库的持续质量维护](concepts/wiki-health-check.md)
- [Wiki Ingest 工作流 — 源材料的增量整合](concepts/wiki-ingest-workflow.md)
- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md)
- [LLM Wiki — 用 LLM 构建个人知识库的模式](sources/notes/llm-wiki-karpathy.md)

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- 类比来源：原文中 "The knowledge is compiled once and then kept current" 的比喻
