---
title: LLM Wiki — 用 LLM 构建个人知识库的模式
description: Karpathy 提出的用 LLM 增量构建和维护结构化交叉引用 markdown wiki 的知识管理模式。
type: source
timestamp: 2026-06-18T00:00:00Z
resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
tags: [wiki, knowledge-base, llm, pattern]
related:
  - wiki-system/concepts/compounding-knowledge.md
  - wiki-system/concepts/wiki-ingest-workflow.md
  - wiki-system/concepts/wiki-query-synthesis.md
  - wiki-system/concepts/wiki-health-check.md
  - wiki-system/analysis/llm-wiki-vs-rag.md
status: stable
---

## Overview

> Andrej Karpathy 提出的 [LLM Wiki](wiki-system/analysis/llm-wiki-vs-rag.md) 模式：将 LLM 作为知识库的"维护者"，增量构建和维持一个结构化、交叉引用的 markdown wiki，替代传统的 RAG 检索方案。核心理念是让知识库成为一个[复利增长](wiki-system/concepts/compounding-knowledge.md)的持久化产物，而非每次查询时从零推导。

## Details

- **来源：** Gist 非正式提案，目标读者是有 LLM agent 使用经验的开发者
- **三个核心操作：** [ingest](wiki-system/concepts/wiki-ingest-workflow.md)（摄入）→ [query](wiki-system/concepts/wiki-query-synthesis.md)（查询）→ [lint](wiki-system/concepts/wiki-health-check.md)（健康检查）
- **三层架构：** 原始源材料（不可变）→ wiki（LLM 全权维护）→ schema（约定文档，人机共演进）
- **与 ZooKeeper 的关系：** ZooKeeper 的 wiki 系统是该模式的独立实现。Karpathy 的文章可视为其设计理念的独立阐述，二者的差异见 LLM Wiki vs RAG

## Relations

- [复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md) — "复利知识"是该文的核心设计原则
- [Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md) — ingest 是三个核心操作之一
- [Query → Synthesis → 归档 — 查询即知识生产](wiki-system/concepts/wiki-query-synthesis.md) — query→归档的闭环
- [Wiki 健康检查 — 知识库的持续质量维护](wiki-system/concepts/wiki-health-check.md) — lint 是持续质量维护机制
- [LLM Wiki vs RAG — 两种知识管理范式的对比](wiki-system/analysis/llm-wiki-vs-rag.md) — 文中通过对比 RAG 来定义 LLM Wiki 模式


## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [ZooKeeper Wiki 概览](overview.md)
- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](wiki-system/analysis/distillation-example-karpathy.md)
- [LLM Wiki vs RAG — 两种知识管理范式的对比](wiki-system/analysis/llm-wiki-vs-rag.md)
- [复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)
- [Wiki 健康检查 — 知识库的持续质量维护](wiki-system/concepts/wiki-health-check.md)
- [Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md)

## References

- 原文 URL：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- 本地副本：`raw/2026-06-18-karpathy-llm-wiki.md`（摄入时抓取的完整原文，不可变）
- Memex 参考：Vannevar Bush, "As We May Think" (1945)
