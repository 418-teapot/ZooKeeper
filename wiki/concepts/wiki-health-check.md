---
title: Wiki 健康检查 — 知识库的持续质量维护
type: concept
created: 2026-06-18
updated: 2026-06-18
tags: [wiki, maintenance, quality]
related:
  - concepts/wiki-ingest-workflow.md
  - concepts/wiki-query-synthesis.md
status: stable
---

## Overview

> Lint（健康检查）是 [LLM Wiki](sources/notes/llm-wiki-karpathy.md) 三个核心操作中的"维持性"操作。随着 wiki 增长，矛盾、过时声明、孤立页面、缺失交叉引用会自然累积。定期让 LLM 扫描 wiki 结构并建议修正，是用 LLM 的"不厌其烦"对抗[知识库](concepts/compounding-knowledge.md)的"熵增"。

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
- 实践建议：每次大型 [ingest](concepts/wiki-ingest-workflow.md) 会话后，或 page 数量突破阈值时（如每 50 页）

### 与自动化工具的分工

- **LLM 负责：** 语义检查（矛盾、过时声明、数据缺口）——需要理解页面内容
- **工具脚本负责：** 机械检查（孤立页面、缺失交叉引用、格式一致性）——规则确定，不应由 agent 执行

## Relations

- [Wiki Ingest 工作流 — 源材料的增量整合](concepts/wiki-ingest-workflow.md) — lint 检查 ingest 的质量结果
- [复利知识 — 持久化知识库的核心价值](concepts/compounding-knowledge.md) — lint 保证复利积累的"本金"不腐烂


## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](analysis/distillation-example-karpathy.md)
- [Wiki Ingest 工作流 — 源材料的增量整合](concepts/wiki-ingest-workflow.md)
- [Query → Synthesis → 归档 — 查询即知识生产](concepts/wiki-query-synthesis.md)
- [LLM Wiki — 用 LLM 构建个人知识库的模式](sources/notes/llm-wiki-karpathy.md)

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
