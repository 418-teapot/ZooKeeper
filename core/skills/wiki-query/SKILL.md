---
name: wiki-query
description: 从 ~/.zoo/wiki/ 中查询知识并合成答案。查询 wiki 覆盖的项目知识时加载此技能，替代盲目委派 explore 或 spider。
---

# Wiki Query 技能

从 `~/.zoo/wiki/` 中查询知识并合成答案。
查询 wiki 覆盖的项目知识时加载此技能，替代盲目委派 explore 或 spider。

---

## Phase 0 — 判断问题类型

| 类型 | 示例 | 策略 |
|------|------|------|
| 概念解释 | "prompt injection 怎么工作的" | 读根 index.md 定位域，查 `~/.zoo/wiki/<domain>/concepts/` |
| 实体行为 | "build agent 有哪些权限" | 读根 index.md 定位域，查 `~/.zoo/wiki/<domain>/entities/` |
| 历史决策 | "为什么选 ruff 而不是 eslint" | 读根 index.md 定位域，查 `~/.zoo/wiki/<domain>/analysis/` 或 `~/.zoo/wiki/<domain>/sources/adr/` |
| 已归档问答 | "上次讨论的 lint 工具对比" | 读根 index.md 定位域，查 `~/.zoo/wiki/<domain>/syntheses/` |
| 全新问题 | 明显不在 wiki 覆盖范围 | 直接委派 explore/spider |

---

## Phase 1 — 读取索引（两层渐进式披露）

读取 `~/.zoo/wiki/index.md`（根索引，列出三个域 + overview.md），根据问题主题确定相关域。然后读取该域的 `~/.zoo/wiki/<domain>/index.md`，定位相关类型和页面路径。若问题跨域，读取多个域 index.md。

---

## Phase 2 — 读取相关页面

读取匹配的 wiki 页面（如 `~/.zoo/wiki/<domain>/concepts/<file>.md`，最多 10 个，防止上下文溢出）。
如果页面有 `related` frontmatter 字段指向其他页面（使用域前缀路径），按需递归读取。

---

## Phase 3 — 合成答案

- **wiki 有完整答案** → 基于 wiki 内容直接回答，标注来源页面（如 "根据 `~/.zoo/wiki/<domain>/concepts/prompt-injection.md`"）
- **wiki 部分覆盖** → wiki 内容作为上下文，委派 explore 补充探索缺失部分
- **wiki 无覆盖** → 委派 explore 或 spider 探索，必要时触发 ingest

可选：调用 `zwiki log` 记录查询事件，便于追踪查询频率和覆盖范围：

```bash
zwiki log \
    --op query --path "—" --action pass \
    --note "查询了 <主题>"
```

---

## Phase 4 — 判断是否归档

回答后，判断答案是否值得持久化：

**值得归档**（可复用知识、非一次性问答）：
1. 加载 wiki-ingest skill，根据源材料复杂度选择直接写入或委派 kiwi 蒸馏
2. 创建 `~/.zoo/wiki/<domain>/syntheses/<slug>.md`（域由答案主题决定，跨域知识归入 shared）
3. 更新对应**域的 index.md**（`~/.zoo/wiki/<domain>/index.md`）和 `~/.zoo/wiki/log.md`；根 index.md 通常无需改动
4. 告知用户已归档的页面路径

**不归档**（一次性问答、时效性内容）→ 跳过

---

## Phase 5 — 呈现答案

向用户呈现合成答案。如果归档了，简要提及创建的 synthesis 页面。