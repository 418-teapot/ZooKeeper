---
title: 单文件修改原则
description: 在自主实验框架中 agent 只能修改单一文件 train.py，其余文件固定不变，将搜索空间限制在模型架构和训练流程内。
resource: https://github.com/karpathy/autoresearch
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, scope-management, agent-constraint]
relations:
  - "[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)"
  - "[后验问责制](shared/concepts/post-hoc-accountability.md)"
  - "[NPC 式分工](shared/concepts/npc.md)"
  - "[train.py](autoresearch/entities/autoresearch-train-py.md)"
  - "[prepare.py](autoresearch/entities/autoresearch-prepare-py.md)"
  - "[autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)"
status: stable
---

# 单文件修改原则

> 在自主实验框架中，agent 只能修改单一文件（[train.py](autoresearch/entities/autoresearch-train-py.md)），其余文件（[prepare.py](autoresearch/entities/autoresearch-prepare-py.md)、数据、评估）固定不变。这一约束将 agent 的搜索空间限制在模型架构和训练流程内，防止范围蔓延并保证 diffs 可审查。这是[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)的执行规则，在[NPC 式分工](shared/concepts/npc.md)中定义了 agent 的编辑领地。

## Overview

单文件修改原则是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 的范围管理策略。它通过限制 agent 的编辑权限，降低自主实验的风险和复杂度。

## Details

### 约束定义

- **可修改：** `train.py` — 模型定义、优化器、训练循环、超参
- **不可修改：** `prepare.py` — 数据加载、tokenizer、评估函数、时间预算常量
- **不可新增：** 依赖包（`pyproject.toml` 固定）

### 设计理由

- **范围可控** — agent 不会意外破坏数据管道或评估逻辑
- **Diff 可审查** — 每次实验的变更集中在单个文件，人类可快速 review
- **评估一致性** — 固定 `prepare.py` 保证所有实验在相同数据、相同评估下比较
- **故障隔离** — 崩溃通常源于 `train.py` 的修改，易于定位

### 边界情况

agent 在 `train.py` 内几乎拥有无限自由：可改架构、改优化器、改 batch size、甚至改模型尺寸。唯一的硬性约束是代码必须能在 5 分钟内跑完且不崩溃。这与[后验问责制](shared/concepts/post-hoc-accountability.md)的"允许越界编辑但在记录时捕获偏差"形成对比——本原则使用前置硬限制，而后验问责制使用后置透明记录。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
- [固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)
- [prepare.py](autoresearch/entities/autoresearch-prepare-py.md)
- [train.py](autoresearch/entities/autoresearch-train-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)
- [NPC 式分工](shared/concepts/npc.md)
- [后验问责制](shared/concepts/post-hoc-accountability.md)
- [简约准则](shared/concepts/simplicity-criterion.md)

## References

- karpathy/autoresearch README "Design choices" 章节
- [program.md](autoresearch/entities/autoresearch-program-md.md) 中的修改权限说明

## Notes

> **待确认：** 当 agent 需要修改模型深度（`DEPTH`）时，是否会影响 [prepare.py](autoresearch/entities/autoresearch-prepare-py.md) 中的 `MAX_SEQ_LEN` 兼容性？当前实现中两者独立。
