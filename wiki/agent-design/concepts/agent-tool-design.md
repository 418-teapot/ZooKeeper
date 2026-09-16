---
title: Agent 工具设计
description: 面向非确定性 agent 设计工具的原则——用清晰边界、高信号返回值、可操作描述和结果导向评估提升工具使用质量。
resource: https://www.anthropic.com/engineering/writing-tools-for-agents
type: concept
timestamp: 2026-09-16T00:00:00Z
tags: [agent-design, tool-use, tool-design, context-engineering, evaluation]
status: stable
last_validated: 2026-09-16T00:00:00Z
timeliness: current
---

# Agent 工具设计

## Overview

> 面向 agent 的工具不是面向程序调用者的 API 薄包装，而是 agent 与信息、动作空间之间的行为契约；设计重点是让正确的工具选择、参数填写和后续行动变得自然且可评估。

## Details

### 选择高价值工具并划清边界

工具应围绕高影响、可验证的工作流设计，而不是机械地把每个底层 API endpoint 暴露给 agent。一个工具可以在内部组合多个查询或动作，直接完成一个人类会识别的任务，并减少中间结果对[上下文资源](context-engineering/concepts/context-rot.md)的占用。

优先选择少量用途明确、彼此互不重叠的工具：

- 用 `search_contacts` 替代把全部联系人返回给 agent 的 `list_contacts`；
- 用 `schedule_event` 封装可用性查询和事件创建；
- 用 `search_logs` 返回相关日志及周边上下文，而不是让 agent 读取完整日志；
- 用 `get_customer_context` 合并客户近期相关的交易、备注和状态。

工具数量不是能力的直接指标。重叠工具会增加选择歧义——[有效上下文的构成](context-engineering/concepts/context-anatomy.md)将其列为最常见的工具失败模式——过于通用的工具会把本可由工具完成的筛选、聚合和组合工作转移给 agent。

当工具按服务或资源形成自然边界时，应使用清晰的 namespace，例如按服务区分 `asana_*` 和 `jira_*`，或按资源区分项目、用户和任务工具。前缀式与后缀式命名的优劣取决于模型和任务，应通过本地评估选择。

### 返回高信号且可继续使用的上下文

工具返回值应优先提供能影响下一步行动的信息，而不是底层实现细节。语义化名称通常比 UUID 或其他难以解释的标识符更容易被 agent 正确检索和复用；只有在后续工具确实需要技术标识符时才应返回它们。

需要同时支持人类可读性和后续调用时，可以提供由 agent 选择的响应格式，例如 `concise` 与 `detailed`。格式应服务于任务，而不是单纯追求结构化程度；JSON、XML 或 Markdown 的最佳选择需要通过评估确认。

工具还应对大结果提供分页、范围选择、过滤和截断，并为截断结果说明如何继续获取信息；这些机制支撑了[即时上下文检索](context-engineering/concepts/just-in-time-context-retrieval.md)所依赖的渐进式探索。输入校验错误也应返回具体、可执行的修正建议，而不是只暴露错误码或堆栈。

### 用描述和 schema 约束正确行为

工具描述应像向新成员介绍工作一样，把实现者默认知道但 agent 不一定知道的内容明确写出：

- 工具的目的、适用边界和不应使用的场景；
- 领域术语、资源之间的关系和特殊查询格式；
- 输入参数的真实含义、格式、限制和边缘情况；
- 输出字段、单位、标识符含义和可能的失败结果。

参数名应避免歧义，例如使用 `user_id` 而不是同时可能表示姓名或标识符的 `user`。严格的数据模型应与描述共同防止无效输入，而不是只依赖 prompt 提醒。

描述和 schema 是 [agent-computer interface](agent-design/concepts/agent-computer-interface.md) 的控制面。它们不应试图硬编码所有可能的执行轨迹，而应提供足够具体的信号，让 agent 能根据环境反馈组合工具。

### 用真实任务评估并迭代

工具验收不能只检查 API 是否能成功执行。应建立由真实工作流产生的任务集，并为每个任务定义可验证的结果或状态。任务应包含多步工具调用、真实数据复杂度和合理的替代路径，避免只测试孤立的参数查询。

评估时同时记录：

- 最终结果的正确性和完整性；
- 工具选择、调用次数和重复调用；
- 工具错误、参数错误和响应处理问题；
- 总运行时间、token 消耗和任务成本；
- 工具描述或 schema 修改前后的表现。

应阅读原始 transcript、工具调用和工具返回值，而不只依赖 agent 自己的反馈。工具名称、参数、返回格式和描述都应根据失败轨迹迭代，并使用 held-out 测试集避免只优化训练任务；这与[多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)的结果导向立场一致——不预设唯一执行路径，检查结果与资源使用。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agent-Computer Interface](agent-design/concepts/agent-computer-interface.md)
- [增强型 LLM](agent-design/concepts/augmented-llm.md)
- [Anthropic Writing effective tools for agents 工程博客](agent-design/sources/notes/anthropic-writing-tools-for-agents.md)
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)
- [上下文工程](context-engineering/concepts/context-engineering.md)
- [即时上下文检索](context-engineering/concepts/just-in-time-context-retrieval.md)
- [多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)
- [Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [增强型 LLM](agent-design/concepts/augmented-llm.md)
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)
- [上下文工程](context-engineering/concepts/context-engineering.md)
- [即时上下文检索](context-engineering/concepts/just-in-time-context-retrieval.md)
- [多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)
- [Anthropic Writing effective tools for agents 工程博客](agent-design/sources/notes/anthropic-writing-tools-for-agents.md)
- Anthropic, "Writing effective tools for AI agents — using agents": https://www.anthropic.com/engineering/writing-tools-for-agents

## Notes

> **待确认：** 文章中的命名方式、响应格式和模型优化收益来自 Anthropic 的内部评估与经验；它们应作为待验证启发式，而不是不依赖模型、任务和运行时的普适规则。
