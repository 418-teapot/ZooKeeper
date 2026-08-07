# Hashline Edit 技术调研报告

> 调研对象：oh-my-openagent (omo) 的 `hashline-core` + `hashline-edit` 集成层、oh-my-pi (omp) 的 `packages/hashline`
> 目标：评估 ZooKeeper 引入 hashline 编辑的可行方案
> 日期：2026-08-07

---

## 一、问题背景

OpenCode 原生 `edit` 工具使用 `oldString/newString` 模式：LLM 提供要被替换的原始文本片段，引擎在文件中查找匹配。这种方式存在两个核心问题：

1. **行号漂移**：LLM 在一次编辑中引用了行号 N，但如果前一次编辑插入/删除了行，行号 N 已经指向不同的内容
2. **oldString 不匹配**：LLM 生成的 oldString 与文件中的实际内容有微小差异（缩进、空白、遗漏），导致 `oldString not found` 错误

omo 的基准测试数据：**仅更换编辑工具**（其他条件不变），Grok Code Fast 1 的成功率从 **6.7% → 68.3%**（约 10 倍提升）。这证明内容寻址编辑对弱模型的帮助是巨大的。

两条可行的技术路线代表：

- **omo（逐行哈希）**：OpenCode 插件，为每行计算 2 字符哈希 ID，编辑锚点 = `行号#ID`
- **omp（整文件哈希）**：独立产品 pi 的编码 agent 自带编辑工具，为整个文件计算 4 位 hex tag，编辑锚点 = 行号 + section header 中的文件哈希

---

## 二、omo 方案：逐行哈希

### 2.1 架构概览

**核心库 `packages/hashline-core/`**（npm 包 `@oh-my-opencode/hashline-core`）——纯逻辑库，`src/` 下 16 个实现文件 + `index.ts` 公开 API 桶 + 6 个测试文件：

| 文件 | 行数 | 职责 |
|------|-----|------|
| `xxhash32.ts` | 90 | xxHash32（Bun 原生 + 纯 JS 回退） |
| `constants.ts` | 10 | 16 字母表 + 256 查找表 + 正则 |
| `hash-computation.ts` | 155 | 逐行哈希 + legacy 哈希 + 流式格式化 |
| `validation.ts` | 181 | `LINE#ID` 解析 + 验证 + `HashlineMismatchError` |
| `normalize-edits.ts` | 95 | raw LLM 输入 → typed `HashlineEdit` |
| `edit-ordering.ts` | 56 | 按行号倒序排序 |
| `edit-deduplication.ts` | 43 | 编辑去重 |
| `edit-operation-primitives.ts` | 125 | 原子编辑操作 + 内建修复 |
| `edit-operations.ts` | 103 | 组合全流程（dedupe → sort → validate → apply） |
| `edit-text-normalization.ts` | 111 | 前缀/缩进/echo 处理 |
| `autocorrect-replacement-lines.ts` | 179 | 自动修复（最复杂模块） |
| `file-text-canonicalization.ts` | 44 | BOM/CRLF 归一化与写回 |
| `hashline-chunk-formatter.ts` | 52 | 流式输出分块 |
| `hashline-edit-diff.ts` | 31 | 编辑 diff 生成 |
| `diff-utils.ts` | 53 | unified diff（唯一外部依赖 `diff` 包） |
| `types.ts` | 20 | 类型定义 |

**集成层 `packages/omo-opencode/src/tools/hashline-edit/`**——24 个文件共 1478 行。真实现仅 5 个：

| 文件 | 行数 | 职责 |
|------|-----|------|
| `tools.ts` | 42 | 工具工厂（schema 定义） |
| `hashline-edit-executor.ts` | 178 | 执行器主逻辑 |
| `formatter-trigger.ts` | 138 | 编辑后按扩展名触发 formatter（带目录级缓存） |
| `tool-description.ts` | 95 | 给 LLM 的工具说明 |
| `index.ts` | 20 | 桶（重导出） |

其余 15 个是从 `hashline-core` 重导出的 1–9 行 shim（`validation.ts` 8 行、`hash-computation.ts` 9 行、`edit-deduplication.ts` 1 行等）。测试 3 个 `.test.ts`：`tools.test.ts`(422)、`formatter-trigger.test.ts`(398)、`formatter-trigger-cache.test.ts`(117)。

**Hooks**：

- `packages/omo-opencode/src/hooks/hashline-read-enhancer/`：`hook.ts`(216) + `index.test.ts`(300)，read 输出行标记增强
- `packages/omo-opencode/src/hooks/hashline-edit-diff-enhancer/`：仅 `hook.ts`(113)，**无 `index.ts`，未接线**（`src/hooks/AGENTS.md` 明示 "has only hook.ts, NOT registered"）

**测试**：`tests/hashline/` 下还有 LLM 集成测试套件（Vercel AI SDK，多模型 headless 跑分）。

### 2.2 哈希算法

**混合策略**（`xxhash32.ts`）：

- 运行时检测 `globalThis.Bun`，存在则调 `Bun.hash.xxHash32(input, seed)`（`xxhash32.ts:83-90`）
- 否则回退纯 JS 实现（`xxhash32.ts:31-81`，约 50 行核心算法，全部分支用 `>>> 0` 强制无符号）
- 无 npm xxhash 依赖

**seed 策略**（`hash-computation.ts:9`）：含字母/数字的行 `seed=0`；空白/纯符号行 `seed=lineNumber`（确保空行在不同位置产生不同哈希）。

**2 字符 ID**：

- 16 字母表 `ZPMQVRWSNKTXJBYH`（`constants.ts:1`，故意避开 0-9 与 A-F，避免与十六进制混淆）
- 预计算 256 项查找表，`hash % 256` 索引（`constants.ts:3-7`）
- 引用正则 `/^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/`（`constants.ts:9`）

**逐行哈希**：每行独立计算，互不影响。

### 2.3 行标记格式

**读取输出**（`formatHashLine`，`hash-computation.ts:23-26`）：

```
{行号}#{2字符ID}|{内容}
```

示例：

```
42#VK|function hello() {
43#XJ|  console.log("hi");
44#MB|  console.log("bye");
45#QR|}
```

**编辑引用只传锚点**（不含 `|` 后面的内容）：`42#VK`。

**Read 增强 Hook**（`hashline-read-enhancer/hook.ts`，216 行）：在 `tool.execute.after` 拦截 read 输出（`hook.ts:197-214`），需 `config.hashline_edit` 开启（默认 false，`hook.ts:27-29`）。把 `N: content` 或 `N|content` 改写为 `N#ID|content`（`hook.ts:56-66`），跳过以 `... (line truncated to 2000 chars)` 结尾的截断行（`hook.ts:17,61-63`）。同时把 write 成功输出改写为 `"File written successfully. N lines written."`（`hook.ts:5,161-190`）。

### 2.4 双哈希兼容

两种哈希模式：

| 模式 | 归一化规则 | 用途 |
|------|-----------|------|
| `computeLineHash`（`hash-computation.ts:15-17`） | strip `\r` + `trimEnd` | 默认验证 |
| `computeLegacyLineHash`（`hash-computation.ts:19-21`） | strip `\r` + strip **所有空白** | 兼容哈希 |

验证时使用 `isCompatibleLineHash`（`validation.ts:18-20`）：当前哈希 **OR** legacy 哈希任一匹配即通过。这意味着文件只改了缩进时，旧哈希仍然有效。

### 2.5 编辑操作

三种操作类型（schema 见 `tools.ts:21-38`）：

```typescript
interface ReplaceEdit {
  op: "replace"
  pos: string                 // 锚点 LINE#ID（required）
  end?: string                // 范围终点（optional，有则为范围替换）
  lines: string | string[] | null  // null/[] = 删除
}
interface AppendEdit {
  op: "append"
  pos?: string                // 锚点（插入其后）；无锚点 → EOF
  lines: string | string[]
}
interface PrependEdit {
  op: "prepend"
  pos?: string                // 锚点（插入其前）；无锚点 → BOF
  lines: string | string[]
}
```

工具 schema 另有顶层参数：`delete?: boolean`（删文件）和 `rename?: string`（重命名）（`tools.ts:10-11,19-20`；执行器 `hashline-edit-executor.ts:16-17`）。legacy 格式已移除，报错 "Legacy format was removed; use op/pos/end/lines."（`normalize-edits.ts:91`）。

### 2.6 执行管线

`hashline-edit-executor.ts:96-148`：

```
normalizeHashlineEdits()          → raw → typed HashlineEdit[]
  ↓
canonicalizeFileText()            → BOM/CRLF 归一化
  ↓
applyHashlineEditsWithReport()    → 内部：dedupe → 按行号降序 + op 优先级排序
                                    → validateLineRefs → detectOverlappingRanges
                                    → 逐 op 应用（含 autocorrect）
  ↓
restoreFileText()                 → 恢复 BOM/CRLF 写回
  ↓
runFormattersForFile()            → 按扩展名执行用户配置的 formatter（目录级缓存）
  ↓
generateUnifiedDiff + publishToolMetadata   → diff/metadata 发布
```

另有空编辑 noop 检测：编辑产生与原文完全一致的内容时报错并提示 "Re-read the file and provide content that differs from current lines"（`hashline-edit-executor.ts:116-122`）。

### 2.7 自动修复（Autocorrect）

`autocorrect-replacement-lines.ts`（179 行）共 6 个策略：

| 策略 | 行为 |
|------|------|
| `stripTrailingContinuationTokens`（:9） | 去行尾延续符 |
| `stripMergeOperatorChars`（:13） | 去合并操作符字符 |
| `restoreOldWrappedLines`（:23） | wrap 行恢复：2–10 行 span 去空白拼接后与原文匹配则还原为单行 |
| `maybeExpandSingleLineMerge`（:67） | 合并行拆分：LLM 把多行压成一行时按有序子串匹配拆回，含 `;` 拆分兜底 |
| `restoreIndentForPairedReplacement`（:152） | 配对替换缩进恢复：替换行数与原始相同时自动补缩进 |
| `autocorrectReplacementLines`（:170） | 组合器（merge → wrap → indent） |

`edit-text-normalization.ts`（111 行）：

- `stripLinePrefixes`（:15-43）：hashline 前缀与 diff `+` 剥离，**过半阈值**（前缀行数 ≥ 非空行数 50% 才剥离，:31-32）
- echo 剥离三件套：`stripInsertAnchorEcho`（:61）、`stripInsertBeforeEcho`（:69）、`stripRangeBoundaryEcho`（:88）——其中 `stripRangeBoundaryEcho` 自 2026-06-01 起改为**精确字符串比较**（`out[0] === lines[beforeIdx]`，:101,106），不再做空白无关匹配
- `stripInsertBoundaryEcho`（:77）已导出（`index.ts:40`）但**无调用方**，属于保留 API

### 2.8 MismatchError

`HashlineMismatchError`（`validation.ts:82-137`）：

- **批量收集**所有不匹配锚点一次报出（`validateLineRefs`，`validation.ts:162-181`）
- `MISMATCH_CONTEXT = 2`（`validation.ts:14`），展示前后各 2 行上下文
- `>>>` 标记变化行（`validation.ts:129`）
- 携带 `remaps: Map<"line#expected", "line#actual">`，LLM 可直接用新哈希重试（`validation.ts:83,91-96`）
- 消息 "N lines have changed since last read. Use updated {line_number}#{hash_id} references below..."（`validation.ts:112-115`）
- executor 层对 MismatchError 附加 Tip："reuse LINE#ID entries from the latest read/edit output, or batch related edits in one call"（`hashline-edit-executor.ts:173-175`）
- 另有 `parseLineRefWithHint` + `suggestLineForHash`（"Did you mean N#ID?"）（`validation.ts:139-160`）

### 2.9 工具注册（Shadow 内建 edit）

```typescript
// tool-registry-gated-tools.ts:26-33
export function createHashlineToolsRecord(args): Record<string, ToolDefinition> {
  return pluginConfig.hashline_edit
    ? { edit: factories.createHashlineEditTool(ctx) }  // 以 "edit" 键名 shadow 内建工具
    : {}
}
```

`tool-registry.ts:52-66` 中 `createHashlineToolsRecord` 在**最后** spread，覆盖同名内建（`tool-registry.ts:65`）。

**关键发现**：OpenCode 插件的 `tool` hook 可以用与内建工具同名的 key shadow 内建实现。omo 用这个机制完全替换了原生 `edit`。

**配置**：`hashline_edit` 为顶层布尔（默认 false，`config/schema/oh-my-opencode-config.ts:59-60`），有从 `experimental.hashline_edit` 的迁移逻辑（`config-migration/transform-opencode.ts:51-53`）。

### 2.10 依赖

| 依赖 | 用途 | 必须性 |
|------|------|--------|
| `diff: ^9.0.0`（`hashline-core/package.json:18-19`） | `createTwoFilesPatch` 生成 unified diff（`diff-utils.ts:1`） | 仅 diff 展示需要 |

核心编辑逻辑（哈希、验证、autocorrect、apply）**零第三方运行时依赖**。

---

## 三、omp 方案：整文件哈希

### 3.1 架构概览

`packages/hashline/src/`——21 个 `.ts` 共 6912 行 + `grammar.lark`（27 行，Lark 形式文法）+ `prompt.md`（133 行，模型提示）+ 12 个测试文件（3378 行）：

| 文件 | 行数 | 职责 |
|------|-----|------|
| `apply.ts` | 1425 | 应用编辑 + 边界修复（`repairReplacementBoundaries`） |
| `parser.ts` | 792 | 状态机解析 → `Edit[]` |
| `patcher.ts` | 759 | 编排器：读文件 → 验证 → apply → 写文件 |
| `tokenizer.ts` | 590 | 逐行分类器 |
| `messages.ts` | 549 | 错误消息常量 |
| `input.ts` | 503 | 输入拆分（多 section） |
| `recovery.ts` | 353 | anchor remapping 恢复 |
| `block.ts` | 275 | block 编辑展开 |
| `snapshots.ts` | 254 | LRU 快照存储 |
| `fs.ts` | 246 | 文件系统抽象 |
| `types.ts` | 225 | 类型定义 |
| `clipboard.ts` | 215 | 剪贴板寄存器 |
| `prefixes.ts` | 150 | 文本前缀剥离 |
| `format.ts` | 146 | 格式常量 + 整文件哈希 |
| `stream.ts` | 132 | 流式输出 |
| `diff-preview.ts` | 124 | diff 预览 |
| `mismatch.ts` | 118 | `MismatchError` |
| `normalize.ts` | 38 | BOM/CRLF 归一化 |
| `index.ts` | 18 | 桶 |

宿主接线在 `packages/coding-agent/src/edit/hashline/`（7 个文件：`block-resolver` / `diff` / `execute` / `filesystem` / `index` / `noop-loop-guard` / `params`）。Rust crate `crates/pi-ast/`（`block.rs` 582 行，tree-sitter NAPI）。

### 3.2 哈希算法

**整文件哈希**（`computeFileHash`，`format.ts:117-121`）：

```typescript
export function computeFileHash(text: string): string {
  const normalized = normalizeFileHashText(text);            // 单遍剔除每行行尾 [ \t\r]+（format.ts:108-110）
  const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff;    // 取低 16 bit
  return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase();  // 4 位大写 hex
}
```

- **无纯 JS fallback**，强制 Bun（`package.json` engines `bun >= 1.3.14`）
- 归一化保留行内缩进，只去行尾空白，因此 CRLF 与显示裁剪不会使 tag 失效

### 3.3 Section header

```
[PATH#HASH]
```

示例：`[src/foo.ts#1A2B]`（`formatHashlineHeader`，`format.ts:133-135`）。

- Lark 文法强制 4 位 hex（`grammar.lark:7` `/[0-9A-F]{4}/`）
- **tokenizer 层哈希可选**：允许 `[PATH]`，从行尾探测 `#XXXX`，路径可含空格；但 **Patcher 层必填**——无哈希的 section 抛 `missingSnapshotTag` 错误
- 即**解析宽松、应用必填**

### 3.4 编辑操作：PUT / CUT / REM / MV

统一文本 diff 风格语法（`format.ts:16-23`；`grammar.lark:10-16`）：

| 操作 | 语法 | 说明 |
|------|------|------|
| `PUT` | `PUT <locator>:` + body | 替换/插入。locator 支持 span `N.=M`（规范分隔符，`format.ts:41`）、block `N*`、`<N` 前插、`>N` 后插、`>N*` block 后插、`<1` BOF、`>$` EOF |
| `PUT @name` | `PUT <locator> @name` | 从寄存器粘贴 |
| `PUT`（gap 无 body 形式） | `PUT <N` / `PUT >$` | 空操作占位（`grammar.lark:13`） |
| `CUT` | `CUT <locator> [@name]` | 剪切到寄存器（span 或 block） |
| `REM` | `REM` | 删除文件 |
| `MV` | `MV <filename>` | 移动文件（快照随之 relocate） |

body 行以 `+` 开头（空 `+` = 空行，`grammar.lark:25`）。

**范围分隔符宽松化**：规范 `N.=M`，同时接受 `-` `=` `.` `..` `…` 及纯空白。

**大量解析容错**（parser.ts）：裸行自动补 `+`、裸 `-` 行 diff 污染检测、均匀 `N:` 前缀剥离、裸 range 自动 `PUT`、快照行自动 `PUT`、`apply_patch` 噪音头恢复、范围上限 100,000 行。

### 3.5 剪贴板

`clipboard.ts`（215 行）：`CUT` 捕获 + `PUT @name` 粘贴（`clipboard.ts:1-9`）。

- **命名寄存器跨调用持久**（host-owned，`clipboard.named: Map`），匿名寄存器**批内有效**、批间重置（`clipboard.ts:5-8`）
- 批处理 fork/commit **事务化**：全部通过才落盘

### 3.6 恢复策略：anchor remapping（fail-closed）

`recovery.ts`（353 行）——**统一 anchor remapping，fail-closed**（`recovery.ts:6-8`）：

1. 用原生 `diffLineRuns`（来自 `@oh-my-pi/pi-natives`，UTF-16 码元级）构建快照 → live 的未变行映射（`recovery.ts:9,64-88`）
2. 校验每个锚点：统一偏移 + 重复行/唯一行邻居上下文**双重验证**
3. 全部通过才 remap 并 replay 到 live 内容；否则抛 `MismatchError`

**无 3-way merge、无独立 session 回放路径**。仅用警告横幅区分来源：`RECOVERY_EXTERNAL_WARNING` / `RECOVERY_SESSION_CHAIN_WARNING`（`messages.ts:379,383`）。

### 3.7 快照存储

`snapshots.ts`（254 行）——`InMemorySnapshotStore`：

- LRU **30 路径 × 每路径 4 版本**（`snapshots.ts:114-116`）+ 全局 **64 MiB** 文本总量上限（`snapshots.ts:117`）
- `seenLines`：记录每个 tag 下实际展示过的行（读取溯源，`snapshots.ts:46`）
- `relocate()` 支持 `MV`；`byHash` 按 tag 找回路径
- 去重要求**哈希 + 全文双等**（`byContent`，`snapshots.ts:70`）
- LRUCache 来自内部 `@oh-my-pi/pi-utils/lru`（`snapshots.ts:22`）

### 3.8 Block 编辑

`crates/pi-ast/src/block.rs`（582 行）导出 `block_range_at`（`block.rs:58`）与 `enclosing_block_boundaries`（`block.rs:234`）：

- tree-sitter 解析 → 首内容列单列宽 point 查询 → 沿祖先上爬到**仍在 N 行开始的最外层命名节点**
- 拒绝 ERROR 子树 / 空行 / 续行 / 闭合行
- 60+ 语言，含 Markdown section、Emacs Lisp、Makefile/Justfile/Dockerfile 特判

TS 层 `resolveBlockEdits`（`block.ts:105-275`）把延迟 block 编辑展开为具体 span 操作：不可解析时降级为普通 `>N` 并告警（`block.ts:123-161`），**单行 block 拒绝**（`block.ts:178-191`）。

### 3.9 边界修复

`apply.ts` 的 `repairReplacementBoundaries`（`apply.ts:885-1083`）共 **8 类**：

| 修复 | 行为 |
|------|------|
| 双端 echo（:909） | 首尾行都是存活行精确副本时剥离两端 |
| 重复尾闭合符（:950） | payload 重复了范围后的 `}` `)` 等 → 删除重复闭合符 |
| 重复首开括号（:962） | payload 重复了范围前的开括号 → 删除重复开括号 |
| 丢失闭合括号保留（:1025） | 删除范围吞掉结构闭合符但 payload 未重新声明 → 保留该闭合符（4 种基础） |
| 单侧 echo（:924-944） | payload 过短时**拒绝而非猜测** |
| 缩进自动修复 | `{` 后整体漏缩进按结构行对齐 |
| after-insert 落地校正（`apply.ts:1085+`） | body 缩进比锚点浅则外滑过闭合行；block 降级插入更深则内滑 |
| 歧义闭合严格拒绝（:1049-1058） | 证据不足时抛错而非二选一 |

支撑：`computeDelimiterBalance` 跳过注释/字符串/模板（`apply.ts:252`）、JSX tag 解析。

### 3.10 守卫机制

- **seen-lines 守卫**：`edit.enforceSeenLines` 可配置、**默认开**（`patcher.ts:234`），拒绝编辑未被 read 展示过的行（`patcher.ts:732`），错误内联揭示内容上限 40 行 / 512 列
- **写漂移检测**：按落盘内容重取哈希 + `writeDriftWarning`（`patcher.ts:39,557-559`）
- **基于 tag 的路径恢复**：basename + tag 唯一匹配本会话读过的文件时重绑定
- **noop 循环防护**：`coding-agent/src/edit/hashline/noop-loop-guard.ts`

### 3.11 依赖与宿主集成

| 依赖 | 用途 |
|------|------|
| `@oh-my-pi/pi-natives` | `diffLineRuns`（恢复用）、`blockRangeAt`（block 解析） |
| `@oh-my-pi/pi-utils` | LRUCache |

**仅 2 个内部依赖，无第三方 npm 依赖**；Bun ≥ 1.3.14。omp 是独立产品（pi 编码 agent），hashline 是其**自带编辑工具**，不是 OpenCode 插件。

---

## 四、omo vs omp 方案对比

### 4.1 核心设计差异

| 维度 | omo | omp |
|------|-----|-----|
| **哈希粒度** | 逐行（每行独立 hash ID） | 整文件（每文件一个 hash tag） |
| **哈希输出** | 2 字符，16 字母表 `ZPMQVRWSNKTXJBYH` | 4 位大写 hex |
| **行标记格式** | `42#VK\|function hello()` | `[src/foo.ts#1A2B]` + `42:function hello()` |
| **编辑格式** | JSON（`{op, pos, end, lines}`） | 文本 diff 风格 `PUT`/`CUT`/`REM`/`MV` |
| **引用方式** | 行号 + 行哈希 | 行号 + 文件哈希 |
| **验证粒度** | 每个锚点行独立验证 | 整文件哈希一次验证 |
| **哈希兼容性** | 当前哈希 OR legacy 哈希 | 精确匹配（tokenizer 解析宽松、应用必填） |
| **失败恢复** | 无（拒绝 + 提供 remap 新哈希） | anchor remapping，fail-closed |
| **剪贴板** | 无 | `CUT` + `PUT @name` 寄存器 |

### 4.2 架构差异

| 维度 | omo | omp |
|------|-----|-----|
| **运行时要求** | Bun 或 Node（纯 JS fallback） | 仅 Bun（无 fallback，engines ≥ 1.3.14） |
| **Rust 组件** | 无 | block 编辑用 tree-sitter NAPI（`crates/pi-ast`） |
| **恢复策略** | 无状态（直接拒绝 + 提供新哈希） | anchor remapping fail-closed（依赖私有 `pi-natives`） |
| **快照存储** | 无（无状态） | LRU 30 路径 × 4 版本 + 64 MiB 上限 |
| **依赖** | `diff: ^9.0.0`（仅 diff 展示） | 仅内部 `pi-natives` + `pi-utils` |
| **与 OpenCode 关系** | 插件，`edit` 键名 shadow 内建工具 | 独立产品自带编辑工具 |
| **代码规模** | 核心库 ~1300 行 + 集成层 ~480 行 | 核心库 6912 行 + Rust + 测试 3378 行 |

### 4.3 优劣势对比

| | omo 优势 | omp 优势 |
|--|---------|---------|
| **简洁性** | 无状态，无快照管理，纯 TS 可移植 | — |
| **恢复能力** | — | anchor remapping 可容忍行号漂移（fail-closed） |
| **验证精度** | 一行变化不影响其他行编辑 | — |
| **Block 编辑** | — | tree-sitter 自动推断语法块范围 |
| **格式亲和** | JSON 结构，LLM 容易生成 | 文本 diff 紧凑，`+` body 直观 |
| **守卫强度** | — | seen-lines / 写漂移 / noop 多重守卫 |
| **可移植性** | Node/Bun 双运行时 | 强制 Bun + 私有原生库，不可移植 |

### 4.4 共同点

- 都用 **xxHash32**
- 都做哈希前空白归一化（strip trailing whitespace、CRLF → LF）
- 都有 BOM/CRLF 写回恢复
- 都有边界 echo 剥离与自动修复（omo 6 策略 autocorrect / omp 8 类边界修复）
- 都有 MismatchError 带上下文展示（omo 前后 2 行 / omp 锚点 + 2 行）
- 都有空编辑 noop 检测

---

## 五、设计决策（草案）

> **状态：** 进行中的设计草案（living document），非定稿。本节记录当前已确认的设计决策与暂定约定，后续讨论中随时可能调整——措辞中的"当前倾向 / 暂定 / 待定"均非钉死表述。
> **日期：** 2026-08-07

基于上述调研，决定**不 fork 任何一方、自研实现**，目标是吸收两家长处做到最好。

### 5.1 已确认决策

#### 1. 整文件哈希（非逐行）

采纳 omp 的整文件哈希方案，而非 omo 的逐行哈希。

- **理由：** token 经济是首要原因——read 输出不被逐行哈希前缀污染；逐行哈希的实现复杂度是一次性成本，而 token 节省是每次 read 都兑现的。

#### 2. 文本 diff 风格编辑格式（非 JSON）

编辑指令采用文本 diff 风格（`PUT` + `+` 前缀 body），而非 omo 的 JSON 结构（`{op, pos, end, lines}`）。

- **理由：** 与整文件哈希的 token 经济一脉相承；`+` 前缀 body 比 JSON 转义字符串对 LLM 更友好、更省 token。

#### 3. Anchor remapping 恢复，fail-closed

采用 omp 的 anchor remapping 恢复机制，fail-closed。

- **理由：** 整文件哈希若不配恢复机制，长会话中行号漂移后编辑将不可用；方案为快照 + 行级 diff 验证锚点后重放，验证不过就报错、绝不猜测。

#### 4. Rust 实现 diff，napi-rs 桥接

行级 diff 用 Rust 实现（不碰纯 TS Myers），经 napi-rs 桥接给 TS 层。

- **理由：** napi-rs 已由 omp 在相同环境（Bun 宿主 + TS 插件）验证可行；crate 落在现有 `tools/` workspace；附带好处是 tree-sitter block 编辑可在同一 crate 扩展。

#### 5. 操作集 = 核心集 + block

- 核心集：`PUT 5.=10:`（替换）、`PUT <5:` / `PUT >5:`（前/后插）、`PUT <1:` / `PUT >$:`（BOF/EOF）、`PUT 5.=10` 无 body（删除）
- Block 编辑：`PUT 42*:`（tree-sitter 推断语法块范围）
- **不做**剪贴板（`CUT` / `PUT @reg`——omp 返修最多的子系统，投入产出比低）与 `REM`/`MV` 文件级操作（bash 可兜底）

#### 6. 守卫全上

- seen-lines（拒绝编辑未被 read 展示过的行）
- 写漂移检测（按落盘内容重取哈希校验）
- noop 检测（编辑结果与原文一致时报错）
- MismatchError 双形态："file changed" vs "hash is not from this session"

- **理由：** 边际成本低（复用快照存储），各自消灭一整类 LLM 失败模式。

#### 7. Shadow 内建 `edit` 工具

- `config.toml` 顶层开关 `hashline_edit`（默认 false），install.py 编译进 OpenCode 配置
- read 输出经 `tool.execute.after` 注入 `[PATH#HASH]` header 并记录快照
- 第一版仅 OpenCode 宿主，pi 宿主延后

### 5.2 暂定约定（表层）

沿用 omp 实战收敛结果，以下为**暂定**，待实战验证：

- Header 格式 `[PATH#HASH]`；范围规范写法 `N.=M`（宽松接受 `..`、`-` 等分隔符）；body 以 `+` 开头（空 `+` = 空行）；block 标记 `N*`
- 哈希：`Bun.hash.xxHash32` 取低 16 bit → 4 位大写 hex；行尾空白归一化后计算
- 快照：LRU 30 路径 × 4 版本 + 64 MiB 总量上限
- 解析容错做核心三样：裸行自动补 `+`、`N:` 前缀剥离、unified diff 污染检测；奇异容错不做
- 边界修复参照 omp 的 8 类：

| 修复 | 行为 |
|------|------|
| 双端/单侧 echo | 存活行精确副本的边界剥离；单侧过短时拒绝而非猜测 |
| 重复闭合/开括号 | payload 重复范围后 `}` / 范围前 `{` 时删除重复项 |
| 丢失闭合括号保留 | 删除范围吞掉闭合符但 payload 未声明时保留 |
| 缩进自动修复 | `{` 后整体漏缩进按结构行对齐 |
| after-insert 落地校正 | body 缩进异常时在闭合行处外滑/内滑校正 |
| 歧义严格拒绝 | 证据不足时抛错而非二选一 |

### 5.3 初步模块布局（待定）

- `tools/zoo-natives/`：新 crate，`diff_lines`（行级 diff）+ `block_range`（tree-sitter）两个 napi 导出
- `src/hashline/`：纯 TS 核心（format / tokenizer / parser / apply / patcher / recovery / snapshots / mismatch / block），零 npm 依赖
- `src/hooks/hashline-edit/`：工具定义（shadow `edit`）+ 执行器 + read 增强
- `config.toml` + `install.py`：开关编译

### 5.4 开放问题

- pi 宿主的集成方式
- 剪贴板 / `REM` / `MV` 是否在未来版本加入
- parser leniency 的边界（实战中按需补充）
- 与 ZooKeeper 现有 Rust CLI 工具链的构建整合细节
- prompt 适配与评估方案
