# opencode-visual-cache 插件完整技术分析

**版本:** 1.0
**日期:** 2026-07-09
**分类:** 技术调研报告 / 插件集成可行性分析

---

## 目录

1. [概述](#1-概述)
2. [项目结构](#2-项目结构)
   - 2.1 [文件清单](#21-文件清单)
   - 2.2 [技术栈与依赖](#22-技术栈与依赖)
   - 2.3 [构建流程](#23-构建流程)
3. [架构分析](#3-架构分析)
   - 3.1 [双入口设计](#31-双入口设计)
   - 3.2 [Server 入口](#32-server-入口)
   - 3.3 [TUI 入口](#33-tui-入口)
4. [源码逐函数详解](#4-源码逐函数详解)
   - 4.1 [文本工具](#41-文本工具)
   - 4.2 [颜色处理](#42-颜色处理)
   - 4.3 [数值格式化](#43-数值格式化)
   - 4.4 [Token 估算引擎](#44-token-估算引擎)
   - 4.5 [面板组件与信号体系](#45-面板组件与信号体系)
   - 4.6 [数据采集与计算](#46-数据采集与计算)
   - 4.7 [TUI 渲染逻辑](#47-tui-渲染逻辑)
   - 4.8 [配置持久化](#48-配置持久化)
   - 4.9 [斜杠命令系统](#49-斜杠命令系统)
5. [数据流完整追踪](#5-数据流完整追踪)
   - 5.1 [SDK API 调用拓扑](#51-sdk-api-调用拓扑)
   - 5.2 [响应式依赖图](#52-响应式依赖图)
   - 5.3 [事件驱动的刷新机制](#53-事件驱动的刷新机制)
6. [边界情况与错误处理](#6-边界情况与错误处理)
7. [设计亮点与取舍](#7-设计亮点与取舍)
8. [ZooKeeper 集成方案](#8-zookeeper-集成方案)
   - 8.1 [复用清单](#81-复用清单)
   - 8.2 [新增文件](#82-新增文件)
   - 8.3 [修改文件](#83-修改文件)
   - 8.4 [依赖变更](#84-依赖变更)
   - 8.5 [架构对比](#85-架构对比)
   - 8.6 [实施阶段建议](#86-实施阶段建议)
9. [总结](#9-总结)

---

## 1. 概述

`opencode-visual-cache`（v1.2.16）是一个 OpenCode TUI 侧边栏插件，实时展示当前 session 的 token 缓存命中率、token 明细、费用统计、按角色拆分的 token 分布估算、以及已加载的 Skill 列表。代码总计 **1331 行**（含安装脚本和构建脚本），核心逻辑集中在 `src/index.tsx`（**1185 行**，单文件），server 端为空壳。

插件完全通过 OpenCode SDK 提供的 `TuiPluginApi` 接口获取数据，不访问文件系统、不启动外部进程、不依赖 GPU/推理。它使用 **SolidJS** 响应式框架渲染终端 UI，支持中英双语、多币种费用换算、自适应主题色和跨 session 状态持久化。

本报告的目标是为 ZooKeeper 集成此插件的全部功能提供详尽的源码级分析，覆盖每个函数、数据流、边界情况和设计决策。

---

## 2. 项目结构

### 2.1 文件清单

```
opencode-visual-cache/
├── package.json            # npm 包定义（type: "module"）
├── tsconfig.json           # TSC 配置（生成 .d.ts，JSX→@opentui/solid）
├── build.tui.mjs           # esbuild 打包脚本（22 行）
├── install.mjs             # 安装脚本（114 行）
├── .github/workflows/
│   ├── ci.yml              # CI: npm ci → version → typecheck → build
│   └── publish.yml         # 发布: tag push → npm publish
├── src/
│   ├── index.tsx           # 全部逻辑（1185 行）
│   ├── server.ts           # 空壳（10 行）
│   └── _version.ts         # 自动生成（gitignored）
├── assets/                 # README 配图
├── README.md / README_EN.md
└── LICENSE (MIT)
```

### 2.2 技术栈与依赖

| 依赖 | 版本要求 | 用途 |
|------|---------|------|
| `@opencode-ai/plugin` | `>=1.14.0` | TuiPluginApi、TuiSlotPlugin 类型 |
| `@opencode-ai/sdk` | `>=1.14.0` | Message、Session、Part、Provider 类型 |
| `@opentui/core` | `>=0.2.0` | 终端 UI 核心库（box、text 等基础组件） |
| `@opentui/solid` | `>=0.2.0` | SolidJS → @opentui 的 JSX 运行时 |
| `solid-js` | `>=1.9.0` | 响应式框架（createSignal、createMemo、createEffect） |

所有依赖均为 `peerDependencies`——运行时由 OpenCode 的 TUI 进程提供，不打包进产物。

Build-time 依赖：
| 依赖 | 用途 |
|------|------|
| `esbuild` `^0.25.0` | JSX/TS 打包 |
| `esbuild-plugin-solid` `^0.5.0` | SolidJS 编译插件（universal 模式） |
| `typescript` `^5.8.0` | 类型检查 + `.d.ts` 生成 |

### 2.3 构建流程

两步构建：

**步骤 1：`tsc`** — 类型检查 + 生成声明文件
```bash
tsc                    # → dist/index.d.ts, dist/server.d.ts
```

**步骤 2：`esbuild`** — 打包 TUI 入口
```js
// build.tui.mjs
esbuild.build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/tui.js",
  format: "esm",
  platform: "node",
  bundle: true,
  external: ["@opencode-ai/*", "@opentui/*", "solid-js"],
  plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
})
```

**关键点**：
- `src/_version.ts` 在构建前自动生成（若不存在），写入 `PLUGIN_VERSION` 常量
- `external` 排除了所有 OpenCode/OpenTUI 和 SolidJS——这些由运行时注入
- SolidJS 编译为 `universal` 模式（`@opentui/solid` 作为 JSX runtime）

产物在 `package.json` 的 `exports` 中映射：
```json
{
  "./server": { "import": "./dist/server.js", "types": "./dist/server.d.ts" },
  "./tui":    { "import": "./dist/tui.js",    "config": { "enabled": true } }
}
```

---

## 3. 架构分析

### 3.1 双入口设计

OpenCode 插件支持同时导出 server 和 TUI 两个入口。`opencode-visual-cache` 利用了这一点：

```
package.json exports
├── "./server" → dist/server.js (空壳)
└── "./tui"    → dist/tui.js    (完整 TUI 插件)
```

- **Server 插件**（`src/server.ts`）：`Plugin` 类型，接收 `PluginInput`，返回空 `{}`。它存在的唯一目的是让 OpenCode 识别这是一个合法的插件包，避免配置解析错误。
- **TUI 插件**（`src/index.tsx`）：`TuiPlugin` 类型，接收 `TuiPluginApi`，注册侧边栏 slot 和斜杠命令。所有实际功能在此实现。

### 3.2 Server 入口

```typescript
// src/server.ts (10 行)
import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const server: Plugin = async () => ({})

const mod: PluginModule = {
  id: "opencode-visual-cache",
  server,
}

export default mod
```

完全空操作。值得注意的是 `PluginModule` 类型——这是 server 插件的导出协议，与 TUI 端的 `TuiPluginModule` 不同。

### 3.3 TUI 入口

```typescript
// src/index.tsx (尾部导出)
const mod: TuiPluginModule & { id: string } = {
  id: "opencode-visual-cache",
  tui,
}
export default mod
```

`tui` 函数（L970–1178）是入口，接收 `TuiPluginApi`，执行两项注册：

1. **注册侧边栏 slot**：`api.slots.register(createSidebarSlot(api, signals))` — `order: 55`
2. **注册斜杠命令**：`api.command?.register()` — 返回 6 个命令定义

`signals` 是插件全局共享的 SolidJS 信号集合，同时在侧边栏渲染和斜杠命令回调中使用，保证 UI 和数据配置的一致性。

---

## 4. 源码逐函数详解

### 4.1 文本工具

#### `charColumns(c: string): number` — 终端字符宽度计算（L34–51）

**用途**：终端中 CJK 字符占 2 列、emoji 占 2 列、ASCII 占 1 列。JavaScript 的 `padEnd`/`padStart` 按 `string.length` 计算（每个 UTF-16 code unit = 1），在混合文本中对齐必然错位。此函数是整个布局系统的基础。

**覆盖的 Unicode 范围**：

| 码点范围 | 类别 | 列数 | 说明 |
|----------|------|------|------|
| `0x00–0x1F` | C0 控制字符 | 0 | 不可见 |
| `0x20–0x7E` | ASCII 可打印 | 1 | 英文、数字、符号 |
| `0x7F–0x9F` | DEL + C1 控制 | 0 | 不可见 |
| `0x1100–0x115F` | Hangul Jamo | 2 | 韩文辅音/元音 |
| `0x2E80–0xA4CF` | CJK Radicals → Yi | 2 | 汉字主体 + 部首 + 彝文 |
| `0xAC00–0xD7A3` | Hangul 音节 | 2 | 现代韩文 |
| `0xF900–0xFAFF` | CJK 兼容表意文字 | 2 | 中日韩兼容 |
| `0xFE10–0xFE6F` | 竖排/兼容形式 | 2 | 中文竖排标点 |
| `0xFF01–0xFF60` | 全角 ASCII | 2 | 全角英文/数字/符号 |
| `0xFFE0–0xFFE6` | 全角货币符号 | 2 | ￠￡￥ |
| `0x1F300–0x1F64F` | 杂项符号/表情 | 2 | Emoji |
| `0x20000–0x3FFFD` | SIP/TIP 补充表意 | 2 | 扩展汉字 |
| 其他全部 | — | 1 | Latin-1、希腊、西里尔等 |

**设计评价**：这个覆盖范围比常见的 `wcwidth` 实现更全面——特别包含了 Emoji（0x1F300-0x1F64F）和 SIP 补充平面（0x20000+），这些都是标准 `wcwidth()` 可能遗漏的范围。缺点是没有使用 Unicode 官方的 East Asian Width 属性表，而是硬编码范围，可能存在少量的边界遗漏（如 `0xA4D0-0xA4FF` 的 Lisu 文）。

#### `visualWidth(s: string): number` (L53–55)

```typescript
function visualWidth(s: string): number {
  let w = 0; for (const c of s) w += charColumns(c); return w
}
```

逐字符求和。注意 `for...of` 遍历的是 **code point**（不是 code unit），所以 `"🀄".length === 2` 但 `for...of` 只会迭代一次。这确保了 emoji 和补充平面字符被正确计数。

#### `visualPadEnd(s: string, cols: number): string` (L57–59)

按视觉宽度右补齐空格。等价于标准的 `padEnd`，但基于 `visualWidth(s)` 而非 `s.length`。

#### `truncateVisual(s: string, maxCols: number): string` (L63–72)

按视觉宽度截断，末尾附加 U+2026（`…`，单字符省略号）。截断前预留 1 列给省略号。逐字符推进，当 `当前宽度 + 当前字符宽度 > maxCols - 1` 时截断。

**注意**：该函数目前未被广泛使用，仅在技能名称过长时 (`maxLabel` 计算，L931) 使用。

---

### 4.2 颜色处理

这是插件视觉设计的核心——"Morandi 风格自适应主题色"的实现。

#### `rgb(raw: unknown): { r, g, b } | null` (L153–175)

解析颜色为 0–255 的 RGB 分量。支持两种输入：

1. **字符串** `"#RRGGBB"` → 直接 `parseInt(slice, 16)` 取 R、G、B
2. **对象** `{ r, g, b }` → 检测 scale（若任意通道 > 1 则为 0-255，否则为 0-1 float），自动 `Math.round(v * scale)` 归一化到 0–255

#### `saturation(r, g, b): number` (L178–185)

标准 HSL 饱和度计算（0–1）：

```
max = max(r,g,b) / 255
min = min(r,g,b) / 255
delta = max - min

if delta == 0 → return 0
L = (max + min) / 2

if L <= 0.5 → delta / (max + min)
else        → delta / (2 - max - min)
```

#### `desaturateTo(raw: unknown, maxSat: number, fallback: string): string` (L191–224)

**核心算法**：将任意颜色降饱和到指定阈值以下。实现采用二分搜索灰混合比 α。

**参数**：
- `raw`：未知格式的颜色值（hex 字符串或 RGBA 对象）
- `maxSat`：目标最大饱和度（Morandi 风格 = 0.28，约 HSL 空间中 15%–30% 的饱和度范围）
- `fallback`：解析失败时的兜底颜色（hex 字符串）

**算法步骤**：

1. 调用 `rgb(raw)` 解析原始色 → 失败返回 `fallback`
2. 调用 `saturation(r,g,b)` → 若 `sat ≤ maxSat`，已是低饱和色，直接返回 hex
3. 计算 BT.601 luma（感知亮度）：
   ```
   luma = r*0.299 + g*0.587 + b*0.114
   ```
4. 二分搜索混合比 α ∈ [0,1]（12 次迭代，精度 1/4096）：
   ```
   mid = (lo + hi) / 2
   nr = r + (luma - r) * mid
   ng = g + (luma - g) * mid
   nb = b + (luma - b) * mid
   if saturation(nr, ng, nb) > maxSat → lo = mid  // 还是太鲜艳，再加灰
   else                              → hi = mid  // 够灰了，试试更少的灰
   ```
5. 用最终的 `hi`（确保不超标的 α）混合，返回 hex

**为什么用 BT.601 luma 而不是纯灰（r=g=b=128）？** 等亮度的灰色在感知上比原色暗（人眼对绿色更敏感）。BT.601 luma 保证了混合后的灰色与原色在**感知亮度**上一致，避免了明显的亮度跳变。

**为什么 12 次迭代？** 作者注释：RGB 通道 8 bit（256 阶），8 次迭代精度 1/256 理论上足够。12 次是"有意超预算"——额外精度几乎免费（12 次浮点运算 < 1μs），消除边界色带。

**配色常量**：

```typescript
const MAX_SAT = 0.28  // 莫兰迪色系饱和度天花板

const FALLBACK = {
  primary: "#8B9DAF",  // 灰蓝
  text:    "#C5C5BB",  // 暖灰
  muted:   "#7A7A72",  // 暗暖灰
  success: "#9CAF8B",  // 灰绿
  warning: "#C5B88D",  // 灰黄
  error:   "#B08A8A",  // 灰红
  border:  "#6B6B63",  // 深灰
}
```

---

### 4.3 数值格式化

#### `progressBar(percent: number, width: number): string` (L251–256)

Unicode 块字符进度条：

```typescript
const filled = Math.round((clamped / 100) * width)
return "█".repeat(filled) + "░".repeat(width - filled)
```

使用 U+2588（FULL BLOCK）和 U+2591（LIGHT SHADE）。

#### `fmt(n: number): string` (L258–262)

大数缩写，英文 locale：

| 范围 | 格式 | 示例 |
|------|------|------|
| ≥ 1,000,000 | `(n/1M).toFixed(1) + "M"` | `1.2M` |
| ≥ 10,000 | `(n/1K).toFixed(1) + "K"` | `15.3K` |
| < 10,000 | `toLocaleString("en-US")` | `9,876` |

**为什么 10K 阈值？** 4 位以下的数字不需要缩写，逗号分隔即可。1,000–9,999 显示如 `"1,234"` 比 `"1.2K"` 更精确自然。

#### `num(v: unknown): number` (L264–266)

安全数字提取：是有限数 → 返回，否则 → 0。广泛用于容错（防止 SDK 返回 undefined/null tokens）。

#### `fmtCost(n, symbol = "$", rate = 1): string` (L268–273)

费用格式化（美元或换算后货币）：

```typescript
const v = n * rate
if (v >= 1)    return symbol + v.toFixed(2)   // $1.23
if (v >= 0.01) return symbol + v.toFixed(3)   // $0.012
                return symbol + v.toFixed(4)   // $0.0012
```

精度随数值减小而增加，保证极小费用仍可辨识。

---

### 4.4 Token 估算引擎

#### `estimateTokens(text: string): number` (L282–310)

这是整个插件中对 ZooKeeper 最有移植价值的函数。它实现了基于字符类别的 BPE token 估算，精度远超简单的 `text.length / 4`。

**步骤 1：字符分类计数**

遍历每个字符，按 Unicode 码点分入 `ascii` 或 `cjk`：

| CJK 范围 | 包含 |
|----------|------|
| `0x4E00–0x9FFF` | CJK 统一表意文字（常用汉字） |
| `0x3040–0x30FF` | 平假名 + 片假名 |
| `0xAC00–0xD7A3` | Hangul 音节 |
| `0x1100–0x11FF` | Hangul Jamo |
| `0x2E80–0x2EFF` | CJK 部首补充 |

其他全部归入 `ascii` 计数。

**步骤 2：文本类型检测**

```typescript
const trimmed = text.trimStart()
const strippedFence = trimmed.replace(/^\x60{3}\w*\s*\n?/, "") // 去除 markdown code fence

// JSON 检测：以 { 或 [ 开头，且 body 含 "key": 模式
const jsonLike = (strippedFence.startsWith("{") || strippedFence.startsWith("["))
  && /"[^"]+"\s*:/.test(text)

// 代码检测：非 JSON 且包含代码关键字
const codeLike = !jsonLike
  && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)
```

**步骤 3：比率选择**

```typescript
const asciiPerToken = jsonLike ? 3.5   // JSON: 每个标点自成 token，密集
                    : codeLike ? 3.5   // 代码: 关键字 + 操作符自成 token
                    : 4                 // 自然语言: ≈4 ASCII 字符 / token

return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.0))
```

**准确性依据**（作者注释）：
- cl100k_base / o200k_base 对 JSON 和代码的实际测量为 3.5–4.0 ASCII chars/token
- 旧版（2.0/2.5 比率）匹配的是 minified JS 的极端情况，系统性高估 token 数
- CJK 字符 ≈ 1 token/char——这是所有主流 tokenizer 的共同行为

**与 ZooKeeper `metrics.ts` 的 `estimateMessageHeuristic` 对比**：

| 维度 | ZooKeeper 当前 | visual-cache |
|------|---------------|-------------|
| 算法 | `text.length / 4` | 按字符类别分 ASCII/CJK |
| JSON 感知 | 无 | 检测 `{` + `"key":` → 3.5 |
| 代码感知 | 无 | 检测关键字 → 3.5 |
| CJK 处理 | 无（全按 /4） | 1.0 token/char |
| Markdown fence 处理 | 无 | 去除后检测内容类型 |
| 最坏情况 | 纯 JSON 高估 ~14% | 综合误差通常 <10% |

**两者误差示例**（10K 字符的 JSON）：
- ZooKeeper: `10000 / 4 = 2500` tokens（实际约 `10000 / 3.5 = 2857`，低估 ~12.5%）
- visual-cache: `10000 / 3.5 = 2857` tokens（接近真实值）

---

### 4.5 面板组件与信号体系

#### `TokenCachePanel` 组件 (L371–946)

组件维护三层信号体系：

**第 1 层：UI 折叠/展开状态（局部 `createSignal`，7 个）**

| 信号 | 默认值 | 控制对象 |
|------|--------|---------|
| `panelWidth` | 26 | 面板宽度（从 box 的 `onSizeChange` 测量） |
| `open` | true | 主面板展开/折叠 |
| `detailOpen` | true | 明细（读/写/未命中/输出/节省）折叠 |
| `modelOpen` | true | 模型（费用/提供商/模型名/单价）折叠 |
| `distOpen` | false | 分布（按角色 token 拆分）折叠 |
| `skillsOpen` | true | 已加载技能列表折叠 |

**第 2 层：用户配置信号（从 `PanelSignals` 注入，9 个）**

在插件入口 `tui()` 中创建，通过 props 传入面板，同时暴露给斜杠命令回调：

| 信号 | 默认值 | 说明 |
|------|--------|------|
| `currencySymbol` | `"$"` | 货币符号（`/cache-currency` 修改） |
| `exchangeRate` | 1 | 自定义汇率（`/cache-rate` 修改） |
| `langZH` | 自动检测 | 中/英文（`/cache-lang` 修改） |
| `sectionDetail` | true | 明细区块可见 |
| `sectionModel` | true | 模型区块可见 |
| `sectionDist` | true | 分布区块可见 |
| `sectionSkills` | true | 技能区块可见 |
| `borderVisible` | true | 边框可见 |

**第 3 层：数据计算信号（5 个）**

| 信号 | 类型 | 驱动方式 |
|------|------|---------|
| `dataSignal` | `object` (完整快照) | `createEffect` 中 `setDataSignal()` 写入 |
| `refreshTick` | `number` (计数器) | 事件监听 `setRefreshTick(v => v+1)` |
| `partVersion` | `number` (计数器) | `bumpPartVersion` (100ms debounce) |
| `lastDist` | `TokenDist` | 最后一次成功的分布快照 |
| `lastHasDist` | `boolean` | 是否有有效分布数据 |

**`dataSignal` 完整结构**：

```typescript
{
  hitRate: number,          // 最新一轮命中率 (0–100)
  read: number,             // 缓存读 token 数
  write: number,            // 缓存写 token 数
  freshInput: number,       // 未命中 token 数
  output: number,           // 输出 token 数
  cost: number,             // session 累计费用 (USD)
  saved: number,            // 缓存命中节省的费用 (USD)
  model: string,            // 模型名（取 modelID 最后一段）
  inputRate: number,        // 输入单价 ($/M tok)
  cacheReadRate: number,    // 缓存读单价 ($/M tok)
  cacheWriteRate: number,   // 缓存写单价 ($/M tok)
  hasPricing: boolean,      // 是否有定价数据
  hasData: boolean,         // 是否有任何统计数据
  trend: number,            // 命中率变化趋势 (百分比差值)
  hasTrendData: boolean,    // 是否有趋势数据（需要至少两轮）
  providerName: string,     // providerID
  sessionHitRate: number,   // 累计命中率 (read / (input + read) * 100)
  dist: TokenDist,          // token 按角色分布
  hasDistData: boolean,     // 是否有分布数据
  skills: { name: string; tokens: number }[],  // 已加载技能
  hasSkills: boolean,       // 是否有技能数据
}
```

---

### 4.6 数据采集与计算

#### 主计算 Effect (L427–561)

这是整个插件的**数据引擎**，被 SolidJS 的 `createEffect` 包裹，依赖如下：

```
sessionId 变化 ──┐
refreshTick ──────┼──→ createEffect 触发 ──→ setDataSignal() ──→ UI 重渲染
partVersion ──────┘
```

`refreshTick` 和 `partVersion` 由事件监听器驱动（详见 §5.3）。

---

##### 阶段 1：聚合 Token 统计 (L433–467)

```typescript
const msgs = api.state.session.messages(sid) as Message[]
const session = api.state.session.get(sid)
```

**优先使用 Session 聚合字段**——这些是数据库级的精确值，不受 `messages()` 的 sync 层 `limit:100` 截断影响：

```typescript
let input  = session?.tokens?.input ?? 0    // 输入 token 总数
let read   = session?.tokens?.cache?.read ?? 0    // 缓存读 token 总数
let write  = session?.tokens?.cache?.write ?? 0   // 缓存写 token 总数
let output = session?.tokens?.output ?? 0   // 输出 token 总数
let cost   = session?.cost ?? 0            // 累计费用
```

**降级逻辑**（`fallbackTokens / fallbackCost / fallbackModel` 标志位）：若 Session 聚合字段为 null/undefined（旧版本 SDK），则遍历每条 `AssistantMessage` 累加 `tokens` 和 `cost`。

同时记录最近两轮的命中率用于计算趋势：

```typescript
for (const msg of msgs) {
  if (msg.role !== "assistant") continue
  const t = msg.tokens; if (!t) continue
  const mit = num(t.input) + num(t.cache?.read)   // 本轮总输入
  const mrt = num(t.cache?.read)                    // 本轮缓存读
  if (mit > 0) {
    prevMsgHitRate = lastMsgHitRate                 // 上上轮
    lastMsgHitRate = (mrt / mit) * 100              // 上一轮（有数据的最新轮）
  }
}
```

**关键指标**：
- `hitRate = lastMsgHitRate`（最新有数据的一轮）
- `sessionHitRate = read / (input + read) * 100`（累计，跨所有轮次）
- `trend = lastMsgHitRate - prevMsgHitRate`（最新 vs 次新）

---

##### 阶段 2：费用计算 (L468–475)

遍历 `api.state.provider` 数组匹配当前模型定价：

```typescript
for (const provider of api.state.provider) {
  if (provider.id !== pid) continue
  const model = provider.models[mid]
  if (!model?.cost) continue
  inputRate = num(model.cost.input)
  cacheReadRate = num(model.cost.cache?.read)
  cacheWriteRate = num(model.cost.cache?.write)
  if (inputRate > cacheReadRate)
    saved = (read * (inputRate - cacheReadRate)) / 1_000_000
  break
}
```

节省金额 = 缓存读量 × (输入单价 - 缓存读单价) / 1,000,000。只有当缓存读单价低于输入单价时才计算节省（否则无节省意义）。

---

##### 阶段 3：Token 分布计算 (L483–551)

包裹在 `untrack()` 中，**避免与 `api.state.part()` 和 `api.state.config` 形成循环响应式依赖**。

```typescript
const distData = untrack(() => {
  let dist: TokenDist = { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0,
                           output: 0, apiOutput: 0, apiInput: 0, stepCost: 0 }
  // ...
})
```

**3.1 System 分类**

```typescript
const cfg = api.state.config
const agentName = String(session?.agent ?? cfg?.default_agent ?? "build")
const agentCfg = cfg?.agent?.[agentName]
const sysPrompt = agentCfg?.prompt ?? ""
if (sysPrompt) dist.system = estimateTokens(sysPrompt)
```

取 agent 配置的 `prompt` 字段（这是用户自定义的 system prompt 部分），用 `estimateTokens()` 估算。

遍历用户消息的 `UserMessage.system` 字段（每条消息的动态 system prompt），同样 `estimateTokens()` 后累加。

注意：这里只估算了 agent 配置 prompt + 用户消息 system。OpenCode 运行时附加的环境信息、工具 schema 等**不在** agent 的 `prompt` 字段中，因此无法估算——这是分布中"总计"（精确 API 值）与分项估算之和存在差距的主要原因（README 中有明确说明）。

**3.2 User 分类**

遍历每条 user 消息的 parts（通过 `api.state.part(msg.id)` 获取）：

```typescript
for (const p of parts) {
  if (p.type === "text" && !p.synthetic && !p.ignored)
    dist.user += estimateTokens(p.text)
  else if (p.type === "file")
    dist.user += estimateTokens(fp.source.text.value)
}
```

排除 `synthetic`（系统生成）和 `ignored`（标记忽略）的文本 parts。

**3.3 Agent 分类**

遍历 assistant 消息的 parts：
- `type === "reasoning"` → `estimateTokens(p.text)`
- `type === "subtask"` → `estimateTokens(sub.prompt || sub.description || "")`

**3.4 Tool Call 分类**

```typescript
if (p.type === "tool") {
  // 取 tool 的输入参数
  let rawInput = ""
  try { rawInput = tp.state.raw ?? (tp.state.input != null ? JSON.stringify(tp.state.input) : "") } catch {}
  if (rawInput) dist.toolCall += estimateTokens(rawInput)

  // 取 tool 的输出结果
  if (tp.state.status === "completed") {
    if (c.output) dist.toolResult += estimateTokens(c.output)
  } else if (tp.state.status === "error") {
    if (e.error) dist.toolResult += estimateTokens(e.error)
  }
}
```

`state.raw` 是未序列化的原始输入文本（优先），fallback 到 `JSON.stringify(state.input)`。

**3.5 精确 API 值**

倒序找到最后一条有完整 token 数据的 assistant 消息：

```typescript
for (let i = msgs.length - 1; i >= 0; i--) {
  if (msgs[i].role !== "assistant") continue
  const t = msgs[i].tokens
  if (t && (t.input > 0 || (t.cache?.read ?? 0) > 0)) {
    lastAssMsg = msgs[i]
    break
  }
}
dist.apiInput  = num(lastAssMsg.tokens.input) + num(lastAssMsg.tokens.cache?.read)
dist.apiOutput = num(lastAssMsg.tokens.output)
```

注意条件判断：需要 `input > 0` **或** `cache.read > 0`。在纯缓存命中的情况下（input = 0, cache.read > 0），条件仍然成立——这是正确的。

**3.6 技能检测**

在 tool parts 遍历中附加的逻辑：

```typescript
if (tp.tool === "skill" && tp.state.status === "completed") {
  // 方法 1：从 state.metadata.name 取
  let name = tp.state.metadata?.name
  // 方法 2：从 output 文本匹配 Markdown heading
  if (typeof name !== "string") {
    const m = typeof tp.state.output === "string"
      ? tp.state.output.match(/^#{1,2}\s*Skill:\s*(.+)/m)
      : null
    if (m) name = m[1].trim()
  }
  if (typeof name === "string") {
    const tokens = typeof tp.state.output === "string"
      ? estimateTokens(tp.state.output) : 0
    const existing = loadedSkills.get(name)
    if (!existing || existing.tokens < tokens) {
      loadedSkills.set(name, { name, tokens })
    }
  }
}
```

**两种提取策略**：
1. SDK 元数据优先（`state.metadata.name`）——这是最可靠的
2. 正则降级（`/^#{1,2}\s*Skill:\s*(.+)/m`）——当 SDK 元数据不可用时

**去重策略**：同名技能取 token 占用最大的那条记录（通常最后一次加载包含完整内容）。

**3.7 分布缓存**

```typescript
const finalDist = hasDistData ? dist : lastDist()
const finalHasDist = hasDistData || lastHasDist()
```

当 `api.state.part()` 由于 session 切换未就绪时，回退到 `lastDist`（上一次成功计算的结果）。这避免了切换 session 时 token 分布区块短暂消失。

---

##### 阶段 4：写入 dataSignal (L553–560)

```typescript
setDataSignal({
  hitRate, read, write, freshInput: input, output, cost, saved, model,
  inputRate, cacheReadRate, cacheWriteRate, hasPricing,
  hasData: read > 0 || write > 0 || input > 0 || output > 0 || cost > 0,
  trend, hasTrendData, providerName, sessionHitRate,
  dist: distData.finalDist, hasDistData: distData.finalHasDist,
  skills: distData.skills, hasSkills: distData.skills.length > 0,
})
```

`hasData` 的判断条件确保只要有**任何**统计数据（读/写/输入/输出/费用），就显示面板内容而非"等待数据..."的占位。

---

### 4.7 TUI 渲染逻辑

#### 响应式 Computed Values

`createMemo` 用于缓存计算开销大的派生值：

| Memo | 用途 | 依赖 |
|------|------|------|
| `t()` | 翻译对象（中/英文） | `langZH()` |
| `pal()` | 7 种语义色（经去饱和） | `props.theme` |
| `hitColor()` | 命中率颜色（绿/橙/红） | `data().hitRate` + `pal()` |
| `gutter()` | 水平内边距（0 或 6） | `borderVisible()` |
| `barW()` | 进度条宽度 | `panelWidth()` + `data()` + `t()` |
| `bar()` | 进度条字符串 | `data().hitRate` + `barW()` |
| `pct()` | 格式化百分比字符串 | `data().hitRate` |
| `sep()` | 分隔线（`─` 重复） | `panelWidth()` + `gutter()` |

#### `justify(label, value, unit)` 对齐算法 (L724–729)

```typescript
const justify = (label: string, value: string, unit = ""): string => {
  const gauge = panelWidth() - gutter()
  const used = visualWidth(label) + visualWidth(value)
             + (unit ? visualWidth(unit) + UNIT_GAP : 0)
  const gap = Math.max(1, gauge - used)
  return label + " ".repeat(gap) + value + (unit ? " " + unit : "")
}
```

**关键**：gap 计算基于 `visualWidth()`，而非 `string.length`。所有标签、数值、单位的视觉宽度相加，面板可用宽度减去之和 = 填充空格数。最小 1 个空格。

#### JSX 渲染树

整个 UI 是一棵嵌套的 `<Show>` 条件渲染树。从外到内：

```
<box border={borderVisible} padding={0|2} ref={boxEl} onSizeChange={...}>
├── 标题行 (onMouseUp → toggle open)
│   ├── ▼/▶ 箭头
│   ├── 标题文字 + 版本号 (展开态)
│   └── 命中率 + 趋势 (折叠态，压缩到一行)
│
├── <Show when={open()}>
│   └── <Show when={hasData} fallback="等待缓存数据...">
│       ├── 分隔线 ────────
│       ├── 命中率行: Hit [████░░░] 85.2% ↑2.3%
│       ├── 累计命中率: Total Hit: ... 76.8%
│       │
│       ├── <Show when={sectionDetail()}>
│       │   ├── 明细标题 (onMouseUp → toggle detailOpen)
│       │   └── <Show when={detailOpen()}>
│       │       ├── 缓存读:  1.2K tok  (if read > 0)
│       │       ├── 缓存写:  345 tok   (if write > 0)
│       │       ├── 未命中:  8.9K tok
│       │       ├── 输出:    2.1K tok
│       │       └── 累计节省: ~$0.034 (if saved > 0)
│       │
│       ├── <Show when={sectionModel()}>
│       │   ├── 模型标题 (onMouseUp → toggle modelOpen)
│       │   └── <Show when={modelOpen()}>
│       │       ├── 费用: $0.156
│       │       ├── 提供商: anthropic  (if providerName)
│       │       ├── 模型: claude-sonnet-4-20250514
│       │       └── 定价 (if hasPricing)
│       │           ├── 输入: $3.00/M tok
│       │           ├── 缓存: $0.30/M tok
│       │           └── 写入: $3.75/M tok
│       │
│       ├── <Show when={sectionDist() && hasDistData}>
│       │   ├── 分布标题 (onMouseUp → toggle distOpen, 默认关闭)
│       │   └── <Show when={distOpen()}>
│       │       ├── 系统提示:   2.3K tok  (if dist.system > 0)
│       │       ├── 用户:       1.5K tok  (if dist.user > 0)
│       │       ├── Agent 指令: 4.2K tok  (if dist.agent > 0)
│       │       ├── Tool 调用:  3.1K tok  (if dist.toolCall > 0)
│       │       ├── Tool 结果:  5.8K tok  (if dist.toolResult > 0)
│       │       └── 总计:      18.5K tok (精确 API 值，始终显示)
│       │
│       └── <Show when={sectionSkills() && hasSkills}>
│           ├── 技能标题 (onMouseUp → toggle skillsOpen, 显示技能数)
│           └── <Show when={skillsOpen()}>
│               └── 技能列表 (forEach)
│                   └── 技能名 (truncated) ... 估算 token 数 tok
```

#### 动态宽度测量

面板宽度通过 `<box>` 的 `onSizeChange` 事件动态测量：

```typescript
<box ref={boxEl} onSizeChange={() => {
  const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
  setPanelWidth((prev) => (prev === w ? prev : w))
}}>
```

`MIN_PANEL_WIDTH = 20`，`DEFAULT_PANEL_WIDTH = 26`。宽度变化时触发所有依赖 `panelWidth()` 的 `createMemo` 重新计算——进度条宽度、分隔线长度、对齐 gap 全部自动适配。

边框可见性变化时（`/cache-section border` toggle），额外触发一次强制 resync（L715–721），因为 `onSizeChange` 不一定在每次 remount 时可靠触发。

#### 折叠态标题行布局

折叠态标题需要在一行内显示：箭头 + 标题 + 命中率 + 趋势。剩余空间计算（L757–772）：

```typescript
// 有趋势数据时
" ".repeat(max(1, panelWidth - gutter - HEADER_PREFIX - visualWidth(title) - visualWidth(pct + " " + t.hitFolded + " " + trendLabel(trend))))
```

所有视觉宽度精确计算，剩余空间填入空格实现右对齐。这保证了在可变宽度终端中折叠态的标题行始终对齐到右侧。

---

### 4.8 配置持久化

使用 `api.kv`（key-value 存储，跨 session 持久化）存储所有用户偏好：

```typescript
const KV_PREFIX = "cache_panel"
```

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `open` | `boolean` | `false` | 主面板折叠（注意默认 false，与信号默认 true 不同——这是作者 bug：信号默认 true 但 kv 回退是 false，第一次加载面板会短暂展开后折叠） |
| `detail` | `boolean` | `true` | 明细折叠 |
| `model` | `boolean` | `true` | 模型折叠 |
| `dist` | `boolean` | `false` | 分布折叠 |
| `skills` | `boolean` | `true` | 技能折叠 |
| `currency` | `string` | — | 货币符号 |
| `rate` | `number` | — | 汇率 |
| `section.detail` | `boolean` | `true` | 明细可见 |
| `section.model` | `boolean` | `true` | 模型可见 |
| `section.dist` | `boolean` | `true` | 分布可见 |
| `section.skills` | `boolean` | `true` | 技能可见 |
| `border` | `boolean` | `true` | 边框可见 |
| `lang` | `string` | — | 语言选择 |
| `dist_snapshot` | `TokenDist` | — | 分布快照（跨 remount 恢复） |

**分布式快照的持久化**（L569–577）：

```typescript
createEffect(() => {
  const d = data()
  if (d.hasDistData) {
    setLastDist({ ...d.dist })
    setLastHasDist(true)
    try { props.api.kv.set(`${KV_PREFIX}.dist_snapshot`, { ...d.dist }) } catch {}
  }
})
```

快照的用途是**双重保险**：
1. `lastDist` signal — 在组件存活期内（同 session 内 part() 短暂不可用时回退）
2. `api.kv` 持久化 — 跨组件 remount（切换 session 时组件被销毁重建，signal 丢失，从 kv 恢复）

#### `onMount` 恢复流程 (L588–670)

```
1. 重置 panelWidth = DEFAULT_PANEL_WIDTH
2. 同步恢复折叠状态:
   - open, detailOpen, modelOpen, distOpen, skillsOpen
3. 恢复用户配置:
   - kv.ready ? doRestore() : 轮询 (10ms, 最多 100 次 ≈ 1s)
4. doRestore():
   - 恢复 currency, rate
   - 恢复 section 可见性
   - 恢复 borderVisible
   - 恢复 langZH (语言)
   - 恢复 dist_snapshot (分布缓存)
   - 重新测量面板宽度
5. 注册事件监听:
   - message.part.updated → bumpPartVersion
   - message.updated     → bumpPartVersion
   - session.updated     → setRefreshTick
6. 初始触发一次 setRefreshTick
```

**轮询逻辑的精妙之处**：`api.kv.ready` 可能在模块重载后尚未初始化（作者提到 Linux 单线程模式下的 session 切换风暴）。轮询机制避免了用户看到默认值闪烁后又立即替换为持久化值的糟糕体验。

---

### 4.9 斜杠命令系统

通过 `api.command?.register()` 注册 6 个斜杠命令，所有命令通过 `api.kv` 持久化配置，**即时生效不需要重启**。

#### 1. `/cache-currency` — 货币选择

```typescript
// 渲染 DialogSelect，6 选项 (USD/CNY/EUR/JPY/GBP/KRW)
onSelect: (opt) => {
  const sym = CURRENCIES[opt.value] ?? "$"
  const defRate = DEFAULT_RATES[opt.value] ?? 1
  api.kv.set("cache_panel.currency", sym)
  api.kv.set("cache_panel.rate", defRate)
  signals.setCurrencySymbol(sym)
  signals.setExchangeRate(defRate)
  api.ui.toast({ message: `Currency: ${opt.value} (${sym}), rate: ${defRate}` })
}
```

选择货币后自动填入内置默认汇率。用户可通过 `/cache-rate` 覆盖。

#### 2. `/cache-rate` — 汇率调整

```typescript
// 渲染 DialogPrompt，默认值为当前汇率
onConfirm: (val) => {
  const n = parseFloat(val)
  if (n > 0) {
    api.kv.set("cache_panel.rate", n)
    signals.setExchangeRate(n)
  }
}
```

校验 `n > 0`，防止负汇率或 0 汇率导致显示异常。

#### 3. `/cache-section` — 区块与边框可见性

```typescript
// 渲染 DialogSelect，5 选项，每个显示当前 ON/OFF 状态
options: [
  { title: `Token Detail    [${detailOn ? "ON" : "OFF"}]`,  value: "detail" },
  { title: `Model & Pricing [${modelOn  ? "ON" : "OFF"}]`,  value: "model" },
  { title: `Token Dist.     [${distOn   ? "ON" : "OFF"}]`,  value: "dist" },
  { title: `Loaded Skills   [${skillsOn ? "ON" : "OFF"}]`,  value: "skills" },
  { title: `Panel Border    [${borderOn ? "ON" : "OFF"}]`,  value: "border" },
]
```

每次选择 toggle 对应的 kv 值和 signal。

#### 4. `/cache-config` — 查看当前配置

```typescript
// 通过 toast 展示当前配置（duration: 8000ms）
api.ui.toast({ title: "Cache Panel Config", message: "Currency: $ | Rate: 1 | ...", duration: 8000 })
```

只读命令，不修改任何值。

#### 5. `/cache-lang` — 语言切换

```typescript
// 渲染 DialogSelect，2 选项，当前语言打勾
options: [
  { title: `中文    ${cur ? "✓" : ""}`, value: "zh" },
  { title: `English ${cur ? "" : "✓"}`, value: "en" },
]
```

选中后写入 kv + 更新 `langZH` signal。UI 即时切换，无重启。

#### 6. `/cache-debug-skills` — 技能检测调试

```typescript
// 不渲染 dialog，直接遍历当前 session 的所有 tool parts
const msgs = api.state.session.messages(sid)
// 统计每种 tool 的调用次数
// 对 tool === "skill" 的 parts，dump:
//   - state.metadata
//   - root.metadata
//   - state.title
//   - state.output[:80]
// 通过 toast 展示 (duration: 15000ms)
```

这是开发调试命令。当技能检测失效时，可通过此命令诊断：查看 tool parts 的实际元数据结构，判断 SDK 是否剥离了 metadata，以及正则匹配 output 是否有效。

---

## 5. 数据流完整追踪

### 5.1 SDK API 调用拓扑

插件使用了 `TuiPluginApi` 的以下接口：

```
TuiPluginApi
├── state.session.messages(sid)     → Message[]          (消息列表)
├── state.session.get(sid)          → Session             (聚合字段)
├── state.part(msgId)               → Part[]             (消息片段详情)
├── state.config                    → Config              (全局配置)
├── state.provider                  → Provider[]          (AI 提供商 + 定价)
│
├── slots.register(slot)            → void               (注册侧边栏 slot)
│
├── command?.register(factory)      → void               (注册斜杠命令)
├── ui.toast(opts)                  → void               (弹出 toast)
├── ui.DialogSelect                 → JSX.Element        (选择对话框)
├── ui.DialogPrompt                 → JSX.Element        (输入对话框)
│
├── event.on("message.part.updated")→ unsub              (part 更新事件)
├── event.on("message.updated")     → unsub              (消息更新事件)
├── event.on("session.updated")     → unsub              (session 更新事件)
│
├── kv.ready                        → boolean            (kv 是否就绪)
├── kv.get(key, fallback?)          → T                  (读取持久化值)
├── kv.set(key, value)              → void               (写入持久化值)
│
└── route.current                   → { name, params }   (当前路由)
```

**数据依赖关系（箭头表示数据流向）**：

```
api.state.session.messages(sid) ──→ 消息遍历 ──→ hitRate, read, write, trend
api.state.session.get(sid)      ──→ 聚合字段 ──→ input, output, cost (优先)
api.state.part(msgId) × N       ──→ parts 遍历 ──→ TokenDist (按角色)
api.state.config                ──→ agent prompt ──→ dist.system
api.state.provider              ──→ 定价匹配 ──→ saved, inputRate
api.event (3 种事件)            ──→ 刷新触发 ──→ 重新计算全部
api.kv                          ──→ 持久化 ──→ 折叠/配置恢复
```

### 5.2 响应式依赖图

SolidJS 的响应式系统自动追踪依赖，变化沿图传播：

```
sessionId ─────────────────────┐
refreshTick (事件驱动) ────────┤
partVersion (debounced) ───────┤
                               ├──→ [createEffect]
api.state.session.messages ────┤     │
api.state.session.get ─────────┤     │
api.state.provider ────────────┤     │
api.state.config ──────────────┤     │
api.state.part() × N ──────────┘     │
                                     ▼
                              setDataSignal(data)
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                 ▼
              pal()             hitColor()         barW()
              (theme)           (hitRate)          (width+hitRate)
                    │                │                 │
                    └────────────────┼─────────────────┘
                                     ▼
                              JSX 重渲染
```

**关键**：`createMemo` 作为缓存层——只有在其直接依赖变化时才重新计算。例如 `pal()` 只在主题色变化时重算，`hitColor()` 只在 `data().hitRate` 和 `pal()` 变化时重算。

### 5.3 事件驱动的刷新机制

```typescript
// onMount 中注册 (L660–668)
let partTimer: ReturnType<typeof setTimeout> | undefined
const bumpPartVersion = () => {
  clearTimeout(partTimer)
  partTimer = setTimeout(() => setPartVersion((v) => v + 1), 100)
}

const unsubPart    = api.event.on("message.part.updated", bumpPartVersion)
const unsubMsg     = api.event.on("message.updated",      bumpPartVersion)
const unsubSession = api.event.on("session.updated",      () => setRefreshTick(v => v + 1))
```

**两种刷新策略**：

| 触发器 | 动作 | Debounce | 原因 |
|--------|------|----------|------|
| `message.part.updated` | `bumpPartVersion` → `setPartVersion(+1)` | 100ms | streaming 期间高频（数百次/秒），需防抖 |
| `message.updated` | 同上 | 100ms | 同上 |
| `session.updated` | `setRefreshTick(+1)` | 无 | session 切换低频事件，应立即响应 |

**Debounce 实现**：`clearTimeout(partTimer)` + `setTimeout(..., 100)` — 每次新事件到来重置定时器，只有持续 100ms 无新事件时才触发计算。这有效避免了 streaming 期间的 N× 重算开销。

**清除**：`onCleanup(() => { clearTimeout(partTimer); unsubPart(); unsubMsg(); unsubSession() })` — 组件销毁时清理定时器和事件订阅，防止内存泄漏。

---

## 6. 边界情况与错误处理

| 场景 | 处理代码 | 策略 |
|------|---------|------|
| `session.tokens` 为空（旧 SDK） | L448–467 | `fallbackTokens` flag → 降级逐消息累加 |
| `session.cost` 为空（旧 SDK） | L461–463 | `fallbackCost` flag → 降级逐消息累加 |
| `modelID` / `providerID` 为空 | L464–466 | 从最后一条 assistant 消息字段提取 |
| `api.state.part()` 调用抛异常 | L498, L506 | `try/catch` → 静默跳过该消息 |
| `api.state.config` 抛异常 | L487 | `try/catch` → 整段分布计算跳过 |
| `api.kv.ready === false` | L640–655 | 轮询 10ms×100 次 → 超时后降级执行 |
| `api.kv.get()` 抛异常 | L629–631 | `try/catch` → signal 保持默认值 |
| session 切换时 part() 未就绪 | L409–413, L569–577 | `lastDist` signal 缓存 + kv 快照双重回退 |
| 空消息列表（新 session） | L777–784 | `hasData: false` → 渲染"等待缓存数据..." |
| streaming 中高频 part 更新 | L660–663 | 100ms debounce（`clearTimeout` + `setTimeout`） |
| 面板宽度测量失败 | L743–744 | `boxEl.width ?? 0` → fallback `DEFAULT_PANEL_WIDTH` |
| 颜色解析失败（主题色缺失） | L677 | fallback 到 `FALLBACK` 常量 |
| 汇率输入非正数 | L1038 | `if (n > 0)` 校验，不更新 |
| `/cache-debug-skills` 非 session 内调用 | L1145 | toast warning 提示，不执行 |
| CJK/Emoji 混合文本对齐错位 | 全局使用 `visualWidth()` | 所有 justify/padEnd 基于视觉宽度 |
| 进度条极端值（0% 或 100%） | L252 | `Math.max(0, Math.min(100, percent))` clamp |
| 无定价数据时费用显示 | L477 | `hasPricing: false` → 隐藏定价行 |
| 无缓存命中时节省显示 | L831–836 | `if (data().saved > 0)` 条件渲染 |
| 仅缓存命中无新输入（input=0） | L541 | 条件 `t.input > 0 || t.cache?.read > 0` 涵盖此情况 |

**一个已知 bug**：`onMount` 中 `setOpen` 的 kv fallback 值为 `false`（L595），但 signal 默认值为 `true`（L378）。这意味着首次加载时面板会短暂（1 frame）展开再折叠，直到 kv 恢复完成。

---

## 7. 设计亮点与取舍

### 亮点

1. **单文件全逻辑（1185 行）**：在无状态管理库、无路由、无测试框架的约束下，用 SolidJS 自带的响应式系统实现了完整的数据采集→计算→渲染→持久化管线。代码自包含，无隐式依赖。

2. **Session 字段优先 + 消息遍历降级**：双路径 token 统计策略既利用了新版 SDK 的聚合字段（精确且不受 sync limit 截断），又保证了旧 SDK 的兼容性。这是实际工程中典型的"渐进增强"模式。

3. **`untrack()` 打破循环依赖**：分布计算需要 `api.state.part()`，而 `part()` 可能被其他 SolidJS 上下文追踪。`untrack()` 显式隔离了这段计算的响应式依赖，避免了难以调试的死锁。这是 SolidJS 高级用法的典型场景。

4. **Debounce + 双重缓存防闪烁**：part 更新的 100ms debounce 防止 streaming 期间的高频重算；`lastDist` signal + kv 分布式快照的双重缓存防止 session 切换时的 UI 闪烁。两者叠加实现了"始终有数据显示"的 seamless 体验。

5. **`estimateTokens()` 的类型感知**：JSON/代码/自然语言分类 + CJK 特殊处理，比简单的 `length/4` 精确得多。字符级 CJK 范围覆盖比很多 `wcwidth` 实现更全面（包含 Emoji 和 SIP）。

6. **Morandi 去饱和算法的数学精度**：12 次二分迭代 + BT.601 感知亮度锚点的设计，在 <1μs 内完成了专业级的颜色空间变换。作者对此的注释展示了扎实的图形学功底。

### 值得注意的取舍

1. **无测试**：CI 只做 `typecheck + build`，没有任何单元测试或集成测试。所有逻辑的验证依赖人工测试。对于核心计算函数（`estimateTokens`、`charColumns`），这是明显的质量风险。

2. **CJK 宽度硬编码**：`charColumns` 使用硬编码 Unicode 范围而非标准的 East Asian Width 属性表。优点是零依赖（不需要 `Intl.Segmenter` 或 `@pkgjs/wcwidth`），缺点是可能有边界遗漏。

3. **分布估算与精确值的固有差距**：作者在 README 中坦诚说明，分布分项之和通常小于"总计"（精确 API 值），差距来自 OpenCode 运行时注入的系统提示部分（环境信息、工具 schema 等），这些不在 agent 配置 prompt 中。这是一个无法在插件层面解决的已知局限。

4. **单文件架构的扩展性**：1185 行单文件在功能继续增长时会变得难以维护。目前的功能集已接近单文件的合理上限。

---

## 8. ZooKeeper 集成方案

### 8.1 复用清单

以下代码可以从 `opencode-visual-cache` 直接移植或仅需少量适配：

| 源函数/代码 | 目标模块 | 适配工作量 | 说明 |
|------------|---------|-----------|------|
| `charColumns()` | `src/core/text-utils.ts` | 低 | 纯函数，零依赖 |
| `visualWidth()` | 同上 | 低 | 纯函数 |
| `truncateVisual()` | 同上 | 低 | 纯函数 |
| `estimateTokens()` | `src/core/metrics.ts` (替换现有) | 低 | 纯函数，需适配 import path |
| `rgb()`, `saturation()`, `desaturateTo()` | `src/core/color.ts` | 低 | 纯函数，颜色常量需提取 |
| `progressBar()`, `fmt()`, `fmtCost()`, `num()` | `src/core/format.ts` | 低 | 纯函数 |
| 缓存统计计算 (L433–480) | `src/core/cache-stats.ts` | 中 | 需抽象为纯函数，接收 messages + session + provider 参数 |
| Token 分布计算 (L483–551) | `src/core/token-dist.ts` | 中 | 需参数化 part 访问器（TUI 用 `api.state.part`，server 用 hook output） |
| 费用节省计算 (L468–475) | `src/core/pricing.ts` | 低 | 接收 provider[] + token 量 → 返回 { saved, rates } |
| 技能检测 (L514–531) | `src/core/skills-usage.ts` | 低 | 接收 parts → 返回技能列表 |
| 中/英文翻译常量 (L86–148) | `src/tui/lang.ts` | 低 | 直接移植 |
| TUI 面板组件 (L371–946) | `src/tui/cache-panel.tsx` | 中 | 拆分为组件 + 适配 ZooKeeper 配置 |
| 斜杠命令 (L996–1177) | `src/tui/commands.ts` | 低 | 拆分独立函数 |
| 插件入口 (L970–993) | `src/tui/plugin.ts` | 中 | 适配 ZooKeeper 的信号和配置体系 |

### 8.2 新增文件

```
src/
├── core/
│   ├── text-utils.ts       # charColumns, visualWidth, truncateVisual, visualPadEnd
│   ├── color.ts            # rgb, saturation, desaturateTo, progressBar
│   ├── format.ts           # fmt, num, fmtCost
│   ├── cache-stats.ts      # 缓存统计纯函数
│   ├── token-dist.ts       # token 分布纯函数
│   ├── pricing.ts          # 费用/节省计算
│   └── skills-usage.ts     # 技能检测
├── tui/
│   ├── lang.ts             # 中/英文翻译常量
│   ├── cache-panel.tsx     # TUI 面板组件 (SolidJS)
│   ├── commands.ts         # 斜杠命令注册函数
│   └── plugin.ts           # TUI 插件入口 (tui() 函数)
```

### 8.3 修改文件

| 文件 | 改动 |
|------|------|
| `src/index.ts` | 增加 `tui` 导出（`export default { id: "zookeeper", server: zookeeper, tui: zookeeperTui }`） |
| `src/core/metrics.ts` | `estimateMessageHeuristic` 改用移植后的 `estimateTokens()` |
| `package.json` | 增加 `exports`、`@opentui/solid`、`solid-js`、`esbuild`、`esbuild-plugin-solid` |
| `build.tui.mjs` | 新建 esbuild 构建脚本（参照 visual-cache 的 `build.tui.mjs`） |
| `check.sh` | 需要对 `src/tui/` 目录做额外的 lint/format（Biome 需配置支持 JSX） |

### 8.4 依赖变更

```diff
// package.json
 {
   "type": "module",
+  "exports": {
+    "./server": {
+      "import": "./dist/server.js",
+      "types": "./dist/server.d.ts"
+    },
+    "./tui": {
+      "import": "./dist/tui.js",
+      "config": { "enabled": true }
+    }
+  },
   "scripts": {
     "typecheck": "tsc --noEmit",
+    "build:tui": "node build.tui.mjs",
     ...
   },
   "devDependencies": {
     "@biomejs/biome": "latest",
+    "@opencode-ai/plugin": "^1.14.0",
+    "@opencode-ai/sdk": "^1.14.0",
+    "@opentui/core": ">=0.2.0",
+    "@opentui/solid": ">=0.2.0",
     "bun-types": "^1.3.14",
+    "esbuild": "^0.25.0",
+    "esbuild-plugin-solid": "^0.5.0",
+    "solid-js": ">=1.9.0",
     "typescript": "^6.0.3"
   }
 }
```

### 8.5 架构对比

| 维度 | visual-cache | ZooKeeper 集成后 |
|------|-------------|-----------------|
| 入口点 | `tui` + 空 `server` | `server`（已有 hook 管线）+ `tui`（新增侧边栏） |
| 核心逻辑位置 | `src/index.tsx` 单文件 1185 行 | 拆分到 `src/core/`（~7 个模块）+ `src/tui/`（~4 个模块） |
| 计算函数 | 内联在 SolidJS effect 中 | 提取为纯函数（可被 server hook 和 TUI 面板共用） |
| TUI 框架 | SolidJS + @opentui/solid | 同上（ZooKeeper 之前无 TUI，此为全新引入） |
| 数据获取 | `TuiPluginApi` 直接调用 | TUI 端同 visual-cache；Server 端通过 hook 参数注入 |
| Part 访问 | `api.state.part(msgId)` | TUI 端同；Server 端从 `messages.transform` hook 的 `parts` 数组获取 |
| 配置 | `api.kv`（key-value） | `api.kv` + `config.toml`（双层配置） |

**关键适配点：Part 访问的抽象**

Server 端（`messages.transform` hook）和 TUI 端（`TuiPluginApi`）获取 part 数据的方式不同。`token-dist.ts` 需要设计一个 `PartAccessor` 接口：

```typescript
// src/core/token-dist.ts
interface PartAccessor {
  getParts(msgId: string): Part[]
}

// TUI 端适配
const tuiPartAccessor: PartAccessor = {
  getParts: (msgId) => api.state.part(msgId)
}

// Server 端适配
const serverPartAccessor: PartAccessor = {
  getParts: (msgId) => {
    // 从 messages.transform hook 的 output.messages[].parts 中查找
  }
}

function computeTokenDist(
  messages: Message[],
  session: Session,
  config: Config,
  partAccessor: PartAccessor
): TokenDist { ... }
```

### 8.6 实施阶段建议

**Phase 1：移植 core 纯函数**（~300 行，无架构风险）
- 创建 `src/core/text-utils.ts`、`src/core/color.ts`、`src/core/format.ts`
- 升级 `src/core/metrics.ts` 的 `estimateMessageHeuristic` → 使用新的 `estimateTokens()`
- 验证：运行 `./test.sh` 确保现有测试不受影响

**Phase 2：提取统计计算逻辑**（~500 行，纯函数）
- 创建 `src/core/cache-stats.ts`、`src/core/token-dist.ts`、`src/core/pricing.ts`、`src/core/skills-usage.ts`
- 所有模块设计为纯函数，接收数据参数，返回计算结果
- 验证：编写单元测试覆盖核心计算函数

**Phase 3：构建 TUI 基础设施**（~200 行，工程配置）
- 新增 `@opentui/solid`、`solid-js`、`esbuild`、`esbuild-plugin-solid` 依赖
- 创建 `build.tui.mjs`、更新 `package.json` exports
- 创建 `src/tui/lang.ts`、`src/tui/plugin.ts`
- 验证：`typecheck` + `build:tui` 通过

**Phase 4：实现 TUI 面板**（~600 行，UX）
- 实现 `src/tui/cache-panel.tsx`（调用 Phase 2 的 core 函数 + `TuiPluginApi`）
- 实现 `src/tui/commands.ts`（斜杠命令）
- 集成到 `src/index.ts` 的导出
- 验证：端到端测试（启动 OpenCode，侧边栏可见，数据正确）

**Phase 5：Server 端集成**（~200 行，数据管线）
- 在 `experimental.chat.messages.transform` 或 `event` hook 中调用 Phase 2 的 core 函数
- 将缓存命中率、token 分布记录到 logger
- 为未来的动态上下文裁剪提供数据基础
- 验证：检查日志输出，确认数据正确性

---

## 9. 总结

`opencode-visual-cache` 是一个设计精良的 OpenCode TUI 插件。它在 **1185 行单文件** 中实现了：

1. **精确的 Token 估算引擎**（JSON/代码/自然语言/CJK 分类感知）
2. **完整的缓存统计管线**（命中率、趋势、累计、费用节省）
3. **按角色的 Token 分布估算**（system/user/agent/tool call/tool result + 精确 API 值）
4. **技能使用检测**（双策略提取 + 去重）
5. **自适应视觉设计**（Morandi 风格颜色去饱和、CJK 宽度感知布局、动态进度条）
6. **完善的持久化系统**（kv 存储 + 双重缓存防闪烁）
7. **用户可配置的斜杠命令**（6 个命令，即时生效）

从 ZooKeeper 的角度，直接可复用的核心资产是 **`estimateTokens()`**（token 估算）和 **缓存统计 + 分布计算逻辑**（提取为纯函数后）。TUI 面板的引入为 ZooKeeper 增加了可视化维度，使其从纯 hook 插件升级为同时具备 server 端数据采集和 TUI 端可视反馈的完整解决方案，为未来的动态上下文裁剪提供了数据基础和用户感知窗口。

**许可证**：MIT — 可以自由移植代码，需保留版权声明 `Copyright (c) 2026 Hotakus`。
