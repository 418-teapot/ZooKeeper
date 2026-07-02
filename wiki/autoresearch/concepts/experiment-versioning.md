---
title: 实验版本管理
description: 使用 git 分支和 commit 作为自主实验的版本控制系统，每个 session 一个独立分支，每次实验一个 commit，失败则 reset。
resource: https://github.com/karpathy/autoresearch
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, versioning, git, experiment-tracking]
relations:
  - "[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)"
  - "[autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)"
  - "[train.py](autoresearch/entities/autoresearch-train-py.md)"
  - "[autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)"
status: stable
last_validated: 2026-06-19T00:00:00Z
timeliness: current
---

# 实验版本管理

> 使用 git 分支和 commit 作为实验的版本控制系统：每个 session 一个独立分支，每次实验一个 commit，失败则 reset。这是[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)的持久化机制。`results.tsv` 作为实验日志（不纳入 git），记录 commit hash、指标、状态和描述。

## Overview

实验版本管理是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 的纯 git 实验跟踪方案。它不需要 Weights & Biases 或 TensorBoard 等外部服务，仅依赖 git 的 branch/commit/reset 机制。

## Details

### 分支策略

- **命名规则** — `autoresearch/<tag>`，如 `autoresearch/mar5` 或 `autoresearch/mar5-gpu0`
- **扩展格式** — `autoresearch/{slug}-{yyyymmdd}`，冲突时自动递增后缀
- **起点** — 从 `master` 切出，确保每次 session 有干净的基线
- **生命周期** — 实验期间持续 advancing，session 结束后可保留或删除

### Commit 语义

- **每个实验 = 一个 commit** — 包含完整的 [train.py](autoresearch/entities/autoresearch-train-py.md) 修改
- **改善则保留** — `val_bpb` 降低时，branch HEAD 前进
- **失败则回退** — `val_bpb` 未改善或崩溃时，`git reset` 到上一个好 commit
- **永不 amend** — 历史是线性的，便于回溯

### Segment 模型

[autoresearch 扩展](autoresearch/concepts/autoresearch-extension-loop.md)引入 segment 将迭代分组，每个 segment 有独立基线。当 benchmark 需要更改（如切换 workload）时，通过 `init_experiment new_segment: true` 创建新 segment，旧 segment 数据保留归档。

### results.tsv 格式

五列 TSV（tab-separated）：

```
commit  val_bpb  memory_gb  status  description
```

- `status` 取值：`keep`、`discard`、`crash`
- 文件不纳入 git — 避免实验日志污染代码历史

### 与 ML Experiment Tracking 的区别

传统工具（Weights & Biases, TensorBoard）依赖外部服务。实验版本管理是纯 git 方案：

- **零依赖** — 不需要外部实验跟踪平台
- **可审计** — 每个结果对应一个可检查的代码版本
- **离线可用** — 不依赖网络

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)
- [autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)

## References

- [program.md](autoresearch/entities/autoresearch-program-md.md) 中的 "The experiment loop" 和 "Logging results" 段落
- karpathy/autoresearch README

## Notes

> **待确认：** 当 agent 连续多次 crash 后，是否应提供"回退到更早稳定版本"的机制？当前 `program.md` 仅建议"rewind very very sparingly"。
