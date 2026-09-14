## concept

- [上下文工程](concepts/context-engineering.md) — 从 prompt engineering 演进的方法论——在每次推理时精选最优 token 集合，而非仅优化 prompt 文本。
- [上下文腐烂](concepts/context-rot.md) — 随上下文 token 数增加，LLM 信息召回能力下降的现象——上下文是有限资源，边际收益递减。
- [即时上下文检索](concepts/just-in-time-context-retrieval.md) — Agent 维护轻量标识符并在运行时按需加载数据的检索模式——从预推理嵌入检索向 agentic 检索演进。
- [有效上下文的构成](concepts/context-anatomy.md) — 上下文各组件（system prompt、工具、示例）的优化原则——每个组件都应最小而充分。

## source

- [Anthropic 上下文工程文章](sources/notes/anthropic-context-engineering.md) — Anthropic 关于 AI agent 有效上下文工程的工程博客——从 prompt engineering 到上下文精选的方法论。

## analysis

- [长程任务的上下文管理](analysis/long-horizon-context-management.md) — 三种应对上下文窗口限制的技术——压缩、结构化笔记、子 agent 架构——的对比与权衡。
