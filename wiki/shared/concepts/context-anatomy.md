---
title: 有效上下文的构成
description: 上下文各组件（system prompt、工具、示例）的优化原则——每个组件都应最小而充分。
resource: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
type: concept
timestamp: 2026-07-21T00:00:00Z
tags: [context-engineering, system-prompt, tool-design, few-shot]
relations:
  - "[上下文工程](shared/concepts/context-engineering.md)"
  - "[即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)"
  - "[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)"
status: stable
last_validated: 2026-07-21T00:00:00Z
timeliness: current
---

# 有效上下文的构成

> [上下文工程](shared/concepts/context-engineering.md)的核心原则——用尽可能少的高信息量 token，让模型最可能产出期望结果——需应用于上下文的每个组件。三个关键组件各有其优化方法：system prompt 的正确高度、工具的 token 效率、示例的精选策略。

## Overview

本文展开上下文工程指导原则在三个静态组件上的具体应用，源自[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)。这些是构建 agent 时的基础实践，区别于运行时的动态检索策略。

## Details

### System Prompt：正确高度

Prompt 应在两个失败模式之间找到 Goldilocks 区域：

- **过低（过于模糊）** — 提供空泛的高层指导，缺乏具体信号，或错误假设共享上下文
- **过高（过于刚性）** — 硬编码复杂的 if-else 逻辑以诱导精确行为，导致脆弱性和维护成本

最优高度：足够具体以有效引导行为，又足够灵活以提供强启发式。建议用 XML 标签或 Markdown 标题将 prompt 组织为独立段落，追求充分描述期望行为的最小信息集。

### 工具：Token 效率

工具定义了 agent 与信息/动作空间的契约。运行时按需加载相关数据的检索策略见[即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)。优化原则：

- **自包含、健壮、用途清晰** — 类似设计良好的函数
- **功能无重叠** — 最常见的失败模式是臃肿工具集覆盖过多功能或导致模糊的工具选择
- **可决断性** — 如果人类工程师无法明确判断某情境下该用哪个工具，agent 也做不到

### 示例：精选而非堆砌

Few-shot 示例是"值千字的画面"，但不应把所有边缘情况塞入 prompt。应精选一组多样的、规范性的示例来有效展示期望行为，而非试图穷举每条规则。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [上下文工程](shared/concepts/context-engineering.md)
- [即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)
- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)

## References

- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md) — 本地源文档摘要
- Anthropic, "Effective context engineering for AI agents" (2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

## Notes

> **待确认：** 文章指出"随着模型能力提升，prompt 格式的重要性可能在下降"——XML 标签 vs Markdown 标头的选择是否仍是关键决策？
