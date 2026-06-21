---
title: train.py
description: autoresearch 中唯一由 AI agent 修改的文件，包含 GPT 模型、MuonAdamW 优化器和训练循环的核心实验画布。
type: entity
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, file, model, training]
related:
  - concepts/autonomous-experiment-loop.md
  - concepts/single-file-modification.md
  - concepts/npc.md
  - entities/autoresearch-prepare-py.md
  - entities/autoresearch-program-md.md
  - sources/notes/autoresearch.md
status: stable
---

# train.py

> autoresearch 中唯一由 AI agent 修改的文件。包含完整的 GPT 模型实现、MuonAdamW 优化器、训练循环和超参配置。是 agent 的实验画布。

## Overview

train.py 是 [autoresearch](sources/notes/autoresearch.md) 的核心文件，约 630 行。它既是模型定义文件，也是训练脚本。Agent 通过修改此文件来尝试不同的架构、优化器和超参。

## Role

- **模型定义** — GPT 架构（embedding、transformer blocks、LM head）
- **优化器** — MuonAdamW（Muon 用于矩阵参数，AdamW 用于其他）
- **训练循环** — 固定 5 分钟 wall-clock 训练，梯度累积，LR 调度
- **超参配置** — 所有可调参数以模块级常量形式定义（无 CLI flags）

## Key Components

- **GPTConfig** — 模型架构配置（depth、dim、heads、window pattern 等）
- **CausalSelfAttention** — 注意力层，支持 Flash Attention 3 和交替窗口模式
- **Value Embedding** — 交替层注入的 value residual（ResFormer 风格）
- **MuonAdamW** — 自定义优化器，结合 Nesterov 动量和 Polar Express 正交化
- **Hyperparameters 区块** — 顶部集中定义所有可调参数

## Behavior

- **输入** — 由 [prepare.py](entities/autoresearch-prepare-py.md) 提供的数据加载器（`make_dataloader`）
- **输出** — 训练日志 + `val_bpb` 评估结果
- **副作用** — 修改 GPU 内存状态、写入 `run.log`
- **约束** — 必须在 5 分钟内完成，VRAM 不能剧烈膨胀

## Relations

- [自主实验循环](concepts/autonomous-experiment-loop.md) — 本文件是循环的核心操作对象
- [单文件修改原则](concepts/single-file-modification.md) — 本文件是"单文件"约束中的唯一可改文件
- [NPC 式分工](concepts/npc.md) — 本文件是 agent 的编辑领地
- [prepare.py](entities/autoresearch-prepare-py.md) — 提供数据加载和评估函数
- [program.md](entities/autoresearch-program-md.md) — 定义 agent 如何修改本文件
- [autoresearch 项目](sources/notes/autoresearch.md) — 本文件的来源项目

## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [autoresearch 设计权衡分析](analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](concepts/autonomous-experiment-loop.md)
- [实验版本管理](concepts/experiment-versioning.md)
- [NPC 式分工](concepts/npc.md)
- [单文件修改原则](concepts/single-file-modification.md)
- [prepare.py](entities/autoresearch-prepare-py.md)
- [program.md](entities/autoresearch-program-md.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md)

## References

- karpathy/autoresearch `train.py` 完整源码
- 本地副本：`raw/2026-06-19-autoresearch.md`

## Notes

> **待确认：** 当前实现依赖 Hopper GPU（H100）的 Flash Attention 3；非 Hopper GPU 使用 `kernels-community/flash-attn3` 回退。
