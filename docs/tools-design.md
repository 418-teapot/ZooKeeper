# ZooKeeper CLI 工具设计文档

**版本:** 1.0
**日期:** 2026-06-15

---

## 目录

1. [概览](#1-概览)
2. [zoo-find — 数据查找](#2-zoo-find--数据查找)
3. [zoo-inspect — 检视分析](#3-zoo-inspect--检视分析)
4. [zoo-trace — 编排链路追踪](#4-zoo-trace--编排链路追踪)
5. [zoo-log — 实时监控](#5-zoo-log--实时监控)
6. [与 DCP 脚本的对应关系](#6-与-dcp-脚本的对应关系)
7. [关键设计原则](#7-关键设计原则)

---

## 1. 概览

ZooKeeper CLI 工具集包含 **4 个独立脚本**，覆盖从会话搜索、行为分析、链路追踪到实时监控的完整调试流程。每个工具对应一个或一组 DCP（Dynamic Context Pruning）参考脚本的功能，但采用统一的 CLI 风格和输出规范。

### 工具总览

| 工具 | 职责 | 主要数据源 | 会话范围 |
|------|------|-----------|---------|
| `zoo-find` | 会话搜索 + 消息检索 | SQLite (`opencode.db`) | 支持 `--all` 展开子会话 |
| `zoo-inspect` | 插件行为统计 + 聚合分析 + 缓存影响评估 | ZK JSONL | 默认仅主会话，`--all` 展开子会话 |
| `zoo-trace` | 多源编排追踪 + 分步 token 时间线 | ZK JSONL + OpenCode 日志 + SQLite | 默认仅主会话，`--child` 展开子会话 |
| `zoo-log` | ZK JSONL 实时监控 + 过滤回放 | ZK JSONL | 按 session ID 定位单个文件 |

### 统一 CLI 约定

- **`--json`** — 所有工具支持 JSON 结构化输出（管道友好）
- **`--db <path>`** — 自定义 SQLite 路径（默认 `~/.local/share/opencode/opencode.db`）
- **`--no-color`** — 禁用 ANSI 颜色（输出重定向时自动检测）
- **退出码：** 成功 0，参数错误 1，数据未找到 2

---

## 2. zoo-find — 数据查找

**独立脚本**，管道友好。用于搜索 OpenCode SQLite 数据库中的会话和消息。

**数据源：** `opencode.db`（SQLite），表 `session`（标题/时间） + `message`（消息内容/角色）。

### 2.1 子命令与参数

| 子命令 / 模式 | 参数 | 类型 | 默认值 | 说明 |
|--------------|------|------|--------|------|
| **默认模式** | `<keyword>` | string | — | 按标题模糊搜索会话 |
| `--all` | — | flag | false | 列出全部主会话（按最近使用排序） |
| `--exact` | `<keyword>` | string | — | 精确匹配标题 |
| `--message` | `<msg-id> [<msg-id2> ...]` | string[] | — | 按消息 ID 检索完整 JSON |
| `--message` + `--session` | `<msg-id>` + `<session-id>` | string + string | — | 指定会话 ID 加速消息检索 |
| `--message` + `--scan` | `<msg-id>` + `<N>` | string + int | 200 | 无 session 时扫描最近 N 个会话 |

**全局参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--json` | flag | false | JSON 结构化输出 |
| `--db <path>` | string | `~/.local/share/opencode/opencode.db` | SQLite 数据库路径 |
| `--session-list-limit <N>` | int | 5000 | 扫描最大会话数 |

### 2.2 行为规则

1. **单匹配仅输出 ID：** 当搜索只命中一个会话时，直接输出 session ID（无格式、无换行后缀），适合 `$(zoo-find ...)` 管道用法。
2. **多匹配输出表格：** 当命中多个会话时，输出格式化表格（含标题、时间、ID）。
3. **`--all`** 列出所有 `parent_id IS NULL` 的主会话（即顶层会话），按 `time_updated` 降序排列。
4. **`--message`** 返回消息的完整 JSON 表示（含 role、content、parts、token 计数等）。

### 2.3 输出示例

#### 默认模式 — 单匹配

```bash
$ zoo-find "bug fix"
ses_abc123def456
```

管道用法：

```bash
$ zoo-inspect stats $(zoo-find "bug fix")
```

#### 默认模式 — 多匹配

```bash
$ zoo-find "deploy"
```

输出：

```
Found 3 sessions matching "deploy":

  Title                          Session ID               Updated
  ─────────────────────────────  ───────────────────────  ─────────────────
  Deploy to production v2.1.0    ses_abc123def456         2026-06-15 14:23
  Rollback deploy — hotfix       ses_def789ghi012         2026-06-14 09:12
  Deploy staging env             ses_ghi345jkl678         2026-06-13 18:45
```

#### --all

```bash
$ zoo-find --all
```

```
All main sessions (most recent first):

  Title                          Agent       Session ID               Updated
  ─────────────────────────────  ──────────  ───────────────────────  ─────────────────
  Deploy to production v2.1.0    deploy      ses_abc123def456         2026-06-15 14:23
  Implement auth middleware      build       ses_mno789pqr012         2026-06-15 11:00
  Rollback deploy — hotfix       deploy      ses_def789ghi012         2026-06-14 09:12
  Refactor DB layer              architect   ses_stu345vwx678         2026-06-13 22:30
```

#### --message

```bash
$ zoo-find --message msg_abc123 --session ses_abc123def456
```

```json
{
  "id": "msg_abc123",
  "session_id": "ses_abc123def456",
  "role": "assistant",
  "agent": "build",
  "timestamp": "2026-06-15T14:23:00.000Z",
  "tokens": 284,
  "parts": [
    {
      "type": "text",
      "text": "I've fixed the issue by updating the authentication middleware..."
    }
  ]
}
```

#### --message + --scan

```bash
$ zoo-find --message msg_abc123 --scan 50
```

无 session 提示时扫描最近 50 个会话，找到即返回。输出格式同上（JSON）。

#### JSON 输出

```bash
$ zoo-find --json "deploy"
```

```json
{
  "keyword": "deploy",
  "matches": 3,
  "sessions": [
    {
      "id": "ses_abc123def456",
      "title": "Deploy to production v2.1.0",
      "agent": "deploy",
      "updated": "2026-06-15T14:23:00Z"
    }
  ]
}
```

---

## 3. zoo-inspect — 检视分析

对 ZK JSONL 日志进行单会话行为分析 + 多会话聚合统计 + 缓存影响评估。

**数据源：** `~/.zoo/log/opencode-<session-id>.log`（ZK JSONL）。

### 3.1 stats — 统计

#### 单会话模式

```bash
zoo-inspect stats <session_id>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID（完整或前缀） |
| `--tokens` | flag | false | 只显示 token 区块 |
| `--hooks` | flag | false | 只显示 hook 区块 |
| `--json` | flag | false | JSON 输出 |
| `--db <path>` | string | `~/.local/share/opencode/opencode.db` | SQLite 路径（用于 token 计数） |

示例输出：

```
Stats for session: ses_abc123def456
File: ~/.zoo/log/opencode-ses_abc123def456.log
Total events: 142
Time span: 2026-06-15 14:23:00 → 2026-06-15 14:45:12 (0h 22m 12s)
Active session IDs: ses_abc123def456

Level Distribution
┌─────────┬───────┐
│ Level   │ Count │
├─────────┼───────┤
│ info    │ 112   │
│ debug   │ 22    │
│ warn    │ 6     │
│ error   │ 2     │
└─────────┴───────┘

Hook Breakdown
┌──────────────────────────────┬───────┬──────────────────────────────┐
│ Hook                         │ Count │ Events                       │
├──────────────────────────────┼───────┼──────────────────────────────┤
│ focus-reminder               │ 38    │ injected:38                  │
│ context-metrics              │ 30    │ context_measured:30          │
│ task-prompt                  │ 28    │ validated:26, invalid:2      │
│ post-task-nudge              │ 22    │ completed:18, deferred:4     │
│ json-error-nudge             │ 10    │ triggered:8, skipped:2       │
│ direct-work-nudge            │ 8     │ triggered:8                  │
└──────────────────────────────┴───────┴──────────────────────────────┘

Token Summary
┌──────────────────┬───────────┐
│ Metric           │ Value     │
├──────────────────┼───────────┤
│ Total input      │ 124,580   │
│ Total output     │ 48,234    │
│ Avg input/turn   │ 4,449     │
│ Avg output/turn  │ 1,722     │
│ Cache hit rate   │ 67.3%     │
│ Est. cost        │ $0.87     │
└──────────────────┴───────────┘
```

#### 多会话模式

```bash
zoo-inspect stats --sessions <N>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--sessions <N>` | int | — | 分析最近 N 个主会话 |
| `--all` | flag | false | 包含子会话（默认仅主会话 `parent_id IS NULL`） |
| `--tokens` | flag | false | 只显示 token 区块 |
| `--hooks` | flag | false | 只显示 hook 区块 |
| `--json` | flag | false | JSON 输出 |
| `--db <path>` | string | `~/.local/share/opencode/opencode.db` | SQLite 路径 |

示例输出（多会话 token 汇总）：

```
Cross-session Token Summary (last 5 sessions)

  Session ID                 Input     Output    Hit Rate  Cost      Hook Events
  ─────────────────────────  ─────────  ─────────  ────────  ────────  ───────────
  ses_abc123def456           124,580    48,234     67.3%     $0.87     142
  ses_def789ghi012           89,200     32,100     72.1%     $0.55     98
  ses_ghi345jkl678           210,450    82,300     58.9%     $1.42     215
  ses_mno789pqr012           56,780     21,450     81.2%     $0.38     72
  ses_stu345vwx678           178,340    67,890     63.4%     $1.12     185
  ─────────────────────────  ─────────  ─────────  ────────  ────────  ───────────
  Total                      659,350    251,974     67.9%     $4.34     712
```

### 3.2 timeline — 事件时间线

```bash
zoo-inspect timeline <session_id>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID |
| `--all` | flag | false | 不限制行数（默认最多 30 行） |

数据来源：ZK JSONL 文件。

示例输出：

```
Timeline: ses_abc123def456

  Time       Level   Hook                Event              Details
  ─────────  ───────  ──────────────────  ─────────────────  ─────────────────────────
  14:23:00   info    context-metrics      context_measured   build: 4,580 tokens (12 msgs)
  14:23:01   info    focus-reminder       injected           agent=build
  14:23:05   info    task-prompt          validated          warnings=0, errors=0
  14:23:10   info    context-metrics      context_measured   build: 6,210 tokens (16 msgs)
  14:23:15   info    focus-reminder       injected           agent=build
  14:24:00   info    direct-work-nudge    triggered          tool=edit
  14:24:02   info    post-task-nudge      completed          todo=done, nudge=general
  14:24:05   warn    task-prompt          invalid            errors=1
  14:24:10   info    context-metrics      context_measured   build: 8,430 tokens (21 msgs)
  ...
```

### 3.3 impact — 缓存影响分析

评估 ZK hook 触发对 LLM 缓存命中率的影响。核心问题：hook 干预是否导致缓存失效/恢复。

```bash
zoo-inspect impact [--sessions <N>]
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--sessions <N>` | int | — | 分析最近 N 个会话 |
| `--session <ID>` | string | — | 分析单个指定会话 |
| `--all` | flag | false | 包含子会话 |
| `--hook <name>` | string | — | 只分析指定 hook 类型（如 `focus-reminder`） |
| `--window <N>` | int | 6 | hook 前后观察窗口步数 |
| `--cost` | flag | false | 显示成本估算（Anthropic 定价） |
| `--verbose` | flag | false | 逐事件明细 |
| `--json` | flag | false | JSON 输出 |
| `--db <path>` | string | `~/.local/share/opencode/opencode.db` | SQLite 路径 |

数据来源：ZK JSONL（事件时间戳 + `context-metrics` token 数据）+ OpenCode 日志（缓存命中率）。

#### 输出区块

##### 区块 1：按 Hook 聚合表

```
Impact Analysis (last 5 sessions, window=6 steps)

Hook-by-Hook Aggregation
┌──────────────────────┬──────────┬─────────────┬────────────┬───────────┐
│ Hook                 │ Triggers │ Hit% Before │ Hit% After │ Δ         │
├──────────────────────┼──────────┼─────────────┼────────────┼───────────┤
│ focus-reminder       │ 156      │ 72.3%       │ 64.8%      │ -7.5%     │
│ task-prompt          │ 112      │ 71.5%       │ 68.9%      │ -2.6%     │
│ direct-work-nudge    │ 42       │ 74.1%       │ 70.2%      │ -3.9%     │
│ json-error-nudge     │ 18       │ 69.4%       │ 62.1%      │ -7.3%     │
│ post-task-nudge      │ 89       │ 75.2%       │ 72.8%      │ -2.4%     │
│ context-metrics      │ 150      │ 73.0%       │ 73.0%      │ 0.0%      │
└──────────────────────┴──────────┴─────────────┴────────────┴───────────┘
```

##### 区块 2：缓存恢复曲线

```
Cache Recovery Curve (relative to hook trigger)
┌──────────┬──────────┬──────────┬────────┬────────┬──────────┐
│ Distance │ Samples  │ Avg Hit% │ Min    │ Max    │ Histogram│
├──────────┼──────────┼──────────┼────────┼────────┼──────────┤
│ -6       │ 98       │ 71.2%    │ 58.3%  │ 84.5%  │ ███████▏ │
│ -5       │ 104      │ 71.8%    │ 59.1%  │ 85.2%  │ ███████▏ │
│ -4       │ 110      │ 72.5%    │ 60.0%  │ 86.0%  │ ███████▍ │
│ -3       │ 115      │ 72.9%    │ 61.2%  │ 86.8%  │ ███████▎ │
│ -2       │ 118      │ 73.4%    │ 62.0%  │ 87.5%  │ ███████▍ │
│ -1       │ 120      │ 73.8%    │ 62.5%  │ 88.0%  │ ███████▍ │
│  0       │ 122      │ 68.2%    │ 45.0%  │ 82.0%  │ ██████▉ ←│
│ +1       │ 118      │ 65.4%    │ 42.0%  │ 80.5%  │ ██████▌  │
│ +2       │ 112      │ 67.1%    │ 44.5%  │ 81.2%  │ ██████▋  │
│ +3       │ 105      │ 69.8%    │ 48.0%  │ 83.0%  │ ██████▉  │
│ +4       │ 92       │ 71.0%    │ 50.2%  │ 84.1%  │ ███████▏ │
│ +5       │ 78       │ 72.2%    │ 52.0%  │ 85.5%  │ ███████▎ │
│ +6       │ 65       │ 73.0%    │ 53.8%  │ 86.2%  │ ███████▍ │
└──────────┴──────────┴──────────┴────────┴────────┴──────────┘
↪ 缓存在 hook 触发后第 4 步恢复到 80%+
```

柱状图刻度：`█` = 10 个百分点，每 1/8 子格（▉▊▋▌▍▎▏）= 1.25 个百分点。

##### 区块 3：总体成本影响（`--cost` 时显示）

```
Cost Impact (Anthropic Claude pricing: $3.00/M input, $15.00/M output)
┌────────────────────────────────┬──────────────┐
│ Metric                         │ Value        │
├────────────────────────────────┼──────────────┤
│ Total input tokens observed    │ 659,350      │
│ Total output tokens observed   │ 251,974      │
│ Baseline cost (at avg 73.0%)   │ $2.84        │
│ Actual cost (at actual 68.2%)  │ $3.12        │
│ Estimated overhead             │ $0.28 (9.9%) │
└────────────────────────────────┴──────────────┘
```

##### 区块 4：逐事件明细（`--verbose` 时显示）

```
Verbose Event Detail (first 5 of 42 focus-reminder events)
┌──────────┬──────────────────────────┬─────────┬──────────┬──────────┬───────────────┐
│ #        │ Timestamp                │ Hook    │ Before % │ After %  │ Delta         │
├──────────┼──────────────────────────┼─────────┼──────────┼──────────┼───────────────┤
│ 1        │ 14:23:01                 │ focus   │ 74.2%    │ 68.1%    │ -6.1%         │
│ 2        │ 14:25:30                 │ focus   │ 75.0%    │ 66.5%    │ -8.5%         │
│ 3        │ 14:28:15                 │ focus   │ 73.8%    │ 65.9%    │ -7.9%         │
│ 4        │ 14:31:00                 │ focus   │ 72.1%    │ 63.4%    │ -8.7%         │
│ 5        │ 14:33:45                 │ focus   │ 71.0%    │ 62.8%    │ -8.2%         │
└──────────┴──────────────────────────┴─────────┴──────────┴──────────┴───────────────┘
```

---

## 4. zoo-trace — 编排链路追踪

多源合并追踪——将 ZK JSONL、OpenCode 日志（key=value 格式）和 SQLite 消息数据合并为统一时间线。

**数据源：**
- `~/.zoo/log/opencode-<session-id>.log`（ZK JSONL）
- `~/.local/share/opencode/log/opencode.log`（OpenCode 宿主日志）
- `~/.local/share/opencode/opencode.db`（SQLite 消息数据）

### 4.1 show — 操作摘要 / 详细时间线

```bash
zoo-trace show <session_id>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID |
| `-v` / `--verbose` | flag | false | 完整逐事件时间线（默认压缩摘要） |
| `-s` / `--subsessions` | flag | false | 包含子会话 |

默认输出（压缩摘要）：

```
Session: auth-middleware (ses_abc123def456…)
Agent: build    Model: claude-sonnet-4     Duration: 22m 12s

14:23:00  —                    zoo        │ context [build]: 4,580 tokens (12 msgs)
14:23:01  —                    zoo        │ focus-reminder/injected agent=build
14:23:05  claude-sonnet-4      🤖 LLM     │
14:23:30  claude-sonnet-4      ▶ 读       │ read: src/auth/middleware.ts
14:23:35  claude-sonnet-4      ▶ 读       │ grep: "auth" src/**/*.ts
14:24:00  claude-sonnet-4      ◀ 写       │ edit: src/auth/middleware.ts
14:24:02  —                    zoo        │ post-task-nudge/completed todo=done
14:24:05  claude-sonnet-4      🤖 LLM     │
14:24:30  claude-sonnet-4      ▶ 读       │ read: src/auth/middleware.ts
14:25:00  claude-sonnet-4      ◀ 写       │ write: src/auth/middleware.test.ts
...

总计: 142 events | 12 LLM | tools: 28(读14/写6/执行2/编排1/其他5) | 38 zoo
```

`-v` 模式输出完整逐事件时间线（含 session 创建、loop step、permission 等），使用 rich Tree/Table 渲染。

### 4.2 steps — 分步 Token 时间线

```bash
zoo-trace steps <session_id>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID |
| `--hook-overlays` | flag | true | 在 step 行上标注 ZK hook 事件（默认开） |
| `--no-hook-overlays` | flag | false | 禁用 hook 标注 |
| `--child` | flag | false | BFS 展开子会话 |
| `--min-cache-drop <N>` | int | — | 只显示缓存下降超过 N tokens 的 step |
| `--json` | flag | false | JSON 输出 |
| `--db <path>` | string | `~/.local/share/opencode/opencode.db` | SQLite 路径 |
| `--no-color` | flag | false | 禁用颜色 |

**输出列：** Step / Cache Read / Δ Cache / Input / Output / Cache% / Duration / Hook Events / Tools / Reason

**颜色规则：**
- Δ Cache > 0：绿色（缓存增长）
- Δ Cache < 0：红色（缓存下降）
- Cache% ≥ 80%：绿色
- Cache% ≥ 50%：黄色
- Cache% < 50%：红色

示例输出：

```
Step-by-Step Token Timeline: ses_abc123def456

Step  │ Cache Read  │ Δ Cache    │ Input   │ Output  │ Cache%   │ Duration │ Hook Events         │ Tools          │ Reason
 ──────┼─────────────┼────────────┼─────────┼─────────┼──────────┼──────────┼─────────────────────┼────────────────┼──────────────────────
 1     │      0      │ +12,450    │ 4,580   │ 1,200   │   0% ░░░ │  8.2s    │ context, focus       │                │ session start
 2     │ 12,450      │  +3,200    │ 1,630   │ 2,100   │  88% ████▍│ 12.5s   │ focus                │ read           │
 3     │ 15,650      │  -8,400    │ 8,400   │ 1,800   │  46% ██▍ │ 15.1s    │ direct-work-nudge    │ edit           │ edit triggered nudge
 4     │  7,250      │  +2,100    │ 2,100   │ 1,500   │  77% ███▊│ 10.3s    │ context, task        │ read, grep     │
 5     │  9,350      │  +1,800    │ 1,800   │ 2,400   │  84% ████▎│ 14.8s   │ focus                │ read, edit     │
 6     │ 11,150      │  -5,200    │ 5,200   │   900   │  53% ██▋ │  9.2s    │ post-task-nudge      │ write          │ deferred todo
 7     │  5,950      │  +6,500    │ 6,500   │ 1,600   │  48% ██▍ │ 18.0s    │ context, focus       │ bash           │
 8     │ 12,450      │  +3,100    │ 3,100   │ 2,000   │  80% ████ │ 11.5s   │                      │ read           │
 ──────┼─────────────┼────────────┼─────────┼─────────┼──────────┼──────────┼─────────────────────┼────────────────┴──────────────────────
 Total │             │ +15,550    │ 33,310  │ 13,500  │ 65.5%    │ 99.6s    │ 7 hook events       │ 9 tool calls
```

`Cache%` 列后的柱状图：`█` = 20 个百分点，每 1/8 子格（▉▊▋▌▍▎▏）= 2.5 个百分点，`░` = 0 占位符。

底部汇总行包含：Total Input / Output / Cache Δ / Avg Hit Rate / Total Duration。

### 4.3 tokens — 消息级 Token 分布

```bash
zoo-trace tokens <session_id>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID |
| `--json` | flag | false | JSON 输出 |
| `--db <path>` | string | `~/.local/share/opencode/opencode.db` | SQLite 路径 |
| `--no-color` | flag | false | 禁用颜色 |

**宽屏模式（终端宽度 ≥ 110 列）与紧凑模式（< 110 列）自动切换。**

示例输出（宽屏模式，≥ 110 列）：

```
Message Token Distribution: ses_abc123def456

  #  │ Role      │ Tokens │ Size                   │ Segments │ ID              │ Preview
 ────┼───────────┼────────┼────────────────────────┼──────────┼─────────────────┼─────────────────────────────
  1  │ user      │  1,240 │ ████████▋  24.5%       │ 3        │ msg_001         │ Can you fix the auth bug in
  2  │ assistant │  2,100 │ ██████████████  41.5%  │ 5        │ msg_002         │ I've identified the issue...
  3  │ user      │    320 │ ██▏  6.3%              │ 1        │ msg_003         │ What about the test file?
  4  │ assistant │  1,450 │ █████████▉  28.6%      │ 4        │ msg_004         │ Let me add unit tests for
  5  │ tool_use  │    180 │ █▎  3.6%               │ 1        │ msg_005         │ read: src/auth/middleware.ts
  6  │ tool_result│  2,800 │ ███████████████████▌ 55.3% │ 2        │ msg_006         │ (file contents...)
  7  │ user      │     85 │ ░  1.7%               │ 1        │ msg_007         │ Let's also handle edge case
  8  │ assistant │  1,020 │ ██████▋  20.1%         │ 3        │ msg_008         │ Added edge case handling...
 ────┼───────────┼────────┼────────────────────────┼──────────┼─────────────────┴─────────────────────────────
      Total: 5,060 tokens (user: 1,645 / assistant: 4,570 / tool: 2,980)
      Largest messages: msg_006 (2,800), msg_002 (2,100), msg_004 (1,450)
      Avg: 632 tokens/msg | Max: 2,800 | Empty parts: 0
```

紧凑模式（< 110 列）：

```
Message Token Distribution: ses_abc123def456

  #  │ Role      │ Tokens │ Size            │ ID
 ────┼───────────┼────────┼─────────────────┼────────────
  1  │ user      │  1,240 │ ████████▋       │ msg_001
  2  │ assistant │  2,100 │ ██████████████  │ msg_002
  3  │ user      │    320 │ ██▏             │ msg_003
  4  │ assistant │  1,450 │ █████████▉      │ msg_004
  5  │ tool_use  │    180 │ █▎              │ msg_005
  6  │ tool_result│  2,800 │ ████████████████│ msg_006
  7  │ user      │     85 │ ░               │ msg_007
  8  │ assistant │  1,020 │ ██████▋         │ msg_008
 ────┼───────────┼────────┼─────────────────┼────────────
      Total: 5,060 tokens
      Largest: msg_006 (2,800), msg_002 (2,100), msg_004 (1,450)
```

`Size` 列的 `█` 柱状图宽度按当前消息占总 token 比例缩放，`░` 标识 < 2%。

底部包含 Largest messages 列表 + Total / Max / Empty 统计。

### 4.4 export — 时间线导出

```bash
zoo-trace export <session_id> <format>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID |
| `format` | `jaeger` / `chrome` | — | 导出格式 |
| `-s` / `--subsessions` | flag | false | 包含子会话 |
| `-o` / `--output` | string | `trace.json` | 输出文件路径 |

导出 Jaeger JSON 格式：

```bash
zoo-trace export ses_abc123def456 jaeger -o trace-jaeger.json
```

导出 Chrome Trace Event 格式：

```bash
zoo-trace export ses_abc123def456 chrome -o trace-chrome.json
```

Jaeger JSON 包含 spans 和 processes，可直接导入 Jaeger UI 查看。Chrome Trace Event 可通过 `chrome://tracing` 加载。

---

## 5. zoo-log — 实时监控

对 ZK JSONL 日志进行实时 tail 和历史回放过滤。基于 jq 管道实现，轻量高效。

**数据源：** `~/.zoo/log/opencode-<session-id>.log`（ZK JSONL 文件）。

### 5.1 show — 历史回放

```bash
zoo-log show <session_id>
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID（完整或前缀） |
| `--hook <name>` | string | — | 按 hook 名过滤 |
| `--level <level>` | string | — | 按级别过滤（`info`, `warn`, `error`, `debug`） |
| `--event <event>` | string | — | 按事件名过滤 |
| `--raw` | flag | false | 跳过 jq 过滤，输出原始行 |

### 5.2 tail — 实时追踪

```bash
zoo-log tail [session_id]
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | string | — | 会话 ID（完整或前缀；可省略通过自动检测） |
| `--hook <name>` | string | — | 按 hook 名过滤 |
| `--level <level>` | string | — | 按级别过滤 |
| `--event <event>` | string | — | 按事件名过滤 |
| `--raw` | flag | false | 跳过 jq 和 grep 预过滤，输出原始行 |

> **注：** `zoo-log` / `zoo-inspect` / `zoo-trace` **不再提供 `list` 子命令**——会话搜索统一由 `zoo-find` 提供（详见 §2、§7.4）。

示例输出：

```
$ zoo-log show ses_abc123def456 --hook focus-reminder
{"timestamp":"2026-06-15T14:23:01.000Z","level":"info","hook":"focus-reminder","event":"injected","agent":"build","sessionId":"ses_abc123def456"}
{"timestamp":"2026-06-15T14:25:30.000Z","level":"info","hook":"focus-reminder","event":"injected","agent":"build","sessionId":"ses_abc123def456"}
```

```bash
$ zoo-log tail ses_abc123def456 --level error
```

实时输出错误级别的 ZK 事件（阻塞等待新行）。

---

## 6. 与 DCP 脚本的对应关系

`@tarquinen/opencode-dcp` 提供了一组独立脚本工具（位于 `scripts/`），ZooKeeper 工具集对标并扩展了这些脚本的功能。

| DCP 脚本 | 对应 ZooKeeper 工具 | 说明 |
|----------|-------------------|------|
| `opencode-find-session` | `zoo-find <keyword>` | 会话搜索，ZooKeeper 新增 `--all` / `--exact` / `--message` 模式 |
| `opencode-get-message` | `zoo-find --message` | 消息检索，ZooKeeper 新增 `--session` / `--scan` 加速 |
| `opencode-token-stats` | `zoo-inspect stats --sessions <N>` | Token 统计，多会话汇总为每会话一行 |
| `opencode-dcp-stats` | `zoo-inspect impact` | Hook 触发对缓存命中率的影响分析 |
| `opencode-session-timeline` | `zoo-trace steps` | 分步 token 时间线，新增 `--hook-overlays` / `--min-cache-drop` |
| `opencode-message-token-counts` | `zoo-trace tokens` | 消息级 token 分布，新增宽屏/紧凑自适应 |
| —（无对应） | `zoo-inspect timeline` | ZK 事件时间线（数据来自 ZK JSONL，非 opencode 日志） |
| —（无对应） | `zoo-trace show` / `export` | 多源合并追踪 + Jaeger/Chrome 导出 |
| —（无对应） | `zoo-log show` / `tail` | ZK 日志实时/历史过滤（基于 jq 管道） |

**ZooKeeper 相对于 DCP 的增强：**

1. **多源合并：** `zoo-trace` 将 ZK JSONL + OpenCode 日志 + SQLite 消息数据合并为单一时间线，DCP 脚本各工具仅操作单一数据源。
2. **父子会话统一处理：** 默认过滤主会话，通过 `--all` / `--child` 展开子会话。
3. **管道友好：** `zoo-find` 单匹配仅输出 ID，适合编排脚本。
4. **统一参数风格：** `--json` / `--db` / `--no-color` 跨工具一致。
5. **缓存影响分析：** `impact` 子命令提供 hook 级聚合表 + 恢复曲线 + 成本估算，DCP 仅有 `dcp-stats` 的简单统计。

---

## 7. 关键设计原则

### 7.1 父子会话

OpenCode 的 session 模型支持 `parent_id` 树结构——子会话（sub-session）由 `task()` 工具编排时创建。各工具的默认行为为 **仅处理主会话**（`parent_id IS NULL`），避免信息过载。

- **zoo-find：** `--all` 包含子会话（搜索范围扩大）
- **zoo-inspect：** `--all` 包含子会话（stats 和 impact 范围扩大）
- **zoo-trace：** `--child` 展开子会话（`zoo-trace steps` 和 `show` 使用）

> 设计理由：用户 90% 的调试场景聚焦于主会话行为。子会话的展开应显式声明，避免默认输出爆炸。

### 7.2 管道友好

工具链应可无缝串联，支持 Unix 管道哲学：

```bash
# 搜索会话 → 直接传给 zoo-trace
zoo-trace steps $(zoo-find "auth middleware")

# 搜索会话 → 传给 zoo-inspect
zoo-inspect stats $(zoo-find "deploy")

# 搜索会话 → 传给 zoo-log
zoo-log show $(zoo-find "bug fix") --level error
```

**规则：**
- `zoo-find` 单匹配时 **仅输出 session ID**（无格式、无换行）
- 所有工具输出到 stdout，stderr 仅输出错误/诊断信息
- `--json` 输出确保可被 `jq` 等工具进一步处理

### 7.3 CLI 一致性

所有工具遵循相同的 CLI 设计规范：

| 规范 | 说明 |
|------|------|
| **子命令优先** | `tool <command> [args]` 而非 `tool --<command>` |
| **位置参数** | session ID 作为位置参数（而非 `--id`） |
| **全局 `--json`** | 输出 JSON（不影响交互式表格的颜色表头） |
| **全局 `--db`** | 显式指定 SQLite 路径 |
| **全局 `--no-color`** | 禁用 ANSI 颜色（输出重定向时自动检测并默认启用） |
| **前缀匹配** | session ID 支持前缀匹配（`ses_abc` 匹配 `ses_abc123`） |
| **错误处理** | 数据未找到时退出码 2，stderr 输出人类可读的错误消息 |

### 7.4 子命令精简

从现有实现中删除 3 个 `list` 子命令，统一由 `zoo-find` 提供会话搜索能力：

| 待删除 | 替代方案 |
|--------|---------|
| `zoo-log list` | `zoo-find --all` |
| `zoo-inspect list` | `zoo-find --all` |
| `zoo-trace list` | `zoo-find --all` |

### 7.5 stats 合并

将单会话 stats 与多会话汇总合并到同一个 `zoo-inspect stats` 命令：

- **单会话：** `zoo-inspect stats <session_id>` → 详细 hook/level 分布 + token 概要
- **多会话：** `zoo-inspect stats --sessions <N>` → 跨会话 token 汇总表（每会话一行）

通过 `--tokens` 和 `--hooks` 参数可以只显示指定区块，适合快速查看。

---

## 附录：架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ZooKeeper CLI Tools                          │
│                                                                      │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐          │
│  │ zoo-find │  │ zoo-inspect │  │ zoo-trace │  │ zoo-log  │          │
│  └────┬─────┘  └─────┬──────┘  └────┬─────┘  └────┬─────┘          │
│       │              │              │              │                 │
│       ▼              ▼              ▼              ▼                 │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  ┌──────────┐      │
│  │ SQLite   │  │ZK JSONL  │  │ZK JSONL        │  │ZK JSONL  │      │
│  │(opencode │  │(~/.zoo   │  │+ OpenCode Log  │  │(~/.zoo   │      │
│  │ .db)     │  │ /log/)   │  │+ SQLite        │  │ /log/)   │      │
│  └──────────┘  └──────────┘  └────────────────┘  └──────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```