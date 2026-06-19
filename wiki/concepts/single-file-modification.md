---
title: 单文件修改原则
type: concept
created: 2026-06-19
updated: 2026-06-19
tags: [autoresearch, scope-management, agent-constraint]
related:
  - concepts/autonomous-experiment-loop.md
  - concepts/npc.md
  - entities/autoresearch-train-py.md
  - entities/autoresearch-prepare-py.md
  - sources/notes/autoresearch.md
status: stable
---

# 单文件修改原则

> 在自主实验框架中，agent 只能修改单一文件（[train.py](entities/autoresearch-train-py.md)），其余文件（[prepare.py](entities/autoresearch-prepare-py.md)、数据、评估）固定不变。这一约束将 agent 的搜索空间限制在模型架构和训练流程内，防止范围蔓延并保证 diffs 可审查。

## Overview

单文件修改原则是 [autoresearch](sources/notes/autoresearch.md) 的范围管理策略。它通过限制 agent 的编辑权限，降低自主实验的风险和复杂度。

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

agent 在 `train.py` 内几乎拥有无限自由：可改架构、改优化器、改 batch size、甚至改模型尺寸。唯一的硬性约束是代码必须能在 5 分钟内跑完且不崩溃。

## Relations

- [自主实验循环](concepts/autonomous-experiment-loop.md) — 单文件约束是循环的执行规则
- [NPC 式分工](concepts/npc.md) — 单文件是分工的具体体现（agent 的领地）
- [train.py](entities/autoresearch-train-py.md) — 唯一可修改的文件
- [prepare.py](entities/autoresearch-prepare-py.md) — 不可修改的固定文件
- [autoresearch 项目](sources/notes/autoresearch.md) — 本概念的来源项目

## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [autoresearch 设计权衡分析](analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](concepts/autonomous-experiment-loop.md)
- [固定时间预算评估](concepts/fixed-time-budget-evaluation.md)
- [NPC 式分工](concepts/npc.md)
- [简约准则](concepts/simplicity-criterion.md)
- [prepare.py](entities/autoresearch-prepare-py.md)
- [train.py](entities/autoresearch-train-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md)

## References

- karpathy/autoresearch README "Design choices" 章节
- [program.md](entities/autoresearch-program-md.md) 中的修改权限说明

## Notes

> **待确认：** 当 agent 需要修改模型深度（`DEPTH`）时，是否会影响 [prepare.py](entities/autoresearch-prepare-py.md) 中的 `MAX_SEQ_LEN` 兼容性？当前实现中两者独立。
