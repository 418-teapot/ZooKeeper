---
title: Anthropic Building Effective Agents 工程博客
description: Anthropic 关于 workflow、agent、增强型 LLM 和可靠 agent 系统设计模式的工程博客摘要。
type: source
timestamp: 2026-09-15T06:15:36Z
resource: https://www.anthropic.com/engineering/building-effective-agents
tags: [agent-design, workflow, agent, anthropic, tool-design]
status: stable
last_validated: 2026-09-16T01:55:38Z
timeliness: current
---

# Anthropic Building Effective Agents 工程博客

> Anthropic 对 agentic systems 的工程经验总结：先用最简单的 LLM 方案解决问题，再按可验证收益逐步引入 workflow、工具调用和自主 agent。

## Overview

- **来源：** Anthropic Engineering Blog
- **标题：** Building effective agents
- **发布时间：** 2024-12-19
- **主要主题：** augmented LLM、workflow 与 agent 的区分、五种 workflow 模式、agent loop、工具设计和复杂度控制
- **蒸馏范围：** 保留可迁移的架构模式与设计原则，丢弃客户案例、产品推荐和特定模型版本信息

## Details

### 核心区分

文章把使用 LLM 和工具的系统统称为 agentic systems，但区分两种架构：

- **Workflow：** 由预先定义的代码路径编排 LLM 和工具。
- **Agent：** 由 LLM 动态决定处理过程和工具使用方式。

Workflow 更适合步骤清晰、可预先分解的任务；agent 更适合步骤数量和路径难以预先确定的开放式任务。

### 基础构件

agentic system 的基本构件是 augmented LLM，即具备检索、工具和记忆能力的 LLM。模型可以生成搜索查询、选择工具，并判断需要保留的信息。

这些能力必须具有清晰、可记录、易测试的接口。工具定义不是外围实现细节，而是 agent 与外部世界之间的主要控制面。后续的[Writing effective tools for agents 工程博客](agent-design/sources/notes/anthropic-writing-tools-for-agents.md)进一步专门讨论工具边界、响应上下文和评估闭环。

### Workflow 模式

文章总结了五种常见模式：

- **Prompt chaining：** 上一步输出作为下一步输入，可在中间步骤设置程序化 gate。
- **Routing：** 先分类，再把输入交给不同的专用流程。
- **Parallelization：** 并行执行独立子任务，或对同一任务进行多次投票。
- **Orchestrator-workers：** 中央 LLM 根据输入动态拆解任务并委派 worker。
- **Evaluator-optimizer：** 一个 LLM 生成结果，另一个 LLM 评价并反馈，循环改进。

这些模式不是互斥框架，而是可以根据任务特征组合的控制结构。

### Agent 运行方式

agent 通常以用户指令或对话开始，在循环中执行以下动作：

1. 规划下一步；
2. 调用工具；
3. 从环境结果获得 ground truth；
4. 根据反馈调整计划；
5. 在完成、阻塞或达到停止条件时结束。

自主性提高了开放式任务的适应能力，也提高了延迟、成本和错误累积风险，因此需要沙箱、guardrail、检查点和最大迭代次数等控制措施。

### 总体原则

文章反复强调：

- 从单次 LLM 调用和检索开始；
- 只有在评估显示简单方案不足时才增加复杂度；
- 明确展示 agent 的规划过程；
- 将工具文档、参数设计和测试视为 [agent-computer interface](agent-design/concepts/agent-computer-interface.md) 的核心工作；
- 用结果质量和实际任务表现，而不是系统复杂度衡量成功。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agentic System 选择分析](agent-design/analysis/agentic-system-selection.md)
- [LLM Workflow 模式](agent-design/analysis/llm-workflow-patterns.md)
- [Agent-Computer Interface](agent-design/concepts/agent-computer-interface.md)
- [增强型 LLM](agent-design/concepts/augmented-llm.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents
- 原文完整副本：`raw/2026-09-15-anthropic-building-effective-agents.md`

## Notes

> **待确认：** 原文发表于 2024-12-19，并明确说明其中部分 tooling landscape 已发生变化。本摘要保留架构原则，不将文中具体 SDK、模型名称或产品建议视为当前推荐。
