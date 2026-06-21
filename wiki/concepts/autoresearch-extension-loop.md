---
title: autoresearch 扩展循环
description: oh-my-pi 提供的两阶段自主实验循环，通过插件基础设施、SQLite 持久化和 agent_end hook 实现无人值守的持续迭代优化。
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, extension, experiment-loop, auto-resume]
related:
  - concepts/autonomous-experiment-loop.md
  - concepts/metric-asi-protocol.md
  - concepts/post-hoc-accountability.md
  - concepts/experiment-versioning.md
  - analysis/autoresearch-porting-roadmap.md
  - sources/rfc/autoresearch-design.md
status: stable
---

# autoresearch 扩展循环

> oh-my-pi autoresearch 扩展模块的两阶段自主循环：Phase 1 构建 benchmark harness，Phase 2 执行"修改 → 运行 → 测量 → 保留/丢弃"迭代。通过 `agent_end` hook 实现自动恢复，无需人类干预即可持续运行。

## Overview

autoresearch 扩展循环是 [Karpathy 自主实验循环](concepts/autonomous-experiment-loop.md) 的架构化演进。它将循环机制从 agent prompt 层面下沉到插件基础设施层面，提供 4 个 LLM-callable 工具、SQLite 状态持久化、[MAD 置信度](concepts/mad-confidence.md)评估和自动恢复能力。

扩展循环在原始基础上增加了：插件驱动的循环基础设施（替代 prompt 自主维持）、SQLite 跨会话状态持久化、METRIC/ASI 标准度量协议、agent_end 自动恢复机制、4 个结构化工具接口，以及 MAD 置信度评估。

## Details

### Phase 1: Harness 设置

在首次迭代前，agent 必须完成以下步骤：

1. 阅读源代码，理解优化目标
2. 编写 `./autoresearch.sh` — benchmark 入口脚本
3. 编写支持文件（benchmark binaries、fixtures 等）
4. 通过 `bash` 工具验证脚本可运行且输出至少一个 `METRIC` 行
5. 调用 `init_experiment` 工具进入 Phase 2

`init_experiment` 自动捕获基线 commit、创建 SQLite session 记录、激活 autoresearch 模式。

### Phase 2: 七步迭代协议

每次迭代遵循固定操作序列：

1. **理解目标** — 阅读源码，识别瓶颈
2. **更新目标/范围** — 通过 `init_experiment` 或 `update_notes` 调整
3. **建立基线** — 首次 `run_experiment` + `log_experiment keep`
4. **迭代修改** — 修改代码后调用 `run_experiment`
5. **评估指标** — `log_experiment` 选择 keep / discard / crash / checks_failed
6. **记录洞察** — 通过 `ASI` 输出存储假设、回滚原因等元数据
7. **置信度验证** — 置信度低时重跑，直到 `conf ≥ 2x` 噪声底限

### 自动恢复机制

`agent_end` hook 在每次 agent 响应结束后检查以下条件：

- autoresearch 模式已激活
- 无待处理用户消息
- 存在 pending run（已完成但未 log）
- 非重复恢复（通过 `lastAutoResumePendingRunNumber` 去重）

条件满足时，插件发送 `autoresearch-resume` 自定义消息作为下一 turn 输入，触发 LLM 继续迭代。这一设计解耦于特定工具，支持 overnight 无人值守运行。

## Relations

- [自主实验循环](concepts/autonomous-experiment-loop.md) — Karpathy 原始循环，本扩展的基础
- [METRIC/ASI 协议](concepts/metric-asi-protocol.md) — 循环的度量与元数据协议
- [后验问责制](concepts/post-hoc-accountability.md) — 循环的权限设计哲学
- [实验版本管理](concepts/experiment-versioning.md) — 循环的版本控制机制
- [ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md) — 将该循环移植到 ZooKeeper 的分析
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md) — 完整来源

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [Agent/Skill/Plugin 判断框架](analysis/agent-skill-plugin-framework.md)
- [autoresearch ZooKeeper 移植路线图](analysis/autoresearch-porting-roadmap.md)
- [自主实验循环](concepts/autonomous-experiment-loop.md)
- [实验版本管理](concepts/experiment-versioning.md)
- [MAD 置信度算法](concepts/mad-confidence.md)
- [METRIC/ASI 文本协议](concepts/metric-asi-protocol.md)
- [后验问责制](concepts/post-hoc-accountability.md)
- [autoresearch — AI agent 自主 LLM 训练实验框架](sources/notes/autoresearch.md)
- [autoresearch 设计文档](sources/rfc/autoresearch-design.md)

## References

- `sources/rfc/autoresearch-design.md` §5 核心循环流程
- `sources/rfc/autoresearch-design.md` §12 插件 Hook 集成

## Notes

> **待确认：** ZooKeeper 基于 OpenCode SDK，当前无 `agent_end` hook 和 `sendMessage` API，auto-resume 机制需重新设计（参见 [移植路线图](analysis/autoresearch-porting-roadmap.md)）。
