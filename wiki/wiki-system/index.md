## concept

- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md) — 将有价值的查询综合回答归档到 wiki 中，让查询也成为知识积累的渠道，而非仅消费知识库。
- [Wiki Ingest 工作流 — 源材料的增量整合](concepts/wiki-ingest-workflow.md) — 将新源材料结构性整合进已有知识库的核心写入操作，通过交叉引用和摘要更新让整个知识库更丰富。
- [Wiki 健康检查 — 知识库的持续质量维护](concepts/wiki-health-check.md) — 定期让 LLM 扫描 wiki 结构并建议修正，检测矛盾、过时内容、孤立页面和缺失交叉引用等质量问题。
- [图链接预测 — 基于拓扑结构的缺失链接推断](concepts/graph-link-prediction.md) — 不依赖文本内容，仅从页面间拓扑结构推断哪些页面应该互连但未连，作为 Wiki 健康检查中缺失交叉引用检测的互补路径。
- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md) — 解释 LLM Wiki 通过预编译交叉引用和持久化中间产物实现知识复利增长的核心价值，区别于 RAG 每次查询从零推导的模式。

## source

- [LLM Wiki — 用 LLM 构建个人知识库的模式](sources/notes/llm-wiki-karpathy.md) — Karpathy 提出的用 LLM 增量构建和维护结构化交叉引用 markdown wiki 的知识管理模式。

## analysis

- [LLM Wiki vs RAG — 两种知识管理范式的对比](analysis/llm-wiki-vs-rag.md) — LLM Wiki 与 RAG 两种知识管理哲学在知识状态、增长方式和价值曲线上的系统对比。
- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](analysis/distillation-example-karpathy.md) — 以 Karpathy 的 LLM Wiki gist 为例完整展示一次 wiki 蒸馏的决策过程和跨页结构设计。
