# ZooKeeper 日志系统与 Trace 可视化 — 设计方案

## 背景

ZooKeeper 作为 OpenCode 编排器插件，当前日志能力薄弱——仅有一个 `debug()` 函数以 binary 开关控制写入 stderr，不持久化、无级别区分、不与 opencode 原生日志关联。日常开发调试时常因无法回溯 hook 行为而反复重跑。

目标：构建一套可持久化、可查询、可关联 opencode 日志的运行时日志系统；同时提供离线 trace 工具，从日志中提取 session 的编排链路并生成美观展示。

调研范围：opencode (宿主)、pi、oh-my-pi、oh-my-openagent、oh-my-opencode-slim、opencode-dynamic-context-pruning 六个参考项目的日志实现。

---

## 一、调研结论

### 1.1 各项目日志设计精要

#### opencode (宿主)

- **格式**：`key=value` 结构化文本（`timestamp=2026-06-13T12:34:56.789Z level=INFO run=48285f78 message=created id=ses_xxx`）
- **路径**：`~/.local/share/opencode/log/opencode.log`
- **级别**：`DEBUG` / `INFO` / `WARN` / `ERROR`，通过 `OPENCODE_LOG_LEVEL` 环境变量或 `--log-level` 控制
- **关联**：每一行包含 `run`（实例 8 位 UUID）+ `session.id` + `messageID`，实现多维度关联
- **遥测**：可选 OTLP 导出到 Honeycomb 等平台
- **桌面版**：Electron 的 `electron-log` 独立管理 `main.log` / `renderer.log` 等，按时间戳创建运行目录，7 天清理

#### pi

- **核心机制**：session JSONL 持久化，`id`/`parentId` 树结构实现原地分支，天然形成审计追踪
- **格式**：`{"type":"message","id":"a1b2","parentId":null,"timestamp":"...","message":{"role":"user","content":"..."}}`
- **事件驱动**：`AgentEvent` 联合类型 → `EventStream` → 监听器（UI 渲染、session 写入、扩展钩子各取所需）
- **分析工具**：独立 Python 脚本 (`scripts/stats.ts`, `scripts/cost.ts`, `scripts/tool-stats.ts`) 解析 JSONL 生成统计和 HTML 报告

#### oh-my-pi

- **框架**：Winston + `winston-daily-rotate-file`（日轮转 + gzip 归档）
- **格式**：JSON（每行 `{timestamp, level, pid, message, ...meta}`）
- **亮点**：Error 序列化保护（`jsonReplacer` 确保 `name/message/stack/cause` 不丢失）、双通道启动诊断（`PI_DEBUG_STARTUP` 同步 stderr + `PI_TIMING` 异步 span tree）、TUI 内置日志查看器
- **路径**：`~/.omp/logs/omp.YYYY-MM-DD.log`

#### oh-my-openagent

- **核心 Logger**：`src/shared/logger.ts`，缓冲（50 条上限）+ 定时刷出（500ms），50MB 轮转 + 2 备份
- **格式**：混合（`[timestamp] message JSON`）
- **哲学**：日志永不抛异常、无日志级别、`os.tmpdir()` 硬编码路径
- **结构化追踪**：ast-grep MCP 和 Transcript 使用 JSON Lines

#### oh-my-opencode-slim

- **路径**：`~/.local/share/opencode/log/oh-my-opencode-slim.<SESSION_ID>.log`
- **写入**：Promise chain 串行化 `appendFile`，不阻塞事件循环
- **清理**：7 天保留期，启动时自动清理
- **第二通道**：`client.app.log()` 用于关键事件（初始化失败等）
- **配置**：仅 `OPENCODE_LOG_DIR` 环境变量，零配置理念

#### opencode-dynamic-context-pruning

- **两级架构**：文本日日志（`YYYY-MM-DD.log`）+ 按 session 的 JSON 上下文快照（`context/{sessionId}/{timestamp}.json`）
- **格式**：`{timestamp} {LEVEL} {component}: {message} | {key=value}`
- **组件自标记**：通过 `Error.prepareStackTrace` 解析调用栈自动提取文件名作为 `component` 标签
- **分析**：独立 Python 脚本读取 `opencode.db`（SQLite），与运行时日志完全解耦
- **配置**：`dcp.jsonc` 中的 `debug: boolean`

### 1.2 共性规律

| 规律 | 项目 | 说明 |
|------|------|------|
| JSON Lines 是结构化日志的事实标准 | pi / oh-my-openagent / oh-my-pi | 三项目独立选择 ndjson，兼具人类可读和机器可解析 |
| 日志错误永不上抛 | oh-my-openagent / oh-my-opencode-slim / DCP | `catch {}` 静默吞掉 I/O 错误是共识 |
| 缓冲 + 定时刷出避免高频 I/O | oh-my-openagent | 500ms 定时器 + 50 条阈值双触发 |
| 分析工具独立于运行时 | pi / DCP | 解耦后运行时零依赖，分析按需使用 |
| 日志路径与宿主关联 | oh-my-opencode-slim / oh-my-pi | 写入宿主的数据目录而非自建，方便关联调试 |

### 1.3 ZooKeeper 当前日志差距

| 维度 | 现状 | 差距 |
|------|------|------|
| **持久化** | 仅 stderr | 关闭终端后日志丢失 |
| **格式** | `[zookeeper:<tag>] <JSON>` | 无固定字段 schema，不可查询 |
| **级别** | binary on/off | 无法区分正常触发与异常 |
| **session 关联** | 仅 task-prompt 带 sessionId/callId | 其他 hook 均不带 sessionId |
| **call 关联** | 无 | 无法定位到单次工具调用 |
| **初始化** | 完全静默 | 不知道插件是否加载、哪些 agent 注入了 prompt |
| **异常** | 4 个 `catch {}` 静默吞掉 | handler 静默失效不可知 |
| **跳过原因** | 无 | 钩子没触发时不知道为什么 |
| **警告内容** | 只记数量 | 不知道具体 warn 了什么 |

---

## 二、设计目标

1. **运行时日志**：每个 hook 的触发、结果、跳过原因都有迹可循。JSON Lines 格式，`jq` 可查询。初始化事件和异常不再静默。
2. **Trace 可视化**：从 opencode 原生日志 + ZooKeeper 日志重构 session 时间线，按时间顺序展示 LLM 调用→权限检查→工具调用→ZooKeeper 干预的完整链路。

---

## 三、Part A — 运行时日志系统

### 3.1 日志路径

```
~/.zoo/log/opencode-<sessionID>.log
```

与 opencode 日志同目录（`~/.local/share/opencode/log/`）优势：trace 工具一次 glob 同时扫到两条流。但用户要求独立目录 `~/.zoo/log/`。

### 3.2 文件组织

```
~/.zoo/log/
├── opencode-20260613T144631.log       # 主日志（文件名含 session 启动时间）
├── opencode-20260613T144631.log.1     # 轮转备份
└── opencode-20260613T144631.log.2     # 轮转备份
```

轮转参数（在 `config.toml` 中配置）：

```toml
[zoo.logging]
max_file_size_mb = 5      # 单文件上限
max_backups = 2           # 保留备份数
retention_days = 7        # 清理 > 7 天的日志
```

TS 插件运行时通过 config hook 传入的配置对象读取这些值，与 `[zoo.validation]` 阈值的读取方式一致。不使用环境变量控制路径。

### 3.3 日志格式 — JSON Lines

每行一个自包含 JSON 对象，固定骨架 + 事件专属字段。

#### 固定字段（每条必含）

与 opencode / oh-my-pi / pi 等项目一致，全部使用完整字段名。

| 字段 | 类型 | 含义 | 示例 |
|------|------|------|------|
| `timestamp` | `string` | ISO 8601 毫秒时间戳 | `"2026-06-13T14:46:31.050Z"` |
| `level` | `string` | 级别：`debug` / `info` / `warn` / `error` | `"debug"` |
| `hook` | `string` | 来源 hook 模块 | `"task-prompt"` |
| `sessionId` | `string` | session ID（初始化时为空串） | `"ses_1407dd2a0ffe"` |
| `callId` | `string?` | call ID（工具调用时有） | `"call_xyz"` |
| `event` | `string` | 事件名 | `"validate_failed"` |

#### 日志级别

| level | 语义 | 典型事件 |
|-------|------|---------|
| `debug` | 每次 hook 触发/跳过的细节 | `validate_passed`、`nudge_skipped`、`reminder_injected` |
| `info` | 生命周期事件（低频） | `plugin_init`、`shutdown` |
| `warn` | 非预期但可恢复 | `validate_failed`、`recovery_injected` |
| `error` | hook 失效/异常 | `handler_crashed`、`todo_api_failed` |

#### 控制方式

单一环境变量 `ZOO_DEBUG`（设 `"1"` / `"true"` / `"yes"` 则最低级别为 `debug`——全部输出）。不做旧名 `ZOOKEEPER_DEBUG` 兼容。

### 3.4 事件定义

以下事件定义来自各 hook 的实际代码输入，字段值来自 hook handler 中已有的计算结果。

#### `plugin` — 初始化事件

| event | level | 附加字段 | 触发点 |
|-------|-------|---------|--------|
| `plugin_init` | `info` | `agents: string[]`, `limits: {contextWordLimit: int, promptWordLimit: int}`, `skills: string[]` | `zookeeper()` 工厂函数返回前 |
| `agent_loaded` | `debug` | `agent: string`, `prompt_len: int` | `config` hook 注入 prompt 时 |
| `skill_registered` | `debug` | `skill: string` | `config` hook 注册 skill 时 |
| `handler_crashed` | `error` | `handler: string`, `error: string` | 各 `catch {}` 块 |

#### `task-prompt` — 任务 prompt 校验

| event | level | 附加字段 | 触发点 |
|-------|-------|---------|--------|
| `validate_failed` | `warn` | `errors: string[]` | `validateBeforeExec` 缺 section |
| `validate_passed` | `debug` | `warnings: int`, `ctx_words: int`, `total_words: int` | 校验通过 |
| `nudge_injected` | `debug` | `warnings: string[]` | `nudgeTaskOutput` 有 warn |
| `nudge_skipped` | `debug` | — | `nudgeTaskOutput` 无 warn |

#### `json-error-nudge` — JSON 解析错误恢复

| event | level | 附加字段 | 触发点 |
|-------|-------|---------|--------|
| `recovery_injected` | `warn` | `tool: string`, `pattern: string` | 检测到 JSON 错误 |
| `recovery_skipped` | `debug` | `tool: string`, `reason: "excluded" \| "no_output" \| "already_marked" \| "no_match"` | 跳过 |

#### `direct-work-nudge` — 直接编辑提醒

| event | level | 附加字段 | 触发点 |
|-------|-------|---------|--------|
| `nudge_injected` | `debug` | `tool: string`, `nudge_type: "edit" \| "search"` | build agent 直接操作 |
| `nudge_skipped` | `debug` | `tool: string`, `reason: "not_build" \| "no_output" \| "not_direct_work"` | 跳过 |

#### `post-task-nudge` — 子任务完成后提醒

| event | level | 附加字段 | 触发点 |
|-------|-------|---------|--------|
| `verify_injected` | `debug` | `todo_state: "none_active" \| "final_active" \| "general" \| "fallback"` | task() 返回后 |
| `todo_api_failed` | `error` | `error: string` | getTodoState 抛异常 |

### 3.5 完整日志示例

```jsonl
{"timestamp":"2026-06-13T14:46:31.050Z","level":"info","hook":"plugin","sessionId":"","event":"plugin_init","agents":["dolphin","lynx","beaver","spider"],"limits":{"contextWordLimit":200,"promptWordLimit":500},"skills":["git-commit"]}
{"timestamp":"2026-06-13T14:46:31.052Z","level":"debug","hook":"plugin","sessionId":"","event":"agent_loaded","agent":"dolphin","prompt_len":3823}
{"timestamp":"2026-06-13T14:46:31.054Z","level":"debug","hook":"plugin","sessionId":"","event":"skill_registered","skill":"git-commit"}
{"timestamp":"2026-06-13T14:46:33.000Z","level":"debug","hook":"task-prompt","sessionId":"ses_1407dd2a0ffe","callId":"call_xyz","event":"validate_passed","warnings":1,"ctx_words":145,"total_words":312}
{"timestamp":"2026-06-13T14:46:33.001Z","level":"debug","hook":"task-prompt","sessionId":"ses_1407dd2a0ffe","callId":"call_xyz","event":"nudge_injected","warnings":["CONTEXT is 145 words — consider splitting into multiple task() calls..."]}
{"timestamp":"2026-06-13T14:46:45.000Z","level":"debug","hook":"post-task-nudge","sessionId":"ses_1407dd2a0ffe","callId":"call_xyz","event":"verify_injected","todo_state":"final_active"}
{"timestamp":"2026-06-13T14:46:45.200Z","level":"warn","hook":"json-error-nudge","sessionId":"ses_1407dd2a0ffe","callId":"call_abc","event":"recovery_injected","tool":"question","pattern":"json parse error"}
{"timestamp":"2026-06-13T14:46:50.000Z","level":"debug","hook":"direct-work-nudge","sessionId":"ses_1407dd2a0ffe","callId":"call_def","event":"nudge_skipped","tool":"edit","reason":"not_build"}
```

### 3.6 写入策略

| 策略 | 来源 | 说明 |
|------|------|------|
| 内存缓冲（50 条上限） | oh-my-openagent | 批量写入减少 I/O |
| 定时刷出（500ms） | oh-my-openagent | 确保日志及时落地 |
| Promise chain 串行化 | oh-my-opencode-slim | 不阻塞事件循环，保证写入顺序 |
| 静默失败 | oh-my-openagent | 所有 I/O 错误吞掉，不中断主流程 |

### 3.7 测试缝

参考 oh-my-openagent 的 `_setLoggerForTesting` 模式，暴露：

- `_getBufferForTesting()` — 断言日志内容
- `_setLogPathForTesting(path)` — 覆盖日志目录
- `_flushForTesting()` — 同步刷出

---

## 四、Part B — Trace 提取与可视化

### 4.1 数据流

```
~/.local/share/opencode/log/opencode.log  ─┐
~/.zoo/log/opencode-<sid>.log             ─┤
                                            ▼
                                 ┌─────────────────────┐
                                 │ log_parser.py        │
                                 │ 解析 opencode        │
                                 │ key=value → dict     │
                                 │ 解析 zoo JSONL → dict│
                                 └────────┬────────────┘
                                          ▼
                                 ┌─────────────────────┐
                                 │ trace_builder.py     │
                                 │ 按 session 分组       │
                                 │ 时间排序 + 事件重构    │
                                 │ 合并两条日志流        │
                                 └────────┬────────────┘
                                          ▼
                                 ┌─────────────────────┐
                                 │ 展示层                │
                                 │ ├─ timeline (rich)   │
                                 │ ├─ stats (rich)      │
                                 │ └─ report (jinja2)   │
                                 └─────────────────────┘
```

### 4.2 工具列表

| 工具 | 命令 | 功能 |
|------|------|------|
| `zoo-log` | `tail <sid>` / `--hook <name>` / `--level <lvl>` | 实时过滤日志，封装 `jq` 管道 |
| `zoo-inspect` | `sessions` / `stats <sid>` / `timeline <sid>` | Session 摘要 + hook 触发统计 + 时间线 |
| `zoo-trace` | `show <sid>` / `list` / `report <sid> -o <file>` | 完整编排链路，含 HTML 报告 |

### 4.3 展示设计 — 终端时间线

使用 Python `rich` 库渲染：

```
╭── Session: calm-panda (ses_1407dd2a0f...) ─────────────────────────────╮
│ Agent: build  |  Model: deepseek-v4-pro  |  Provider: DeepSeek          │
│ Project: ZooKeeper  |  Duration: 4m 32s  |  Cost: $0.42                 │
╰────────────────────────────────────────────────────────────────────────╯

14:46:31.000  ◆ SESSION START  [open]
14:46:31.050  ● config loaded  [open → config]
14:46:31.200  ▲ LLM CALL #1 (deepseek-v4-pro, 3500→580 tokens)  [thinking]
14:46:32.100  ▼ PERMISSION CHECK  read *.env.example → allow
14:46:32.150  ■ TOOL: read .env.example  [tool]
14:46:33.000  ▲ LLM CALL #2 (deepseek-v4-pro, 15000→2400 tokens)  [thinking]
              │  ZooKeeper: task-prompt-validate → valid (0 errors, 1 warn)
              │  ZooKeeper: post-task-nudge → hasTodo=true, general nudge
14:46:35.000  ■ TOOL: task "fix the bug" → subagent general  [orchestration]
```

语义图标：
- `◆` 会话生命周期  `●` 配置/初始化  `▲` LLM 调用
- `▼` 权限检查  `■` 工具调用  `◈` ZooKeeper hook

### 4.4 展示设计 — 统计面板

```
Session Summary
─────────────────────────────────────────
Total turns:              12
LLM calls:                12
Tool calls:                8 (read: 4, task: 2, write: 2)
Permission checks:        15 (allow: 14, deny: 1)
ZooKeeper interventions:   5 (nudge: 3, validation: 2)
Total tokens:          24,500 → 8,200
Cache hit rate:            34%
Estimated cost:           $0.42
Duration:                4m 32s
```

### 4.5 展示设计 — HTML 报告

使用 Jinja2 模板生成自包含 HTML：
- 交互式时间线（可折叠 LLM turn 详情）
- 甘特图式时间条
- token 分布饼图 + 工具调用分布饼图
- 每次 LLM 调用的输入/输出 token 瀑布图

### 4.6 工具实施优先级

| 优先级 | 工具 | 理由 |
|--------|------|------|
| P0 | `zoo-log tail` | 取代手打 `jq`，开发即时反馈 |
| P1 | `zoo-inspect stats` | 快速了解 hook 行为 |
| P2 | `zoo-inspect timeline` | 查看事件时间顺序 |
| P3 | `zoo-trace` | 完整编排链路，依赖 opencode 日志解析 |

---

## 五、实施计划

### Phase 1 — 核心日志（P0）

- 重写 `src/hooks/utils/logger.ts`：JSONL 格式 + 文件写入 + 级别 + 缓冲 + 轮转 + 清理
- `config.toml` 新增 `[zoo.logging]` section
- 环境变量改为 `ZOO_DEBUG`

### Phase 2 — 日志记录点补齐（P0）

- `src/index.ts`：`plugin_init` / `agent_loaded` / `skill_registered` / `handler_crashed`
- 各 hook：补齐 `sid` / `cid` / `evt` / 具体 content（替换计数为实际内容）

### Phase 3 — 调试工具（P1）

- `tools/zoo-log` — 实时日志过滤
- `tools/zoo-inspect` — session 摘要 + 统计
- `tools/zoo-trace` — 完整 trace + HTML 报告（P3）

### 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/hooks/utils/logger.ts` | 重写 | 从 stderr 单函数 → 文件 JSONL + 级别 + 缓冲 + 轮转 |
| `src/index.ts` | 修改 | 初始化日志 + 异常日志 + 会话 ID 获取 |
| `src/hooks/task-prompt/hook.ts` | 修改 | 增加 sid/cid，替换计数为具体内容 |
| `src/hooks/json-error-nudge/hook.ts` | 修改 | 增加 sid/cid，增加 skip reason |
| `src/hooks/direct-work-nudge/hook.ts` | 修改 | 增加 sid/cid，增加 skip reason |
| `src/hooks/post-task-nudge/hook.ts` | 修改 | 增加 sid/cid，增加 error 日志 |
| `config.toml` | 修改 | 新增 `[zoo.logging]` section |
| `tools/zoo-log` | 新增 | 实时日志过滤工具（Python） |
| `tools/zoo-inspect` | 新增 | Session 摘要工具（Python） |
| `tools/zoo-trace/` | 新增 | 完整 trace 工具（Python） |

---

## 六、附：调研来源索引

| 项目 | 路径 | 日志关键文件 |
|------|------|------------|
| opencode | `~/Code/Agent/opencode/` | `packages/core/src/observability/logging.ts` |
| pi | `~/Code/Agent/pi/` | `packages/coding-agent/src/core/session-manager.ts` |
| oh-my-pi | `~/Code/Agent/oh-my-pi/` | `packages/utils/src/logger.ts` |
| oh-my-openagent | `~/Code/Agent/oh-my-openagent/` | `src/shared/logger.ts` |
| oh-my-opencode-slim | `~/Code/Agent/oh-my-opencode-slim/` | `src/utils/logger.ts` |
| opencode-dynamic-context-pruning | `~/Code/Agent/opencode-dynamic-context-pruning/` | `lib/logger.ts` |
| ZooKeeper (当前) | `~/Code/Agent/ZooKeeper/` | `src/hooks/utils/logger.ts` |
