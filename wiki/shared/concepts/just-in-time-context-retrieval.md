---
title: 即时上下文检索
description: Agent 维护轻量标识符并在运行时按需加载数据的检索模式——从预推理嵌入检索向 agentic 检索演进。
resource: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
type: concept
timestamp: 2026-07-21T00:00:00Z
tags: [context-engineering, retrieval, agentic-search, progressive-disclosure]
relations:
  - "[上下文工程](shared/concepts/context-engineering.md)"
  - "[有效上下文的构成](shared/concepts/context-anatomy.md)"
  - "[复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)"
  - "[长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)"
  - "[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)"
status: stable
last_validated: 2026-07-21T00:00:00Z
timeliness: current
---

# 即时上下文检索

> 即时上下文检索（just-in-time context retrieval）：agent 不预先加载所有相关数据，而是维护轻量标识符（文件路径、存储查询、web 链接），在运行时通过工具按需加载数据。这是从预推理嵌入检索向 agentic 检索的范式转移，是[上下文工程](shared/concepts/context-engineering.md)在运行时的核心策略。

## Overview

随着 agent 自主性增强，上下文检索从"预推理时嵌入检索"转向"运行时即时加载"（详见[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)）。agent 像人类使用文件系统和书签一样，在需要时才检索相关信息，而非预先记住整个语料。这是[有效上下文构成](shared/concepts/context-anatomy.md)在运行时的对应策略。

## Details

### 渐进式披露

Agent 通过探索增量发现相关上下文：文件大小暗示复杂度、命名约定暗示用途、时间戳可作相关性代理。agent 逐层组装理解，仅在工作记忆中保留必要内容。这种自管理的上下文窗口让 agent 聚焦于相关子集，而非淹没在详尽但可能无关的信息中。

### 元数据即信号

标识符的元数据提供了高效的行为精炼机制。文件名为 `test_utils.py` 位于 `tests/` 目录暗示的用途，不同于同名文件位于 `src/core_logic/`。文件夹层级、命名约定、时间戳都为 agent 提供何时、如何使用信息的重要信号。

### 混合策略

运行时探索比检索预计算数据更慢。最有效的 agent 常采用混合策略：部分数据预先加载以获得速度，其余按自主探索按需加载。决策边界取决于任务——动态性低的内容（如法律、财务文档）更适合预加载。该策略与长程任务的上下文管理中的笔记/[子 agent](shared/analysis/long-horizon-context-management.md) 技术互补；预编译的[复利知识](wiki-system/concepts/compounding-knowledge.md)是混合策略中"预加载"侧的实例。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)
- [有效上下文的构成](shared/concepts/context-anatomy.md)
- [上下文工程](shared/concepts/context-engineering.md)
- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)
- [复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)

## References

- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md) — 本地源文档摘要
- Anthropic, "Effective context engineering for AI agents" (2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

## Notes

> **待确认：** 文章提到无适当引导时 agent 可能误用工具、追逐死胡同或无法识别关键信息——即时检索的有效性高度依赖工具设计和启发式质量。
