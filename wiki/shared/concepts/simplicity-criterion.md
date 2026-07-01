---
title: 简约准则
description: 自主实验中变更评估准则：复杂度成本必须与收益 magnitude 相称，小幅改进若需大量 hacky 代码则不值得。
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, design-principle, complexity-tradeoff]
related:
  - autoresearch/concepts/autonomous-experiment-loop.md
  - autoresearch/concepts/single-file-modification.md
  - autoresearch/entities/autoresearch-program-md.md
  - autoresearch/sources/notes/autoresearch.md
status: stable
---

# 简约准则

> 自主实验中的变更评估准则：复杂度成本必须与收益 magnitude 相称。小幅改进（如 0.001 `val_bpb`）若需大量 hacky 代码则不值得；同等改进若来自删除代码则值得保留。简约是主动目标，而非被动约束。该准则写入 [program.md](autoresearch/entities/autoresearch-program-md.md) 作为 agent 的行为约束，是[自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md)中的决策规则，与[单文件修改原则](autoresearch/concepts/single-file-modification.md)从物理上限制了复杂度蔓延。

## Overview

简约准则是 [autoresearch](autoresearch/sources/notes/autoresearch.md) 中 agent 的决策启发式，写入 program.md 作为 agent 的行为约束。它防止 agent 在收益递减的局部最优中持续投入复杂代码。

## Details

### 评估公式

`program.md` 中明确给出的判断标准：

- **不值得** — 0.001 `val_bpb` 改进 + 20 行 hacky 代码 → 丢弃
- **值得** — 0.001 `val_bpb` 改进 + 删除代码 → 保留
- **值得** — ~0 改进 + 大幅简化 → 保留

### 为什么需要显式准则

Agent 作为自主决策者，需要清晰的启发式来避免：

- **过度工程** — 为微小收益引入复杂技巧
- **代码腐烂** — 实验历史累积的 dead code 和 workaround
- **方向迷失** — 在收益递减的局部最优中持续投入

### 与 Occam's Razor 的区别

简约准则不是"选最简单的假设"，而是"在收益相当时选更简单的实现"。它允许复杂方案，但要求复杂方案必须有与之相称的显著收益。

## Relations

- [自主实验循环](autoresearch/concepts/autonomous-experiment-loop.md) — 简约准则是循环中的决策规则
- [单文件修改原则](autoresearch/concepts/single-file-modification.md) — 单文件约束从物理上限制了复杂度蔓延
- [autoresearch 项目](autoresearch/sources/notes/autoresearch.md) — 本概念的来源项目

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [program.md](autoresearch/entities/autoresearch-program-md.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)

## References

- [program.md](autoresearch/entities/autoresearch-program-md.md) 中的 "Simplicity criterion" 段落

## Notes

> **待确认：** 该准则在 `program.md` 中以自然语言描述，agent 如何精确量化"复杂度成本"尚无形式化定义。
