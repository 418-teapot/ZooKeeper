# 开发指南

## 项目概览

ZooKeeper 是一个 OpenCode 编排器插件，通过 SDK deny + prompt 注入确保编排器不越权调用工具。

核心机制：插件在 `config` hook 里就地修改每个 agent 的 `permission`（deny 工具）和 `prompt`（从 `.md` 文件注入）。

## 目录结构

```
install.py              ← 安装脚本（读取 config.toml + .env → 生成 ~/.config/opencode/opencode.json）
config.toml             ← 用户可编辑的配置模板（{env:VAR} 占位符）
.env / .env.example     ← 环境变量（apiKey、baseURL、模型名）
check.sh                ← 统一 lint/format 脚本
core/prompts/*.md       ← 各 agent 的 prompt 文件（被插件动态注入）
adapters/opencode/src/  ← OpenCode 插件 TS 代码
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

# 仅 Python
ruff check install.py
ruff format install.py

# 仅 TypeScript
npx biome check --write adapters/opencode/src/
npx biome lint adapters/opencode/src/
npx biome format --write adapters/opencode/src/
```

## 代码风格

- **Python**：ruff（lint + format），Google docstring 风格（Args/Returns/Raises），注释英文，用户界面输出中文
- **TypeScript**：Biome v2（lint + format），JSDoc 风格（@param/@returns），注释英文，2-space 缩进，双引号，80 字符行宽
- **install.toml**：注释中文（用户可编辑的配置文件）
- **不使用项目内部术语当注释**：如"L1/L2"分层概念不出现在代码注释里，只用通用自解释描述

## 插件工作原理

`adapters/opencode/src/index.ts` 是插件入口，导出 `config` hook：

1. 遍历 config 中所有 agent
2. 从 `core/prompts/{agent-name}.md` 加载 prompt 并注入到 `agent.prompt`
3. 从 `blocked-tools.ts` 的 `BLOCKED` 字典读取工具 deny 列表，设置 `agent.permission[tool] = "deny"`

工具 deny 是 SDK 级别：OpenCode 从 agent 的工具定义列表中移除这些工具，LLM 根本看不到它们。

当前 deny 配置：
- build: grep, glob, webfetch, websearch
- spider: edit, write, bash
- explore: edit, write

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
