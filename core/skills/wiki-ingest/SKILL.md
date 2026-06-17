---
name: wiki-ingest
description: 用于将外部源文档或对话发现的知识 ingest 到 wiki/ 中。由 build agent 在收到源材料时加载本技能，生成三段式 prompt 后委派给 kiwi 执行。
---

# Wiki Ingest 技能

将外部源文档或对话发现的知识 ingest 到 `wiki/` 中。
由 build agent 在收到源材料时加载本技能，生成三段式 prompt 后委派给 kiwi 执行。

---

## Phase 0 — 分类源材料

根据源材料的性质确定目标目录和页面类型。

| 类型 | 特征 | 目标目录 | 页面类型 |
|------|------|---------|---------|
| 架构决策记录 | ADR、设计文档、RFC | `wiki/sources/adr/` | source |
| 外部规范 | 第三方 API 文档、标准、指南 | `wiki/sources/rfc/` | source |
| 会议记录 | 讨论总结、决策会议笔记 | `wiki/sources/notes/` | source |
| 概念知识 | 关于某机制或原理的说明 | `wiki/concepts/` | concept |
| 实体行为 | 某工具、agent、模块的行为 | `wiki/entities/` | entity |
| 分析对比 | 多个选项的权衡、经验总结 | `wiki/analysis/` | analysis |

如果源材料无法明确归入以上类型 → 归类为 `wiki/concepts/`，页面类型为 concept。

---

## Phase 1 — 检查重复

读取 `wiki/index.md` 搜索已有页面是否覆盖了相同主题：

```bash
# 如果存在 index.md，读取并搜索相关关键词
cat wiki/index.md 2>/dev/null || echo "wiki/index.md 不存在，无需去重检查"
```

- 如果找到重复：在已有页面补充信息，**不创建新页面**。记录补充了哪些内容。
- 如果未找到重复：继续到 Phase 2。

---

## Phase 2 — 准备源材料

根据用户提供的源材料形式，执行对应的获取步骤：

| 输入形式 | 操作 |
|---------|------|
| 文件路径 | 用 `read` 工具读取完整内容 |
| URL | 先委派 spider agent 获取内容，等待其返回 |
| 文字描述 | 直接使用，整理为结构化格式 |
| 对话历史引用 | 从对话中提取相关段落 |

将源内容整理为 kiwi 可以直接消费的格式：
- 保留原文结构（标题、列表、代码块）
- 附上元信息：来源路径/URL、获取时间、内容长度
- 如果内容是 URL 获取的，附上 spider agent 的返回状态

---

## Phase 3 — 构造三段式 Prompt

构造一个包含 SUMMARY / CONTEXT / ACCEPTANCE 三段的 prompt，格式如下：

```
**SUMMARY:** 将 [源材料简要描述] ingest 到 wiki 中

**CONTEXT:**
[源内容摘要]
[已有 wiki 状态：index.md 当前条目、相关页面摘要、约束条件]

**ACCEPTANCE:**
- 创建 [N] 个 wiki 页面（指定目录和预期页面类型）
- 更新 `wiki/index.md` 的对应类别条目
- 追加日志条目到 `wiki/log.md`
- 适当时更新相关页面的 `related` 字段
- 返回创建/更新的页面路径列表
```

### 字段填充规则

| 字段 | 内容来源 | 注意事项 |
|------|---------|---------|
| SUMMARY | Phase 0 的分类结果 + 源材料的简短描述 | 不超过一行，让 kiwi 一目了然任务目标 |
| CONTEXT | Phase 1 的去重结果 + Phase 2 的源内容 | 包含完整源内容；明确标注哪些主题已被覆盖 |
| ACCEPTANCE | Phase 0 的目标目录和页面类型 | 路径和类型必须具体，不可写"酌情创建" |

---

## Phase 4 — 委派 kiwi

调用 `task()` 将三段式 prompt 传给 kiwi subagent：

```
task(subagent="kiwi", prompt=<Phase 3 构造的三段式 prompt>)
```

- 不要对 kiwi 做额外约束 — 所有要求已在 ACCEPTANCE 中表达
- kiwi 负责实际的文件创建、index.md 更新、log.md 追加

---

## Phase 5 — 验证

kiwi 返回后执行以下验证：

1. **路径确认** — 确认 kiwi 返回的页面路径列表与 ACCEPTANCE 中预期的目录和数量一致
2. **完整性检查** — 确认 `wiki/log.md` 中已有对应的 ingest 日志条目
3. **索引检查** — 确认 `wiki/index.md` 的对应类别已更新
4. **可选：健康检查** — 如果存在健康检查工具，运行它以验证 wiki 结构完整性：

```bash
python core/skills/wiki-maintain/tools/health.py --json 2>/dev/null \
  && echo "✓ wiki 结构完整" \
  || echo "ℹ 健康检查工具不可用，跳过"
```

如果验证失败 → 检查失败原因，必要时重新委派 kiwi 修复。
如果验证通过 → 向用户报告创建的页面列表和摘要。

---

## 快速参考

| 场景 | 起始阶段 |
|------|---------|
| 用户提供了文件路径 | Phase 0 → Phase 2（read） |
| 用户提供了 URL | Phase 0 → Phase 2（spider） |
| 用户提供了文字描述 | Phase 0 → Phase 2（直接使用） |
| 不确定是否已有相关内容 | Phase 1 先检查 |
| kiwi 返回但路径不符合预期 | Phase 5 → 重新委派 |
