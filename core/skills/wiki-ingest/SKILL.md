---
name: wiki-ingest
description: 用于将外部源文档或对话知识 ingest 到项目 wiki 中。统一委派 kiwi 蒸馏后执行写入，自动维护原始材料副本和反向链接。只要涉及 wiki 摄入、知识归档或文档蒸馏的请求，就请加载此技能。
---

# Wiki Ingest 技能

将外部源文档或对话发现的知识 ingest 到 `~/.zoo/wiki/` 中。

收到值得归档的源材料时加载此技能，统一委派 kiwi 蒸馏后执行写入。

---

## Phase 0 — 分类源材料

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

该分类仅用于准入决策（确认材料值得摄入）。不传递给 kiwi，kiwi 会在其流程中基于源材料特征和 wiki 现状独立分类，传递分类结果会造成锚定效应，剥夺 kiwi 结合 wiki 全貌做决策的机会。

---

## Phase 1 — 委派 kiwi

### 1.1 准备源材料

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

### 1.2 构造三段式 Prompt

构造包含 SUMMARY / CONTEXT / ACCEPTANCE 三段的 prompt：

```
**SUMMARY:** 将 [源材料简要描述] 蒸馏到 wiki 中

**CONTEXT:**
[源内容摘要，如果是 URL 输入则放入原始 URL 而非嵌入全文]
[调用方掌握的额外上下文：相关页面变动、约束条件、用户偏好]

**源材料特征（Source Profile，可选，仅当长度可能误导 kiwi 时添加）：**
简要描述源材料的知识密度特征，帮助 kiwi 区分核心知识和论证包装：
- 文档类型？（调研报告 / 会议记录 / API 文档 / 博客 / 设计文档 / ...）
- 知识密度？（简洁直接 / 论证链路长 / 知识混在大量执行细节中）
- 如果知识密度低，哪些部分可能是包装而非核心知识？（例：风险矩阵、时间线估算、逐接口分析——这些是论证支撑材料，不是可复用的结构知识）

**ACCEPTANCE:**
返回一份结构化分析，描述：
  - 要创建/更新的页面路径、完整 frontmatter、完整页面内容（遵循 SCHEMA.md 规范）
  - 要在 `wiki/index.md` 中添加的索引条目
  - 需要更新的交叉引用（更新哪些已有页面的 `related` 字段；反向链接由 `backlinks.py` 自动维护，kiwi 无需处理）
  - 关于 `overview.md` 是否需要更新的建议
  - 要通过 wiki_log.py 追加的日志条目
```

### 1.3 委派 kiwi

将三段式 prompt 传给 kiwi subagent，不要对 kiwi 做额外约束 — 所有要求已在 ACCEPTANCE 中表达。

---

## Phase 2 — 通用写入步骤

kiwi 返回分析后，由调用方 agent 执行写入：

**创建新页面时：**
1. **创建骨架** — 使用 `new_page.py`：
    ```bash
    python3 ~/.zoo/wiki/tools/new_page.py \
        --type <concept|entity|analysis|synthesis> \
        --title "<页面标题>"
    ```
    对于 source 类型追加 `--source-type <adr|rfc|notes>`
2. **填充内容** — 使用 `write` / `edit` 将 kiwi 提供的页面内容写入

**更新已有页面时：**
1. 无需创建新页面
2. **编辑页面** — 使用 `edit` 工具按照 kiwi 的建议修改已有页面的指定节

**以下步骤创建和更新共用：**
3. **保存原始材料** — 如果输入为 URL 或文件，保存原文副本到 `raw/`：
    ```bash
    curl -sL "<url>" -o ~/.zoo/wiki/raw/$(date +%F)-<slug>.md
    ```
4. **更新索引** — 创建新页面时在 `~/.zoo/wiki/index.md` 对应类别下追加条目；更新已有页面时跳过
5. **记录日志** — 调用 `wiki_log.py`，`--action` 用 `create` 或 `edit`：
    ```bash
    python3 ~/.zoo/wiki/tools/wiki_log.py \
        --op ingest --path "wiki/<dir>/<file>.md" \
        --action <create|edit> --note "<简短说明>"
    ```
6. **更新 overview.md** — 如果 kiwi 的分析建议更新，则执行
7. **更新交叉引用** — 按照 kiwi 的建议，在已有页面的 `related` 字段中添加新引用。反向链接由 `backlinks.py` 自动维护
8. **同步反向链接**：
    ```bash
    python3 ~/.zoo/wiki/tools/backlinks.py --write
    ```

---

## Phase 3 — 验证

写入完成后，执行以下验证：

1. **路径确认** — 确认创建/更新的页面路径列表与预期一致
2. **日志检查** — 确认 `~/.zoo/wiki/log.md` 中已有对应的日志条目
3. **索引检查** — 确认 `~/.zoo/wiki/index.md` 的对应类别已更新
4. **反向链接检查** — 确认 `backlinks.py` 已运行且幂等（二次运行报告 0 更新）：
    ```bash
    python3 ~/.zoo/wiki/tools/backlinks.py --write
    ```
5. **可选：健康检查** — 如果存在健康检查工具，运行它以验证 wiki 结构完整性：

```bash
python3 ~/.zoo/wiki/tools/health.py --json 2>/dev/null \
  && echo "✓ wiki 结构完整" \
  || echo "ℹ 健康检查工具不可用，跳过"
```

如果验证失败 → 检查失败原因，必要时重新委派 kiwi。
如果验证通过 → 向用户报告创建的页面列表和摘要。
