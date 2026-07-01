---
title: Query → Synthesis → 归档 — 查询即知识生产
description: 将有价值的查询综合回答归档到 wiki 中，让查询也成为知识积累的渠道，而非仅消费知识库。
resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
type: concept
timestamp: 2026-06-18T00:00:00Z
tags: [wiki, query, synthesis, knowledge-production]
related:
  - wiki-system/concepts/compounding-knowledge.md
  - wiki-system/concepts/wiki-ingest-workflow.md
status: stable
---

## Overview

> Karpathy 的一个关键洞察：**好的回答不该消失在聊天历史里。** 一次有价值的查询（对比分析、连接发现、综合理解）的产出本身是知识，应该像[摄入源材料](wiki-system/concepts/wiki-ingest-workflow.md)一样归档到 wiki 中。这让查询也变成[知识积累](wiki-system/concepts/compounding-knowledge.md)的渠道——不只是消费知识库，也在生产知识。

## Details

### 机制

```
用户提问 → LLM 检索 wiki → 综合回答
                              ↓
                    回答被归档为 syntheses/<slug>.md
                              ↓
                    更新 index.md + log.md
                              ↓
                    后续查询可直接引用该 synthesis
```

### 与 Ingest 的对比

| 维度 | Ingest | Query → Synthesis |
|------|--------|-------------------|
| 输入 | 外部源材料 | 用户问题 |
| 触发 | 有新材料时 | 有值得归档的回答时 |
| 知识来源 | 外部文档 | LLM 综合推理 |
| 输出位置 | 多个目录（sources + concepts + entities） | 主要为 `syntheses/` |

### 关键设计考量

- **归档决策权** — 不是所有查询都归档。LLM 或调用方判断回答是否有"超越当前会话的复用价值"
- **引用溯源** — synthesis 通过 frontmatter `sources` 字段标注引用了哪些已有 wiki 页面
- **格式多样性** — 回答可以是 markdown 页面、对比表、幻灯片、图表等，不同格式对应不同输出目标

## Relations

- [复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md) — 查询归档是复利机制的第二条增长曲线
- [Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md) — 归档执行流程与 ingest 类似


## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

- [ZooKeeper Wiki 概览](overview.md)
- [蒸馏示例 — Karpathy LLM Wiki 文章的摄入过程](wiki-system/analysis/distillation-example-karpathy.md)
- [复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md)
- [Wiki Ingest 工作流 — 源材料的增量整合](wiki-system/concepts/wiki-ingest-workflow.md)
- [LLM Wiki — 用 LLM 构建个人知识库的模式](wiki-system/sources/notes/llm-wiki-karpathy.md)

## References

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
