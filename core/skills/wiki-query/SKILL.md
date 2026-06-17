---
name: wiki-query
description: 从 wiki/ 中查询知识并合成答案。由 build agent 在用户提问时加载，替代盲目委派 explore 或 spider。
---

# Wiki Query 技能

从 `wiki/` 中查询知识并合成答案。由 build agent 在用户提问时加载，
替代盲目委派 explore 或 spider。

---

## Phase 0 — 判断问题类型

| 类型 | 示例 | 策略 |
|------|------|------|
| 概念解释 | "prompt injection 怎么工作的" | 查 wiki/concepts/ |
| 实体行为 | "build agent 有哪些权限" | 查 wiki/entities/ |
| 历史决策 | "为什么选 ruff 而不是 eslint" | 查 wiki/analysis/ 或 wiki/sources/adr/ |
| 已归档问答 | "上次讨论的 lint 工具对比" | 查 wiki/syntheses/ |
| 全新问题 | 明显不在 wiki 覆盖范围 | 直接委派 explore/spider |

---

## Phase 1 — 读取 index.md

读取 `wiki/index.md`，根据问题类型定位相关类别和页面路径。

---

## Phase 2 — 读取相关页面

读取匹配的 wiki 页面（最多 10 个，防止上下文溢出）。
如果页面有 `related` frontmatter 字段指向其他页面，按需递归读取。

---

## Phase 3 — 合成答案

- **wiki 有完整答案** → 基于 wiki 内容直接回答，标注来源页面（如 "根据 wiki/concepts/prompt-injection.md"）
- **wiki 部分覆盖** → wiki 内容作为上下文，委派 explore 补充探索缺失部分
- **wiki 无覆盖** → 委派 explore 或 spider 探索，必要时触发 ingest

---

## Phase 4 — 判断是否归档

回答用户后，判断答案是否值得持久化：

**值得归档**（可复用知识、非一次性问答）：
1. 构造三段式 prompt（SUMMARY / CONTEXT / ACCEPTANCE）
2. 委派 `task(subagent="kiwi")` 创建 `wiki/syntheses/<slug>.md`
3. kiwi 自动更新 wiki/index.md 和 wiki/log.md
4. 告知用户已归档的页面路径

**不归档**（一次性问答、时效性内容）→ 跳过

---

## Phase 5 — 呈现答案

向用户呈现合成答案。如果归档了，简要提及创建的 synthesis 页面。
