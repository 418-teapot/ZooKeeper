---
title: ZooKeeper Wiki 概览
type: synthesis
created: 2026-06-18
updated: 2026-06-18
tags: [overview, wiki, knowledge-base]
related:
  - sources/notes/autoresearch.md
  - concepts/autonomous-experiment-loop.md
  - concepts/compounding-knowledge.md
  - concepts/wiki-ingest-workflow.md
  - concepts/wiki-query-synthesis.md
  - concepts/wiki-health-check.md
  - analysis/llm-wiki-vs-rag.md
  - concepts/wiki-ingest-workflow.md
  - concepts/wiki-query-synthesis.md
  - concepts/wiki-health-check.md
  - analysis/llm-wiki-vs-rag.md
status: stable
---

## Overview

> ZooKeeper wiki 系统是 [Karpathy LLM Wiki 模式](sources/notes/llm-wiki-karpathy.md) 的独立实现。核心理念来自[复利知识](concepts/compounding-knowledge.md)：将 LLM 作为知识库的持续维护者，通过三个核心操作（ingest / query / lint）让知识库产生复利增长，而非像 RAG 那样每次查询从零推导。

## Details

### 设计哲学

本 wiki 遵循"[预编译而非实时拼凑](concepts/compounding-knowledge.md)"的设计原则：

- **知识编译一次，持续维护** — [ingest](concepts/wiki-ingest-workflow.md) 时不只追加新页面，而是涟漪式更新所有相关页面（交叉引用、摘要、矛盾标记）
- **查询即生产** — 有价值的[查询结果归档](concepts/wiki-query-synthesis.md)为 syntheses/ 页面，让探索也产生知识积累
- **抗熵增** — 定期[健康检查](concepts/wiki-health-check.md)扫描矛盾、过时声明、孤立页面

### 三层架构

| 层 | 说明 |
|----|------|
| 源材料 | 外部文档、URL、设计记录（不可变，LLM 只读） |
| Wiki 页面 | LLM 生成和维护的结构化 markdown 文件（6 个分类目录） |
| SCHEMA.md | 格式规范与操作流程的约定文档（人机共演进） |

### 当前知识版图

| 分类 | 页面数 | 核心内容 |
|------|--------|----------|
| Concepts | 10 | 复利知识、ingest 工作流、query→synthesis 归档、健康检查、自主实验循环、固定时间预算评估、单文件修改原则、NPC 式分工、简约准则、实验版本管理 |
| Entities | 3 | train.py、prepare.py、program.md（autoresearch 核心文件） |
| Sources → Notes | 2 | Karpathy LLM Wiki 模式原始提案、autoresearch 自主实验框架 |
| Analysis | 3 | LLM Wiki vs RAG 结构化对比、蒸馏示例、autoresearch 设计权衡分析 |

### 外部参考知识

- [autoresearch](sources/notes/autoresearch.md) — Karpathy 的 AI agent 自主 LLM 训练实验框架，为 ZooKeeper 的 agent 自动化设计提供参考。其核心机制（自主实验循环、NPC 式分工、单文件修改原则）与 ZooKeeper 的 agent 编排理念高度相关。

### 与 RAG 的本质区别

参见 [LLM Wiki vs RAG](analysis/llm-wiki-vs-rag.md) 的详细对比。最根本的差异在于知识状态：

- RAG：无状态，每次查询独立拼凑
- LLM Wiki：有状态，wiki 是持久化的中间产物，每次摄入和查询都让它更丰富

### 工具与 Agent 的分工原则

- **LLM（kiwi 等蒸馏 agent）** 负责判断性工作：提取、分类、组织、建议链接方向
- **工具脚本** 负责机械性工作：格式校验、关联对称性维护、孤立页面检测
- 交叉引用的双向对称性不应由 agent 保证 — 确定性程序比 LLM 更适合重复性机械操作

## Relations

- `concepts/compounding-knowledge.md` — 本 wiki 遵循的核心设计哲学
- `sources/notes/llm-wiki-karpathy.md` — 设计理念来源的原始材料
- `analysis/llm-wiki-vs-rag.md` — 与其他知识管理范式的边界

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
