---
title: 自主实验循环
description: AI agent 自主进行小规模 LLM 训练实验的闭环机制：读取指令、修改代码、运行训练、评估结果、保留或丢弃。
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, ai-agent, experiment-loop, automation]
related:
  - concepts/fixed-time-budget-evaluation.md
  - concepts/single-file-modification.md
  - concepts/npc.md
  - concepts/experiment-versioning.md
  - concepts/autoresearch-extension-loop.md
  - entities/autoresearch-train-py.md
  - entities/autoresearch-program-md.md
  - sources/notes/autoresearch.md
status: stable
---

# 自主实验循环

> AI agent 自主进行小规模 LLM 训练实验的闭环机制：读取指令 → 修改代码 → 运行训练 → 评估结果 → 保留或丢弃。人类只需设定初始条件，agent 在固定时间预算内持续迭代优化。

## Overview

自主实验循环是 [autoresearch](sources/notes/autoresearch.md) 项目的核心机制。它让 AI agent（如 Claude、Codex）在无人值守的情况下，整夜持续进行 LLM 训练实验。每次循环约 5 分钟，一个睡眠周期可完成约 100 次实验。

oh-my-pi 的 [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md)在此基础上增加了插件基础设施、SQLite 持久化和自动恢复机制。

该循环的关键在于"完全自主"——agent 在实验过程中禁止询问人类，所有决策（修改方向、保留/丢弃、异常处理）均由 agent 自行判断。

## Details

### 循环流程

1. **读取上下文** — agent 阅读 [program.md](entities/autoresearch-program-md.md) 获取实验指令和约束
2. **提出假设** — 基于历史结果和代码理解，决定修改方向
3. **修改代码** — 直接编辑 [train.py](entities/autoresearch-train-py.md)（唯一可修改文件）
4. **提交版本** — `git commit` 记录实验版本
5. **运行实验** — 执行训练脚本，固定 5 分钟 wall-clock 时间
6. **评估结果** — 提取 `val_bpb`（越低越好）
7. **决策保留** — 改善则保留提交，否则 `git reset` 回退

### 设计意图

- **无人值守运行** — 人类可睡眠期间持续实验，约 12 次/小时
- **快速迭代** — 短周期（5 分钟）允许高频试错，降低单次实验成本
- **客观淘汰** — 以 `val_bpb` 为唯一标准，消除主观判断

### 与人工研究的区别

| 维度 | 人工研究 | 自主实验循环 |
|------|---------|-------------|
| 迭代频率 | 数小时至数天 | 5 分钟 |
| 实验记录 | 手动笔记 | 自动 git commit + `results.tsv` |
| 失败处理 | 人工调试 | 自动回退，继续下一实验 |
| 规模 | 受人类时间限制 | 受算力限制（可并行多 GPU） |

## Relations

- [固定时间预算评估](concepts/fixed-time-budget-evaluation.md) — 循环的时间控制机制
- [单文件修改原则](concepts/single-file-modification.md) — 循环的代码修改范围约束
- [NPC 式分工](concepts/npc.md) — 循环中人类与 agent 的职责划分
- [实验版本管理](concepts/experiment-versioning.md) — 循环的版本控制机制
- [train.py](entities/autoresearch-train-py.md) — 循环中唯一被修改的文件
- [program.md](entities/autoresearch-program-md.md) — 循环中 agent 读取的指令文件
- [autoresearch 项目](sources/notes/autoresearch.md) — 本概念的来源项目

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md)
- [实验版本管理](concepts/experiment-versioning.md)
- [固定时间预算评估](concepts/fixed-time-budget-evaluation.md)
- [NPC 式分工](concepts/npc.md)
- [简约准则](concepts/simplicity-criterion.md)
- [单文件修改原则](concepts/single-file-modification.md)
- [program.md](entities/autoresearch-program-md.md)
- [train.py](entities/autoresearch-train-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md)

## References

- karpathy/autoresearch: https://github.com/karpathy/autoresearch
- `program.md` 中的实验循环定义

## Notes

> **待确认：** 多 GPU 并行实验的具体实现方式（当前 repo 为单 GPU，但 `program.md` 暗示可通过分支名区分 `gpu0`/`gpu1`）。
