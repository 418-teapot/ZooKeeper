---
title: autoresearch ZooKeeper 移植路线图
description: 将 oh-my-pi 的 autoresearch 扩展移植到 ZooKeeper 的三阶段计划及关键障碍分析。
type: analysis
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, zookeeper, porting, roadmap, opencode]
sources:
  - autoresearch/sources/rfc/autoresearch-design.md
relations:
  - "[autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)"
  - "[Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)"
  - "[性能调优设计模式](autoresearch/analysis/performance-tuning-design-patterns.md)"
status: draft
last_validated: 2026-06-19T00:00:00Z
timeliness: current
---

# autoresearch ZooKeeper 移植路线图

> 将 oh-my-pi 的 [autoresearch 扩展](autoresearch/concepts/autoresearch-extension-loop.md)移植到 ZooKeeper（OpenCode 插件）的三阶段计划。最大障碍是 session 管理差异：Pi 原生支持深度生命周期 hook 和自定义 entry 写入，OpenCode SDK 当前仅提供只读 session 访问。

## Overview

oh-my-pi 的 autoresearch 扩展（~4131 行 TypeScript）为 ZooKeeper 的 agent 自动化提供了可直接参考的架构。移植不是简单复制，而是需要在 OpenCode SDK 的约束下重新设计核心机制（尤其是 auto-resume 和 prompt 注入）。

## Details

### 三阶段路线图

**Phase 1: 移植核心组件**
- 提取类型定义、状态管理、MAD 算法、METRIC/ASI 解析（低难度，直接复制）
- 适配 SQLite 存储层和 git 操作（中难度，Bun 环境兼容）
- 适配 4 个实验工具到 OpenCode 工具 API（中难度）
- 重新设计 plugin hooks（高难度，OpenCode hook 能力差异大）

**Phase 2: 内核调优特化**
- 定义 `perf-tuner` agent（config.toml + core/prompts/perf-tuner.md）—— 根据 [Agent/Skill/Plugin 判断框架](shared/analysis/agent-skill-plugin-framework.md)的六维评估，perf-tuning 适合实现为 agent
- 定义 `perf-tuning` skill（core/skills/perf-tuning/SKILL.md）
- 调整超时（内核编译 > 600s）
- 定义内核 benchmark 指标约定和 scope 约束模板

**Phase 3: 蒸馏与知识积累**
- 运行多轮内核调优实验，参考[性能调优设计模式](autoresearch/analysis/performance-tuning-design-patterns.md)中提炼的六种通用模式
- 记录调优轨迹，蒸馏为 `wiki/analysis/` 页面
- 形成稳定的 `perf-tuning` skill 方法论

### 关键差异：Session 管理

| 维度 | oh-my-pi (Pi 自身) | ZooKeeper (OpenCode 插件) |
|------|-------------------|--------------------------|
| 运行时身份 | Pi 自身代码（fork） | OpenCode 外挂插件 |
| Extension API | Pi 专有 Bridge | OpenCode SDK |
| Session 管理 | 原生 SessionManager + 多后端 | SDK 内置，插件只读 |
| 自定义 entry | 可读写 | 不可写 |
| 生命周期 hook | session_start、agent_end、before_agent_start | 无对应 hook |

### 无法直接移植的核心机制

1. **`reconstructControlState`** — 依赖 `sessionManager.getBranch()` 扫描 custom entries
2. **auto-resume 循环** — 依赖 `agent_end` hook 发送恢复消息
3. **prompt 注入** — 依赖 `before_agent_start` hook 每 turn 动态注入

### 四条移植路径

| 方案 | 描述 | 难度 |
|------|------|------|
| A. 增强 OpenCode SDK | 向 OpenCode 贡献扩展 SDK | 高 |
| B. 降级循环模式 | 独立 SQLite + build 显式触发 rehydrate | 中 |
| C. 自建循环协议 | bash 脚本驱动，不集成 agent 运行时 | 低 |
| D. Fork OpenCode | 改用 Pi 作为运行时基线 | 战略级 |

### 推荐组件移植顺序

按"低难度优先"顺序：类型定义和 MAD 算法 → METRIC/ASI 解析 → SQLite 存储层 → Git 操作 → 4 个实验工具 → Dashboard → Plugin hooks（最后两者难度高且依赖路径选择）。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [性能调优设计模式](autoresearch/analysis/performance-tuning-design-patterns.md)
- [autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)
- [autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)

## References

- `autoresearch/sources/rfc/autoresearch-design.md` §19 ZooKeeper 实现路线
- `autoresearch/sources/rfc/autoresearch-design.md` §19.3 Session 管理差异深度分析

## Notes

> **待确认：** 当前分析基于 OpenCode SDK 的现有能力。如果 OpenCode 未来扩展了 hook 系统，路径 A 的可行性会显著提高。
