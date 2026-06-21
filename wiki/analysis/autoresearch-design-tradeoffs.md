---
title: autoresearch 设计权衡分析
description: autoresearch 项目核心设计决策（固定时间预算、单文件修改等）的利弊分析与适用边界。
type: analysis
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, design, tradeoff, analysis]
sources:
  - sources/notes/autoresearch.md
related:
  - concepts/fixed-time-budget-evaluation.md
  - concepts/single-file-modification.md
  - concepts/npc.md
  - concepts/simplicity-criterion.md
  - sources/notes/autoresearch.md
status: stable
---

# [autoresearch 设计](sources/rfc/autoresearch-design.md)权衡分析

> [autoresearch](sources/notes/autoresearch.md) 项目的核心设计决策及其利弊分析。每个决策都是在特定约束下的权衡，理解这些权衡有助于评估该框架的适用边界和扩展方向。

## Overview

autoresearch 的设计不是"最优解"，而是"在约束下的合理选择"。本文档分析四个核心决策的利弊，帮助判断该框架是否适合你的场景。

## Details

### 固定时间预算 vs 固定步数/epoch

| 维度 | 固定时间预算 | 固定步数 |
|------|-------------|---------|
| **公平性** | 不同架构在相同 wall-clock 下比较 | 大模型天然吃亏（每步更慢） |
| **平台适配** | 自动找到该平台 5 分钟内的最优解 | 需要针对平台调整步数 |
| **跨平台可比性** | 结果不可比 | 结果可比 |
| **适用场景** | 个人实验、平台优化 | 学术论文、基准测试 |

**结论：** 固定时间预算适合"找到我的 GPU 上的最优配置"，不适合"发表可复现的 benchmark 结果"。

### 单文件修改 vs 全仓库修改

| 维度 | 单文件修改 | 全仓库修改 |
|------|-----------|-----------|
| **范围控制** | 防止 agent 破坏数据管道 | 允许更激进的架构重构 |
| **Diff 审查** | 人类可快速 review | 变更分散，难以审查 |
| **表达能力** | 受限（不能改数据格式） | 完全自由 |
| **故障定位** | 崩溃必在 [train.py](entities/autoresearch-train-py.md) | 可能源于任何文件 |

**结论：** 单文件修改是 agent 自主性的"安全护栏"，适合无人值守场景。全仓库修改更适合有人监督的协作开发。

### 自包含 vs 依赖外部服务

| 维度 | 自包含（纯 git） | 外部实验跟踪（W&B 等） |
|------|-----------------|----------------------|
| **依赖** | 零外部依赖 | 需要 API key、网络、服务可用性 |
| **可审计性** | 代码与结果一一对应 | 需要跨系统关联 |
| **功能丰富度** | 仅基础记录 | 可视化、对比、超参搜索 |
| **离线可用** | 完全离线 | 需要网络 |

**结论：** 自包含是"最小可行实验跟踪"，适合快速启动和隐私敏感场景。规模化后可能需要补充外部工具。

### [NPC 式分工](concepts/npc.md) vs 协作编程

| 维度 | NPC 式分工 | 协作编程 |
|------|-----------|---------|
| **人类投入** | 低（设定后无人值守） | 高（持续交互） |
| **策略迭代** | 通过编辑 [program.md](entities/autoresearch-program-md.md) | 通过对话和代码审查 |
| **Agent 一致性** | 高（同一 skill 文件） | 低（依赖上下文窗口） |
| **适用时长** | 长时间（overnight） | 短时间（单次会话） |

**结论：** NPC 式分工是"委托模式"，适合长时间自主运行。协作编程是"伙伴模式"，适合复杂问题求解。

## Relations

- [固定时间预算评估](concepts/fixed-time-budget-evaluation.md) — 被分析的设计决策之一
- [单文件修改原则](concepts/single-file-modification.md) — 被分析的设计决策之一
- [NPC 式分工](concepts/npc.md) — 被分析的设计决策之一
- [简约准则](concepts/simplicity-criterion.md) — 被分析的设计决策之一
- [autoresearch 项目](sources/notes/autoresearch.md) — 被分析的来源项目

## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md)

## References

- karpathy/autoresearch README "Design choices" 章节
- [program.md](entities/autoresearch-program-md.md) 中的约束和准则定义

## Notes

> **待确认：** 分析基于当前单 agent 设计。多 agent 协作时部分权衡（如单文件修改）可能需要重新评估。
