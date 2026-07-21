---
title: 上下文腐烂
description: 随上下文 token 数增加，LLM 信息召回能力下降的现象——上下文是有限资源，边际收益递减。
resource: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
type: concept
timestamp: 2026-07-21T00:00:00Z
tags: [context-engineering, llm, attention, context-rot]
relations:
  - "[上下文工程](shared/concepts/context-engineering.md)"
  - "[长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)"
  - "[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)"
status: stable
last_validated: 2026-07-21T00:00:00Z
timeliness: current
---

# 上下文腐烂

> 上下文腐烂（context rot）：随着上下文窗口中 token 数量增加，模型从该上下文中准确召回信息的能力下降。这一现象在所有模型中普遍存在，使上下文必须被视为有限资源。它是[上下文工程](shared/concepts/context-engineering.md)的根本动机。

## Overview

上下文腐烂是 needle-in-a-haystack 基准测试揭示的现象，由 Chroma Research 命名，[Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)系统阐述了其影响。它解释了为什么更大的上下文窗口不能消除对上下文工程的需求——任何大小的窗口都受腐烂约束，[长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)需要专门技术应对。

## Details

### 现象

上下文腐烂的核心发现：token 越多，召回越差。部分模型的退化曲线更平缓，但该特征跨所有模型存在。每个新引入的 token 都会消耗模型的"注意力预算"（attention budget），增加精选上下文的必要性。

### 架构原因

- **n² 注意力** — Transformer 架构使每个 token 关注所有其他 token，产生 n² 个配对关系。上下文越长，捕捉这些关系的精度越被稀释
- **训练分布偏差** — 模型的注意力模式源于训练数据，其中短序列远比长序列常见。模型对长上下文依赖的专用参数更少

位置编码插值等技术允许模型处理更长序列，但以 token 位置理解退化为代价。

### 性能梯度而非悬崖

上下文腐烂产生的是性能梯度而非硬性悬崖：模型在长上下文下仍高度可用，但信息检索和长程推理的精度可能下降。这意味着等待更大上下文窗口不是根本解法——所有大小的窗口都受上下文污染影响。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [长程任务的上下文管理](shared/analysis/long-horizon-context-management.md)
- [上下文工程](shared/concepts/context-engineering.md)
- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)

## References

- Anthropic, "Effective context engineering for AI agents" (2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Chroma Research, "context rot": https://research.trychroma.com/context-rot

## Notes

> **待确认：** 不同模型族（Claude / GPT / Gemini）的 context rot 退化曲线差异尚需独立验证。
