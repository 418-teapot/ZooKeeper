---
title: Anthropic 上下文工程文章
description: Anthropic 关于 AI agent 有效上下文工程的工程博客——从 prompt engineering 到上下文精选的方法论。
type: source
timestamp: 2026-07-21T00:00:00Z
resource: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
tags: [context-engineering, agent-design, anthropic]
relations:
  - "[上下文工程](shared/concepts/context-engineering.md)"
  - "[上下文腐烂](shared/concepts/context-rot.md)"
  - "[有效上下文的构成](shared/concepts/context-anatomy.md)"
  - "[即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)"
  - "[长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)"
status: stable
last_validated: 2026-07-21T00:00:00Z
timeliness: current
---

# Anthropic 上下文工程文章

> Anthropic Applied AI 团队的工程博客，系统阐述 context engineering 的定义、动机、构成、运行时检索策略和长程任务管理技术。

## Overview

- **来源：** Anthropic Engineering Blog，2025-09-29 发布
- **作者：** Prithvi Rajasekaran, Ethan Dixon, Carly Ryan, Jeremy Hadfield 等（Applied AI 团队）
- **目标读者：** 构建 AI agent 的工程师

## Key Points

- [上下文工程](shared/concepts/context-engineering.md)是 prompt engineering 的自然演进——从写好 prompt 到精选整个上下文状态
- [上下文腐烂](shared/concepts/context-rot.md)使上下文成为有限资源，边际收益递减
- 指导原则：用尽可能少的高信息量 token，让模型最可能产出期望结果
- 上下文[构成](shared/concepts/context-anatomy.md)：prompt 高度、工具效率、示例精选
- [即时检索](shared/concepts/just-in-time-context-retrieval.md)替代预推理嵌入检索，agent 维护轻量标识符按需加载
- 长程任务三种技术：压缩、结构化笔记、[子 agent 架构](shared/analysis/long-horizon-context-management.md)

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [ZooKeeper Wiki 概览](overview.md)
- [有效上下文的构成](shared/concepts/context-anatomy.md)
- [上下文工程](shared/concepts/context-engineering.md)
- [上下文腐烂](shared/concepts/context-rot.md)
- [即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)

## References

- 原文 URL：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- 本地副本：`raw/2026-07-21-anthropic-context-engineering.md`（摄入时抓取的完整原文，不可变）
