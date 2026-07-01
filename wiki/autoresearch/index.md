# autoresearch 领域

## Concepts（概念）

* [自主实验循环](concepts/autonomous-experiment-loop.md) - AI agent 自主修改→训练→评估→保留/丢弃的闭环
* [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md) - oh-my-pi 扩展的两阶段自主循环与自动恢复
* [固定时间预算评估](concepts/fixed-time-budget-evaluation.md) - 5 分钟 wall-clock + val_bpb 的公平比较机制
* [单文件修改原则](concepts/single-file-modification.md) - agent 仅修改 train.py 的范围约束
* [实验版本管理](concepts/experiment-versioning.md) - git branch + commit + results.tsv 的实验跟踪
* [MAD 置信度算法](concepts/mad-confidence.md) - 基于中位数绝对偏差的实验信号检测
* [METRIC/ASI 文本协议](concepts/metric-asi-protocol.md) - 零依赖的 benchmark 度量与元数据协议

## Entities（实体）

* [train.py](entities/autoresearch-train-py.md) - autoresearch 中唯一可修改的文件，含模型和训练循环
* [prepare.py](entities/autoresearch-prepare-py.md) - 固定基础设施，数据加载和评估函数
* [program.md](entities/autoresearch-program-md.md) - 人类编辑的 agent 指令文件

## Sources（源文档）

* [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md) - Karpathy 的自主实验项目
* [autoresearch 设计文档](sources/rfc/autoresearch-design.md) - oh-my-pi autoresearch 扩展的完整设计记录
* ADR — 暂无条目。

## Analysis（分析）

* [autoresearch 设计权衡分析](analysis/autoresearch-design-tradeoffs.md) - 核心设计决策的利弊结构化分析
* [autoresearch ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md) - 三阶段移植计划与四条路径分析
* [性能调优设计模式](analysis/performance-tuning-design-patterns.md) - 从 6 个 AI 调优系统提炼的通用模式

## Syntheses（综合）

暂无条目。
