# ZooKeeper

同时适配 OpenCode 和 pi 两个宿主的编排器插件，具备静态权限配置 + 运行时 Prompt 注入。

## 功能特性

### Agent 定义

| Agent | 角色 |
|-------|------|
| `dolphin` | 编排器 — 任务分发与结果验证 |
| `mola` | 规划顾问 — 产出 plan artifacts 到 `.zoo/plans`，不执行代码 |
| `lynx` | 代码探索 — 搜索和理解代码库，只读 |
| `beaver` | 编码实现 — 读写文件、执行命令 |
| `spider` | 网络调研 — 网页抓取和信息收集 |
| `eagle` | 代码审查 — 只读审查，由 code-review 技能加载 |
| `kiwi` | 知识分析 — wiki 蒸馏/验证，由对应技能加载 |

### 运行时增强

插件在运行时通过 Prompt 注入和行为引导 hook 增强 Agent 能力：

- **Prompt 注入**：自动将 `src/agents/<name>.ts` 中定义的 prompt 常量注入到对应 Agent，无需手动配置
- **Task Prompt 校验**：拦截格式不合规的 `task()` 调用，要求包含 SUMMARY / CONTEXT / ACCEPTANCE 三段式结构
- **直接工作提醒**：当编排器直接执行代码编辑时，提醒其应当委派子代理完成任务
- **JSON 错误恢复**：检测工具输出中的 JSON 解析错误，自动注入修复提示
- **任务完成验证**：每次子代理返回后，注入标准化的验证清单（post-task nudge），确保结果被严格审查
- **Prompt 长度检测**：自动检测 Task Prompt 是否过长或包含不推荐的代码片段
- **上下文管理**：自动管理上下文，包括消息去重、错误清理、压缩与用量提醒
- **模型变体**：支持为不同 Agent 分配模型变体（high / low / max 等）

### 技能管理

插件内置 10 个技能，存放在 `core/skills/` 目录下（每个技能为一个独立子目录），会根据任务类型按需自动加载：

- `beaver-tdd` — 测试驱动开发
- `code-review` — 代码审查
- `git-commit` — 标准化的 Git 提交
- `grill` — 计划/设计审查，沿决策树逐层质询直至达成共识
- `kiwi-distill` — 知识蒸馏
- `kiwi-verify` — 源回溯验证
- `mola-plan` — 从需求澄清到计划落地
- `wiki-ingest` — wiki 知识收录
- `wiki-query` — wiki 知识查询
- `wiki-verify` — wiki 知识验证

## 安装

### 前置要求

- Python 3（无需额外依赖，仅使用标准库）
- OpenCode 和/或 pi（`install.py` 自动检测已安装的宿主，缺失则跳过对应配置）

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
# 模型 ID
ZOO_WHALE_MODEL=Cambricon/glm-5.1
ZOO_HIPPO_MODEL=Cambricon/glm-5.1
ZOO_ANT_MODEL=Cambricon/deepseek-v4-flash

# Provider 凭据 — 只需设置你实际使用的 Provider，其余可注释或留空
CAMBRICON_API_KEY=your-api-key-here
CAMBRICON_BASE_URL=https://api.example.com/v1
DEEPSEEK_API_KEY=your-deepseek-api-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic

# GitLab MCP（可选）
GITLAB_MCP_URL=https://api.example.com/mcp
GITLAB_ACCESS_TOKEN=your-gitlab-private-token-here
```

**3. 生成宿主配置**

```bash
uv run python install.py
```

**4. 添加 CLI 工具到 PATH**

将 `~/.zoo/tools/bin` 加入 `PATH` 后即可使用：

- `zwiki` — wiki 知识库管理
- `zlog` — 日志过滤
- `zfind` — 会话搜索
- `zinspect` — 事件统计
- `ztrace` — 编排追踪
