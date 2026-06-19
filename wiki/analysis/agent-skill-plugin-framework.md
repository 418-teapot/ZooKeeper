---
title: Agent/Skill/Plugin 判断框架
type: analysis
created: 2026-06-19
updated: 2026-06-19
tags: [autoresearch, architecture, agent-design, extension-design]
sources:
  - sources/rfc/autoresearch-design.md
related:
  - concepts/autoresearch-extension-loop.md
  - analysis/autoresearch-porting-roadmap.md
  - sources/rfc/autoresearch-design.md
status: stable
---

# Agent/Skill/Plugin 判断框架

> 六维度评估框架：通过权限隔离、模型差异、上下文隔离、并行执行、角色边界、迭代模式六个维度判断一个能力应该实现为 Agent、Skill 还是 Plugin Extension。核心洞察是 autoresearch 的价值不在"谁来做"，而在"循环基础设施 + 度量协议 + 状态持久化"。

## Overview

oh-my-pi 的 [autoresearch 设计](sources/rfc/autoresearch-design.md)经历了"Agent vs Skill vs Plugin Extension"的深度讨论。最终结论是一个三层协作架构：Plugin 提供循环基础设施，Agent 提供领域知识和执行能力，Skill 提供方法论约束。

## Details

### 六维度评估框架

六个评估维度：

- **权限隔离** — 需要不同工具访问面 → Agent；共享 host 权限 → Skill
- **模型差异** — 需要不同 tier 模型 → Agent；沿用 host 模型 → Skill
- **上下文隔离** — 专项上下文污染主对话 → Agent；共享上下文有益 → Skill
- **并行执行** — 可同时多实例 → Agent；单一执行流 → Skill
- **角色边界** — 身份清晰 → Agent；角色不重要 → Skill
- **迭代模式** — measure→analyze→change 循环 → Agent；单次工作流 → Skill

简化判据：Agent = 换个身份、换个脑子、换个沙箱；Skill = 同一个人，穿上专门的工作服。

### 内核调优的分项评估

对 Linux 内核调优场景的具体评估（4/6 维度倾向 Agent）：

- **权限** — 和 general 几乎相同 → Skill
- **模型** — 热点分析、寄存器状态判断需要强模型 → Agent
- **上下文** — kernel 调优上下文很重，会污染主对话 → Agent
- **并行** — 多策略并行很常见 → Agent
- **身份** — 有明确"调优专家"身份 → Agent
- **迭代** — measure→analyze→change 多次循环 → Agent

### 关键洞察：Extension 的独立价值

autoresearch 的真正价值不在"谁来做"（agent 身份），而在**循环机制 + 度量协议 + 状态持久化**：

| 方案 | 循环能力 | 状态持久化 | 度量协议 |
|------|---------|----------|----------|
| 纯 agent | prompt 自己维持（不可靠） | 无 | 无标准 |
| 纯 skill | 每次人工驱动（非自主） | 无 | 无标准 |
| plugin + agent | **插件提供循环基础设施** | SQLite | METRIC 协议 |

### 三层协作架构

```
perf-tuning (skill)          ← 方法论、工具链约定、决策树
    ↓ 委派
perf-tuner (agent)           ← 权限、模型、身份、执行能力
    ↓ 使用工具
autoresearch (plugin)        ← 4 个工具、SQLite、segment、auto-resume、dashboard
```

## Relations

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md) — 插件提供的循环基础设施
- [ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md) — 将该框架应用于 ZooKeeper 的设计
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md) — 完整来源

## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [autoresearch ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md)
- [性能调优设计模式](analysis/performance-tuning-design-patterns.md)
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md)

## References

- `sources/rfc/autoresearch-design.md` §3 Agent vs Skill vs Plugin Extension

## Notes

> **待确认：** 该框架假设 host agent 和 subagent 使用同一套工具 API。如果工具 API 差异显著（如 OpenCode vs Pi Extension Bridge），评估结果可能变化。
