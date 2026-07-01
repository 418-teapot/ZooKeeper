---
title: 图链接预测 — 基于拓扑结构的缺失链接推断
description: 不依赖文本内容，仅从页面间拓扑结构推断哪些页面应该互连但未连，作为 Wiki 健康检查中缺失交叉引用检测的互补路径。
type: concept
timestamp: 2026-06-19T00:00:00Z
tags: [wiki, graph-theory, link-prediction, health-check]
related:
  - wiki-system/concepts/wiki-health-check.md
  - wiki-system/concepts/compounding-knowledge.md
  - wiki-system/analysis/llm-wiki-vs-rag.md
status: stable
---

# 图链接预测 — 基于拓扑结构的缺失链接推断

> 不依赖文本内容，仅从页面间的拓扑结构推断"哪些页面应该互连但未连"。作为 Wiki 健康检查中"缺失交叉引用"检测的互补路径。交叉引用密度是 wiki 产生 n² 级关联价值的前提（见[复利知识](wiki-system/concepts/compounding-knowledge.md)），而图链接预测与锚文本挖掘两条路径互补（详见 [LLM Wiki vs RAG](wiki-system/analysis/llm-wiki-vs-rag.md) 中的价值曲线对比）。

## Overview

Wiki 已有的锚文本挖掘（见 [Wiki 健康检查](wiki-system/concepts/wiki-health-check.md) 中的 `check_missing_inline_links`）依赖已建立的链接映射表发现缺失内联链接，对新页面或冷门概念覆盖不足。图链接预测提供一条纯拓扑路径：将 wiki 视为有向图（节点 = 页面，边 = `related` 声明 + 正文内联链接），通过邻居集合的交集和路径结构推断缺失边。

## Details

### 局部邻域方法

基于两页面的共同邻居集合推断连接概率：

- **Common Neighbors（CN）** — `score = |Γ(A) ∩ Γ(B)|`。直觉：两个页面引用越多相同的第三方页面，越应互连。致命弱点：偏向高度数节点（hub 页天然有大量共同邻居）。
- **Jaccard 系数** — `score = |Γ(A) ∩ Γ(B)| / |Γ(A) ∪ Γ(B)|`。用并集归一化，公平对待邻居集大小差异巨大的页面对（如枢纽页 vs 叶子页），分数范围 [0,1]。
- **Adamic-Adar 指数（AA）** — `score = Σ 1/log|Γ(z)|`，对共同邻居 z 的度数取对数惩罚。核心洞察：共享一个冷门概念（被少数页面引用）的信号强度远大于共享一个热门概念。Liben-Nowell & Kleinberg（2007）在合著网络上系统比较，AA 排名前三。

### 全局与结构方法

- **Katz 指数** — 捕获任意长度路径的加权和，短路径权重高。截断至 L=3-5，复杂度 O(L·m)。含义：A 没直接引用 B，但通过 2-3 跳间接关联 → 可能在同一知识链条上。
- **三角闭合** — Granovetter（1973）经典理论：A→B 且 A→C 时，B↔C 的形成概率显著增高。CN/Jaccard/AA 本质上是三角闭合的量化实现。
- **结构洞（Structural Holes）** — Burt（1992）的互补视角：衡量节点桥接多个孤立集群的潜力。低约束度 = 桥接潜力高。与三角闭合正交——后者衡量相似性，前者衡量互补性。
- **优先连接** — `score = deg(A) × deg(B)`，作为基线对照。若优先连接已高分，说明这对节点本身已高度连接，降低推荐优先级。

### 实施策略

对于当前 wiki 规模，推荐顺序：**Adamic-Adar > Jaccard > Katz > 结构洞检测**。不推荐 GNN/node2vec/SBM（节点太少，训练不稳定，无法解释）。

阈值策略：Top-20 推荐 + 以已有 `related` 边的分数分布均值作为下限。百分位或 Z-score 也可作为备选过滤。

### 与现有健康检查的关系

两条路径互补：

- **锚文本挖掘**（`health.py` 的 `check_missing_inline_links`）：依赖已有链接建立映射表，覆盖已链接过的术语，对新概念覆盖不足。
- **图链接预测**：只看拓扑结构，不依赖文本，可发现锚文本映射表中不存在的新概念链接。

理想组合：图方法先缩小候选搜索空间 → 在候选对上做文本匹配决策，避免全对文本比较的开销。

## Relations

- [Wiki 健康检查 — 知识库的持续质量维护](wiki-system/concepts/wiki-health-check.md) — 图链接预测作为"缺失交叉引用"检测的拓扑互补路径
- [复利知识 — 持久化知识库的核心价值](wiki-system/concepts/compounding-knowledge.md) — 交叉引用密度是 wiki 产生 n² 级关联价值的前提
- [LLM Wiki vs RAG — 两种知识管理范式的对比](wiki-system/analysis/llm-wiki-vs-rag.md) — 超线性价值依赖交叉引用的完整性## References

- Liben-Nowell & Kleinberg, "The Link Prediction Problem for Social Networks" (2007)
- Adamic & Adar, "Friends and Neighbors on the Web" (2003)
- Lü & Zhou, "Link Prediction in Complex Networks" (2011) — 最全面的拓扑链接预测综述
- Burt, "Structural Holes and Good Ideas" (2004)
- Granovetter, "The Strength of Weak Ties" (1973)
- Barabási & Albert, "Emergence of Scaling in Random Networks" (1999)

## Notes

> **待确认：** 当前 wiki 节点数为 38，图方法计算量极小。当节点数扩至 1000 时，全对组合 ~50 万对，仍可在纯 Python 中秒级完成，但需评估是否引入稀疏矩阵优化。
