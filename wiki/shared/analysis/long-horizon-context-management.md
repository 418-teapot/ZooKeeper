---
title: 长程任务的上下文管理
description: 三种应对上下文窗口限制的技术——压缩、结构化笔记、子 agent 架构——的对比与权衡。
resource: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
type: analysis
timestamp: 2026-07-21T00:00:00Z
tags: [context-engineering, long-horizon, compaction, agentic-memory, multi-agent]
sources:
  - shared/sources/notes/anthropic-context-engineering.md
relations:
  - "[上下文工程](shared/concepts/context-engineering.md)"
  - "[上下文腐烂](shared/concepts/context-rot.md)"
  - "[即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)"
  - "[Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)"
  - "[复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)"
status: stable
last_validated: 2026-07-21T00:00:00Z
timeliness: current
---

# 长程任务的上下文管理

> 长程任务（跨越数十分钟到数小时的连续工作）的 token 量超过 LLM 上下文窗口。[上下文腐烂](shared/concepts/context-rot.md)使等待更大上下文窗口不是根本解法——任何大小的窗口都受上下文污染影响。三种互补技术应对这一约束。

## Overview

本分析对比三种长程上下文管理技术。Anthropic 在 Claude Code 和多 agent 研究系统中实践了这些技术，其选择取决于任务特征。这些技术是[上下文工程](shared/concepts/context-engineering.md)在长程场景下的延伸，与运行时[即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)互补；预编译的[复利知识](wiki-system/concepts/compounding-knowledge.md)是笔记技术的实例化。

## Options Considered

### Option A：压缩（Compaction）

将接近上下文窗口上限的对话总结后重置为新窗口。

- **优点：** 保持对话流连续性；高保真蒸馏关键细节（架构决策、未解 bug、实现细节）
- **缺点：** 过度压缩可能丢失后续才显重要性的微妙上下文；keep vs discard 的选择是艺术
- **适用场景：** 需要大量来回对话的任务；维持对话流连续性

最轻量的压缩形式是工具结果清除——深埋在消息历史中的工具调用原始结果无需重复可见。调优建议：先最大化 recall 确保不丢关键信息，再迭代提升 precision 剔除冗余。

### Option B：结构化笔记（Agentic Memory）

Agent 定期将笔记持久化到上下文窗口之外的存储，后续再拉回上下文。

- **优点：** 以最小开销提供持久记忆；跨上下文重置保持连贯性；跟踪复杂任务进度与依赖
- **缺点：** 需要 agent 主动维护笔记纪律；笔记结构需任务适配
- **适用场景：** 有清晰里程碑的迭代开发；跨重置的多步骤策略

### Option C：子 Agent 架构（Sub-agent Architecture）

专门的子 agent 用干净上下文窗口处理聚焦任务，主 agent 协调高层计划。

- **优点：** 清晰的[关注点分离](shared/analysis/agent-skill-plugin-framework.md)——详细搜索上下文隔离在子 agent 内，主 agent 聚焦综合分析；子 agent 可消耗数万 token 但仅返回 1,000–2,000 token 摘要
- **缺点：** 协调开销；子 agent 间信息传递有损；架构复杂度
- **适用场景：** 复杂研究和分析；并行探索有收益的任务

## Conclusion

三种技术不互斥——实际长程 agent 常组合使用。选择取决于任务特征：压缩保持对话流；笔记擅于迭代里程碑；子 agent 架构适合并行探索。即使模型持续改进，跨扩展交互维持连贯性仍是核心挑战。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [上下文工程](shared/concepts/context-engineering.md)
- [上下文腐烂](shared/concepts/context-rot.md)
- [即时上下文检索](shared/concepts/just-in-time-context-retrieval.md)
- [Anthropic 上下文工程文章](shared/sources/notes/anthropic-context-engineering.md)

## References

- Anthropic, "Effective context engineering for AI agents" (2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, "How we built our multi-agent research system": https://www.anthropic.com/engineering/multi-agent-research-system

