---
name: wiki-ingest
description: 用于将外部源文档或对话知识 ingest 到项目 wiki 中。统一委派 kiwi 蒸馏后执行写入，自动维护原始材料副本和反向链接。只要涉及 wiki 摄入、知识归档或文档蒸馏的请求，就请加载此技能。
---

# Wiki Ingest 技能

将外部源文档或对话发现的知识 ingest 到 `~/.zoo/wiki/` 中。

收到值得归档的源材料时加载此技能，统一委派 kiwi 蒸馏后执行写入。

---

## Phase 0 — 分类源材料

根据源材料的性质确定页面类型：

| 类型 | 特征 | 页面类型 |
|------|------|---------|
| 架构决策记录 | ADR、设计文档、RFC | source(adr) |
| 外部规范 | 第三方 API 文档、标准、指南 | source(rfc) |
| 会议记录 | 讨论总结、决策会议笔记 | source(notes) |
| 概念知识 | 关于某机制或原理的说明 | concept |
| 实体行为 | 某工具、agent、模块的行为 | entity |
| 分析对比 | 多个选项的权衡、经验总结 | analysis |

如果源材料无法明确归入以上类型 → 归类为 concept 类型。

该分类仅用于准入决策（确认材料值得摄入）。不传递给 kiwi，包括域分类也不传递。kiwi 会在其流程中基于源材料特征和 wiki 现状独立完成所有分类决策（归属域、页面类型、页面路径），传递任何分类结果会造成锚定效应，剥夺 kiwi 结合 wiki 全貌做决策的机会。

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
  - 要在相关**域**的 `index.md`（如 `wiki/<domain>/index.md`）中添加的索引条目（根 index.md 只列域，新建域时才改）
   - 需要更新的交叉引用（更新哪些已有页面的 `relations` 字段；反向链接由 `zwiki backlinks` 自动维护，kiwi 无需处理）
   - 关于 `overview.md` 是否需要更新的建议
   - 要通过 `zwiki log` 追加的日志条目
```

### 1.3 委派 kiwi

在 task prompt 开头告知 kiwi 加载 `kiwi-distill` 技能（kiwi 的技能列表由 `config.toml` 白名单控制，当前仅 `kiwi-distill` 可用）：

> 加载 `kiwi-distill` 技能后执行以下蒸馏任务。

将三段式 prompt 传给 kiwi subagent，不要对 kiwi 做额外约束 — 所有要求已在 ACCEPTANCE 中表达。

---

## Phase 2 — 通用写入步骤

kiwi 返回分析后，由调用方 agent 执行写入：

**创建新页面时：**
1. **创建骨架** — 使用 `zwiki create`：
    ```bash
    zwiki create \
        --domain <域名> \
        --type <concept|entity|analysis|synthesis> \
        --title "<页面标题>"
    ```
    域由 kiwi 的分析结果决定（kiwi 返回的页面路径含域前缀）。合法域由 wiki 根目录下实际存在的子目录决定（运行 `zwiki create --help` 或查看 `~/.zoo/wiki/` 下子目录）；团队可通过新建子目录扩展域。对于 source 类型追加 `--source-type <adr|rfc|notes>`；中文标题需加 `--slug <english-slug>`
2. **填充内容** — 使用 `write` / `edit` 将 kiwi 提供的页面内容写入

**更新已有页面时：**
1. 无需创建新页面
2. **编辑页面** — 使用 `edit` 工具按照 kiwi 的建议修改已有页面的指定节

**以下步骤创建和更新共用：**
3. **保存原始材料** — 如果输入为 URL 或文件，保存原文副本到 `raw/`：
    ```bash
    curl -sL "<url>" -o ~/.zoo/wiki/raw/$(date +%F)-<slug>.md
    ```
4. **更新索引** — 创建新页面时在对应**域的 index.md**（`~/.zoo/wiki/<domain>/index.md`）对应类型节下追加条目；**根 index.md 只在新建域时才改动**（通常不需要）。更新已有页面时跳过此步
5. **记录日志** — 调用 `zwiki log`，`--action` 用 `create` 或 `edit`：
    ```bash
    zwiki log \
        --op ingest --path "<domain>/concepts/<file>.md" \
        --action <create|edit> --note "<简短说明>"
    ```
6. **更新 overview.md** — 如果 kiwi 的分析建议更新，则执行
7. **更新交叉引用** — 按照 kiwi 的建议，在已有页面的 `relations` 字段中添加新引用（使用域前缀路径，如 `<domain>/concepts/<file>.md`）。反向链接由 `zwiki check` 自动同步
8. **同步反向链接** — `zwiki check` 已自动执行，无需手动调用

---

## Phase 3 — Supersede 确认与写入

如果 kiwi 的分析报告中包含 Supersede Proposals（非空的取代候选列表）：

1. 向用户列出每个取代提议：
   - 被取代的页面路径
   - 旧声明（kiwi 摘录的原文）
   - 新声明（新源中的原文）
   - 取代理由

2. 询问用户是否确认每个提议。用户可以：
   - 全部确认
   - 部分确认（指定哪些接受，哪些拒绝）
   - 全部拒绝

3. 只对用户确认的提议执行写入。kiwi 会在每个取代提议中标明哪个页面取代哪个页面。对每对取代关系，使用 `zwiki supersede` 一次性更新两侧 frontmatter：

   ```bash
   zwiki supersede \
       --old <domain>/concepts/old-page.md \
       --new <domain>/concepts/new-page.md \
       --reason "<kiwi 提供的取代理由>"
   ```

   该命令会自动在取代页面（`--new`）的 frontmatter 中追加 `supersedes` 条目（含 `path` 和 `reason`），并在被取代页面（`--old`）的 frontmatter 中追加 `superseded_by` 条目。

如果 kiwi 没有返回 Supersede Proposals，或列表为空 → 跳过此 Phase。

---

## Phase 4 — 验证

写入完成后，执行以下验证：

1. **路径确认** — 确认创建/更新的页面路径列表与预期一致
2. **日志检查** — 确认 `~/.zoo/wiki/log.md` 中已有对应的日志条目
3. **索引检查** — 确认对应**域的 index.md** 已更新；根 index.md 通常无需改动
4. **反向链接检查** — `zwiki check` 已自动同步，二次运行应报告 0 更新
5. **增量内联链接检查** — 扫描本次写入的新增文本：
    ```bash
    zwiki check --diff || echo "⚠ 新增文本中存在缺失的内联链接，请检查并修复"
    ```
    如果检查发现问题 → 在新增文本中为缺失链接的术语添加 `[术语](目标页.md)` 内联链接，然后重新运行检查确认通过。
6. **可选：健康检查** — 运行全量 wiki 结构完整性检查：
    ```bash
    zwiki check 2>/dev/null \
      && echo "✓ wiki 结构完整" \
      || echo "ℹ 健康检查工具不可用，跳过"
    ```

如果验证失败 → 检查失败原因，必要时重新委派 kiwi。
如果验证通过 → 向用户报告创建的页面列表和摘要。
