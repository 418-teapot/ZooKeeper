---
title: autoresearch — AI agent 自主 LLM 训练实验框架
description: Andrej Karpathy 发布的让 AI agent 在单 GPU 上自主进行 LLM 训练实验的开源框架。
type: source
timestamp: 2026-06-19T00:00:00Z
resource: https://github.com/karpathy/autoresearch
tags: [autoresearch, ai-agent, llm-training, research-automation]
relations:
  - "[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)"
  - "[autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)"
  - "[固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)"
  - "[单文件修改原则](autoresearch/concepts/single-file-modification.md)"
  - "[NPC 式分工](shared/concepts/npc.md)"
  - "[简约准则](shared/concepts/simplicity-criterion.md)"
  - "[实验版本管理](autoresearch/concepts/experiment-versioning.md)"
  - "[train.py](autoresearch/entities/autoresearch-train-py.md)"
  - "[prepare.py](autoresearch/entities/autoresearch-prepare-py.md)"
  - "[program.md](autoresearch/entities/autoresearch-program-md.md)"
  - "[autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)"
  - "[autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)"
status: stable
last_validated: 2026-06-19T00:00:00Z
timeliness: current
---

# autoresearch — AI agent 自主 LLM 训练实验框架

> Andrej Karpathy 发布的 autoresearch 项目：让 AI agent 在单 GPU 上自主进行小规模 LLM 训练实验 overnight。核心创新是将"研究组织代码"（[program.md](autoresearch/entities/autoresearch-program-md.md)）与"模型代码"（[train.py](autoresearch/entities/autoresearch-train-py.md)）分离，使人类迭代策略、agent 迭代实现。

## Overview

autoresearch 是一个让 AI agent 自动在小规模单 GPU LLM 训练实验上跑研究的框架。Agent 自主修改训练代码、运行 5 分钟实验、根据 `val_bpb` 指标决定保留/丢弃，整夜无人值守循环迭代。该框架的核心机制（[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)、[固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)、[单文件修改原则](autoresearch/concepts/single-file-modification.md)、[NPC 式分工](shared/concepts/npc.md)、[简约准则](shared/concepts/simplicity-criterion.md)）被后续的 oh-my-pi [autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)架构化。[实验版本管理](autoresearch/concepts/experiment-versioning.md)是框架的 git 原生版本控制方案。详细的设计决策分析见[设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)，扩展设计来源于[autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)。

- **作者：** Andrej Karpathy (@karpathy)
- **发布时间：** 2026 年 3 月
- **目标：** 单 GPU overnight 自主实验，约 100 次/睡眠周期
- **技术栈：** PyTorch, Flash Attention 3, rustbpe, tiktoken, uv
- **平台要求：** 单 NVIDIA GPU（H100 测试），Python 3.10+

## Details

### 核心文件

| 文件 | 角色 | 编辑者 |
|------|------|--------|
| train.py | 模型、优化器、训练循环 | Agent |
| [prepare.py](autoresearch/entities/autoresearch-prepare-py.md) | 数据、tokenizer、评估 | 固定 |
| program.md | Agent 指令 | 人类 |

### 关键设计选择

- **固定 5 分钟时间预算** — wall-clock 公平比较
- **val_bpb 评估** — vocab-size-independent 指标
- **单文件修改** — 范围可控，diff 可审查
- **自包含** — 无分布式训练，无复杂配置

### 技术亮点

- **Value Embedding** — 交替层注入 value residual（ResFormer 风格）
- **BOS-aligned best-fit packing** — 100% 序列利用率，无 padding
- **MuonAdamW** — Muon + AdamW 混合优化器，带 Polar Express 正交化
- **交替注意力模式** — `SSSL` 窗口模式（短-短-短-长），末层始终全注意力
- **Flash Attention 3** — Hopper GPU 专用 kernel，非 Hopper 自动回退

### 社区 Fork

- MacOS: [miolini/autoresearch-macos](https://github.com/miolini/autoresearch-macos), [trevin-creator/autoresearch-mlx](https://github.com/trevin-creator/autoresearch-mlx)
- Windows: [jsegov/autoresearch-win-rtx](https://github.com/jsegov/autoresearch-win-rtx)
- AMD: [andyluo7/autoresearch](https://github.com/andyluo7/autoresearch)

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
- [实验版本管理](autoresearch/concepts/experiment-versioning.md)
- [固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)
- [单文件修改原则](autoresearch/concepts/single-file-modification.md)
- [prepare.py](autoresearch/entities/autoresearch-prepare-py.md)
- [program.md](autoresearch/entities/autoresearch-program-md.md)
- [train.py](autoresearch/entities/autoresearch-train-py.md)
- [ZooKeeper Wiki 概览](overview.md)
- [NPC 式分工](shared/concepts/npc.md)
- [简约准则](shared/concepts/simplicity-criterion.md)

## References

- 项目仓库：https://github.com/karpathy/autoresearch
- 本地副本：`raw/2026-06-19-autoresearch.md`
- 相关推文：https://x.com/karpathy/status/2029701092347630069, https://x.com/karpathy/status/2031135152349524125
- 父项目 nanochat：https://github.com/karpathy/nanochat

## Notes

> **待确认：** 项目 README 中提到"research org code"的迭代优化是未来方向，但当前 `program.md` 仅为单 agent 基线。
