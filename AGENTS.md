# AI 代理编码指南

本文件为在本仓库中操作的 AI 代理提供编码指南。

## 项目概览

**ZooKeeper** — 一个 OpenCode 编排器插件，通过静态配置权限 + prompt 注入确保编排器不越权调用工具。基于 Python + TypeScript 构建。

核心机制：`config.toml` 中声明各 agent 的 `permission` deny 列表（**单一事实来源**），install.py 编译后写入 OpenCode 配置；插件在 `config` hook 里注入 `core/prompts/*.md` 作为各 agent 的 prompt。

## 命令

| 命令 | 说明 |
|------|------|
| `python3 install.py` | 安装/更新 OpenCode 配置（读取 config.toml + .env → 生成 ~/.config/opencode/opencode.json） |
| `./check.sh` | 自动修复 lint + format 问题 |
| `./check.sh lint` | 只检查 lint 不修复 |
| `./check.sh format` | 只格式化 |
| `./test.sh` | 统一测试入口（静态分析 + dry-run + TS 单元测试） |
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

### TOML
- **注释中文**（用户可编辑的配置文件）
- `config.toml` 中的 `{env:VAR}` 占位符由 install.py 在运行时解析

## 目录结构

```
ZooKeeper/
├── install.py               # 安装脚本（读取 config.toml + .env → 生成配置）
├── config.toml              # 用户可编辑的配置模板（{env:VAR} 占位符）
├── .env / .env.example      # 环境变量（apiKey、baseURL、模型名）
├── check.sh                 # 统一 lint/format 脚本
├── test.sh                  # 统一测试脚本（Python 静态测试 + dry-run + TS 单元测试）
├── core/
│   └── prompts/*.md         # 各 agent 的 prompt 文件（被插件动态注入）
├── src/                        # OpenCode 插件 TS 代码
│   ├── index.ts                # 插件入口（config hook + prompt validation）
│   └── hooks/                  # 各功能 hook（如 json-error-recovery）
├── tests/                   # Prompt 评估测试框架（Phase 1: build.md）
│   └── runner.py            # 评估测试运行器
└── docs/                    # 设计文档和调研报告
```

生成的配置写入 `~/.config/opencode/opencode.json`（不在 git 仓库里）。项目级 `opencode.json` 已 gitignore。

## 开发流程

1. 修改代码（config.toml、prompt 文件、插件代码等）
2. 运行 `./check.sh` 自动修复 lint/format 问题
3. 运行 `./test.sh` 验证测试通过（静态分析 + dry-run + TS 单元测试）

## 关键文件

- **`install.py`** — 安装脚本入口，读取 config.toml + .env → 生成 OpenCode 配置
- **`config.toml`** — 用户配置模板（单一事实来源），所有 deny 权限和 agent 配置在此声明
- **`src/index.ts`** — 插件入口，导出 `config` hook 动态注入 prompt + 任务 prompt 校验
- **`core/prompts/*.md`** — 各 agent 的 prompt 文件，按 `{agent-name}.md` 命名

## 调试/日志

OpenCode 日志写入以下位置：

- **macOS/Linux：** `~/.local/share/opencode/log/`
- **Windows：** `%USERPROFILE%\.local\share\opencode\log`

日志文件按时间戳命名（如 `2025-01-09T123456.log`），保留最近 10 个日志文件。可使用 `--log-level DEBUG` 命令行选项获取更详细的调试信息。
