---
title: NPC 式分工
description: 人类扮演"游戏设计师"编写 NPC 行为脚本，AI agent 扮演 NPC 在脚本约束下自主行动，实现策略与执行的分离。
resource: https://github.com/karpathy/autoresearch
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, human-agent-division, skill-pattern]
relations:
  - "[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)"
  - "[单文件修改原则](autoresearch/concepts/single-file-modification.md)"
  - "[program.md](autoresearch/entities/autoresearch-program-md.md)"
  - "[train.py](autoresearch/entities/autoresearch-train-py.md)"
  - "[autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)"
status: stable
---

# NPC 式分工

> 人类扮演"游戏设计师"编写 NPC 行为脚本（[program.md](autoresearch/entities/autoresearch-program-md.md)），AI agent 扮演 NPC 在脚本约束下自主行动（修改 [train.py](autoresearch/entities/autoresearch-train-py.md)）。人类不干预单次实验，只调整高层策略；agent 不质疑目标，只优化执行。这是[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)的组织基础，其文件边界基于[单文件修改原则](autoresearch/concepts/single-file-modification.md)。

## Overview

NPC 式分工是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 的人类/agent 协作模式。它将传统 pair programming 中的"共同编辑、共同决策"转变为"策略-执行分离"的委托模式。

## Details

### 职责划分

| 角色 | 编辑对象 | 决策层级 |
|------|---------|---------|
| 人类 | `program.md` | 战略：实验目标、约束条件、评估标准、停止条件 |
| Agent | `train.py` | 战术：具体架构、超参、优化器、训练技巧 |

### 为什么叫"NPC"

- **非对称信息** — agent 不知道人类为什么设定这些约束，只遵循
- **可替换性** — 换一个 agent（Claude、Codex、Gemini）只要读取同一 `program.md`，行为一致
- **迭代对象不同** — 人类迭代的是"组织代码"（research org code），agent 迭代的是"模型代码"

### 与协作编程的区别

传统 pair programming 中人类和 AI 共同编辑同一文件、共同决策。NPC 式分工中：

- 文件边界清晰（`program.md` vs `train.py`)
- 决策层级分离（战略 vs 战术）
- 运行时可无人值守（agent 不需要人类确认）

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
- [单文件修改原则](autoresearch/concepts/single-file-modification.md)
- [program.md](autoresearch/entities/autoresearch-program-md.md)
- [train.py](autoresearch/entities/autoresearch-train-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- karpathy/autoresearch README "How it works" 章节
- [program.md](autoresearch/entities/autoresearch-program-md.md) 中的角色定义

## Notes

> **待确认：** 多 agent 协作时（如一个 agent 负责架构、一个负责数据增强），`program.md` 如何扩展以支持多 NPC 定义。
