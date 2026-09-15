---
title: Agentic System 选择分析
description: 在单次 LLM 调用、固定 workflow 和自主 agent 之间选择的复杂度阶梯与风险权衡。
type: analysis
timestamp: 2026-09-15T06:15:36Z
tags: [agent-design, agentic-system, workflow, autonomy, simplicity, reliability]
sources:
  - agent-design/sources/notes/anthropic-building-effective-agents.md
status: stable
last_validated: 2026-09-15T06:15:36Z
timeliness: current
---

# Agentic System 选择分析

> 选择 agentic system 的核心不是追求最大自主性，而是从单次 LLM 调用开始，只在更高复杂度能够带来可验证收益时，才升级到 workflow 或自主 agent。

## Overview

LLM 应用可以沿着"单次调用 -> 固定 workflow -> 自主 agent"的复杂度阶梯演进。每上升一级，通常都会获得更多灵活性，但也付出更多延迟、成本、调试难度和错误累积风险。

## Details

### 选择阶梯

```text
+-------------------+
| single LLM call   |
| retrieval/examples|
+---------+---------+
          |
          | simple solution insufficient
          v
+-------------------+
| fixed workflow    |
| predictable path  |
+---------+---------+
          |
          | path cannot be hardcoded
          v
+-------------------+
| autonomous agent  |
| plan-tool-feedback|
+-------------------+
```

优先级判断：

- **单次调用：** 任务结构简单，检索和 in-context examples 已足够。
- **Workflow：** 任务可以固定分解，需要一致性、可预测性和中间检查。
- **Agent：** 所需步骤、工具选择或执行路径取决于运行时发现，无法可靠硬编码。

这与[Agent/Skill/Plugin 判断框架](agent-design/analysis/agent-skill-plugin-framework.md)互补：前者选择运行时控制结构，后者选择能力在宿主中的实现形态。

### Workflow 与 agent 的边界

Workflow 由代码掌握流程控制；agent 由 LLM 根据环境反馈动态掌握流程控制。

```text
workflow:
[input] -> [step 1] -> [step 2] -> [step 3] -> [output]

agent:
[input] -> [plan] -> [tool] -> [observe] -> [decide]
                         ^                    |
                         +--------------------+
```

Workflow 的优势是路径透明、行为一致、测试容易。Agent 的优势是可以处理预先不知道的步骤数量、工具组合和异常分支。

当任务在可信环境中具有明确目标，但实现路径开放且需要多轮反馈时，agent 才值得承担其额外自主性。

### Agent loop 与控制面

自主 agent 通常遵循以下闭环：

1. 接收用户目标并澄清任务；
2. 制定或更新计划；
3. 调用工具改变或查询环境；
4. 读取工具结果作为 ground truth；
5. 判断继续、请求人工意见或结束；
6. 受最大迭代次数、阻塞条件或完成条件约束。

```text
+-------+    +------+    +---------+
| plan  | -> | tool | -> | observe |
+---+---+    +------+    +----+----+
    ^                              |
    |                              v
    +---------- [decide] <---------+
                   |
          done / human / continue
```

透明地显示规划步骤有助于诊断和人工介入，但不意味着必须把所有决策硬编码成固定轨迹。

### 成本与风险

Agent 的收益来自灵活性和模型驱动的决策，主要代价包括：

- 多轮调用带来的延迟和 token 成本；
- 单步错误在后续步骤中累积；
- 工具误用或环境状态变化导致路径漂移；
- 自主行为增加测试、观测和恢复要求；
- 需要信任模型在当前工具和环境中的决策能力。

因此应使用沙箱、工具权限边界、停止条件、检查点和人工介入点。复杂度应由结果评估证明其必要性，这与[简约准则](agent-design/concepts/simplicity-criterion.md)的"收益必须匹配复杂度成本"原则一致。

### 可靠性判断

不能只评估 agent 是否执行了预设轨迹。更重要的是评估：

- 最终结果是否正确、完整并满足任务标准；
- 工具调用是否得到环境反馈支持；
- 失败后是否能恢复或安全停止；
- 成本、延迟和资源消耗是否可接受；
- 人工是否能在关键检查点理解并接管系统。

生产化前应通过代表性任务测试实际路径，持续观察失败模式，再决定是否增加 workflow 组合或 agent 自主性。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agent/Skill/Plugin 判断框架](agent-design/analysis/agent-skill-plugin-framework.md)
- [简约准则](agent-design/concepts/simplicity-criterion.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents
- [简约准则](agent-design/concepts/simplicity-criterion.md)
- [多 agent 系统的评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)

## Notes

> **待确认：** "agent 更适合开放式任务"是架构启发式，不是严格分类器。某些开放式任务仍可通过 routing、orchestrator-workers 或 evaluator-optimizer 组合成可控 workflow。
