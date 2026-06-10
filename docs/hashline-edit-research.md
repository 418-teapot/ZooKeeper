# Hashline Edit 技术调研报告

> 调研对象：oh-my-openagent (omo) 的 `hashline-core` + `hashline-edit`、oh-my-pi (omp) 的 `packages/hashline`
> 目标：评估 ZooKeeper 引入 hashline 编辑的可行方案
> 日期：2026-06-10

---

## 一、问题背景

OpenCode 原生 `edit` 工具使用 `oldString/newString` 模式：LLM 提供要被替换的原始文本片段，引擎在文件中查找匹配。这种方式存在两个核心问题：

1. **行号漂移**：LLM 在一次编辑中引用了行号 N，但如果前一次编辑插入/删除了行，行号 N 已经指向不同的内容
2. **oldString 不匹配**：LLM 生成的 oldString 与文件中的实际内容有微小差异（缩进、空白、遗漏），导致 `oldString not found` 错误

omo 的基准测试数据：**仅更换编辑工具**（其他条件不变），Grok Code Fast 1 的成功率从 **6.7% → 68.3%**（约 10 倍提升）。这证明内容寻址编辑对弱模型的帮助是巨大的。

---

## 二、omo 方案：逐行哈希

### 2.1 架构概览

```
packages/hashline-core/     纯逻辑库（23 文件，~1200 行）
  └── src/
       ├── xxhash32.ts          xxHash32 实现（纯 JS + Bun 原生）
       ├── constants.ts         16 字母表 + 256 查找表 + 正则
       ├── hash-computation.ts  逐行哈希 + legacy 哈希 + 流式格式化
       ├── validation.ts        LINE#REF 解析 + 验证 + MismatchError
       ├── normalize-edits.ts   raw LLM 输入 → typed HashlineEdit
       ├── edit-ordering.ts     按行号倒序排序 + 重叠检测
       ├── edit-deduplication.ts 去重
       ├── edit-operation-primitives.ts  6 个原子编辑操作
       ├── edit-operations.ts   组合全流程（validate → sort → dedupe → apply）
       ├── edit-text-normalization.ts   前缀/缩进/echo 处理
       ├── autocorrect-replacement-lines.ts  自动修复（最复杂模块）
       ├── file-text-canonicalization.ts  BOM/CRLF 归一化
       ├── hashline-chunk-formatter.ts   流式输出分块
       ├── hashline-edit-diff.ts  编辑 diff 生成
       ├── diff-utils.ts        unified diff（唯一外部依赖：diff 包）
       └── types.ts             类型定义

src/tools/hashline-edit/        OpenCode 集成层（24 文件）
  ├── hashline-edit-executor.ts  执行器主逻辑
  ├── tool-description.ts        给 LLM 的工具说明
  ├── tools.ts                   工具注册（schema + execute）
  └── ...（re-export 文件）

src/hooks/
  ├── hashline-read-enhancer/    拦截 read 输出，注入行哈希
  └── hashline-edit-diff-enhancer/  拦截 write 输出，附加 diff
```

### 2.2 哈希算法

**xxHash32**（`xxhash32.ts`，90 行）：

- 非加密哈希，速度快，32-bit 输出
- 运行时检测：Bun 环境走 `Bun.hash.xxHash32()` 原生 API；否则走纯 JS 实现（约 50 行核心算法）
- 种子策略：有字母/数字的行 → seed=0；空白/标点行 → seed=lineNumber（确保空行在不同位置产生不同哈希）
- 所有 32-bit 运算用 `>>> 0` 强制无符号，避免 JS 有符号整数陷阱

**2 字符哈希 ID**（`constants.ts`）：

- 16 字母表：`ZPMQVRWSNKTXJBYH`（故意避开 0-9 和 A-F，避免与十六进制混淆）
- 预计算 256 项查找表：`hash % 256` → 2 字符 ID
- 正则：`/^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/`

### 2.3 行标记格式

**读取输出**（`hash-computation.ts:23-26`）：

```
{行号}#{哈希}|{内容}
```

示例：
```
42#VK|function hello() {
43#XJ|  console.log("hi");
44#MB|  console.log("bye");
45#QR|}
```

**编辑引用**（只传递锚点，不含 `|` 后面的内容）：
```
42#VK
```

### 2.4 哈希归一化

两种哈希模式（`hash-computation.ts`）：

| 模式 | 归一化规则 | 用途 |
|------|-----------|------|
| **当前哈希** `computeLineHash` | strip `\r` + trimEnd | 默认验证 |
| **Legacy 哈希** `computeLegacyLineHash` | strip `\r` + strip **所有空白** | 兼容哈希 |

验证时使用 `isCompatibleLineHash`（`validation.ts:18-20`）：当前哈希 **OR** legacy 哈希匹配即可。这意味着如果文件只改了缩进，旧哈希仍然有效。

### 2.5 编辑操作

三种操作类型（`types.ts`）：

```typescript
interface ReplaceEdit {
  op: "replace"
  pos: string           // 锚点 LINE#ID（required）
  end?: string          // 范围终点（optional，有则为范围替换）
  lines: string | string[] | null  // null/[] = 删除
}
interface AppendEdit {
  op: "append"
  pos?: string          // 锚点（插入其后）；无锚点 → EOF
  lines: string | string[]
}
interface PrependEdit {
  op: "prepend"
  pos?: string          // 锚点（插入其前）；无锚点 → BOF
  lines: string | string[]
}
```

### 2.6 执行管线

```
normalizeHashlineEdits()    → RawHashlineEdit → typed HashlineEdit[]
  ↓
validateLineRefs()          → 校验所有 LINE#ID 锚点
  ↓
getEditLineNumber()           → 按行号降序排序（bottom-up）
  ↓
detectOverlappingRanges()   → 检测范围重叠，重叠则报错
  ↓
dedupeEdits()               → 去重
  ↓
applySetLine / applyReplaceLines / applyInsertAfter /
applyInsertBefore / applyAppend / applyPrepend
  ↓
autocorrectReplacementLines() → 自动修复 LLM 常见错误
```

### 2.7 自动修复（Autocorrect）

`autocorrect-replacement-lines.ts`（179 行，最复杂模块）三阶段：

1. **合并行拆分** `maybeExpandSingleLineMerge`：LLM 把多行合并成一行时，尝试按有序子串匹配拆回原始行数
2. **Wrap 行恢复** `restoreOldWrappedLines`：LLM 把长行拆成多短行时，按空白无关匹配合回原始单行
3. **配对替换缩进恢复** `restoreIndentForPairedReplacement`：替换行数与原始相同时，如果新行无缩进但原始有，自动恢复

### 2.8 原子操作中的内建修复

`edit-operation-primitives.ts` 中的 4 种自动修复：

| 修复 | 描述 |
|------|------|
| **缩进恢复** | 替换行无缩进但原始行有 → 自动补上原始缩进 |
| **锚点 echo 剥离** | insert 首/末行重复了锚点行 → 自动删除重复行 |
| **边界 echo 剥离** | replace 范围的前后行重复了存活边界行 → 自动删除 |
| **hashline 前缀剥离** | 替换文本中混入了 `LINE#ID|` 前缀或 `+` diff 标记 → 自动去除 |

### 2.9 哈希不匹配处理

`HashlineMismatchError`（`validation.ts:82-137`）：

- 收集所有不匹配的锚点后一次性报出
- 展示 2 行上下文（`MISMATCH_CONTEXT = 2`），`>>>` 标记变化行
- 携带 `remaps: Map<string, string>`（`old-ref → new-ref`），LLM 可直接用新哈希重试
- 提示：`"Tip: reuse LINE#ID entries from the latest read/edit output"`

### 2.10 工具注册（Shadow 内建 edit）

```typescript
// tool-registry-gated-tools.ts:31
return pluginConfig.hashline_edit
  ? { edit: factories.createHashlineEditTool(ctx) }  // 名为 "edit"，shadow 内建工具
  : {}

// tool-registry.ts:51-64 — 最后扩展，覆盖同名内建
const allTools = {
  ...createCoreTools({...}),
  ...createHashlineToolsRecord({...}),  // ← 最后 spread
}
```

**关键发现**：OpenCode 插件的 `tool` hook 可以用与内建工具同名的 key 来 shadow 内建实现。omo 用这个机制完全替换了原生 `edit`。

### 2.11 Read 增强 Hook

`hashline-read-enhancer/hook.ts`（216 行）拦截 `read` 工具输出：

```
原始输出: 42: function hello() {
增强输出: 42#VK|function hello() {
```

核心逻辑：解析 `N: content` 或 `N|content` 格式 → 计算行哈希 → 重写为 `N#hash|content`。跳过被截断的行（以 `... (line truncated to 2000 chars)` 结尾）。

### 2.12 外部依赖

| 依赖 | 用途 | 必须性 |
|------|------|--------|
| `diff` ~9.0.0 | `createTwoFilesPatch` 生成 unified diff | 仅 diff 展示需要 |
| `bun-types`（dev） | TypeScript 类型检查 | 开发依赖 |

核心编辑逻辑 **零外部依赖**。

---

## 三、omp 方案：整文件哈希

### 3.1 架构概览

```
packages/hashline/            核心库（~1800 行）
  └── src/
       ├── format.ts           格式常量 + computeFileHash（整文件哈希）
       ├── types.ts            Edit/Cursor/Anchor/BlockResolver 类型
       ├── tokenizer.ts        逐行分类器
       ├── parser.ts           状态机解析 → Edit[]
       ├── apply.ts            应用 Edit[] + 边界修复
       ├── patcher.ts          编排器：读文件 → validate → apply → 写文件
       ├── recovery.ts         3-way merge 恢复
       ├── snapshots.ts        LRU 快照存储
       ├── mismatch.ts         MismatchError
       ├── block.ts            tree-sitter block 解析
       ├── input.ts            输入拆分（多 section）
       ├── normalize.ts        BOM/CRLF 归一化
       ├── messages.ts         错误消息常量
       └── prefix-prefixes.ts  文本前缀剥离

crates/pi-ast/src/block.rs    Rust NAPI: tree-sitter block 范围解析
```

### 3.2 哈希算法

**xxHash32**（`format.ts:96-109`）：

- 只用 `Bun.hash.xxHash32()`（无纯 JS fallback，omp 强制 Bun 运行时）
- 取低 16 bit (`& 0xffff`) → 4 hex 字符（`0000`-`FFFF`，大写）
- 哈希前归一化：strip trailing `[ \t\r]`（per-line，保留缩进，只去行尾空白）
- **整文件哈希**——对整个文件内容哈希，不是逐行

```typescript
export function computeFileHash(text: string): string {
  const normalized = text.replace(/[ \t\r]+(?=\n|$)/g, "");
  const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff;
  return low16.toString(16).padStart(4, "0").toUpperCase();
}
```

### 3.3 Section Header 格式

```
[PATH#HASH]
```

示例：
```
[src/foo.ts#1A2B]
replace 5..10:
+new line 1
+new line 2
delete 15..20
insert after 30:
+inserted line
```

- `#` 是文件路径与哈希的分隔符（路径中禁止出现 `#`）
- 哈希是**必选的**——没有无哈希的形式
- 小写 hex 也能被解析，自动转大写

### 3.4 编辑操作

文本 diff 风格（非 JSON），8 种操作：

| 操作 | 语法 | 说明 |
|------|------|------|
| 替换行 | `replace N..M:` | 替换行 N-M（含），后面跟 `+` 行 |
| 替换整块 | `replace block N:` | tree-sitter 解析 N 开始的语法块范围 |
| 删除行 | `delete N..M` | 删除行 N-M，无冒号无 body |
| 删除整块 | `delete block N` | tree-sitter 解析块范围并删除 |
| 插入之前 | `insert before N:` | 在行 N 前插入 |
| 插入之后 | `insert after N:` | 在行 N 后插入 |
| 文件头插入 | `insert head:` | BOF 插入 |
| 文件尾插入 | `insert tail:` | EOF 插入 |

Body 行以 `+` 开头（空 `+` = 空行）。`-` 前缀被拒绝。

### 3.5 3-Way Merge 恢复（omp 独有）

`recovery.ts`（186 行）——hashline 验证失败时的恢复策略：

**策略 1：3-way merge**

```
1. 在快照（快照 = 上次 read 时的文件内容）上应用编辑 → 得到编辑后版本
2. 计算快照 → 编辑后版本 的 structured patch
3. 尝试把 patch 应用到当前 live 文件上（fuzzFactor=0，精确匹配）
4. 成功 → 恢复完成，附带 RECOVERY_EXTERNAL_WARNING
```

**策略 2：Session-chain replay**（条件更严苛的快速路径）

```
前提条件：
  - 快照明细行数 == live 文件行数（无净增删）
  - 每个编辑锚点行的内容在快照和 live 文件中完全一致

执行：直接在当前 live 文件上重放编辑
输出：RECOVERY_SESSION_REPLAY_WARNING（确定性更低）
```

### 3.6 快照存储

`snapshots.ts`（128 行）——`InMemorySnapshotStore`：

- LRU cache：**30 个文件路径** × **每路径 4 个版本**
- 内容寻址：`record(path, text)` → `computeFileHash(text)` → 存 `Snapshot { path, text, hash, recordedAt }`
- 去重：相同内容的 read 复用已有 tag（刷新最近访问时间）
- 用于 3-way merge 恢复：通过 `byHash(path, hash)` 检索特定版本

### 3.7 Block 编辑（omp 独有，Rust NAPI）

`block.ts` + `crates/pi-ast/src/block.rs`：

```
replace block 42:
+new function body

→ tree-sitter 解析第 42 行开始的语法块
→ 扩展到完整范围（如 42..85）
→ 转化为 replace 42..85: + ...
```

- 通过 NAPI 桥接 Rust tree-sitter
- 找到第 42 行首列的 named descendant → 上溯到最外层仍在第 42 行开始的祖先节点
- 支持所有 tree-sitter 语言
- 语法错误或无法解析时返回 `null`

### 3.8 边界修复

`apply.ts`（~482 行）中的 `repairReplacementBoundaries`——4 种自动修复：

| 修复 | 触发条件 | 处理 |
|------|---------|------|
| 双端 echo | 首尾行都是存活行的精确副本 | 剥离两端 |
| 重复闭合括号 | payload 重复了范围后的 `}` `)` 等 + 括号不平衡 | 删除重复的闭合符 |
| 重复开括号 | payload 重复了范围前的开括号 + 括号不平衡 | 删除重复的开括号 |
| 丢失闭合括号 | 删除范围吞掉了结构闭合符但 payload 未重新声明 | 保留该闭合符 |

### 3.9 MismatchError

`mismatch.ts`（138 行）两种错误消息：

| `hashRecognized` | 含义 | 消息 |
|------------------|------|------|
| `true` | 快照中有记录，但文件变了 | "file changed between read and edit" — 给出当前哈希 |
| `false` | 快照中无此哈希 | "hash is not from this session" — 警告不要编造或跨 session 复用 |

两种都展示锚点行 + 2 行上下文，`*` 标记。

### 3.10 外部依赖

| 依赖 | 用途 |
|------|------|
| `Bun.hash.xxHash32` | 哈希计算（无 fallback） |
| `diff` | `Diff.structuredPatch` + `Diff.applyPatch`（recovery 用） |
| `lru-cache` | SnapshotStore |
| tree-sitter（Rust） | block 编辑范围解析 |
| Bun 运行时 | `Bun.file`、`Bun.write` |

---

## 四、omo vs omp 方案对比

### 4.1 核心设计差异

| 维度 | omo | omp |
|------|-----|-----|
| **哈希粒度** | 逐行（每行独立 hash ID） | 整文件（每文件一个 hash tag） |
| **哈希输出** | 2 字符，16 字母表 | 4 hex 字符 |
| **行标记格式** | `42#VK|function hello()` | `[src/foo.ts#1A2B]` + `42:function hello()` |
| **编辑格式** | JSON（`{op, pos, end, lines}`） | 文本 diff（`replace N..M:` / `+line`） |
| **引用方式** | 行号 + 行哈希 | 行号 + 文件哈希 |
| **验证粒度** | 每个锚点行独立验证 | 整文件哈希一次验证 |
| **哈希兼容性** | 当前哈希 OR legacy 哈希 | 精确匹配 |

### 4.2 架构差异

| 维度 | omo | omp |
|------|-----|-----|
| **运行时要求** | Bun 或 Node（纯 JS fallback） | 仅 Bun |
| **Rust 组件** | 无 | block 编辑用 tree-sitter NAPI |
| **恢复策略** | 无（直接拒绝 + 提供正确哈希） | 3-way merge + session-chain replay |
| **快照存储** | 无（状态less） | LRU cache（30 路径 × 4 版本） |
| **与 OpenCode 关系** | 插件，shadow 内建 edit | 独立产品，自带工具系统 |

### 4.3 优劣势对比

| | omo 优势 | omp 优势 |
|--|---------|---------|
| **简洁性** | 无状态，无需快照管理 | — |
| **恢复能力** | — | 3-way merge 可以处理外部编辑冲突 |
| **可移植性** | 纯 TS，Node/Bun 兼容 | — |
| **Block 编辑** | — | 自动推断语法块范围 |
| **验证精度** | 一行变化不影响其他行编辑 | — |
| **格式亲和** | JSON 结构，LLM 容易生成 | 文本 diff，token 更紧凑 |

### 4.4 共同点

- 都用 **xxHash32**
- 都做哈希前空白归一化（strip trailing whitespace + CRLF → LF）
- 都有 BOM/CRLF 写回恢复
- 都有边界 echo 剥离
- 都有 MismatchError 带上下文展示

---

## 五、ZooKeeper 集成方案评估

### 5.1 ZooKeeper 当前环境

| 项目 | 现状 |
|------|------|
| **运行时** | OpenCode 内嵌 Bun（`Bun.hash.xxHash32` 可用） |
| **依赖管理** | 零依赖，无 `node_modules`、无 lockfile |
| **工具注册** | 不注册自定义工具，不 shadow 内建工具 |
| **Hook 数** | 3 个（`config` + `tool.definition` + `tool.execute.before/after`） |
| **哲学** | 声明式配置（config.toml 单一事实来源） |

### 5.2 方案 A：直接复用 omo hashline-core

**做法**：将 `packages/hashline-core/`（23 文件，~1200 行）复制到 ZooKeeper 的 `packages/hashline-core/`，编写集成层（~400 行）。

**需要做的事情**：

1. **引入 workspace 结构**：
   ```json
   // package.json
   "workspaces": ["packages/hashline-core"],
   "dependencies": { "diff": "^9.0.0" }
   ```

2. **复制核心库**：`packages/hashline-core/src/` 全部 23 个文件（含测试）

3. **编写集成层**（~400 行）：

   | 文件 | 行数 | 说明 |
   |------|------|------|
   | `src/hooks/hashline-edit/tool.ts` | ~45 | 自定义 `edit` 工具定义（shadow 内建），需要 zod |
   | `src/hooks/hashline-edit/executor.ts` | ~120 | 执行器（从 omo 简化，去掉 `publishToolMetadata` 和 formatter） |
   | `src/hooks/hashline-edit/read-enhancer.ts` | ~80 | read 输出行标记增强 |
   | `src/hooks/hashline-edit/tool-description.ts` | ~95 | 给 LLM 的工具说明 |

4. **修改 `src/index.ts`**：新增 `tool` hook 注册 + read-enhancer handler

5. **修改 `config.toml`**：可选添加 `[hashline] enabled = true` + install.py 编译逻辑

**风险**：

| 风险 | 说明 | 缓解措施 |
|------|------|---------|
| 隐式耦合 | omo 代码中引用了 `@opencode-ai/plugin/tool`、`publishToolMetadata`、`FormatterClient` 等 | 集成层重写时不直接引用 omo，只 import hashline-core 的纯函数 API |
| 维护同步 | omo 更新 hashline-core 后需要手动同步 | 作为 fork 维护，不追求上游同步 |
| 依赖引入 | 打破了 ZooKeeper 零依赖的设计 | `diff` 是唯一运行时依赖，轻量且稳定 |

**优劣**：

| ✅ 优势 | ❌ 劣势 |
|---------|---------|
| 成熟代码，700+ 行测试覆盖 | 引入 workspace + diff 依赖 |
| 边界条件和 autocorrect 经过大量打磨 | 隐式耦合需要仔细剥离 |
| 逐行验证的 legacy hash 兼容机制 | 后续维护需跟踪 omo 上游 |

**总工作量估计**：~1600 行代码（1200 复制 + 400 集成），约 2-3 天调试和集成验证。

### 5.3 方案 B：自行实现

**做法**：参照 omo/omp 的设计，从零编写 hashline 核心库 + 集成层。

**模块清单**：

| # | 模块 | 预估行数 | 依赖 | 复杂度 |
|---|------|---------|------|--------|
| 1 | `xxhash32.ts` | 90 | — | 中（32-bit 无符号运算注意 `>>> 0`） |
| 2 | `constants.ts` | 10 | — | 低 |
| 3 | `hash-computation.ts` | 155 | 1, 2 | 低 |
| 4 | `types.ts` | 20 | — | 低 |
| 5 | `validation.ts` | 181 | 2, 3 | 中（MismatchError 格式较复杂） |
| 6 | `normalize-edits.ts` | 95 | 4 | 低 |
| 7 | `edit-text-normalization.ts` | 111 | 4 | 中（前缀/缩进/echo 多种处理） |
| 8 | `edit-operation-primitives.ts` | 125 | 5, 7 | 中（6 个原语各有特殊处理） |
| 9 | `edit-ordering.ts` | 56 | 4, 5 | 低 |
| 10 | `edit-deduplication.ts` | 43 | 4, 7 | 低 |
| 11 | `autocorrect-replacement-lines.ts` | 179 | — | **高**（边界条件多） |
| 12 | `edit-operations.ts` | 99 | 8, 9, 10, 5 | 低 |
| 13 | `file-text-canonicalization.ts` | 44 | — | 低 |
| 14 | `hashline-chunk-formatter.ts` | 52 | — | 低 |
| 15 | `diff-utils.ts` | ~100 | `diff` 包 | 低 |
| 16 | `hashline-edit-diff.ts` | 50 | 3, 15 | 低 |

核心库合计：**~1410 行**

集成层（同方案 A 的 3b-3e）：**~400 行**

**总计**：~1810 行（比方案 A 多约 200 行，因为 diff-utils 自写比直接用 `diff` 包略长，但可以用 `diff` 包减少这部分）

**需要自行编写测试**：

| 测试文件 | 测试要点 | 预估用例数 |
|---------|---------|-----------|
| `hash-computation.test.ts` | 确定性、种子的选择、缩进敏感、legacy 兼容、CRLF | ~11 |
| `validation.test.ts` | 解析、格式错误提示、哈希匹配/不匹配、批量错误 | ~15 |
| `edit-operations.test.ts` | 各种编辑组合、边界条件、echo 剥离、缩进恢复 | ~25 |
| `normalize-edits.test.ts` | 归一化各种输入格式 | ~6 |
| `diff-utils.test.ts` | unified diff 格式 | ~7 |

测试合计：**~64 个用例**

**难点和风险**：

| 难点 | 说明 |
|------|------|
| **xxHash32 正确性** | JS 中 32-bit 运算全是 signed，每个中间步骤都要 `>>> 0`。一个遗漏就全错 |
| **Autocorrect 边界条件** | 拆合并行的有序子串匹配、wrap 行的空白无关匹配，逻辑不难但组合情况多 |
| **Echo 剥离遗漏** | 4 种 echo 情况（insert 首末行重复锚点、replace 边界重复存活行），容易漏掉某一种 |
| **MismatchError 的 remaps** | 不匹配时生成 `old-ref → new-ref` 映射，LLM 可直接修正重试 |
| **测试覆盖不足** | omo 的 autocorrect 模块有回归测试（애국가 bug），自写时可能踩到同样的坑 |

### 5.4 方案对比

| 维度 | A. 复用 omo | B. 自写 |
|------|-----------|---------|
| **代码量** | ~1600 行（1200 复制 + 400 集成） | ~1810 行 |
| **开发时间** | 2-3 天（集成调试） | 5-7 天（编写 + 调试 + 测试） |
| **测试覆盖** | 已有 ~64 个测试用例 | 需要自写，质量取决于投入 |
| **外部依赖** | `diff` 包 + workspace | `diff` 包 + workspace（相同） |
| **代码理解** | 需要读懂 1200 行 omo 代码 | 每行都是自己写的 |
| **维护成本** | 需要跟踪 omo 更新 | 完全自主 |
| **定制灵活度** | 中（改核心逻辑要理解上游意图） | 高（想改哪改哪） |
| **风险** | 隐式耦合、同步维护 | 算法实现错误、边界条件遗漏 |

### 5.5 建议

**短期推荐方案 A（复用 omo）**，原因：

1. `autocorrect-replacement-lines.ts`（179 行）和 `edit-operation-primitives.ts`（125 行）是经验累积型代码，自写很难一次性覆盖所有边界条件
2. omo 的 hashline-core 已经是 `private: true` 的内部包，API 稳定，适合作为 fork 基础
3. 节省的 3-4 天时间可以投入到集成验证和 prompt 调优上——hashline 的 LLM 行为效果比实现细节更重要
4. `diff` 包是两者都需要的，不是额外成本

**长期可渐进迁移**：在充分使用和理解后，逐步用自写代码替换不需要的部分（如 stream formatter、chunk formatter），保留经过验证的核心（hash、validation、autocorrect）。

---

## 六、实施路线

### Phase 1：基础集成（方案 A）

1. 引入 workspace + `diff` 依赖
2. 复制 `packages/hashline-core/` 全部文件
3. 编写集成层：tool definition + executor + read-enhancer
4. 在 `config.toml` 中添加 `[hashline]` 可选开关
5. 修改 `src/index.ts`：注册 `tool` hook + read-enhancer
6. 跑通 `bun test` + `./check.sh` + `./test.sh`
7. 手动端到端测试：用 OpenCode 编辑文件，验证 hashline 工作流

### Phase 2：Prompt 适配

8. 更新 `build.md` 和 `general.md`：指导 agent 使用 hashline 格式
9. 编写 hashline 相关的 prompt 评估测试场景
10. 验证 hashline 对 LLM 编辑成功率的影响

### Phase 3：增强（可选）

11. Formatter 触发（编辑后自动 format）
12. 考虑 omp 的 3-way merge 恢复（如果实际使用中冲突率高）
13. 考虑渐进式自写替换
