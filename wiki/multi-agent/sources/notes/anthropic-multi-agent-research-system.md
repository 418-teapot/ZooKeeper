---
title: Anthropic 多 agent 研究系统文章
description: Anthropic 关于 Research 多 agent 架构、协作 prompt、评估方法与生产可靠性经验的工程博客摘要。
type: source
timestamp: 2026-09-14T02:14:29Z
resource: https://www.anthropic.com/engineering/multi-agent-research-system
tags: [multi-agent, agent-orchestration, prompt-engineering, evaluation, anthropic]
relations:
  - "[多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)"
  - "[Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)"
  - "[多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)"
  - "[上下文工程](context-engineering/concepts/context-engineering.md)"
  - "[长程任务的上下文管理](context-engineering/analysis/long-horizon-context-management.md)"
status: stable
last_validated: 2026-09-14T02:14:29Z
timeliness: current
---

# Anthropic 多 agent 研究系统文章

> Anthropic 工程团队对 Claude Research 多 agent 系统的架构、prompt 工程、评估和生产化经验总结；本文是相关概念页与分析页的共同来源。

## Overview

- **来源：** Anthropic Engineering Blog
- **标题：** How we built our multi-agent research system
- **发布时间：** 2025-06-13
- **作者：** Jeremy Hadfield、Barry Zhang、Kenneth Lien、Florian Scholz、Jeremy Fox、Daniel Ford 等
- **主要主题：** orchestrator-worker 架构、并行搜索、[协作 prompt](multi-agent/concepts/agent-collaboration-prompting.md)、agent 评估、状态恢复和生产部署

## Key Points

- Research 使用 lead agent 规划任务，并创建多个具有明确职责的 subagent 并行探索（见[多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)）。
- 并行 subagent 通过独立上下文窗口增加推理容量，同时降低单一路径依赖（见[上下文工程](context-engineering/concepts/context-engineering.md)）。
- lead agent 需要根据问题复杂度决定 subagent 数量、工具调用预算和任务边界（详见前述协作 prompt 概念页）。
- 工具描述与工具选择启发式会直接影响 agent 是否走上有效路径。
- 评估重点应放在事实准确性、引用准确性、完整性、来源质量和工具效率，而不是固定执行轨迹（见[多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)）。
- 生产系统需要支持断点恢复、重试、检查点、全链路 tracing 和 rainbow deployment（长程上下文策略见[长程任务的上下文管理](context-engineering/analysis/long-horizon-context-management.md)）。
- 同步等待简化协调，但会形成瓶颈；异步执行有更高并行潜力，也带来状态一致性和错误传播问题。

## Details

### 适用任务

多 agent 架构最适合开放式、广度优先、可拆成相对独立方向、且信息量超过单个上下文窗口的研究任务。需要所有 agent 共享同一上下文，或 agent 之间存在大量依赖的任务，收益较低。

### 系统流程

lead agent 分析问题、制定策略、创建 subagent；subagent 使用搜索工具独立收集和评估信息，再将结果交回 lead agent。lead agent 综合结果并判断是否需要继续研究，最终由 citation agent 将报告中的声明与来源位置对应起来。

### 工程经验

文章强调：应通过模拟观察 agent 的逐步行为来迭代 prompt；用小规模真实查询尽早建立 eval；同时结合 LLM judge 和人工测试；生产系统则必须假设状态持续存在、错误会累积、部署会与运行中的 agent 重叠。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)
- [Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)
- [多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- Anthropic, "How we built our multi-agent research system" (2025-06-13): https://www.anthropic.com/engineering/multi-agent-research-system
- 原文完整副本：`raw/2026-09-14-anthropic-multi-agent-research-system.md`

## Notes

> **待确认：** 文中 90.2% 的内部评估提升、BrowseComp 方差解释比例、40% 工具描述优化收益和最高 90% 的时间缩短均来自 Anthropic 内部实验或特定系统上下文，不应直接外推为普遍保证。
