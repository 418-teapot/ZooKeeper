---
name: wiki-verify
description: 用于对 `~/.zoo/wiki/` 中的页面执行来源回溯验证（source traceback verification）。扫描 stale 验证记录，委派 kiwi 做语义比对，根据 drift/validated/uncertain 三类结果执行差异化的写入操作。只要涉及验证 wiki 页面来源一致性的请求，就请加载此技能。
---

# Wiki Verify 技能

对 `~/.zoo/wiki/` 中已标记 `last_validated` 的页面执行来源回溯验证，确认其声明仍与源页面保持一致。

收到"验证 wiki 来源"或"检查 wiki 页面一致性"等请求时加载此技能。

---

## Phase 1 — 确定范围并扫描

确定验证范围，然后运行 `zwiki verify --json` 获取 stale 页面对列表：

| 范围 | 操作 |
|------|------|
| 全量扫描（默认） | `zwiki verify --json` |
| 指定域 | `zwiki verify --json --domain <name>` |
| 指定页面 | 跳过扫描，直接以该页面进入 Phase 2 |

源页面 `timestamp` > 派生页面 `last_validated` 时判定为 stale。

```bash
zwiki verify --json
```

输出为 JSON 数组，每个元素包含：

```json
{
  "derived_page": "domain/concepts/some-concept.md",
  "source_page": "domain/concepts/source-concept.md",
  "source_timestamp": "2026-07-04T00:00:00Z",
  "derived_last_validated": "2026-06-19T00:00:00Z"
}
```

如果输出为空数组 `[]` → 所有页面的 `last_validated` 均为最新，没有需要验证的页面。向用户报告"✓ 所有验证均处于最新状态，无需操作"并终止。

否则，将页面对列表用于下一阶段。

---

## Phase 2 — 委派 kiwi

对每个页面对构造三段式 task prompt 并委派 kiwi subagent，告知 kiwi 加载 `kiwi-verify` 技能。

### 2.1 构造 Prompt

```
**SUMMARY:** 加载 `kiwi-verify` 技能，验证 {derived_path} 中的声明是否仍被其源页 {source_path} 支撑。

**CONTEXT:**
- 派生页路径：`{derived_page}`
- 源页路径：`{source_page}`
- 源页修改时间：`{source_timestamp}`
- 派生页最后验证时间：`{derived_last_validated}`
- 验证标准：派生页中每个可溯源的声明、数据点、结论都应能在源页中找到对应支撑。允许派生页有自己的总结和组织结构，但不允许出现源页中不存在的实质断言。

**ACCEPTANCE:**
返回以下结构化判定（JSON 格式）：
  - `page`: 派生页路径
  - `verdict`: 整体裁定，枚举值 `validated` | `drifted` | `uncertain`
  - `drifted_claims`（仅 `drifted` 时存在）: 数组，每个元素包含 `claim`（派生页中的声明原文）、`expected`（源页支撑内容摘要）和 `severity`（minor/major）
  - `validated_claims`（仅 `validated` 时存在）: 被验证通过的声明列表
  - `summary`: 一段中文摘要，说明裁定理由
```

### 2.2 并行委派

各页面对之间**相互独立**，应在同一轮中**并行**委派 kiwi（通过同时发起多个 `task()` 调用）。每个 `task()` 只处理一个页面对。

---

## Phase 3 — 收集结果

收集所有 kiwi 返回的判定结果。按 `verdict` 字段归类：

| 裁定 | 含义 | 后续操作 |
|------|------|---------|
| `validated` | 派生页声明与源页一致 | 进入 Phase 4（写入），执行验证状态刷新 |
| `drifted` | 发现声明未被源页支撑 | 进入 Phase 4（写入），追加待确认标记 |
| `uncertain` | kiwi 无法做出明确判断 | 仅报告用户，不做写入 |

向用户展示汇总：

```
验证结果汇总：
- ✓ 已验证：{X} 个页面（声明与来源一致）
- ⚠ 已漂移：{Y} 个页面（声明未获源页支撑，已标记待确认）
- ? 不确定：{Z} 个页面（需人工审查）
```

---

## Phase 4 — 写入

根据裁定执行不同写入操作：

### validated — 刷新验证时间戳

对每个裁定为 `validated` 的派生页，更新其 `last_validated` 为当前时间：

```bash
zwiki property last_validated \
  --page "<domain>/concepts/<page>.md" \
  --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

### drifted — 降级状态并追加待确认标记

对每个裁定为 `drifted` 的派生页：

1. **降级 status**：
   ```bash
   zwiki property status --page "<path>" --downgrade
   ```
   zwiki 自动执行 `stable → review → draft` 映射，仅降派生页，源页不动。

2. **追加待确认标记** — 在页面末尾的 Notes 节（如不存在则创建）逐条追加：
   > **待确认：来源回溯发现声明「{claim}」未被源页支撑，需人工审查。**

### uncertain — 不写入

仅向用户报告，不做任何文件修改。

---

## Phase 5 — 日志

对每个写入的页面（validated 和 drifted），追加日志条目：

```bash
zwiki log \
  --op verify --path "<domain>/concepts/<page>.md" \
  --action edit --note "来源回溯验证：{validated|drifted}"
```

validated 页面在 note 中附带验证通过的声明数量；drifted 页面在 note 中附带漂移声明摘要。

---

## Phase 6 — 验证

执行最终验证确认所有操作完成：

1. **路径确认** — 确认需要刷新的页面列表与已操作的页面一致
2. **完整性检查** — 运行 wiki 健康检查：
   ```bash
   zwiki check 2>/dev/null \
     && echo "✓ wiki 结构完整性检查通过" \
     || echo "ℹ 健康检查工具不可用，跳过"
   ```
3. **日志检查** — 确认 `~/.zoo/wiki/logs/` 下已有对应的日志条目（当前月份 `logs/YYYY-MM.md` 文件）

向用户报告最终结果：

```
验证流程完成：
- ✓ 已刷新 {X} 个页面的验证状态
- ⚠ 已标记 {Y} 个漂移页面待人工审查
- ? {Z} 个不确定页面需人工判定
- ✓ wiki 结构完整性检查通过
```
