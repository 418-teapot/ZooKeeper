---
title: ZooKeeper Wiki 概览
description: ZooKeeper wiki 系统的结构化概览，涵盖设计哲学、三层架构、当前知识版图及工具与 Agent 的分工原则。
type: synthesis
timestamp: 2026-07-01T00:00:00Z
tags: [overview, wiki, knowledge-base]
relations:
  - "[复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)"
  - "[LLM Wiki — 用 LLM 构建个人知识库的模式](wiki-system/sources/notes/llm-wiki-karpathy.md)"
  - "[LLM Wiki vs RAG — 两种知识管理范式的对比](wiki-system/analysis/llm-wiki-vs-rag.md)"
  - "[Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md)"
  - "[Wiki 健康检查 — 知识库的持续质量维护](wiki-system/concepts/wiki-health-check.md)"
  - "[Query → Synthesis → 归档 — 查询即知识生产](wiki-system/concepts/wiki-query-synthesis.md)"
  - "[autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)"
  - "[autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)"
  - "[autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)"
  - "[MAD 置信度算法](autoresearch/concepts/mad-confidence.md)"
  - "[METRIC/ASI 文本协议](autoresearch/concepts/metric-asi-protocol.md)"
  - "[NPC 式分工](shared/concepts/npc.md)"
  - "[Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)"
status: stable
---

## Overview

> ZooKeeper wiki 系统是 [Karpathy LLM Wiki 模式](wiki-system/sources/notes/llm-wiki-karpathy.md) 的独立实现。核心理念来自[复利知识](wiki-system/concepts/compounding-knowledge.md)：将 LLM 作为知识库的持续维护者，通过三个核心操作（ingest / query / lint）让知识库产生复利增长，而非像 RAG 那样每次查询从零推导。

## Details

### 设计哲学

本 wiki 遵循"预编译而非实时拼凑"的设计原则：

- **知识编译一次，持续维护** — [ingest](wiki-system/concepts/wiki-ingest-workflow.md) 时不只追加新页面，而是涟漪式更新所有相关页面（交叉引用、摘要、矛盾标记）
- **查询即生产** — 有价值的[查询结果归档](wiki-system/concepts/wiki-query-synthesis.md)为 syntheses/ 页面，让探索也产生知识积累
- **抗熵增** — 定期[健康检查](wiki-system/concepts/wiki-health-check.md)扫描矛盾、过时声明、孤立页面

### 三层架构

| 层 | 说明 |
|----|------|
| 源材料 | 外部文档、URL、设计记录（不可变，LLM 只读） |
| Wiki 页面 | LLM 生成和维护的结构化 markdown 文件，按领域组织（每个域含 6 类目录） |
| SCHEMA.md | 格式规范与操作流程的约定文档（人机共演进） |

### 当前知识版图

Wiki 按领域组织，每个领域独立维护 6 类页面（concepts/entities/sources/analysis/syntheses 及 sources 的三个子类）。新增领域只需 `zwiki create --domain <name>` 即可自动创建骨架。

| 领域 | 页面数 | 核心内容 |
|------|--------|----------|
| autoresearch | 15 | 自主实验循环、扩展循环、实验版本管理、固定时间预算评估、[MAD 置信度](autoresearch/concepts/mad-confidence.md)、[METRIC/ASI 协议](autoresearch/concepts/metric-asi-protocol.md)、单文件修改原则；train.py/prepare.py/program.md 三个核心文件；设计权衡、移植路线图、性能调优模式；autoresearch 设计文档与原始提案 |
| wiki-system | 8 | 复利知识、ingest 工作流、query→synthesis 归档、健康检查、图链接预测；LLM Wiki vs RAG 对比、Karpathy 蒸馏示例；Karpathy LLM Wiki 原始材料 |
| shared | 4 | [NPC 式分工](shared/concepts/npc.md)、后验问责制、简约准则；[Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md) |

### 外部参考知识

- [autoresearch](autoresearch/sources/notes/autoresearch.md) — Karpathy 的 AI agent 自主 LLM 训练实验框架，为 ZooKeeper 的 agent 自动化设计提供参考。其核心机制（自主实验循环、NPC 式分工、单文件修改原则）与 ZooKeeper 的 agent 编排理念高度相关。
- [autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md) — oh-my-pi 的 [autoresearch 扩展](autoresearch/concepts/autoresearch-extension-loop.md)设计，为 ZooKeeper 的 agent 自动化和内核调优提供架构参考。核心机制（扩展循环、MAD 置信度、METRIC/ASI 协议）与 ZooKeeper 的插件架构和 perf-tuner 规划直接相关。

### 与 RAG 的本质区别

参见 [LLM Wiki vs RAG](wiki-system/analysis/llm-wiki-vs-rag.md) 的详细对比。最根本的差异在于知识状态：

- RAG：无状态，每次查询独立拼凑
- LLM Wiki：有状态，wiki 是持久化的中间产物，每次摄入和查询都让它更丰富

### 工具与 Agent 的分工原则

- **LLM（kiwi 等蒸馏 agent）** 负责判断性工作：提取、分类、组织、建议链接方向
- **工具脚本** 负责机械性工作：格式校验、关联对称性维护、孤立页面检测
- 交叉引用的双向对称性不应由 agent 保证 — 确定性程序比 LLM 更适合重复性机械操作

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
