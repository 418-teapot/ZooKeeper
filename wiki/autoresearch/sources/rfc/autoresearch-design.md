---
title: autoresearch 设计文档
description: oh-my-pi 的 autoresearch 扩展完整设计文档，涵盖架构设计、核心循环、类型系统和状态管理等 19 个章节。
type: source
timestamp: 2026-06-19T00:00:00Z
resource: raw/2026-06-19-autoresearch-design.md
tags: [autoresearch, design, rfc, oh-my-pi]
relations:
  - "[autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)"
  - "[MAD 置信度算法](autoresearch/concepts/mad-confidence.md)"
  - "[METRIC/ASI 文本协议](autoresearch/concepts/metric-asi-protocol.md)"
  - "[后验问责制](shared/concepts/post-hoc-accountability.md)"
  - "[Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)"
  - "[性能调优设计模式](autoresearch/analysis/performance-tuning-design-patterns.md)"
  - "[autoresearch ZooKeeper 移植路线图](autoresearch/analysis/autoresearch-porting-roadmap.md)"
status: stable
---

# autoresearch 设计文档

> oh-my-pi 的 [autoresearch 扩展](autoresearch/concepts/autoresearch-extension-loop.md)模块的完整设计文档（3747 行）。涵盖架构设计、行业调研（蒸馏为[性能调优设计模式](autoresearch/analysis/performance-tuning-design-patterns.md)）、Agent/Skill/Plugin 讨论、核心循环、类型系统、状态管理、存储层、Git 策略、[METRIC/ASI 协议](autoresearch/concepts/metric-asi-protocol.md)、工具规范、Hook 集成、Dashboard、Prompt 工程、设计决策（包括[后验问责制](shared/concepts/post-hoc-accountability.md)）、测试策略、配置参数、已知局限和 [ZooKeeper 移植路线图](autoresearch/analysis/autoresearch-porting-roadmap.md)。

## Overview

本文档是 oh-my-pi（OpenCode 的 fork/演进）autoresearch 扩展的权威设计记录。该扩展为 LLM agent 提供自主迭代优化能力，核心是一个"生成 → 运行 → 测量 → 保留/丢弃"循环。

## Details

### 文档结构

本文档共 19 个章节，核心可复用知识集中在：§2（行业调研与 6 个设计模式）、§3（[Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)）、§5（两阶段循环与 auto-resume）、§7（[MAD 置信度算法](autoresearch/concepts/mad-confidence.md)）、§10（METRIC/ASI 协议）、§15（7 个关键设计决策）、§18（8 个已知局限）、§19（ZooKeeper 移植路线图）。

实现层面细节（TypeScript 接口、行号引用、测试 fixture、模板变量清单）占约 60%，属于非核心知识。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 设计权衡分析](autoresearch/analysis/autoresearch-design-tradeoffs.md)
- [autoresearch ZooKeeper 移植路线图](autoresearch/analysis/autoresearch-porting-roadmap.md)
- [性能调优设计模式](autoresearch/analysis/performance-tuning-design-patterns.md)
- [autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)
- [MAD 置信度算法](autoresearch/concepts/mad-confidence.md)
- [METRIC/ASI 文本协议](autoresearch/concepts/metric-asi-protocol.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](autoresearch/sources/notes/autoresearch.md)
- [ZooKeeper Wiki 概览](overview.md)
- [Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)
- [后验问责制](shared/concepts/post-hoc-accountability.md)

## References

- 本地副本：`raw/2026-06-19-autoresearch-design.md`
- Karpathy autoresearch: https://github.com/karpathy/autoresearch

## Notes

> **待确认：** 文档版本为 2.0（2026-06-17），后续更新可能改变 §19 的移植分析结论。
