---
title: Agent-Computer Interface
description: 确定性软件与非确定性 agent 之间的行为契约——工具定义、参数 schema 与错误反馈共同构成的控制面。
type: concept
timestamp: 2026-09-16T00:00:00Z
tags: [agent-design, aci, tool-use, tool-design]
status: stable
last_validated: 2026-09-16T00:00:00Z
timeliness: current
---

# Agent-Computer Interface

> Agent-computer interface（ACI）是 agent 与外部世界交互的接口层：工具定义、参数 schema、返回值和错误反馈共同构成控制面，其质量直接决定 agent 的行动路径质量。

## Overview

传统 API 连接两个确定性系统；ACI 连接确定性软件与可能产生不同执行路径的非确定性 agent。因此 ACI 不能只保证"能调用"，还要帮助 agent 判断何时使用、如何填写参数、如何处理结果和如何继续行动。ACI 是[增强型 LLM](agent-design/concepts/augmented-llm.md)构件中工具能力的暴露面。

## Details

### 设计目标

好的工具接口应：

- 明确用途、参数含义、边界和失败行为；
- 提供必要的输入格式、边缘情况和使用示例；
- 使用模型熟悉、自然出现的输出格式；
- 避免无谓的计数、转义和结构化开销；
- 通过参数设计让常见错误更难发生。

接口设计的目标不是增加规则数量，而是让正确动作成为最容易选择的动作。

### 接口验收：观察实际使用

工具不能只按 API 是否能运行来验收，还应观察模型如何实际使用它。测试过程应覆盖：

- 代表性输入；
- 错误参数和边界条件；
- 多个相似工具之间的选择；
- 工具结果返回后的下一步行为；
- 长路径中工作目录或状态变化后的调用。

工具接口不仅要能执行，还应根据真实工具调用轨迹评估 agent 是否选择正确工具、正确填写参数并有效处理结果。根据失败轨迹修改工具名称、描述和参数，比继续堆叠 system prompt 更可能解决工具误用问题。

### 从接口到工程闭环

ACI 回答"单个工具接口如何设计"；[Agent 工具设计](agent-design/concepts/agent-tool-design.md)将这一视角扩展为完整工程闭环——工具选择、namespace、响应格式、token 效率和结果导向评估。工具描述作为控制面的一部分，其协作场景的约束（互斥用途、先宽后窄的搜索策略）由[Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)展开。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agent 工具设计](agent-design/concepts/agent-tool-design.md)
- [增强型 LLM](agent-design/concepts/augmented-llm.md)
- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- [Anthropic Writing effective tools for agents 工程博客](agent-design/sources/notes/anthropic-writing-tools-for-agents.md)
- [Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [增强型 LLM](agent-design/concepts/augmented-llm.md) — ACI 的宿主构件
- [Agent 工具设计](agent-design/concepts/agent-tool-design.md) — ACI 的工程化扩展
- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- Anthropic, "Writing effective tools for AI agents — using agents": https://www.anthropic.com/engineering/writing-tools-for-agents

## Notes

> **待确认：** ACI 的提法来自 Anthropic 工程博客（类比 HCI）；不同宿主（OpenCode / pi / MCP client）对工具 schema 的支持程度不同，ACI 设计的可迁移性需按宿主验证。
