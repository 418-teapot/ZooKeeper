---
title: METRIC/ASI 文本协议
type: concept
created: 2026-06-19
updated: 2026-06-19
tags: [autoresearch, protocol, metric, benchmark]
related:
  - concepts/autoresearch-extension-loop.md
  - concepts/mad-confidence.md
  - sources/rfc/autoresearch-design.md
status: stable
---

# METRIC/ASI 文本协议

> 基于标准输出的零依赖文本协议：benchmark 通过 `METRIC name=value` 行报告指标，通过 `ASI key=value` 行存储结构化元数据。任何语言/工具均可通过简单 `echo` 输出，无需库依赖。

## Overview

METRIC/ASI 协议是 [autoresearch 扩展](concepts/autoresearch-extension-loop.md)的度量与元数据交换约定。它让 benchmark 脚本与插件之间无需共享库或 RPC，仅通过 stdout 文本行完成通信。

## Details

### METRIC 行格式

`METRIC <name>=<value>`

- `name` 由字母、数字、点、µ、连字符组成
- `value` 为有限数值（`Number.isFinite` 过滤）
- 每行一个指标，多指标多行输出
- 主指标名称由 `init_experiment` 的 `primary_metric` 参数指定

### ASI 行格式

`ASI <key>=<value>`

- `key` 由字母、数字、点、连字符组成
- `value` 自动类型检测：boolean → null → number → JSON → string
- 支持嵌套 JSON 对象和数组
- 用途：存储假设、回滚原因、下一步建议等自由格式元数据

### 安全设计

- **原型污染防护** — 过滤 `__proto__`、`constructor`、`prototype` 键名
- **两阶段截断** — LLM 接收严格截断（4KB/10 行），显示用默认限制
- **数值校验** — 仅保留有限数值，排除 `NaN` 和 `Infinity`

### 设计 rationale

选择文本协议而非结构化接口（如 gRPC、共享内存）的理由：

- **零依赖** — 任何语言均可通过 `echo` 输出
- **语言无关** — Shell、Python、C、Rust 等无差别支持
- **约定优于配置** — 无需预定义 schema，agent 自由使用 ASI
- **日志即协议** — benchmark 输出同时是人类可读日志和机器可解析数据

## Relations

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md) — 协议是循环的度量传递机制
- [MAD 置信度算法](concepts/mad-confidence.md) — 协议提供的主指标是置信度计算的输入
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md) — 完整来源

## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md)
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md)

## References

- `sources/rfc/autoresearch-design.md` §10 METRIC/ASI 协议
- `oh-my-pi/packages/coding-agent/src/autoresearch/helpers.ts`

## Notes

> **待确认：** 启发式单位推断（`inferMetricUnitFromName`）通过后缀匹配（`_ms` → "ms"），模式枚举不完备，可能产生误导性显示。
