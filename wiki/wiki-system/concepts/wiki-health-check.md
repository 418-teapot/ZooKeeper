---
title: Wiki 健康检查 — 知识库的持续质量维护
description: 定期让 LLM 扫描 wiki 结构并建议修正，检测矛盾、过时内容、孤立页面和缺失交叉引用等质量问题。
resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
type: concept
timestamp: 2026-06-18T00:00:00Z
tags: [wiki, maintenance, quality]
relations:
  - "[Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md)"
  - "[LLM Wiki — 用 LLM 构建个人知识库的模式](wiki-system/sources/notes/llm-wiki-karpathy.md)"
  - "[复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)"
status: stable
last_validated: 2026-06-18T00:00:00Z
timeliness: current
---

## Overview

> Lint（健康检查）是 [LLM Wiki](wiki-system/sources/notes/llm-wiki-karpathy.md) 三个核心操作中的"维持性"操作。随着 wiki 增长，矛盾、过时声明、孤立页面、缺失交叉引用会自然累积。定期让 LLM 扫描 wiki 结构并建议修正，是用 LLM 的"不厌其烦"对抗[知识库](wiki-system/concepts/compounding-knowledge.md)的"熵增"。

## Details

### 检查维度

| 检查项 | 说明 |
|--------|------|
| 矛盾检测 | 两个页面对同一事实的声明不一致 |
| 过时内容 | 新源材料已推翻旧声明，但旧页面未更新 |
| 孤立页面 | 无 inbound 链接的页面（可能是孤岛知识） |
| 缺失页面 | 多处提及但未独立成页的重要概念 |
| 缺失交叉引用 | 两页面内容明显相关但无链接 |
| 数据缺口 | 可通过 web 搜索填补的信息空白 |

### 执行频率

- Karpathy 建议"periodically"，未给出固定频率
- 实践建议：每次大型 [ingest](wiki-system/concepts/wiki-ingest-workflow.md) 会话后，或 page 数量突破阈值时（如每 50 页）

### 与自动化工具的分工

- **LLM 负责：** 语义检查（矛盾、过时声明、数据缺口）——需要理解页面内容
- **工具脚本负责：** 机械检查（孤立页面、缺失交叉引用、格式一致性）——规则确定，不应由 agent 执行

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [ZooKeeper Wiki 概览](overview.md)
- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](wiki-system/analysis/distillation-example-karpathy.md)
- [图链接预测 — 基于拓扑结构的缺失链接推断](wiki-system/concepts/graph-link-prediction.md)
- [Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md)
- [LLM Wiki — 用 LLM 构建个人知识库的模式](wiki-system/sources/notes/llm-wiki-karpathy.md)

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
