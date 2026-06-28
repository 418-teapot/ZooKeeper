# ZooKeeper

一个 OpenCode 编排器插件，通过静态权限配置 + 运行时 Prompt 注入，确保各个 AI Agent 各司其职、不越权操作。

## 功能特性

### Agent 定义

| Agent | 角色 |
|-------|------|
| `dolphin` | 编排器 — 负责任务分发与结果验证 |
| `lynx` | 代码探索 — 搜索和发现代码库内容 |
| `beaver` | 通用编码 — 读写文件、执行命令 |
| `spider` | 网络调研 — 网页抓取和信息收集 |

### 运行时增强

插件在运行时通过 Prompt 注入和行为引导 hook 增强 Agent 能力：

- **Prompt 注入**：自动将 `src/agents/<name>.ts` 中定义的 prompt 常量注入到对应 Agent，无需手动配置
- **Task Prompt 校验**：拦截格式不合规的 `task()` 调用，要求包含 SUMMARY / CONTEXT / ACCEPTANCE 三段式结构
- **直接工作提醒**：当编排器直接执行代码编辑时，提醒其应当委派子代理完成任务
- **JSON 错误恢复**：检测工具输出中的 JSON 解析错误，自动注入修复提示
- **任务完成验证**：每次子代理返回后，注入标准化的验证清单，确保结果被严格审查
- **聚焦提醒**：每轮 LLM 回复前，向编排器注入"保持聚焦、委派子代理"的提醒
- **Prompt 长度检测**：根据 `[zoo.validation]` 阈值自动检测 Task Prompt 是否过长或包含不推荐的代码片段

### 技能管理

插件支持通过 `[zoo.skills]` 配置控制技能（Skill）的启用与禁用。技能存放在 `core/skills/` 目录下，每个技能为一个独立子目录（如 `core/skills/git-commit/`）。

```toml
[zoo.skills]
git-commit = "enable"    # 启用技能
# my-skill = "disable"   # 禁用技能
```

设置为 `"enable"` 时，插件会在运行时注册该技能；设置为 `"disable"` 时则跳过。未在配置中列出的技能默认启用。

## 安装

### 前置要求

- Python 3（无需额外依赖，仅使用标准库）
- [OpenCode](https://opencode.ai)

### 安装步骤

**1. 克隆仓库**

```bash
git clone <repository-url>
cd ZooKeeper
```

**2. 配置环境变量**

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 LLM API 凭据：

```
# 模型 ID（所有 Agent 共用）
ZOO_MODEL=Cambricon/glm-5.1
ZOO_MEDIUM_MODEL=Cambricon/glm-5.1
ZOO_SMALL_MODEL=Cambricon/deepseek-v4-flash

# Provider 凭据 — 只需设置你实际使用的 Provider，其余可注释或留空
CAMBRICON_API_KEY=your-api-key-here
CAMBRICON_BASE_URL=https://api.example.com/v1
DEEPSEEK_API_KEY=your-deepseek-api-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
```

**3. 生成 OpenCode 配置**

```bash
python3 install.py
```

安装脚本读取 `config.toml` + `.env`，解析 `{env:VAR}` 占位符，将编译后的配置写入 `~/.config/opencode/opencode.json`。已有配置会自动备份（带时间戳）。同时创建 Wiki 和 CLI 工具的软链接到 `~/.zoo/`。

**4. 添加 CLI 工具到 PATH**

将 `~/.zoo/tools/bin` 加入 `PATH` 环境变量，使 `zwiki`、`zlog` 等 CLI 工具全局可用。
