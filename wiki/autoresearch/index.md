## concept

- [autoresearch 扩展循环](concepts/autoresearch-extension-loop.md) — oh-my-pi 提供的两阶段自主实验循环，通过插件基础设施、SQLite 持久化和 agent_end hook 实现无人值守的持续迭代优化。
- [MAD 置信度算法](concepts/mad-confidence.md) — 使用 Median Absolute Deviation 作为噪声底限，计算实验改善是否真实而非随机噪声的统计算法，对异常值鲁棒。
- [METRIC/ASI 文本协议](concepts/metric-asi-protocol.md) — 基于标准输出的零依赖文本协议，通过 METRIC 行报告指标和 ASI 行存储结构化元数据，任何语言均可通过简单 echo 输出。
- [单文件修改原则](concepts/single-file-modification.md) — 在自主实验框架中 agent 只能修改单一文件 train.py，其余文件固定不变，将搜索空间限制在模型架构和训练流程内。
- [固定时间预算评估](concepts/fixed-time-budget-evaluation.md) — 以固定 wall-clock 时间（5 分钟）作为实验控制变量，结合 val_bpb 指标实现不同架构和超参在同等时间成本下的公平比较。
- [实验版本管理](concepts/experiment-versioning.md) — 使用 git 分支和 commit 作为自主实验的版本控制系统，每个 session 一个独立分支，每次实验一个 commit，失败则 reset。
- [自主实验循环](concepts/autonomous-experiment-loop.md) — AI agent 自主进行小规模 LLM 训练实验的闭环机制：读取指令、修改代码、运行训练、评估结果、保留或丢弃。

## entity

- [prepare.py](entities/autoresearch-prepare-py.md) — 固定不变的基础设施文件，负责数据下载、BPE tokenizer 训练和 val_bpb 评估，确保实验可比性。
- [program.md](entities/autoresearch-program-md.md) — 人类可编辑的 agent 指令文件，定义实验目标、约束条件和行为准则的轻量级 skill。
- [train.py](entities/autoresearch-train-py.md) — autoresearch 中唯一由 AI agent 修改的文件，包含 GPT 模型、MuonAdamW 优化器和训练循环的核心实验画布。

## source

- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md) — Andrej Karpathy 发布的让 AI agent 在单 GPU 上自主进行 LLM 训练实验的开源框架。
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md) — oh-my-pi 的 autoresearch 扩展完整设计文档，涵盖架构设计、核心循环、类型系统和状态管理等 19 个章节。

## analysis

- [autoresearch ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md) — 将 oh-my-pi 的 autoresearch 扩展移植到 ZooKeeper 的三阶段计划及关键障碍分析。
- [autoresearch 设计权衡分析](analysis/autoresearch-design-tradeoffs.md) — autoresearch 项目核心设计决策（固定时间预算、单文件修改等）的利弊分析与适用边界。
- [性能调优设计模式](analysis/performance-tuning-design-patterns.md) — 从 Linux 内核调优和 GPU 计算领域的 AI agent 系统中提炼的六个通用性能调优设计模式。
