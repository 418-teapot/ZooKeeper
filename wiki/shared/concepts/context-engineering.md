---
title: 上下文工程
description: 从 prompt engineering 演进的方法论——在每次推理时精选最优 token 集合，而非仅优化 prompt 文本。
resource: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
type: concept
timestamp: 2026-07-21T00:00:00Z
tags: [context-engineering, agent-design, llm]
relations:
  - "[上下文腐烂](shared/concepts/context-rot.md)"
  - "[有效上下文的构成](shared/concepts/context-anatomy.md)"
  - "[即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)"
  - "[长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)"
  - "[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)"
status: stable
last_validated: 2026-07-21T00:00:00Z
timeliness: current
---

# 上下文工程

> 上下文工程（context engineering）是 prompt engineering 的自然演进。它不再只关注如何写好 system prompt，而是回答更广的问题：在每次推理时，从不断膨胀的信息宇宙中精选什么样的 token 集合最可能引导模型产生期望行为？指导原则是：**用尽可能少的高信息量 token，让模型最可能产出期望结果**。

## Overview

上下文工程是 Anthropic 提出的 agent 设计方法论（详见[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)），将"写好 prompt"升级为"精选整个上下文状态"。它是构建多轮推理 agent 的基础实践。

## Details

### 从 Prompt 工程到上下文工程

Prompt engineering 聚焦于编写和组织 LLM 指令（尤其 system prompt）以获得最优输出。但随着 agent 走向多轮推理和更长的时间跨度，需要管理的不只是 prompt 文本——而是整个上下文状态：system 指令、工具、外部数据、消息历史。

关键区别：prompt engineering 是离散的写作行为；上下文工程是迭代的——每次决定向模型传入什么时都发生精选。agent 在循环中生成越来越多潜在相关信息，这些信息必须被循环式精炼。

### 指导原则

好的上下文工程意味着**用尽可能少的高信息量 token，让模型最可能产出期望结果**。这一原则源于[上下文腐烂](shared/concepts/context-rot.md)的约束——上下文是有限资源，边际收益递减。它适用于上下文的每个组件（[构成](shared/concepts/context-anatomy.md)）、运行时[检索策略](shared/concepts/just-in-time-context-retrieval.md)、以及[长程任务](shared/analysis/long-horizon-context-management.md)的上下文延续。

"最小"不意味着"最短"——agent 仍需足够的 upfront 信息来确保行为一致性。实践中，先用最小 prompt 在最强模型上测试，再根据失败模式逐步添加指令和示例。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)
- [有效上下文的构成](shared/concepts/context-anatomy.md)
- [上下文腐烂](shared/concepts/context-rot.md)
- [即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)
- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)

## References

- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md) — 本地源文档摘要
- Anthropic, "Effective context engineering for AI agents" (2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- 本地副本：`raw/2026-07-21-anthropic-context-engineering.md`

