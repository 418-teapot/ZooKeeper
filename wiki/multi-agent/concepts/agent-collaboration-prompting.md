---
title: Agent 协作的 prompt 与工具设计
description: 通过明确委派契约、按复杂度分配工作量、工具启发式和反馈循环控制多 agent 协作行为。
type: concept
timestamp: 2026-09-14T02:14:29Z
tags: [multi-agent, prompt-engineering, tool-design, delegation, evaluation]
status: stable
last_validated: 2026-09-14T02:14:29Z
timeliness: current
---

# Agent 协作的 prompt 与工具设计

> 多 agent 系统的 prompt 不只是描述单个 agent 要做什么，还必须规定如何分工、如何选择工具、如何控制投入，以及何时停止或继续协作。

## Overview

单 agent prompt 的局部优化不足以控制[多 agent 系统](multi-agent/analysis/multi-agent-evaluation-reliability.md)的涌现行为。在[多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)中，lead agent、subagent 和工具接口共同构成协作协议；这些原则提炼自 Anthropic 的[多 agent 研究系统工程实践](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)，是[上下文工程](context-engineering/concepts/context-engineering.md)在协作场景的具体化。改进应从真实失败轨迹出发，以启发式和边界约束引导行为，而不是把所有步骤硬编码成固定流程。

## Details

### 委派契约

任务描述应遵循[有效上下文的构成](context-engineering/concepts/context-anatomy.md)的高信息量原则，每个 subtask 至少应明确：

- 研究目标和需要回答的问题
- 输出格式与交付粒度
- 应使用的工具和优先来源
- 与其他 subagent 的任务边界
- 完成标准和不应继续扩展的范围

只有"研究某个主题"之类的短指令容易导致重复搜索、范围误解和覆盖空缺。lead agent 的拆解质量决定了并行执行是否产生互补信息。

### 按复杂度分配 effort

prompt 应包含 effort scaling 规则，而不是让 agent 对所有问题采用同一资源预算。简单事实查询可以使用一个 agent 和少量工具调用；比较任务需要多个方向；复杂研究则需要更多 subagent，但每个 subagent 必须拥有清晰且不重叠的责任。

这种规则同时控制质量和成本，防止简单问题启动过多 subagent，也防止复杂问题只进行浅层搜索。任务是否值得这种投入，可参考[Agent/Skill/Plugin 判断框架](agent-design/analysis/agent-skill-plugin-framework.md)的并行执行与上下文隔离维度。

### 工具接口与搜索策略

工具描述应有清晰、互斥的用途，帮助 agent 根据用户意图选择正确工具。agent 应先了解可用工具，再匹配工具与任务；广泛探索使用通用搜索，已有专门数据源时优先使用专用工具。

搜索过程通常应先宽后窄：先用短而宽泛的查询了解信息版图，再根据发现逐步收窄。过早写出很长、很具体的查询容易返回稀疏结果并锁定错误方向。工具定义本身是 agent-computer interface 的控制面；关于格式开销、参数防错、边界说明和工具使用测试的系统化原则见[增强型 LLM](agent-design/concepts/augmented-llm.md)。

### 用失败轨迹改进系统

prompt 迭代应使用与生产系统相同的 prompt 和工具进行模拟，观察 agent 每一步的选择。常见可诊断失败包括：已有足够结果仍继续搜索、查询过度冗长、选错工具、来源质量偏低和多个 subagent 重复工作。

Claude 4 等强模型也可以参与改进 prompt 或工具描述：让一个 agent 重现工具失败，诊断误用原因，再提出更清晰的描述。该方式仍需要测试闭环验证，不能把模型建议直接视为正确答案。

### 思维过程作为控制面

extended thinking 可用于让 lead agent 规划工具、判断任务复杂度、确定 subagent 数量和划分角色。subagent 在每次工具返回后进行 interleaved thinking，可重新评估来源质量、识别信息缺口并调整下一次搜索。

这些机制不是为了强制固定轨迹，而是为 agent 提供检查点，使其能根据中间发现修正策略。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [上下文工程](context-engineering/concepts/context-engineering.md)
- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)
- [上下文工程](context-engineering/concepts/context-engineering.md)
- Anthropic, "How we built our multi-agent research system": https://www.anthropic.com/engineering/multi-agent-research-system

## Notes

> **待确认：** 文章将 Claude 4 的 prompt 自改进能力作为经验观察；是否适用于其他模型、工具协议和宿主环境，需要通过本地 eval 验证。
