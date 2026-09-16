---
title: ZooKeeper Wiki 概览
description: ZooKeeper wiki 系统的结构化概览，涵盖设计哲学、三层架构、当前知识版图及工具与 Agent 的分工原则。
type: synthesis
timestamp: 2026-07-01T00:00:00Z
tags: [overview, wiki, knowledge-base]
status: stable
last_validated: 2026-07-01T00:00:00Z
timeliness: current
---

## Overview

> ZooKeeper wiki 系统是 [Karpathy LLM Wiki 模式](wiki-system/sources/notes/llm-wiki-karpathy.md) 的独立实现。核心理念来自[复利知识](wiki-system/concepts/compounding-knowledge.md)：将 LLM 作为知识库的持续维护者，通过三个核心操作（ingest / query / lint）让知识库产生复利增长，而非像 RAG 那样每次查询从零推导。

## Details

### 设计哲学

本 wiki 遵循"预编译而非实时拼凑"的设计原则：

- **知识编译一次，持续维护** — [ingest](wiki-system/concepts/wiki-ingest-workflow.md) 时不只追加新页面，而是涟漪式更新所有相关页面（交叉引用、摘要、矛盾标记）
- **查询即生产** — 有价值的[查询结果归档](wiki-system/concepts/wiki-query-synthesis.md)为 syntheses/ 页面，让探索也产生知识积累
- **抗熵增** — 定期[健康检查](wiki-system/concepts/wiki-health-check.md)扫描矛盾、过时声明、孤立页面

### 三层架构

| 层 | 说明 |
|----|------|
| 源材料 | 外部文档、URL、设计记录（不可变，LLM 只读） |
| Wiki 页面 | LLM 生成和维护的结构化 markdown 文件，按领域组织（每个域含 6 类目录） |
| SCHEMA.md | 页面格式规范，内嵌于 zwiki（`zwiki schema` 查看，安装时物化到 store 根） |

### 当前知识版图

Wiki 按领域组织，每个领域独立维护 6 类页面（concepts/entities/sources/analysis/syntheses 及 sources 的三个子类）。新增领域只需 `zwiki page create --domain <name>` 即可自动创建骨架。

| 领域 | 页面数 | 核心内容 |
|------|--------|----------|
| autoresearch | 15 | 自主实验循环、扩展循环、实验版本管理、固定时间预算评估、[MAD 置信度](autoresearch/concepts/mad-confidence.md)、[METRIC/ASI 协议](autoresearch/concepts/metric-asi-protocol.md)、单文件修改原则；train.py/prepare.py/program.md 三个核心文件；设计权衡、移植路线图、性能调优模式；autoresearch 设计文档与原始提案 |
| wiki-system | 8 | 复利知识、ingest 工作流、query→synthesis 归档、健康检查、图链接预测；LLM Wiki vs RAG 对比、Karpathy 蒸馏示例；Karpathy LLM Wiki 原始材料 |
| context-engineering | 6 | 上下文工程系列（上下文工程、上下文腐烂、有效上下文构成、即时检索、长程管理）；Anthropic 上下文工程文章 |
| multi-agent | 4 | [多 agent 研究架构](multi-agent/concepts/multi-agent-research-architecture.md)、[协作 prompt](multi-agent/concepts/agent-collaboration-prompting.md)、[评估与生产可靠性](multi-agent/analysis/multi-agent-evaluation-reliability.md)；Anthropic multi-agent research 工程博客 |
| agent-design | 11 | [NPC 式分工](agent-design/concepts/npc.md)、后验问责制、简约准则、[增强型 LLM](agent-design/concepts/augmented-llm.md)、[Agent-Computer Interface](agent-design/concepts/agent-computer-interface.md)（工具接口的设计目标与验收）、[Agent 工具设计](agent-design/concepts/agent-tool-design.md)（工具边界、namespace、响应上下文、token 效率和评估闭环）；[Agent/Skill/Plugin 判断框架](agent-design/analysis/agent-skill-plugin-framework.md)、[五种 LLM workflow 模式](agent-design/analysis/llm-workflow-patterns.md)、[单次调用/workflow/自主 agent 的选择阶梯](agent-design/analysis/agentic-system-selection.md) |

### 外部参考知识

- [autoresearch](autoresearch/sources/notes/autoresearch.md) — Karpathy 的 AI agent 自主 LLM 训练实验框架，为 ZooKeeper 的 agent 自动化设计提供参考。其核心机制（自主实验循环、NPC 式分工、单文件修改原则）与 ZooKeeper 的 agent 编排理念高度相关。
- [autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md) — oh-my-pi 的 [autoresearch 扩展](autoresearch/concepts/autoresearch-extension-loop.md)设计，为 ZooKeeper 的 agent 自动化和内核调优提供架构参考。核心机制（扩展循环、MAD 置信度、METRIC/ASI 协议）与 ZooKeeper 的插件架构和 perf-tuner 规划直接相关。
- [Anthropic 上下文工程文章](context-engineering/sources/notes/anthropic-context-engineering.md) — Anthropic Applied AI 团队关于 AI agent 有效上下文工程的工程博客。其核心原则（上下文为有限资源、高信息量 token 最小化、即时检索、长程管理技术）为 ZooKeeper 的 validation 阈值和 prompt 注入机制提供独立理论支撑。
- [Anthropic 多 agent 研究系统文章](multi-agent/sources/notes/anthropic-multi-agent-research-system.md) — Anthropic 关于 Research（multi-agent research system）的工程博客。其 lead/subagent 编排模式、委派契约、effort scaling、结果导向 eval 与生产可靠性经验，与 ZooKeeper 的编排器 + subagent 委派架构直接对应。
- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md) — 关于 augmented LLM、workflow 与 agent 区分、五种 workflow 模式、agent loop 和工具设计的工程经验总结。其“简单可组合模式优先于复杂框架”原则与 ZooKeeper 的编排器设计哲学一致。
- [Anthropic Agent 工具设计文章](agent-design/sources/notes/anthropic-writing-tools-for-agents.md) — Anthropic 关于为 AI agent 选择、命名、描述、实现和评估工具的工程博客。其核心主张（工具不是 API 薄包装，而是 agent 与信息/动作空间之间的行为契约；工具质量需通过真实任务和 held-out eval 验证）为 ZooKeeper 的工具注册与委派门设计提供方法论支撑。

### 与 RAG 的本质区别

参见 [LLM Wiki vs RAG](wiki-system/analysis/llm-wiki-vs-rag.md) 的详细对比。最根本的差异在于知识状态：

- RAG：无状态，每次查询独立拼凑
- LLM Wiki：有状态，wiki 是持久化的中间产物，每次摄入和查询都让它更丰富

### 工具与 Agent 的分工原则

- **LLM（kiwi 等蒸馏 agent）** 负责判断性工作：提取、分类、组织、建议链接方向
- **工具脚本** 负责机械性工作：格式校验、反向链接派生、孤立页面检测
- 反向链接由工具从正文链接自动派生，不应由 agent 手工维护 — 确定性程序比 LLM 更适合重复性机械操作

跨主题结论：工具负责把领域边界、筛选、聚合、错误反馈和上下文压缩编码进可调用接口；agent 负责根据任务和环境反馈组合这些接口。

跨主题结论：高价值、可并行、信息量超过单一上下文窗口的任务适合 lead/subagent 架构；但生产化必须配套评估、tracing、checkpoint 与渐进部署。agentic system 应遵循复杂度阶梯：先优化单次 LLM 调用，再按可验证收益引入固定 workflow，只有在路径无法预先硬编码时才使用自主 agent；复杂度带来的灵活性必须与延迟、成本和错误累积风险进行权衡。

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
