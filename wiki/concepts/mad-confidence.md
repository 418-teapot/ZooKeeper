---
title: MAD 置信度算法
description: 使用 Median Absolute Deviation 作为噪声底限，计算实验改善是否真实而非随机噪声的统计算法，对异常值鲁棒。
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, statistics, confidence, algorithm]
related:
  - concepts/autoresearch-extension-loop.md
  - sources/rfc/autoresearch-design.md
status: stable
---

# MAD 置信度算法

> 使用 Median Absolute Deviation（中位数绝对偏差）作为噪声底限，计算实验改善的置信度。相比标准差，MAD 对异常值更鲁棒，适合 LLM agent 运行 benchmark 时偶发异常值的场景。

## Overview

MAD 置信度算法是 [autoresearch 扩展](concepts/autoresearch-extension-loop.md)中判断实验改善是否"真实"的核心数学组件。它回答"这次优化是真实信号还是随机噪声"的问题。

## Details

### 计算公式

```
Confidence = |bestKept - baseline| / MAD
```

其中：
- `MAD` = median(|xi - median(x)|)，对当前 segment 所有非 flagged、metric > 0 的 run
- `bestKept` = 当前 segment 中 kept 且非 flagged 的最佳指标值
- `baseline` = 当前 segment 中第一个 kept 且非 flagged 的指标值

### 置信度解读

- `conf >= 2.0` — likely real，信号显著高于噪声
- `1.0 <= conf < 2.0` — marginal，边缘可信
- `conf < 1.0` — within noise floor，可能为噪声

### 为什么用 MAD 而非标准差

MAD 对异常值鲁棒。单个极端测量值不会大幅膨胀噪声底限，而标准差会被离群值显著拉高。在 LLM agent 自主运行 benchmark 的场景中，偶发的系统负载波动或测量异常是常见现象。

### 返回 null 的边界条件

以下情况置信度无法计算，返回 `null`：

- 当前 segment 有效 run 少于 3 个（数据不足）
- `MAD === 0`（所有值相同，无噪声信息）
- `bestKept === baseline` 或 `bestKept === null`（无改善或无最佳值）

## Relations

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md) — 本算法是循环的评估环节
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md) — 算法的完整来源

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md)
- [METRIC/ASI 文本协议](concepts/metric-asi-protocol.md)
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md)

## References

- `sources/rfc/autoresearch-design.md` §7 状态管理
- `oh-my-pi/packages/coding-agent/src/autoresearch/state.ts`

## Notes

> **待确认：** MAD null 合并问题 — 多种边界条件都返回 `null`，调用者无法区分具体原因。
