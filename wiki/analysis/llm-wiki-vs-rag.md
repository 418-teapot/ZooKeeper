---
title: LLM Wiki vs RAG — 两种知识管理范式的对比
description: LLM Wiki 与 RAG 两种知识管理哲学在知识状态、增长方式和价值曲线上的系统对比。
resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
type: analysis
timestamp: 2026-06-18T00:00:00Z
tags: [wiki, rag, comparison, knowledge-management]
sources:
  - sources/notes/llm-wiki-karpathy.md
related:
  - concepts/compounding-knowledge.md
  - concepts/graph-link-prediction.md
status: stable
---

## Overview

> Karpathy 在文章中通过对比 RAG 来定义 [LLM Wiki](sources/notes/llm-wiki-karpathy.md) 模式。这个对比不是技术优劣的评判，而是**两种截然不同的知识管理哲学**：RAG 走"实时检索→综合→丢弃"路径；LLM Wiki 走"预编译→存储→[复利](concepts/compounding-knowledge.md)"路径。

## Details

### 核心差异

| 维度 | RAG | LLM Wiki |
|------|-----|----------|
| **知识状态** | 无状态 — 每次查询独立 | 有状态 — wiki 是持久化的中间产物 |
| **知识增长** | 静态 — 增加文档不自动更新已有知识 | 动态 — 每次 [ingest](concepts/wiki-ingest-workflow.md) 涟漪式更新相关页面 |
| **查询成本** | 每次都需要检索 → 综合 → 推理 | 大部分推理已预计算（交叉引用、摘要、矛盾标记） |
| **矛盾处理** | 不处理 — 可能检索到冲突分块并产生混淆 | 主动标记 — ingest 时注明新旧矛盾 |
| **价值曲线** | 线性 — n 个文档 ≈ n 次独立查询价值 | 超线性 — 交叉引用让 n 个文档产生 n² 级关联价值 |

### 适用场景

- **RAG 更适合：** 文档集频繁变化、单次查询为主、不需要长期积累的场景（如客服知识库的一次性检索）
- **LLM Wiki 更适合：** 个人/团队长期研究、知识需要综合和对比、需要"知识复利"的场景

### 边界与混合

- RAG 可在 LLM Wiki 中作为**补充检索层**使用（如用全文搜索引擎辅助 index 导航）
- 两种模式并非互斥 — LLM Wiki 是"预编译 + 推理"，RAG 是"检索 + 推理"，可以组合

## Relations

- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md) — "复利知识"是 LLM Wiki 模式区别于 RAG 的核心哲学


## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](analysis/distillation-example-karpathy.md)
- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md)
- [图链接预测 — 基于拓扑结构的缺失链接推断](concepts/graph-link-prediction.md)
- [LLM Wiki — 用 LLM 构建个人知识库的模式](sources/notes/llm-wiki-karpathy.md)

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## Notes

> **待确认：** Karpathy 原文中未严格定义 RAG，用的是宽泛含义（"ChatGPT file uploads, NotebookLM"）。本文的分析基于他对 RAG 的描述（"retrieve relevant chunks at query time"），不包括带记忆或持久化层的 RAG 变体。
