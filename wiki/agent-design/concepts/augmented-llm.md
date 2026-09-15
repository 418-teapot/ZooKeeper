---
title: 增强型 LLM
description: 通过检索、工具和记忆扩展基础模型能力的 agentic system 构件，也是 agent 与外部世界交互的最小接口单元。
type: concept
timestamp: 2026-09-15T06:15:36Z
tags: [agent-design, augmented-llm, tool-use, memory, retrieval, aci]
status: stable
last_validated: 2026-09-15T06:15:36Z
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

工具定义是 agent-computer interface（ACI），其质量会直接影响 agent 的行动路径。好的工具接口应：

- 明确用途、参数含义、边界和失败行为；
- 提供必要的输入格式、边缘情况和使用示例；
- 使用模型熟悉、自然出现的输出格式；
- 避免无谓的计数、转义和结构化开销；
- 通过参数设计让常见错误更难发生。

接口设计的目标不是增加规则数量，而是让正确动作成为最容易选择的动作。

### 工具测试

工具不能只按 API 是否能运行来验收，还应观察模型如何实际使用它。测试过程应覆盖：

- 代表性输入；
- 错误参数和边界条件；
- 多个相似工具之间的选择；
- 工具结果返回后的下一步行为；
- 长路径中工作目录或状态变化后的调用。

根据失败轨迹修改工具名称、描述和参数，比继续堆叠 system prompt 更可能解决工具误用问题。

### 与上下文工程的关系

增强型 LLM 是能力接口；[有效上下文的构成](context-engineering/concepts/context-anatomy.md)关注如何让 system prompt、工具和示例以最小而充分的形式进入上下文。[上下文工程](context-engineering/concepts/context-engineering.md)则进一步管理每次推理时实际提供的信息集合。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [LLM Workflow 模式](agent-design/analysis/llm-workflow-patterns.md)
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)
- [Agent 协作的 prompt 与工具设计](multi-agent/concepts/agent-collaboration-prompting.md)
- [ZooKeeper Wiki 概览](overview.md)

## References

- [Anthropic Building Effective Agents 工程博客](agent-design/sources/notes/anthropic-building-effective-agents.md)
- Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents
- [有效上下文的构成](context-engineering/concepts/context-anatomy.md)

## Notes

> **待确认：** 文章以检索、工具和记忆作为主要增强类别，但不同 agent runtime 对 memory 的持久化边界和一致性语义并不相同；本页不假定某一种具体实现。
