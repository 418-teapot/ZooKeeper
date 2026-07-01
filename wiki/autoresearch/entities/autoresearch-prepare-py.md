---
title: prepare.py
description: 固定不变的基础设施文件，负责数据下载、BPE tokenizer 训练和 val_bpb 评估，确保实验可比性。
type: entity
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, file, data, evaluation]
related:
  - autoresearch/concepts/fixed-time-budget-evaluation.md
  - autoresearch/concepts/single-file-modification.md
  - autoresearch/entities/autoresearch-train-py.md
  - autoresearch/sources/notes/autoresearch.md
status: stable
---

# prepare.py

> autoresearch 中固定不变的基础设施文件。负责数据下载、BPE tokenizer 训练、数据加载器（BOS-aligned best-fit packing）和 `val_bpb` 评估。agent 不可修改，确保所有实验在相同数据和评估下比较。本文件是[固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)的评估函数实现者和[单文件修改原则](autoresearch/concepts/single-file-modification.md)中"不可修改"约束的核心。

## Overview

prepare.py 是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 的固定基础设施，约 389 行。它定义了实验的"不变量"——数据、tokenizer、评估协议和时间预算。这些不变量保证了不同实验之间的可比性。

## Role

- **数据准备** — 从 HuggingFace 下载 `climbmix-400b-shuffle` 数据分片
- **Tokenizer 训练** — 使用 `rustbpe` 训练 BPE tokenizer，导出为 `tiktoken` 格式
- **数据加载** — `make_dataloader` 提供 BOS-aligned best-fit packing（100% 利用率，无 padding）
- **评估函数** — `evaluate_bpb` 计算 validation bits per byte（固定评估协议）

## Key Constants

- `MAX_SEQ_LEN = 2048` — 上下文长度
- `TIME_BUDGET = 300` — 训练时间预算（秒）
- `EVAL_TOKENS = 40 * 524288` — 验证集 token 数
- `VOCAB_SIZE = 8192` — tokenizer 词表大小

## Behavior

- **输入** — 命令行参数（`--num-shards`、`--download-workers`）
- **输出** — `~/.cache/autoresearch/` 下的数据和 tokenizer
- **被调用方** — [train.py](autoresearch/entities/autoresearch-train-py.md) 导入 `Tokenizer`、`make_dataloader`、`evaluate_bpb`、`MAX_SEQ_LEN`、`TIME_BUDGET`

## Relations

- [固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md) — 本文件定义时间预算和评估函数
- [单文件修改原则](autoresearch/concepts/single-file-modification.md) — 本文件是"不可修改"约束的核心
- [train.py](autoresearch/entities/autoresearch-train-py.md) — 导入本文件的工具函数和常量
- [autoresearch 项目](autoresearch/sources/notes/autoresearch.md) — 本文件的来源项目

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [固定时间预算评估](autoresearch/concepts/fixed-time-budget-evaluation.md)
- [单文件修改原则](autoresearch/concepts/single-file-modification.md)
- [program.md](autoresearch/entities/autoresearch-program-md.md)
- [train.py](autoresearch/entities/autoresearch-train-py.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)

## References

- karpathy/autoresearch `prepare.py` 完整源码
- 本地副本：`raw/2026-06-19-autoresearch.md`

## Notes

> **待确认：** 数据下载使用固定验证分片（`shard_06542`），训练分片数量由 `--num-shards` 控制。
