---
title: LLM Workflow 模式
description: Prompt chaining、routing、parallelization、orchestrator-workers 和 evaluator-optimizer 五种可组合的 LLM workflow 控制结构。
type: analysis
timestamp: 2026-09-15T06:15:36Z
tags: [agent-design, llm-workflow, prompt-chaining, routing, parallelization, orchestration, evaluation]
sources:
  - agent-design/sources/notes/anthropic-building-effective-agents.md
status: stable
last_validated: 2026-09-15T06:15:36Z
timeliness: current
---

# LLM Workflow 模式

> LLM workflow 是通过预定义代码路径组合多个[增强型 LLM](agent-design/concepts/augmented-llm.md)调用的控制结构；固定路径换取可预测性，动态性则让位给显式编排代码。

## Overview

Workflow 适合任务步骤可预先描述、每一步职责清晰的场景。选择 workflow 的关键不是使用多少次 LLM 调用，而是能否在运行前确定主要路径、输入输出边界和中间检查点。

## Details

### 模式总览

```text
+------------------+       +------------------+
|   LLM workflow   |       |      Agent       |
| fixed code path  |       | dynamic decisions|
+--------+---------+       +--------+---------+
         |                          |
         v                          v
   predefined steps          tool + feedback loop
         |                          |
         v                          v
   predictable output       flexible execution
```

五种模式可按控制方式理解：

- **串行变换：** prompt chaining
- **条件分派：** routing
- **并发聚合：** parallelization
- **动态拆解：** orchestrator-workers
- **迭代反馈：** evaluator-optimizer

它们可以组合，但组合后的复杂度必须由评估结果证明其必要性。

### Prompt chaining

把任务拆成固定顺序的子任务，让前一步的结果成为后一步的输入；任意中间步骤都可以加入程序化 gate。

```text
[input]
   |
   v
+------+    +------+    +------+
| LLM1 | -> | gate | -> | LLM2 |
+------+    +------+    +------+
                            |
                            v
                         [output]
```

适用条件：

- 子任务可以稳定地按顺序分解；
- 每一步的输出都能成为下一步的有效输入；
- 增加延迟可以换取更高准确率或更易测试的中间结果。

典型结构是先生成提纲，再检查提纲，最后依据合格提纲生成正文。

### Routing

先对输入分类，再把请求交给针对该类别优化的后续流程。

```text
                      +--> [specialist A] --+
[input] -> [router] --+--> [specialist B] --+-> [output]
                      +--> [specialist C] --+
```

适用条件：

- 输入类别之间存在真实差异；
- 不同类别需要不同 prompt、工具或模型；
- 分类器能够以足够可靠的准确率完成分派。

Routing 可以避免一个统一 prompt 为兼容所有输入而变得臃肿，也可以让简单请求和复杂请求使用不同资源预算。

### Parallelization

并行化有两种主要形式：

- **Sectioning：** 把任务拆成互相独立的子任务，并行处理后聚合结果；
- **Voting：** 对同一个任务运行多次，以多个结果提高置信度或降低单次偏差。

```text
              +--> [LLM A] --+
[input] ------+--> [LLM B] --+--> [aggregate]
              +--> [LLM C] --+
```

Sectioning 适合多个关注点彼此独立的任务，例如分别检查安全性、事实性和格式。Voting 适合单次输出不稳定、但多个独立尝试可以提供共识的判断任务。

并行化的成本是协调、聚合和错误处理；只有子任务真正独立，或多次尝试确实能提高质量时，并行才值得。

### Orchestrator-workers

中央 LLM 根据当前输入动态拆解任务，再委派给 worker，最后综合 worker 结果。

```text
                           +--> [worker 1] --+
[input] -> [orchestrator]--+--> [worker 2] --+--> [synthesis]
                           +--> [worker 3] --+
```

它和 parallelization 的外形相似，但关键区别是：parallelization 的子任务通常预先定义，orchestrator-workers 的子任务由 orchestrator 根据具体输入决定。

适用条件：

- 子任务数量或类型无法在运行前稳定预测；
- worker 之间仍可以相对独立地工作；
- 中央模型能够理解结果并处理缺口、重复或冲突。

该模式与[多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)中的 lead/subagent 结构相关，但本文模式不限于研究任务。

### Evaluator-optimizer

一个 LLM 生成候选结果，另一个 LLM 按标准评价并反馈，生成器据此循环改进。

```text
+---------+     candidate      +---------+
|generator| -----------------> |evaluator|
+----^----+                    +----+----+
     |           feedback           |
     +------------------------------+
                    |
             [stop when good]
```

适用条件：

- 质量标准可以被明确表达；
- 反馈确实能带来可观察的改进；
- evaluator 能识别候选结果中的关键缺陷；
- 系统有明确停止条件，避免无收益循环。

这类模式适合需要多轮润色、批评和补充检索的任务，但评价模型本身也可能产生偏差，不能替代最终结果评估。

### 组合原则

Workflow 模式不是完整框架，也不是固定架构清单。实际系统可以先 routing，再对某一分支使用 prompt chaining，或在 orchestrator-workers 的结果上使用 evaluator-optimizer。

组合前应先回答：

- 新模式解决了哪个已观测的失败？
- 额外延迟和 token 成本是否换来可测量收益？
- 中间结果是否可检查、可记录和可重放？
- 失败时能否定位是分类、调用、聚合还是评价出了问题？

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents
- [多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)

## Notes

> **待确认：** 原文给出了模式的结构和适用条件，但没有提供适用于所有模型、任务和成本环境的统一选择阈值。实际组合顺序应由本地评估和运行成本决定。
