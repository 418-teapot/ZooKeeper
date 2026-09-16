---
title: 增强型 LLM
description: 通过检索、工具和记忆扩展基础模型能力的 agentic system 构件，也是 agent 与外部世界交互的最小接口单元。
type: concept
timestamp: 2026-09-15T06:15:36Z
tags: [agent-design, augmented-llm, tool-use, memory, retrieval, aci]
status: stable
last_validated: 2026-09-16T01:55:38Z
timeliness: current
---

# 增强型 LLM

> 增强型 LLM（augmented LLM）是在基础模型外接检索、工具和记忆能力的最小 agentic system 构件；workflow 和 agent 都可以把它作为每次推理的基础单元。

## Overview

单次 LLM 调用只能处理已经放入上下文的信息。增强型 LLM 允许模型主动查询外部信息、执行动作，并保留对后续步骤有用的状态，从而成为 workflow 和 agent 的共同基础。

## Details

### 三类增强能力

- **Retrieval：** 从文件、数据库、搜索服务或其他知识源获取当前任务所需的信息。
- **Tools：** 调用外部服务、执行计算或改变环境状态。
- **Memory：** 保留跨轮次或跨上下文仍有价值的信息。

模型不只是被动接收这些能力，还可以生成搜索查询、选择工具，并判断哪些结果值得继续保留。

### 交互结构

```text
+-------------------+
|   Augmented LLM   |
| prompt + reasoning|
+----+---------+----+
     |         |
     v         v
 retrieval   tools
     |         |
     +----+----+
          v
       memory
          |
          v
     environment
```

增强能力应针对具体任务定制，并通过稳定、清晰、可记录的接口暴露给模型。能力越多，接口越需要避免功能重叠和语义歧义。

### Agent-computer interface

工具定义构成 agent 与外部世界交互的控制面。[Agent-Computer Interface](agent-design/concepts/agent-computer-interface.md)给出了这一接口的设计目标与验收方法（含工具测试），[Agent 工具设计](agent-design/concepts/agent-tool-design.md)进一步将其扩展为工具选择、namespace、响应格式和结果导向评估的完整工程闭环。

### 与上下文工程的关系

增强型 LLM 是能力接口；[有效上下文的构成](context-engineering/concepts/context-anatomy.md)关注如何让 system prompt、工具和示例以最小而充分的形式进入上下文。[上下文工程](context-engineering/concepts/context-engineering.md)则进一步管理每次推理时实际提供的信息集合。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [LLM Workflow 模式](agent-design/analysis/llm-workflow-patterns.md)
- [Agent-Computer Interface](agent-design/concepts/agent-computer-interface.md)
- [Agent 工具设计](agent-design/concepts/agent-tool-design.md)
- [Anthropic Writing effective tools for agents 工程博客](agent-design/sources/notes/anthropic-writing-tools-for-agents.md)
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)

## Notes

> **待确认：** 文章以检索、工具和记忆作为主要增强类别，但不同 agent runtime 对 memory 的持久化边界和一致性语义并不相同；本页不假定某一种具体实现。
