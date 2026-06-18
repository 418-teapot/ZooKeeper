---
name: wiki-ingest
description: 用于将外部源文档或对话知识 ingest 到项目 wiki 中。收到 wiki 可 ingest 的源材料时加载此技能。
---

# Wiki Ingest 技能

将外部源文档或对话发现的知识 ingest 到 `~/.zoo/wiki/` 中。
收到值得归档的源材料时加载此技能，根据源材料复杂度选择直接写入或委派 kiwi 蒸馏。

---

## Phase 0 — 判断路径

根据源材料的性质选择执行路径：

| 特征 | 路径 | 说明 |
|------|------|------|
| 结构化内容、已 wiki 格式化的文本、简短的摘要 | **简单路径** | 直接调用工具脚本写入 |
| URL（网页链接） | **复杂路径** | 直接传给 kiwi（kiwi 自己 webfetch 抓取） |
| 非结构化原始源、会议记录、外部 RFC、设计文档 | **复杂路径** | 委派 kiwi 蒸馏 |

**结构化判定标准：**
- 内容已按 wiki 页面节结构组织（Overview / Details / Relations）
- 已知目标目录和文件名
- 不需要摘要/重写/组织

**URL 输入规则：**
- 不要委派 spider 抓取 — 浪费上下文
- 直接把 URL 放入 kiwi 的 CONTEXT，kiwi 用 `webfetch` 自行获取内容

**非结构化判定标准：**
- 聊天记录、会议转录、原始 API 文档
- 需要分类、摘要、提取要点
- 需要跨多个 wiki 目录组织

---

## Phase 1 — 简单路径：直接写入

适用于结构化/已格式化的内容。

1. 使用 `new_page.py` 脚手架创建骨架页面（如果需要新页面）：
    ```bash
    python3 ~/.zoo/wiki/tools/new_page.py \
        --type <concept|entity|analysis|synthesis> \
        --title "<页面标题>"
    ```
    对于 source 类型：
    ```bash
    python3 ~/.zoo/wiki/tools/new_page.py \
        --type source \
        --title "<页面标题>" \
        --source-type <adr|rfc|notes>
    ```
2. 使用 `write` 或 `edit` 工具填充页面内容
3. 更新 `~/.zoo/wiki/index.md` — 在对应类别追加条目
4. 调用 `wiki_log.py` 追加日志：
    ```bash
    python3 ~/.zoo/wiki/tools/wiki_log.py \
        --op ingest --path "wiki/<dir>/<file>.md" \
        --action create --note "<简短说明>"
    ```
5. （可选）更新相关页面的 `related` 字段

不需要委派 kiwi，直接进入 Phase 3。

---

## Phase 2 — 复杂路径：委派 kiwi 蒸馏

适用于非结构化复杂源材料。

### 2.1 分类源材料

根据源材料的性质确定目标目录和页面类型：

| 类型 | 特征 | 目标目录 | 页面类型 |
|------|------|---------|---------|
| 架构决策记录 | ADR、设计文档、RFC | `wiki/sources/adr/` | source |
| 外部规范 | 第三方 API 文档、标准、指南 | `wiki/sources/rfc/` | source |
| 会议记录 | 讨论总结、决策会议笔记 | `wiki/sources/notes/` | source |
| 概念知识 | 关于某机制或原理的说明 | `wiki/concepts/` | concept |
| 实体行为 | 某工具、agent、模块的行为 | `wiki/entities/` | entity |
| 分析对比 | 多个选项的权衡、经验总结 | `wiki/analysis/` | analysis |

如果源材料无法明确归入以上类型 → 归类为 `wiki/concepts/`，页面类型为 concept。

### 2.2 检查重复

读取 `~/.zoo/wiki/index.md` 搜索已有页面是否覆盖了相同主题：

```bash
cat ~/.zoo/wiki/index.md 2>/dev/null || echo "~/.zoo/wiki/index.md 不存在，无需去重检查"
```

- 如果找到重复：在已有页面补充信息，**不创建新页面**。记录补充了哪些内容。
- 如果未找到重复：继续到下一步。

### 2.3 准备源材料

根据输入形式执行对应的获取步骤：

| 输入形式 | 操作 |
|---------|------|
| 文件路径 | 用 `read` 工具读取完整内容 |
| URL | 直接将 URL 传递给 kiwi（kiwi 自己 webfetch 获取内容） |
| 文字描述 | 直接使用，整理为结构化格式 |
| 对话历史引用 | 从对话中提取相关段落 |

将源内容整理为 kiwi 可以直接消费的格式：
- 保留原文结构（标题、列表、代码块）
- 附上元信息：来源路径/URL、获取时间、内容长度
- 如果是 URL 输入，直接将 URL 放入 CONTEXT，kiwi 自行 webfetch 获取内容

### 2.4 构造三段式 Prompt

构造包含 SUMMARY / CONTEXT / ACCEPTANCE 三段的 prompt：

```
**SUMMARY:** 将 [源材料简要描述] 蒸馏到 wiki 中

**CONTEXT:**
[源内容摘要，如果是 URL 输入则放入原始 URL 而非嵌入全文]
[已有 wiki 状态：index.md 当前条目、相关页面摘要、约束条件]

**ACCEPTANCE:**
返回一份结构化分析，描述：
  - 要创建/更新的页面路径、完整 frontmatter、完整页面内容（遵循 SCHEMA.md 规范）
  - 要在 `wiki/index.md` 中添加的索引条目
  - 需要更新的交叉引用（更新哪些已有页面的 `related` 字段）
  - 关于 `overview.md` 是否需要更新的建议
  - 要通过 wiki_log.py 追加的日志条目
```

### 2.5 委派 kiwi

将三段式 prompt 传给 kiwi subagent，不要对 kiwi 做额外约束 — 所有要求已在 ACCEPTANCE 中表达。

### 2.6 执行写入

kiwi 返回分析后，由你（调用方 agent）执行所有文件写入：

1. **创建新页面** — 使用 `new_page.py` 脚手架创建骨架页面：
    ```bash
    python3 ~/.zoo/wiki/tools/new_page.py \
        --type <concept|entity|analysis|synthesis> \
        --title "<页面标题>"
    ```
    对于 source 类型：
    ```bash
    python3 ~/.zoo/wiki/tools/new_page.py \
        --type source \
        --title "<页面标题>" \
        --source-type <adr|rfc|notes>
    ```
2. **填充内容** — 使用 `write` / `edit` 工具将 kiwi 提供的页面内容写入
3. **更新索引** — 在 `~/.zoo/wiki/index.md` 对应类别下追加条目
4. **记录日志** — 调用 `wiki_log.py` 为每个页面追加日志：
    ```bash
    python3 ~/.zoo/wiki/tools/wiki_log.py \
        --op ingest --path "wiki/<dir>/<file>.md" \
        --action create --note "<简短说明>"
    ```
5. **更新 overview.md** — 如果 kiwi 的分析建议更新，则执行
6. **更新交叉引用** — 按照 kiwi 的建议，在已有页面的 `related` frontmatter 字段中添加新页面引用

---

## Phase 3 — 验证

复杂路径（Phase 2.6 写入后）或简单路径（工具写入后），执行以下验证：

1. **路径确认** — 确认创建/更新的页面路径列表与预期一致
2. **日志检查** — 确认 `~/.zoo/wiki/log.md` 中已有对应的日志条目
3. **索引检查** — 确认 `~/.zoo/wiki/index.md` 的对应类别已更新
4. **可选：健康检查** — 如果存在健康检查工具，运行它以验证 wiki 结构完整性：

```bash
python3 ~/.zoo/wiki/tools/health.py --json 2>/dev/null \
  && echo "✓ wiki 结构完整" \
  || echo "ℹ 健康检查工具不可用，跳过"
```

如果验证失败 → 检查失败原因，必要时重新委派 kiwi。
如果验证通过 → 向用户报告创建的页面列表和摘要。
