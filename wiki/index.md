# Wiki Index

## Concepts（概念）

- [自主实验循环](concepts/autonomous-experiment-loop.md) — AI agent 自主修改→训练→评估→保留/丢弃的闭环
- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md) — oh-my-pi 扩展的两阶段自主循环与自动恢复
- [固定时间预算评估](concepts/fixed-time-budget-evaluation.md) — 5 分钟 wall-clock + val_bpb 的公平比较机制
- [单文件修改原则](concepts/single-file-modification.md) — agent 仅修改 train.py 的范围约束
- [后验问责制](concepts/post-hoc-accountability.md) — 通过透明度管理 agent 越界编辑的设计哲学
- [NPC 式分工](concepts/npc.md) — 人类编 skill、agent 执行的分工模式
- [简约准则](concepts/simplicity-criterion.md) — 复杂度成本与收益 magnitude 的权衡准则
- [实验版本管理](concepts/experiment-versioning.md) — git branch + commit + results.tsv 的实验跟踪
- [MAD 置信度算法](concepts/mad-confidence.md) — 基于中位数绝对偏差的实验信号检测
- [METRIC/ASI 文本协议](concepts/metric-asi-protocol.md) — 零依赖的 benchmark 度量与元数据协议
- [复利知识](concepts/compounding-knowledge.md) — 持久化 wiki 的知识积累模式，区别于 RAG 的从零推导
- [Wiki Ingest 工作流](concepts/wiki-ingest-workflow.md) — 源材料增量整合到知识库的完整流程
- [Query → Synthesis 归档](concepts/wiki-query-synthesis.md) — 查询结果归档为知识库新页面的闭环机制
- [Wiki 健康检查](concepts/wiki-health-check.md) — 定期扫描矛盾、过时内容、缺失链接的维护机制
- [图链接预测](concepts/graph-link-prediction.md) — 基于拓扑结构的缺失链接推断，与锚文本挖掘互补

## Entities（实体）

- [train.py](entities/autoresearch-train-py.md) — autoresearch 中唯一可修改的文件，含模型和训练循环
- [prepare.py](entities/autoresearch-prepare-py.md) — 固定基础设施，数据加载和评估函数
- [program.md](entities/autoresearch-program-md.md) — 人类编辑的 agent 指令文件

## Sources → ADR（架构决策）

暂无条目。

## Sources → RFC（设计文档）

- [autoresearch 设计文档](sources/rfc/autoresearch-design.md) — oh-my-pi autoresearch 扩展的完整设计记录

## Sources → Notes（笔记来源）

- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md) — Karpathy 的自主实验项目
- [LLM Wiki — Karpathy](sources/notes/llm-wiki-karpathy.md) — Karpathy 的 LLM Wiki 设计模式提案 gist

## Analysis（分析）

- [autoresearch 设计权衡分析](analysis/autoresearch-design-tradeoffs.md) — 核心设计决策的利弊结构化分析
- [Agent/Skill/Plugin 判断框架](analysis/agent-skill-plugin-framework.md) — 六维度能力分层评估框架
- [性能调优设计模式](analysis/performance-tuning-design-patterns.md) — 从 6 个 AI 调优系统提炼的通用模式
- [autoresearch ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md) — 三阶段移植计划与四条路径分析
- [蒸馏示例 — Karpathy 文章](analysis/distillation-example-karpathy.md) — 一次完整蒸馏的决策过程拆解
- [LLM Wiki vs RAG](analysis/llm-wiki-vs-rag.md) — 两种知识管理范式的结构化对比

## Syntheses（综合）

暂无条目。
