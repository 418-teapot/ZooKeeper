---
title: 多 agent 研究架构
description: 由 lead agent 编排多个隔离上下文中的专门 subagent，以并行探索和结果压缩处理开放式研究任务的架构模式。
type: concept
timestamp: 2026-09-14T02:14:29Z
tags: [multi-agent, orchestration, subagent, parallelism, context-isolation]
status: stable
last_validated: 2026-09-14T02:14:29Z
timeliness: current
---

# 多 agent 研究架构

> 多 agent 研究架构以 lead agent 负责规划和综合，以多个专门 subagent 负责隔离、并行的探索；它用额外 token 和上下文窗口换取开放式研究任务的覆盖率与推理容量。

## Overview

该模式回答一个核心问题：当任务无法预先写成固定流程，且需要探索多个相对独立方向时，如何让 agent 扩展搜索能力而不把所有过程塞入单一上下文。该模式提炼自 Anthropic 的[多 agent 研究系统工程实践](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)。

## Details

### 角色分工

- **Lead agent：** 分析用户问题，制定研究策略，拆解子任务，决定工作量，汇总结果并判断是否需要继续研究。
- **Subagent：** 接收一个边界清晰的研究目标，独立调用搜索和领域工具，评估结果质量，返回结构化发现。
- **Citation agent：** 在研究完成后定位支持具体声明的来源位置，避免最终报告只有概括性来源而缺少逐项归因。

角色分工的关键不是增加 agent 数量，而是让每个上下文承担一个清晰、互补的探索责任。

### 为什么并行有效

研究问题通常具有开放式、路径依赖和广度优先特征，无法可靠地预先规定所有步骤。独立 subagent 可以从不同方向探索，避免单个 agent 过早锁定某条搜索路径；它们还可以在各自上下文中消化大量工具结果，只向 lead agent 返回压缩后的发现。这与[上下文工程](context-engineering/concepts/context-engineering.md)的最小高信息量 token 原则一致，也是[长程任务的上下文管理中的子 agent 架构技术](context-engineering/analysis/long-horizon-context-management.md)的核心机制。

这同时形成关注点分离：不同 subagent 可以拥有不同的任务 prompt、工具选择和探索轨迹。并行化因此既增加覆盖范围，也把详细搜索上下文隔离在主 agent 之外。orchestrator-workers 是更一般的 workflow 模式；它与本页的研究架构都使用中央 agent 动态拆解任务，但不局限于研究场景——[LLM Workflow 模式](agent-design/analysis/llm-workflow-patterns.md)将其作为五种通用 workflow 模式之一展开。

### 适用边界与成本

该模式适合高价值、可并行化、信息量超过单一上下文窗口的任务。不适合所有 agent 必须共享相同即时上下文，或子任务之间存在密集依赖的任务。

主要成本包括 token 消耗、协调开销、结果传递损失和错误累积。同步等待每批 subagent 完成可以简化协调，但会让一个慢 subagent 阻塞整个研究循环；异步执行能提高并发度，却需要额外处理状态一致性、结果协调和错误传播。[多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)分析了这些权衡的评估与生产化影响；判断是否采用该模式可参考[Agent/Skill/Plugin 判断框架](agent-design/analysis/agent-skill-plugin-framework.md)的上下文隔离与并行执行维度。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agent/Skill/Plugin 判断框架](agent-design/analysis/agent-skill-plugin-framework.md)
- [LLM Workflow 模式](agent-design/analysis/llm-workflow-patterns.md)
- [长程任务的上下文管理](context-engineering/analysis/long-horizon-context-management.md)
- [多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)
- [Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)
- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)
- Anthropic, "How we built our multi-agent research system": https://www.anthropic.com/engineering/multi-agent-research-system

## Notes

> **待确认：** 文章中的性能提升和 token 倍数是 Anthropic Research 与其内部 eval 的结果；本页只提炼架构机制，不将这些数字视为跨任务、跨模型的稳定结论。
