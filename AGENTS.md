# AI 代理编码指南

本文件为在本仓库中操作的 AI 代理提供编码指南。

## 项目概览

**ZooKeeper** — 一个编排器插件，通过静态配置权限 + prompt 注入确保编排器不越权调用工具。基于 Python + TypeScript + Rust 构建。同时适配 OpenCode 和 pi 两个宿主（双宿主，共享 `src/core/` 与 `src/agents/`，各自入口 `src/opencode.ts` 与 `src/pi.ts`）。

核心机制：`config.toml` 中声明各 agent 的 `permission` deny 列表（**单一事实来源**）和 `[zoo.validation]` 阈值（上下文/提示词长度限制），install.py 编译 permission 部分后写入 OpenCode 配置（`~/.config/opencode/opencode.json`）和 pi 配置（`~/.pi/agent/settings.json` + `models.json`）；install.py 用 `shutil.which` 检测 opencode/pi 是否安装，按检测结果控制各安装段（缺失则跳过）；`[zoo.validation]` 阈值由 TS 插件在运行时直接读取。TS 插件采用单元化注册架构：`src/registry.ts` 声明唯一有序的加载单元名单，`src/core/compose.ts`（`composeProfile`）按 `[zoo.mode.<name>]` profile 选择并实例化启用单元，`src/compose-opencode.ts` 把结果组装成 OpenCode hook 注册、`src/compose-pi.ts` 把结果组装成 pi 的 tool_result/context handler；OpenCode 插件在 `config` hook 注入 `src/agents/<name>.ts` 的 prompt 常量；pi 扩展（compose 驱动，经 `src/compose-pi.ts` 接触层映射事件）注册 `before_agent_start`（注入 agent prompt）、`resources_discover`（贡献 `core/skills` 目录）、`tool_result`（跑 profile.hooks 的 afterExec 贡献）与 `context`（跑 transform 贡献，写回裁剪后的消息视图）四事件，null profile 全部失效（fail-closed，与 OpenCode 对齐）。

## 命令

| 命令 | 说明 |
|------|------|
| `uv run python install.py` | 安装/更新配置（读取 config.toml + .env → 检测 opencode/pi → 生成 OpenCode 的 opencode.json 和 pi 的 settings.json + models.json） |
| `./check.sh` | 自动修复 + 严格 lint（Python + TS + Rust），禁止 `#[expect]`/`#[allow]` |
| `./test.sh` | 统一测试入口（Python + Rust 测试 + 覆盖率 + TS 单元测试） |
| `./build.sh` | Release 编译 Rust CLI 工具（zlog / zfind / ztrace / zinspect） |
| `./release.sh` | 构建发布包（podman + Debian 10 容器编译 Rust 工具 + 打包 tarball） |
| `python3 tests/runner.py --dry-run` | 干跑（不调用 LLM，回放 JSONL） |
| `python3 tests/runner.py --scenario <name>` | 只跑指定场景 |
| `python3 tests/runner.py --replay` | 从 JSONL 回放（不调 LLM，只跑断言+阈值） |
| `python3 tests/runner.py --replay --scenario <name>` | 回放指定场景 |
| `python3 tests/runner.py -v` | 详细输出（标准错误、指标明细、堆栈） |

> **已知失败说明：** `dolphin-pressure-2` 场景测试"语言正确性 vs 行为完整性"问题，预期失败已被 `test.sh` 排除。详见 `docs/verbal-correctness-vs-behavioral-completeness.md`。

## 代码风格

### 通用规则
- **注释英文**，用户界面输出中文
- **不使用项目内部术语当注释**：如"L1/L2"分层概念不出现在代码注释里，只用通用自解释描述
- **注释描述代码"是什么"，不引用外部叙事**：禁止层级编号（Layer 1/2/3）、施工过程引用（round/phase/"the refactor"）、未在代码中定义的比喻性架构自称（如给架构起名字）。模块 docstring 直接描述自身职责；架构全景描述只保留一份（入口文件头部注释）

### Python
- **Formatter/Linter:** ruff（lint + format）
- **Docstring:** Google docstring 风格（Args/Returns/Raises）
- **注释英文**，用户界面输出中文

### TypeScript
- **Formatter/Linter:** Biome v2（lint + format）
- **Docstring:** JSDoc 风格（@param/@returns）
- **注释英文**
- **缩进：** 2-space
- **引号：** 双引号
- **行宽：** 80 字符

### Rust
- **Formatter/Linter:** cargo fmt + cargo clippy
- **Docstring:** 注释英文
- **行宽：** 80 字符（`tools/rustfmt.toml`: `max_width = 80`）
- **禁止 unsafe：** 所有 crate 顶部含 `#![forbid(unsafe_code)]`

### TOML
- **注释中文**（用户可编辑的配置文件）
- `config.toml` 中的 `{env:VAR}` 占位符由 install.py 在运行时解析

## 目录结构

```
ZooKeeper/
├── install.py               # 安装脚本入口（薄编排层：检测宿主 → 备份 → 生成 → 验证）
├── installer/               # 安装逻辑包（envfile 解析 / variants 校验 / opencode·pi 配置生成 /
│   │                        #   jsonio IO helper / output 终端输出；单元测试在 installer/tests/）
│   └── tests/               # installer 模块单元测试（pytest）
├── config.toml              # 用户可编辑的配置模板（{env:VAR} 占位符；含 [zoo.validation] 阈值）
├── .env / .env.example      # 环境变量（apiKey、baseURL、模型名）
├── check.sh                 # 统一 lint/format 脚本
├── bunfig.toml              # Bun 测试配置（vendor/** 排除出覆盖率）
├── test.sh                  # 统一测试脚本（Python + Rust + TS）
├── build.sh                 # Release 编译 Rust CLI 工具
├── core/
│   └── skills/              # skill 定义目录
├── src/                     # 插件 TS 代码（OpenCode + pi 双宿主入口，共享 core/agents）
│   ├── agents/              # 各 agent 的 prompt 常量 + agent 单元（unit 描述符）
│   │   ├── parts.ts         # 共享 prompt 片段（DELEGATION_FORMAT_TEXT、TASK_PROMPT_HINT）
│   │   ├── dolphin.ts
│   │   ├── beaver.ts
│   │   ├── mola.ts
│   │   ├── lynx.ts
│   │   ├── spider.ts
│   │   ├── eagle.ts
│   │   └── kiwi.ts
│   ├── adapters/            # 宿主适配层（opencode/ 与 pi/ 各自实现 HostAdapter 契约；pi 的单消费者 helper 内联于 render.ts）
│   ├── registry.ts          # 单元注册表 — 唯一有序的加载单元名单（单一事实来源）
│   ├── opencode.ts          # OpenCode 扩展入口 + 底盘（profile 驱动的注册由 compose-opencode 组装）
│   ├── compose-opencode.ts  # OpenCode 事件键适配器（组装 ComposedResult → hook 注册；统一 COMMAND_HANDLED 哨兵）
│   ├── compose-pi.ts        # pi 事件键适配器（组装 ComposedResult → tool_result/context handler）
│   ├── pi.ts                # pi 扩展入口（compose 驱动：注册 before_agent_start / resources_discover / tool_result / context 四事件）
│   ├── tui/                 # TUI 侧边栏插件（OpenCode 专属，solid-js；index.tsx 入口 + subagent.ts 纯逻辑层）
│   ├── core/                # 框架无关纯逻辑（零 OpenCode 依赖）
│   │   ├── compose.ts       # 选择引擎（composeProfile：profile → 启用单元实例化 → ComposedResult）
│   │   ├── slots.ts         # 槽位词汇（单元描述符、贡献类型、ComposedResult/Deps/ActiveSet）
│   │   ├── context/         # 上下文管理域（host 无关核心：透镜 → 状态 → 流水线原语；19 模块，职责见各文件 docstring）
│   │   ├── client/          # 宿主 client 类型切片（框架无关的 client 接口契约）
│   │   │   ├── agent.ts         # Agent 类型检测（Clientish 接口 + getAgentName）
│   │   │   ├── todo.ts          # Todo 状态查询（TinyClient 接口 + getTodoState）
│   │   │   └── session.ts       # 会话 client 最小契约（SessionClient 接口）
│   │   ├── config-types.ts  # [zoo.context] 配置 schema 类型（纯类型）
│   │   ├── config-parse.ts  # config.toml 解析
│   │   ├── validate.ts      # task prompt 校验（section 提取、词数限制、反模式检测）
│   │   ├── recovery.ts      # JSON 解析错误检测与恢复
│   │   ├── plan.ts          # 计划文件读写（frontmatter 解析、状态更新）
│   │   ├── checks.ts        # 计划/todo 进度检查
│   │   ├── delegation.ts    # task() 委派权限判定
│   │   └── prompts.ts       # hook/tool 注入的 nudge 文本（agent 片段见 agents/parts.ts）
│   ├── hooks/               # 各 hook 单元的薄适配层（每目录一个单元：解包框架 (input, output) → 调 core 函数）
│   │   ├── context-metrics/ # 上下文指标（重导出 adapters/opencode/types 的 measureContext）
│   │   ├── context-pruning/ # 上下文裁剪 transform（mark-sweep + compress）
│   │   ├── direct-work-nudge/# 直接编辑提醒（nudgeDirectWork 适配器）
│   │   ├── json-error-nudge/# JSON 解析错误恢复（重导出 core/recovery）
│   │   ├── post-task-nudge/ # task() 返回后验证+todo 提醒（nudgePostTask 适配器）
│   │   ├── task-delegation/ # task() 委派权限拦截
│   │   └── task-prompt/     # task prompt 校验 + nudge（3 个适配器函数）
│   ├── tools/               # OpenCode 工具适配器（compress / decompress 工具工厂）
│   ├── commands/            # 斜杠命令单元（每目录一个命令单元：unit 描述符 + 处理器）
│   │   ├── go/              # /go 命令（计划 handoff：planning-done → dolphin 子会话）
│   │   ├── dcp/             # /dcp 命令（command.ts 处理器 + unit 描述符）
│   │   └── notify.ts        # 命令失败通知（notifySessionError，go/dcp 共用）
│   └── utils/
│       └── logger.ts        # JSON Lines 文件日志（旋转 + 保留策略）
├── vendor/
│   └── smol-toml/           # 上游 TS 源码（v1.7.1 tag，零修改）：index.ts 等 9 个源文件 + LICENSE；
│                            #   来源 https://github.com/squirrelchat/smol-toml（BSD-3-Clause）；
│                            #   vendor 日期 2026-08-08；更新方式：按新 tag 重新拷贝上游 src/ + LICENSE
├── tests/                   # Prompt 评估测试框架（Phase 1: dolphin.md）
│   └── runner.py            # 评估测试运行器
├── tools/                   # Rust CLI tools workspace
│   ├── Cargo.toml           # workspace root (members: zutil, zlog, zfind, ztrace, zinspect)
│   ├── rustfmt.toml         # max_width = 80
│   ├── zutil/               # 共享库（expand_tilde, format_number, ts_display 等）
│   ├── zlog/                # 实时日志过滤（取代 Python zoo-log）
│   ├── zfind/               # 会话/消息搜索（取代 Python zoo-find）
│   ├── ztrace/              # 编排追踪（取代 Python zoo-trace）
│   ├── zinspect/            # 事件统计（取代 Python zoo-inspect）
└── docs/                    # 设计文档和调研报告
```

生成的配置写入 `~/.config/opencode/opencode.json`（不在 git 仓库里）。项目级 `opencode.json` 已 gitignore。

## 重要规则

- **禁止自行提交 git commit**：除非用户明确要求进行 git 提交（如"提交"、"commit"、"push"等），否则绝对不得执行 `git commit`、`git add` + `git commit` 或任何形式的提交操作。运行 `./check.sh` 时其内部的自动格式化修改是可以接受的，但不得主动暂存或提交这些修改。
- **git 提交必须使用 git-commit skill**：当用户要求提交代码时，必须加载 `git-commit` skill（位于 `core/skills/git-commit/SKILL.md`）来执行提交，不得自行拼写 commit message 或手动执行 `git commit`。

## 开发流程

1. 修改代码（config.toml、prompt 文件、插件代码等）
2. 运行 `./check.sh` 自动修复 lint/format 问题
3. 运行 `./test.sh` 验证测试通过（静态分析 + Rust tests + dry-run + TS 单元测试）
4. Rust 工具变更后运行 `./build.sh` 确保 release 编译通过

## 关键文件

- **`install.py`** — 安装脚本入口，读取 config.toml + .env → 用 `shutil.which` 检测 opencode/pi 是否安装 → 按检测结果生成：OpenCode 的 `~/.config/opencode/opencode.json`、pi 的 `~/.pi/agent/settings.json`（每次安装完整重建，只含 extensions + 从 `[defaults].model`（`{env:ZOO_WHALE_MODEL}`，`Provider/model` 格式）拆出的 defaultProvider/defaultModel，不读取旧文件）+ `~/.pi/agent/models.json`（provider 转换：明文 apiKey、baseUrl 对 anthropic-messages 去 `/v1`、cost 补全四字段、idempotent prune 残留）。provider 跳过 warn 统一打一次。三阶段对称打印（备份/生成/验证/安装完成）。只依赖 Python 标准库。
- **`installer/`** — install.py 委托的安装逻辑包：`envfile.py`（.env 解析 + `{env:VAR}` 递归解析 + 凭据缺失条目剔除）、`variants.py`（`[zoo.variants]` 全局/按 agent 双通道校验收集）、`opencode.py`（mode profile 解析 + opencode.json 组装）、`pi.py`（provider → models.json 转换）、`jsonio.py`（JSON 读写 helper）、`output.py`（终端输出）。单元测试位于 `installer/tests/`。
- **`config.toml`** — 用户配置模板（单一事实来源），所有 deny 权限和 agent 配置在此声明，`[zoo.validation]` 阈值由 TS 插件在运行时直接读取
- **`src/opencode.ts`** — 插件入口 + 底盘，薄接线层：解析配置、持有共享 session 映射（`sessionAgentMap`），合并 `compose-opencode.ts` 组装的 profile 驱动 fragment 与常驻基础设施 hook
- **`src/pi.ts`** — pi 扩展入口，通过 `~/.pi/agent/settings.json` 的 `extensions` 数组被 pi 加载；compose 驱动，把全量 REGISTRY 交给 `composeProfile`（tool/command 单元实例化但槽位不被消费）：注册 `before_agent_start`（prepend 组合后的 agent prompt 到 systemPrompt）、`resources_discover`（贡献 `core/skills` 子目录）、`tool_result`（跑 profile.hooks 的 afterExec 贡献）与 `context`（跑 transform 贡献，写回裁剪后的消息视图）四事件；deps 适配：`client: {}`（pruning transform 照常运行，dedup 通知因无 session prompt API 短路）、`directory: process.cwd()`、dolphin-enabled profile 时 `sessionAgentMap` 恒解析 "dolphin"（pi 会话即编排器）；null profile 四事件全部失效（fail-closed，与 OpenCode 对齐）；用 `realpathSync` 跟随路径确保 `../config.toml` 与 `../core/skills` 解析正确；config.toml 经 `vendor/smol-toml` 的 `parse` 解析（pi 的 Node/jiti 运行时无法 import .toml）
- **`src/registry.ts`** — 单元注册表，唯一有序的加载单元名单（单一事实来源），`composeProfile` 按此数组顺序实例化启用单元
- **`src/compose-opencode.ts`** — OpenCode 事件键适配器：把 `ComposedResult` 组装成 hook 注册（config / tool / command / 三个 handler 槽位），统一抛出 `COMMAND_HANDLED` 哨兵短路已处理的斜杠命令
- **`src/compose-pi.ts`** — pi 事件键适配器：唯一理解 pi 事件键的模块，把 `ComposedResult` 组装成 `buildPiToolResultHandler(afterExec)`（tool_result handler：文本增量追加）与 `buildPiContextHandler(transform)`（context handler：消息转换，写回裁剪后的视图）
- **`src/core/`** — 框架无关纯逻辑模块，零 OpenCode 依赖，可被任何 TS 运行时 import；含选择引擎 `compose.ts`（`composeProfile`）、槽位词汇 `slots.ts`
- **`src/agents/<name>.ts`** — 各 agent 的 prompt 常量 + agent 单元（unit 描述符），按 `{agent-name}.ts` 命名
- **`src/agents/parts.ts`** — 共享 prompt 片段常量（`DELEGATION_FORMAT_TEXT`、`TASK_PROMPT_HINT`）
- **`tools/Cargo.toml`** — Rust workspace 根配置

## 调试/日志

OpenCode 日志写入以下位置：

- **macOS/Linux：** `~/.local/share/opencode/log/`
- **Windows：** `%USERPROFILE%\.local\share\opencode\log`

日志文件按时间戳命名（如 `2025-01-09T123456.log`），保留最近 10 个日志文件。可使用 `--log-level DEBUG` 命令行选项获取更详细的调试信息。

### 插件调试日志

所有 hook 使用 `src/utils/logger.ts` 导出的 `log()` 函数输出 JSON Lines 触发记录。日志按宿主（host）+ 会话 ID 分片写入 `~/.zoo/log/` 目录：带会话 ID 的条目写入 `<host>-<sessionID>.log`（如 `opencode-<sessionID>.log`、`pi-<sessionID>.log`）；无会话 ID 的加载期条目（如 `plugin_init` 配置告警）缓冲后归入进程首个会话的文件，进程始终无会话则不落盘。每条 JSON 记录携带 `host` 字段，便于合并查看时归属宿主。

- **info/warn/error 始终记录** — 即使不设置 `ZOO_DEBUG`，这三个级别也会写入日志文件
- **debug 日志默认关闭** — 设置 `ZOO_DEBUG=1 opencode`（或在 shell 中 `export ZOO_DEBUG=1`）后额外启用 debug 级别
- **输出目标：** stderr（不进 TUI），避免 Bun 将 `console.debug` 当成 `console.log` 污染界面

示例输出：

```
[zookeeper:task-prompt-validate] trigger { valid: false, errors: 1 }
[zookeeper:json-error-nudge] trigger { tool: "webfetch", pattern: "...", }
[zookeeper:direct-work-nudge] trigger { tool: "edit" }
[zookeeper:post-task-nudge] trigger { hasTodo: true, nudge: "beaver" }
```

## CLI 工具

`tools/` 下有 4 个 CLI 工具用于分析 zoo 插件日志、会话记录和 token 消耗。

| 工具 | 语言 | 职责 | 主要子命令 |
|------|------|------|-----------|
| `zfind` | Rust | 搜索 SQLite 中的会话与消息 | `search <keyword>` / `search --exact <title>` / `list [--all]` / `show <sid>` / `message <id>` |
| `zlog` | Rust | 实时过滤 zoo JSONL 日志 | `show <id>` / `tail <id>`（支持 `--hook` / `--level` / `--event` / `--raw` 过滤） |
| `ztrace` | Rust | 完整编排追踪（多源合并） | `show <id>` / `export <id>` / `steps <id>` / `tokens <id>` |
| `zinspect` | Rust | 事件统计与 hook 影响分析 | `stats <id>` / `stats --sessions N` / `timeline <id>` / `impact [<id>]` |

**共享标志**（全部四工具）：`--json` / `--no-color`；`zfind` / `ztrace` / `zinspect` 额外 `--db <path>`。
**短标志**：`-j`（`--json`）、`-a`（`--all`，含子会话）、`-v`（`--verbose`）。

**退出码**：`0` 成功 / `1` 参数错误 / `2` 未找到。全部工具支持 session ID 前缀匹配。

**典型工作流：**

```shell
# 1. 用 zfind 搜索会话，单条匹配时只输出 ID（管道友好）
$ ztrace steps $(zfind search "auth middleware")

# 2. 追踪单个会话的 step 级 token 消耗
$ ztrace steps <sid> --min-cache-drop 1000
```
