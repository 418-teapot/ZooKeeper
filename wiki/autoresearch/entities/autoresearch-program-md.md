---
title: program.md
description: 人类可编辑的 agent 指令文件，定义实验目标、约束条件和行为准则的轻量级 skill。
type: entity
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, file, skill, prompt]
relations:
  - "[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)"
  - "[NPC 式分工](shared/concepts/npc.md)"
  - "[简约准则](shared/concepts/simplicity-criterion.md)"
  - "[train.py](autoresearch/entities/autoresearch-train-py.md)"
  - "[prepare.py](autoresearch/entities/autoresearch-prepare-py.md)"
  - "[autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)"
status: stable
---

# program.md

> autoresearch 中的人类可编辑 agent 指令文件。本质是一个"轻量级 skill"：定义实验目标、约束条件、评估标准、行为准则和停止条件。Agent 通过阅读此文件理解自己在[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)中的角色和任务边界。它体现了[NPC 式分工](shared/concepts/npc.md)中人类编写脚本、agent 执行的协作模式，并明确定义了[简约准则](shared/concepts/simplicity-criterion.md)作为行为约束。

## Overview

program.md 是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 的"组织代码"——不是模型代码，而是定义实验如何组织的自然语言指令。它由人类编写、迭代，由 agent 读取、执行。约 114 行。

## Role

- **实验目标** — "get the lowest val_bpb"
- **权限边界** — 可修改 [train.py](autoresearch/entities/autoresearch-train-py.md)，不可修改 [prepare.py](autoresearch/entities/autoresearch-prepare-py.md) 和依赖
- **评估标准** — `val_bpb` 越低越好，VRAM 不能剧烈膨胀
- **行为准则** — 简约准则、永不停止、自主决策
- **操作流程** — 设置 → 实验循环 → 日志记录

## Key Sections

- **Setup** — 分支创建、文件读取、数据验证、基线运行
- **Experimentation** — 修改权限、目标、约束
- **Output format** — 结果解析方式
- **Logging** — `results.tsv` 格式
- **The experiment loop** — 完整循环流程
- **Timeout / Crashes** — 异常处理规则

## Behavior

- **被读取方** — agent 在每次 session 开始时阅读
- **被编辑方** — 人类根据实验策略迭代调整
- **不执行** — 本身不是代码，是自然语言指令

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
- [实验版本管理](autoresearch/concepts/experiment-versioning.md)
- [固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)
- [单文件修改原则](autoresearch/concepts/single-file-modification.md)
- [program.md](autoresearch/entities/autoresearch-program-md.md)
- [train.py](autoresearch/entities/autoresearch-train-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)
- [NPC 式分工](shared/concepts/npc.md)
- [简约准则](shared/concepts/simplicity-criterion.md)

## References

- karpathy/autoresearch `program.md` 完整原文
- 本地副本：`raw/2026-06-19-autoresearch.md`

## Notes

> **待确认：** 当前 [program.md](autoresearch/entities/autoresearch-program-md.md) 为单 agent 设计。多 agent 协作时可能需要扩展为多个 skill 文件或增加协调章节。
