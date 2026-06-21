# AI 代理编码指南

本文件为在本仓库中操作的 AI 代理提供编码指南。

## 项目概览

**ZooKeeper** — 一个 OpenCode 编排器插件，通过静态配置权限 + prompt 注入确保编排器不越权调用工具。基于 Python + TypeScript + Rust 构建。

核心机制：`config.toml` 中声明各 agent 的 `permission` deny 列表（**单一事实来源**）和 `[zoo.validation]` 阈值（上下文/提示词长度限制），install.py 编译 permission 部分后写入 OpenCode 配置；`[zoo.validation]` 阈值由 TS 插件在运行时直接读取；插件在 `config` hook 里注入 `core/prompts/*.md` 作为各 agent 的 prompt。

## 命令

| 命令 | 说明 |
|------|------|
| `python3 install.py` | 安装/更新 OpenCode 配置（读取 config.toml + .env → 生成 ~/.config/opencode/opencode.json） |
| `./check.sh` | 自动修复 + 严格 lint（Python + TS + Rust），禁止 `#[expect]`/`#[allow]` |
| `./test.sh` | 统一测试入口（Python + Rust 测试 + 覆盖率 + TS 单元测试） |
| `./build.sh` | Release 编译 Rust CLI 工具（zlog / zfind / ztrace / zinspect） |
| `python3 tests/runner.py --dry-run` | 干跑（不调用 LLM，回放 JSONL） |
| `python3 tests/runner.py --scenario <name>` | 只跑指定场景 |
| `python3 tests/runner.py --replay` | 从 JSONL 回放（不调 LLM，只跑断言+阈值） |
| `python3 tests/runner.py --replay --scenario <name>` | 回放指定场景 |
| `python3 tests/runner.py -v` | 详细输出（标准错误、指标明细、堆栈） |

> **已知失败说明：** `build-pressure-2` 场景测试"语言正确性 vs 行为完整性"问题，预期失败已被 `test.sh` 排除。详见 `docs/verbal-correctness-vs-behavioral-completeness.md`。

## 代码风格

### 通用规则
- **注释英文**，用户界面输出中文
- **不使用项目内部术语当注释**：如"L1/L2"分层概念不出现在代码注释里，只用通用自解释描述

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
├── install.py               # 安装脚本（读取 config.toml + .env → 生成配置）
├── config.toml              # 用户可编辑的配置模板（{env:VAR} 占位符；含 [zoo.validation] 阈值）
├── .env / .env.example      # 环境变量（apiKey、baseURL、模型名）
├── check.sh                 # 统一 lint/format 脚本
├── test.sh                  # 统一测试脚本（Python + Rust + TS）
├── build.sh                 # Release 编译 Rust CLI 工具
├── core/
│   └── prompts/*.md         # 各 agent 的 prompt 文件（被插件动态注入）
├── src/                     # OpenCode 插件 TS 代码
│   ├── index.ts             # 插件入口（config hook + prompt validation）
│   └── hooks/
│       ├── task-prompt/     # task prompt 校验 + nudge
│       ├── json-error-nudge/# JSON 解析错误恢复
│       ├── direct-work-nudge/# 直接编辑提醒
│       ├── post-task-nudge/ # task() 返回后验证+todo 提醒
│       └── shared/          # 共享模块
├── tests/                   # Prompt 评估测试框架（Phase 1: build.md）
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

- **`install.py`** — 安装脚本入口，读取 config.toml + .env → 生成 OpenCode 配置
- **`config.toml`** — 用户配置模板（单一事实来源），所有 deny 权限和 agent 配置在此声明，`[zoo.validation]` 阈值由 TS 插件在运行时直接读取
- **`src/index.ts`** — 插件入口，导出 `config` hook 动态注入 prompt + 任务 prompt 校验
- **`core/prompts/*.md`** — 各 agent 的 prompt 文件，按 `{agent-name}.md` 命名
- **`tools/Cargo.toml`** — Rust workspace 根配置

## 调试/日志

OpenCode 日志写入以下位置：

- **macOS/Linux：** `~/.local/share/opencode/log/`
- **Windows：** `%USERPROFILE%\.local\share\opencode\log`

日志文件按时间戳命名（如 `2025-01-09T123456.log`），保留最近 10 个日志文件。可使用 `--log-level DEBUG` 命令行选项获取更详细的调试信息。

### 插件调试日志

所有 hook 使用 `src/hooks/shared/logger.ts` 导出的 `debug()` 函数输出触发记录，格式为 `[zookeeper:<hook-name>] trigger`。

- **info/warn/error 始终记录** — 即使不设置 `ZOO_DEBUG`，这三个级别也会写入日志文件
- **debug 日志默认关闭** — 设置 `ZOO_DEBUG=1 opencode`（或在 shell 中 `export ZOO_DEBUG=1`）后额外启用 debug 级别
- **输出目标：** stderr（不进 TUI），避免 Bun 将 `console.debug` 当成 `console.log` 污染界面

示例输出：

```
[zookeeper:task-prompt-validate] trigger { valid: false, errors: 1 }
[zookeeper:json-error-nudge] trigger { tool: "webfetch", pattern: "...", }
[zookeeper:direct-work-nudge] trigger { tool: "edit" }
[zookeeper:post-task-nudge] trigger { hasTodo: true, nudge: "general" }
```

## CLI 工具

`tools/` 下有 4 个 CLI 工具用于分析 zoo 插件日志、会话记录和 token 消耗。
完整文档见 `docs/tools-design.md`。

| 工具 | 语言 | 职责 | 主要子命令 |
|------|------|------|-----------|
| `zfind` | Rust | 搜索 SQLite 中的会话与消息 | 模糊搜索 / `--all` / `--exact` / `--session <sid>` / `--message <id>` |
| `zlog` | Rust | 实时过滤 zoo JSONL 日志 | `show <id>` / `tail <id>`（支持 `--hook` / `--level` / `--event` 过滤） |
| `ztrace` | Rust | 完整编排追踪（多源合并） | `show <id>` / `export <id>` / `steps <id>` / `tokens <id>` |
| `zinspect` | Rust | 事件统计与 hook 影响分析 | `stats <id>` / `stats --sessions N` / `timeline <id>` / `impact` |

**共享标志**（`zfind` / `ztrace` / `zinspect`）：`--db <path>` / `--no-color` / `--json`。

**退出码**：`0` 成功 / `1` 错误 / `2` 未找到。`zlog` 支持 session ID 前缀匹配；`zfind`、`ztrace`、`zinspect` 需完整 ID。

**典型工作流：**

```shell
# 1. 用 zfind 搜索会话，单条匹配时只输出 ID（管道友好）
$ ztrace show $(zfind "auth middleware") -s

# 2. 追踪单个会话的 step 级 token 消耗
$ ztrace steps <sid> --min-cache-drop 1000
```
