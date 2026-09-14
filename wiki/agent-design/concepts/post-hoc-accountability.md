---
title: 后验问责制
description: 不阻止 agent 越界编辑，而是在实验记录时捕获偏差并要求合理性说明，通过透明度而非硬限制管理 agent 自主性。
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [autoresearch, design-philosophy, scope-management, agent-constraint]
relations:
  - "[autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)"
  - "[单文件修改原则](autoresearch/concepts/single-file-modification.md)"
  - "[autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)"
status: stable
last_validated: 2026-06-19T00:00:00Z
timeliness: current
---

# 后验问责制

> 不阻止 agent 的越界编辑，而是在实验记录时捕获偏差并要求合理性说明。通过透明度而非硬限制来管理 agent 的自主性，在灵活性与可审计性之间取得平衡。该理念与 Karpathy 原始[单文件修改原则](autoresearch/concepts/single-file-modification.md)的硬限制形成对比，在 [autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)的 §15.1 中有系统性阐述。

## Overview

后验问责制是 [autoresearch 扩展](autoresearch/concepts/autoresearch-extension-loop.md)的权限设计哲学。与"编辑防护"（阻止 agent 修改特定文件）不同，它允许 agent 修改任何文件，但要求对超出 scope 的修改负责。

## Details

### 核心机制

1. **Scope 定义** — `init_experiment` 指定 `scope_paths`（预期修改）和 `off_limits`（禁止修改）
2. **偏差记录** — `log_experiment` 自动检测并记录 `scope_deviations`（越界路径）
3. **合理性要求** — 对越界修改执行 `keep` 时，必须提供 `justification`
4. **后续问责** — 无理由的越界修改在下一迭代 prompt 中标记为 `unjustified`
5. **Retroactive 修正** — 通过 `flag_runs` 标记历史 run 为可疑，排除出基线计算

### 与编辑防护的对比

| 维度 | 编辑防护（前置阻止） | 后验问责制（后置记录） |
|------|-------------------|----------------------|
| 灵活性 | 低 — 硬限制可能阻止必要修改 | 高 — 允许意外但必要的修改 |
| 安全性 | 高 — 物理隔离 | 中 — 依赖 agent 诚实记录 |
| 透明度 | 低 — 阻止行为不可见 | 高 — 所有修改均可审计 |
| 误报成本 | 高 — 合法修改被阻止 | 低 — 仅需额外说明 |

### 设计理由

Agent 的自主性不应被硬限制束缚。实际优化中，意料之外的文件修改有时是必要的（如修改配置文件以启用新优化选项）。问责制在保持灵活性的同时提供了透明度，并通过 `flag_runs` 允许人类后续修正。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [autoresearch 扩展循环](autoresearch/concepts/autoresearch-extension-loop.md)
- [单文件修改原则](autoresearch/concepts/single-file-modification.md)
- [autoresearch 设计文档](autoresearch/sources/rfc/autoresearch-design.md)

## References

- `autoresearch/sources/rfc/autoresearch-design.md` §15.1 后验问责 vs 编辑防护
- `autoresearch/sources/rfc/autoresearch-design.md` §11.3 log_experiment 工具规范

## Notes

> **待确认：** 当前实现中 agent 理论上可以绕过记录（不调用 `log_experiment`），但循环设计通过 `auto-resume` 强制要求完成 log 步骤才能继续。
