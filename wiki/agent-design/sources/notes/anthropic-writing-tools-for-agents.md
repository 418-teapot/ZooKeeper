---
title: Anthropic Writing effective tools for agents 工程博客
description: Anthropic 关于为 AI agent 选择、命名、描述、实现和评估工具的工程实践。
type: source
timestamp: 2026-09-16T00:00:00Z
resource: https://www.anthropic.com/engineering/writing-tools-for-agents
tags: [agent-design, tool-use, tool-design, evaluation, anthropic]
status: stable
last_validated: 2026-09-16T00:00:00Z
timeliness: current
---

# Anthropic Writing effective tools for agents 工程博客

> Anthropic 关于如何把工具从确定性 API 包装成适合非确定性 agent 使用的行为接口，并通过真实任务评估和迭代优化工具设计的工程博客。

## Overview

- **来源：** Anthropic Engineering Blog
- **原标题：** Writing effective tools for AI agents — using agents
- **发布日期：** 2025-09-11
- **蒸馏主题：** 工具选择、namespace、响应上下文、token 效率、工具描述和评估闭环
- **主要结论：** 高质量工具应有清晰边界，返回高信号上下文，使用明确的描述和 schema，并通过真实任务与 held-out 测试集持续验证

## Details

### 工具是 agent 的行为契约

传统函数通常连接两个确定性系统；agent 工具连接确定性软件与会产生不同执行路径的非确定性模型。因此，工具不能只复刻底层 API，还要帮助 agent 判断何时使用、如何填写参数、如何处理结果和如何继续行动——这把工具定义推上了 [agent-computer interface](agent-design/concepts/agent-computer-interface.md) 的核心位置。

### 评估驱动的改进闭环

文章建议先快速搭建工具原型，再用真实工作流生成大量评估任务。每个任务都应有可验证的响应或最终状态，验证器要避免因格式或等价措辞差异而误判正确结果。

评估除准确率外，还应记录工具调用次数、运行时间、token 消耗和工具错误。分析时不能只看 agent 自己的反馈，还要检查完整 transcript、工具调用和工具返回值。使用 held-out 测试集可以避免工具只对生成任务过拟合——[多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)同样主张以结果和过程指标评估，而非复现固定轨迹。

### 四类工具设计原则

文章将可迁移原则归纳为：

- 选择少量面向高价值工作流的工具，避免功能重叠和低价值 API 包装；
- 用 namespace 和自然的资源边界帮助 agent 在大量工具中作出选择；
- 返回相关、语义化、可继续调用的上下文，并控制响应 token 数量；
- 用清晰的工具描述、无歧义的参数名和严格 schema 明确输入、输出及失败行为。

分页、过滤、范围选择、截断和有指导性的错误消息，既能减少上下文消耗，也能引导 agent 采用更有效的检索策略——后者正是[即时上下文检索](context-engineering/concepts/just-in-time-context-retrieval.md)依赖的渐进式披露。

### 蒸馏范围与保留边界

保留文章中可迁移到 ZooKeeper 的工具设计和评估原则，它们已蒸馏为[Agent 工具设计](agent-design/concepts/agent-tool-design.md)概念页。

丢弃 Claude Code、Claude Desktop、DXT、MCP CLI 和具体 Anthropic API 的接入步骤；这些内容属于产品或生态操作说明。Slack、Asana 等内部工具的性能图表和案例只作为评估方法的论据，不把具体数字或产品实现当作通用结论。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agent 工具设计](agent-design/concepts/agent-tool-design.md)
- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- [Anthropic 上下文工程文章](context-engineering/sources/notes/anthropic-context-engineering.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- 原文完整副本：`raw/2026-09-16-anthropic-writing-tools-for-agents.md`
- Anthropic, "Writing effective tools for AI agents — using agents": https://www.anthropic.com/engineering/writing-tools-for-agents
- [Agent 工具设计](agent-design/concepts/agent-tool-design.md)
- [增强型 LLM](agent-design/concepts/augmented-llm.md)
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)

## Notes

> **待确认：** 文章建议使用 agent 参与工具优化，但没有给出跨模型、跨任务的统一收益阈值；调用方应将模型自我分析视为候选诊断，仍需通过独立评估确认。
