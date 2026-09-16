---
title: 多 agent 系统的评估与生产可靠性
description: 分析多 agent 系统为何必须以结果和合理过程评估，并通过状态恢复、观测和渐进部署控制生产风险。
type: analysis
timestamp: 2026-09-14T02:14:29Z
tags: [multi-agent, evaluation, reliability, production]
sources:
  - multi-agent/sources/notes/anthropic-multi-agent-research-system.md
status: stable
last_validated: 2026-09-16T01:55:38Z
timeliness: current
---

# 多 agent 系统的评估与生产可靠性

> 多 agent 系统的有效路径具有非确定性，因此评估应优先检查结果、证据和资源使用；生产化则需要把长程状态、错误恢复、行为观测和版本共存作为一等问题。

## Overview

单 agent eval 常假设输入对应一条正确执行路径，但[多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)下的系统可能通过不同的工具、搜索次数和委派顺序得到同样有效的结果。因此，可靠性工作应同时覆盖 outcome quality、合理过程和长程运行能力，而不是检查是否复现预设轨迹。本文分析基于 Anthropic 的[多 agent 研究系统工程实践](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)。

## Details

### 评估什么

研究类输出适合从以下维度评分（与[上下文工程](context-engineering/concepts/context-engineering.md)关注结果承载的有效信息一致）：

- **事实准确性：** 声明是否被来源支持
- **引用准确性：** 引用是否真正对应声明
- **完整性：** 是否覆盖用户要求的各个方面
- **来源质量：** 是否优先使用权威或一手来源
- **工具效率：** 是否选择正确工具，并以合理次数调用

工具本身的边界、描述、schema 和返回格式也属于被评估对象——[Agent 工具设计](agent-design/concepts/agent-tool-design.md)给出了这些维度的具体设计原则。工具评估可同时记录调用次数、重复调用、参数错误、工具错误、token 消耗和运行时间；不应把某一条工具调用序列当作唯一正确路径，结果、资源使用和必要的工具行为更适合共同组成 rubric。

对会改变持久状态的长程任务（[长程任务的上下文管理](context-engineering/analysis/long-horizon-context-management.md)给出了对应的上下文管理策略），更适合检查最终状态或离散检查点，而不是逐轮要求固定动作序列。

### 自动与人工评估

早期 prompt 迭代不应等待大型数据集；约二十个代表真实用法的查询通常足以发现显著回归或改进。自由文本输出可使用 LLM judge 按 rubric 评分，并输出连续分数与 pass/fail 结果；当答案有明确标准时，也可以直接检查正确性。

人工评估仍然必要，因为它能发现自动 eval 遗漏的边界情况、系统故障和来源偏差。例如，agent 可能偏好 SEO 内容农场而不是排名较低但更权威的学术或个人来源。

### 长程错误与恢复

agent 在多个工具调用中持续维护状态，微小失败可能改变后续轨迹。简单重启会丢失已完成工作并增加成本，因此系统应组合使用重试、定期 checkpoint、持久化计划和从失败位置恢复。

让 agent 知道工具失败并自行调整有时有效，但不能替代确定性保护。模型适应性与显式错误处理应共同存在。

### 观测与部署

完整 production tracing 能区分搜索查询错误、来源选择错误、工具失败和协调问题。除普通日志外，还应观测 agent 的决策模式和交互结构；在重视隐私的场景下，可以优先记录高层行为指标而不是对话内容。

由于 agent 可能在更新期间处于任意执行阶段，部署需要让旧版和新版短时间共存，并逐步迁移流量。渐进部署降低了更新打断运行中 agent 的风险。

### 核心权衡

结果导向 eval 能容纳多条有效路径，但会牺牲对中间行为的直接控制；更细的过程约束便于诊断，却可能误判合法的替代路径。同步执行简化状态协调但牺牲吞吐；异步执行提高并行潜力但增加一致性和错误传播复杂度。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agentic System 选择分析](agent-design/analysis/agentic-system-selection.md)
- [Agent 工具设计](agent-design/concepts/agent-tool-design.md)
- [Anthropic Writing effective tools for agents 工程博客](agent-design/sources/notes/anthropic-writing-tools-for-agents.md)
- [长程任务的上下文管理](context-engineering/analysis/long-horizon-context-management.md)
- [多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)
- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md)
- [长程任务的上下文管理](context-engineering/analysis/long-horizon-context-management.md)
- Anthropic, "How we built our multi-agent research system": https://www.anthropic.com/engineering/multi-agent-research-system

## Notes

> **待确认：** 文章没有公开完整 eval 数据、judge rubric 实现或生产 tracing schema；本页不应被视为可直接复制的评估规范。
