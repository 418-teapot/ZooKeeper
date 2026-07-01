---
title: 固定时间预算评估
description: 以固定 wall-clock 时间（5 分钟）作为实验控制变量，结合 val_bpb 指标实现不同架构和超参在同等时间成本下的公平比较。
resource: https://github.com/karpathy/autoresearch
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, evaluation, metric, fair-comparison]
related:
  - autoresearch/concepts/autonomous-experiment-loop.md
  - autoresearch/concepts/single-file-modification.md
  - autoresearch/entities/autoresearch-prepare-py.md
  - autoresearch/sources/notes/autoresearch.md
status: stable
---

# 固定时间预算评估

> 以固定 wall-clock 时间（5 分钟）作为实验控制变量，以 `val_bpb`（validation bits per byte）作为 vocab-independent 评估指标。两者结合使得不同架构、超参、模型尺寸在同等时间成本下可直接比较。固定时间预算是[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)的核心评估机制，与[单文件修改原则](autoresearch/concepts/single-file-modification.md)共同约束 agent 的行为空间。

## Overview

固定时间预算评估是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 的核心评估设计。它解决了"不同实验如何公平比较"的问题——不是比较固定 epoch 数，而是比较在相同 wall-clock 时间内谁的表现更好。

## Details

### 固定时间预算

训练脚本在 wall-clock 达到 5 分钟时自动停止（排除启动/编译时间）。这意味着：

- **公平比较** — 大模型与小模型、高 batch size 与低 batch size 在相同时间内竞争
- **平台适配** — 最优模型是针对你的 GPU 在 5 分钟内的最优解，而非绝对最优
- **不可跨平台比较** — 不同 GPU 的 5 分钟结果不具可比性

### val_bpb 度量

`val_bpb`（validation bits per byte）是唯一的评判标准：

- **vocab-size-independent** — 修改 `vocab_size` 或 tokenizer 不会扭曲指标
- **物理意义明确** — 每字节的平均信息熵，越低表示模型压缩能力越强
- **与 [prepare.py](autoresearch/entities/autoresearch-prepare-py.md) 绑定** — 评估函数固定，agent 不可修改

### 为什么这对自主实验至关重要

固定时间 + 客观指标消除了 agent 的"作弊"空间：

- 不能通过训练更久来刷分
- 不能通过缩小 vocab 来虚假降低 loss
- 所有改进必须来自真正的架构/优化器/超参进步

## Relations

- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md) — 本概念是循环的评估环节
- [单文件修改原则](autoresearch/concepts/single-file-modification.md) — 评估指标固定是"单文件"约束的一部分（[prepare.py](autoresearch/entities/autoresearch-prepare-py.md) 不可改）
- [prepare.py](autoresearch/entities/autoresearch-prepare-py.md) — 包含固定的 `evaluate_bpb` 实现
- [autoresearch 项目](autoresearch/sources/notes/autoresearch.md) — 本概念的来源项目

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
- [prepare.py](autoresearch/entities/autoresearch-prepare-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)

## References

- karpathy/autoresearch [prepare.py](autoresearch/entities/autoresearch-prepare-py.md) 中的 `evaluate_bpb` 实现
- [program.md](autoresearch/entities/autoresearch-program-md.md) 中的评估说明

## Notes

> **待确认：** 启动/编译时间的排除机制（`step > 10` 后开始计时）在不同 GPU 上是否足够稳定。
