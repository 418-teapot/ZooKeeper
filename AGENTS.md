# 开发指南

## 项目概览

ZooKeeper 是一个 OpenCode 编排器插件，通过静态配置权限 + prompt 注入确保编排器不越权调用工具。

核心机制：`config.toml` 中声明各 agent 的 `permission` deny 列表（**单一事实来源**），install.py 编译后写入 OpenCode 配置；插件在 `config` hook 里注入 `core/prompts/*.md` 作为各 agent 的 prompt。

## 目录结构

```
install.py              ← 安装脚本（读取 config.toml + .env → 生成 ~/.config/opencode/opencode.json）
config.toml             ← 用户可编辑的配置模板（{env:VAR} 占位符）
.env / .env.example     ← 环境变量（apiKey、baseURL、模型名）
check.sh                ← 统一 lint/format 脚本
core/prompts/*.md       ← 各 agent 的 prompt 文件（被插件动态注入）
adapters/opencode/src/  ← OpenCode 插件 TS 代码
tests/                  ← Prompt 评估测试框架（Phase 1: build.md）
docs/                   ← 设计文档和调研报告
```

生成的配置写入 `~/.config/opencode/opencode.json`（不在 git 仓库里）。项目级 `opencode.json` 已 gitignore。

## 关键约束

- **config.toml 里的 `{env:VAR}` 占位符**：install.py 运行时全部解析为 `.env` 中的实际值写入 JSON。输出的 JSON 里不含任何 `{env:}` 字符串。
- **agent 的 model 字段**：必须写入实际模型名（如 `Cambricon/glm-5.1`），OpenCode 不在 model 字段解析 `{env:}`。
- **apiKey/baseURL 也解析为实际值**：密钥写入 `~/.config/opencode/opencode.json`（仅本地，不在 git 里）。
- **没有 .env 文件时 install.py 直接报错退出**，不会生成含 `{env:}` 的无效配置。
- **config.toml 中每个 agent 都显式指定 model**：没有自动填充逻辑，全由用户在 config.toml 或 .env 里配置。

## 开发命令

```bash
# 安装/更新 OpenCode 配置
python3 install.py

# lint + format（Python + TypeScript）
./check.sh            # check:  自动修复
./check.sh lint       # lint:   只检查不修复
./check.sh format     # format: 只格式化

# Prompt 评估测试
python3 tests/runner.py --dry-run                 # 干跑（不调用 LLM）
python3 tests/runner.py --scenario build-green    # 只跑指定场景
python3 tests/runner.py --replay                  # 从 JSONL 回放（不调 LLM，只跑断言+阈值）
python3 tests/runner.py --replay --scenario build-green  # 回放指定场景
python3 tests/runner.py -v                        # 详细输出（标准错误、指标明细、堆栈）
python3 -m pytest tests/test_static.py -v         # 静态分析测试
```

## 代码风格

- **Python**：ruff（lint + format），Google docstring 风格（Args/Returns/Raises），注释英文，用户界面输出中文
- **TypeScript**：Biome v2（lint + format），JSDoc 风格（@param/@returns），注释英文，2-space 缩进，双引号，80 字符行宽
- **install.toml**：注释中文（用户可编辑的配置文件）
- **不使用项目内部术语当注释**：如"L1/L2"分层概念不出现在代码注释里，只用通用自解释描述

## 插件工作原理

OpenCode 支持两种互补的约束机制，ZooKeeper 各用其一：

### 1. 工具 deny — 由 `config.toml` 定义（单一事实来源）

每个 agent 的 `permission` 块中，通过 `<tool> = "deny"` 列出禁止工具。install.py 把这一段原样写入 `~/.config/opencode/opencode.json`，OpenCode 启动时从 agent 的工具定义列表中移除这些工具，LLM 根本看不到它们。

```toml
# 示例
[agent.build.permission]
grep = "deny"
glob = "deny"
```

**为什么不用插件设 permission？** 插件的 `config` hook 在 OpenCode 已经构造好 agent 配置之后才执行，对已构造好的工具列表做运行时拦截更可靠，但会引入时序问题。静态配置在加载阶段就完成 deny，行为更可预测。

**完整的 deny 配置见 `config.toml`**。需要新增禁止工具时，只改这一个文件，然后 `python3 install.py` 重新生成配置。

### 2. Prompt 注入 — 由插件动态注入

`adapters/opencode/src/index.ts` 是插件入口，导出 `config` hook：

1. 遍历 config 中所有 agent
2. 从 `core/prompts/{agent-name}.md` 加载 prompt 并注入到 `agent.prompt`

prompt 文件在运行时动态加载，不需要 install.py。改 prompt 后**下一轮 opencode 调用**即可看到新行为（插件是每次 opencode run 重新加载的 .ts 文件）。

## 环境变量

| 变量 | 用途 | 示例值 |
|------|------|--------|
| `CAMBRICON_API_KEY` | AI 服务密钥 | `sk-abc123def456` |
| `CAMBRICON_BASE_URL` | API 地址 | `https://api.example.com/v1` |
| `CAMBRICON_MODEL` | 主模型 | `Provider/model-name` |
| `CAMBRICON_SMALL_MODEL` | 小模型 | `Provider/small-model-name` |

在项目根目录创建 `.env` 文件（参考 `.env.example`），install.py 自动加载。

## 未来计划（代码中的 TODO）

- Claude Code 适配器（PreToolUse Python hook + CLAUDE.md）
- Hook 级别的工具 deny（运行时拦截，而非仅 SDK 移除）
