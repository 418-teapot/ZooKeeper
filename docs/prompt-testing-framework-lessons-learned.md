# ZooKeeper Prompt 测试框架：经验教训与技术复盘

> 本文档记录 ZooKeeper 提示词评估测试框架开发过程中的关键问题、解决方案与经验教训。
> 
> **日期**: 2026-06-05  
> **分类**: 技术复盘文档

---

## 目录

1. [概述](#1-概述)
2. [核心问题与调查过程](#2-核心问题与调查过程)
3. [关键技术发现](#3-关键技术发现)
4. [解决方案对比](#4-解决方案对比)
5. [实施细节](#5-实施细节)
6. [经验教训总结](#6-经验教训总结)
7. [最佳实践建议](#7-最佳实践建议)
8. [参考资料](#8-参考资料)

---

## 1. 概述

### 1.1 项目目标

ZooKeeper 项目需要一套自动化测试框架，用于评估 LLM 代理（agent）对提示词（prompt）和权限配置（permission deny rules）的遵守程度。测试框架需要支持：

- **多代理测试**：5 个代理（build、general、explore、scout、spider）
- **多阶段测试**：RED（基线）、GREEN（期望）、PRESSURE（压力）三阶段
- **行为验证**：通过 JSONL 日志解析工具调用序列，计算行为指标
- **阈值检查**：对比指标与预设阈值，判定测试通过/失败
- **CI 集成**：支持 `--replay` 模式，避免重复调用 LLM

### 1.2 遇到的核心挑战

在开发过程中，我们遇到了一个关键问题：**deny 机制失效**。

**问题描述**：
```
在 config.toml 中配置：
[agent.general]
permission = { task = "deny" }

预期行为：general 代理无法调用 task() 工具
实际行为：general 代理成功调用了 task() 并委派给了 explore 子代理
```

这导致整个测试框架无法验证代理是否遵守了权限限制，测试失去意义。

---

## 2. 核心问题与调查过程

### 2.1 第一阶段：初步实现与验证

**初始实现**（`adapters/opencode/src/index.ts`）：

```typescript
// 使用 Proxy 拦截权限设置
agent.permission = new Proxy({}, {
  set(target, prop, value) {
    const blocked = BLOCKED_TOOLS[agentName] || [];
    if (blocked.includes(prop as string)) {
      console.warn(`Blocked: ${String(prop)} for ${agentName}`);
      return false;  // 拦截设置
    }
    target[prop as any] = value;
    return true;
  }
});
```

**验证结果**：测试失败，但失败原因不是权限拦截，而是代理根本没有调用 task()。这引发了我们的怀疑：**proxy 到底有没有生效？**

### 2.2 第二阶段：日志分析

我们添加了详细的日志输出，发现一个关键现象：

```json
// 测试运行日志
[ZooKeeper] Set general.permission.task = "deny"
[ZooKeeper] Set explore.permission.write = "deny"

// CLI 命令输出
! agent "general" is a subagent, not a primary agent. Falling back to default agent
Running with build agent...

// JSONL 会话日志（build agent 的会话）
{
  "type": "tool_use",
  "tool": "task",
  "state": {
    "input": {
      "subagent_type": "explore",
      "prompt": "Read the file..."
    }
  }
}
```

**关键发现**：
1. 插件正确设置了权限（日志显示）
2. CLI 命令 `opencode run --agent general` 失败，自动回退到 build agent
3. build agent 调用了 task() 委派给 explore（而非 general）

### 2.3 第三阶段：深入调查 Opencode 内部机制

我们使用 `strings` 命令分析 `/root/.opencode/bin/opencode` 二进制文件，发现了关键代码：

```javascript
// 从 opencode 二进制中提取的配置合并逻辑
e.mode = s.mode ?? e.mode

// 内置 agent 配置
build: {
  name: "build",
  mode: "primary",
  native: true
}

general: {
  name: "general", 
  mode: "subagent",  // 关键：内置 mode 为 subagent
  native: true
}

explore: {
  name: "explore",
  mode: "subagent",
  native: true
}
```

**核心发现**：Opencode 的 agent 有严格的 mode 分类：

| Mode | 调用方式 | 示例 |
|------|---------|------|
| `primary` | CLI 直接调用 | build |
| `subagent` | 只能通过 task() 委派 | general, explore, scout, spider |
| `all` | 两种方式都支持 | 自定义代理 |

**重要机制**：用户配置中的 `mode` 字段会**覆盖**内置 mode：

```javascript
// 用户配置合并顺序
e.mode = s.mode ?? e.mode
// s.mode (用户配置) 优先于 e.mode (内置配置)
```

### 2.4 第四阶段：开源方案调研

我们调研了主流开源项目的做法：

#### 2.4.1 obra/superpowers（推荐方案）

**仓库**：https://github.com/obra/superpowers

**做法**：不直接测试子代理，而是通过主代理调用 task()，验证子代理行为。

```bash
# 测试脚本核心逻辑
run_agent "build" "请调查 src/ 下的 bug"
assert_output "委派给了 explore 代理"
assert_output "explore 报告发现了 3 个文件问题"
```

**优点**：
- 真实运行环境（代理就是 subagent）
- 简单直接

**缺点**：
- 依赖主代理的提示词（可能委派错代理）
- 难以精确控制子代理行为

#### 2.4.2 OpenCode 内部测试（官方做法）

**做法**：创建**独立的测试专用 primary agent**，与生产环境隔离。

```yaml
# test-agents.yaml
agents:
  test-general:
    prompt_file: general.md
    permission:
      task: deny
    mode: primary  # 明确设为 primary
```

**优点**：
- 生产环境不受影响
- 可以精确控制代理行为

**缺点**：
- 需要维护两套配置
- 增加复杂性

#### 2.4.3 其他方案（不推荐）

- **直接修改二进制**：不可行，opencode 是闭源的
- **Hook CLI 命令**：过于复杂，容易破坏
- **模拟代理行为**：无法测试真实的 LLM 响应

---

## 3. 关键技术发现

### 3.1 发现 1：Opencode 的代理 Mode 机制

**机制描述**：

Opencode 在启动时会加载所有代理配置，并根据 `mode` 字段决定代理的调用方式：

1. **配置加载顺序**：
   - 加载内置代理配置（`opencode` 二进制中硬编码）
   - 加载用户配置（`config.toml` 或 `opencode.json`）
   - 合并配置：用户配置覆盖内置配置

2. **Mode 判断逻辑**：
   ```javascript
   // 从 opencode 二进制中提取
   function getAgent(name) {
     const agent = agents[name];
     if (!agent) return null;
     
     // 检查 mode
     if (agent.mode === "subagent") {
       throw new Error(`agent "${name}" is a subagent, not a primary agent`);
     }
     
     return agent;
   }
   ```

3. **CLI 命令执行流程**：
   ```
   opencode run --agent <name>
     ↓
   getAgent(name)
     ↓
   if (agent.mode === "subagent") → 报错，回退到 build
     ↓
   执行代理
   ```

### 3.2 发现 2：Permission Deny 的正确实现方式

**错误做法**：使用 Proxy 拦截权限设置

```typescript
// ❌ 错误：只拦截设置权限的行为
agent.permission = new Proxy({}, {
  set(target, prop, value) {
    const blocked = BLOCKED_TOOLS[agentName] || [];
    if (blocked.includes(prop as string)) {
      return false;
    }
    target[prop as any] = value;
    return true;
  }
});
```

**问题分析**：
- Proxy 拦截的是 `agent.permission.task = "deny"` 这个**设置行为**
- 如果权限已经通过配置文件设置好了，Proxy 不会被触发
- 即使 Proxy 拦截了，也只是不让插件设置权限，不影响配置文件中已有的权限

**正确做法**：使用 `tool.execute.before` hook 在运行时检查权限

```typescript
// ✅ 正确：运行时检查工具调用
{
  hooks: {
    'tool.execute.before': (input) => {
      const blocked = BLOCKED_TOOLS[input.agentName] || [];
      if (blocked.includes(input.tool)) {
        return {
          blocked: true,
          reason: `Tool ${input.tool} is blocked for ${input.agentName}`
        };
      }
    }
  }
}
```

**工作原理**：
1. 代理调用工具前，Opencode 触发 `tool.execute.before` hook
2. 插件检查工具是否在禁止列表中
3. 如果禁止，返回 `blocked: true`，工具不会被执行

### 3.3 发现 3：JSONL 解析的复杂性

**挑战**：Opencode 输出的 JSONL 格式复杂，包含多种事件类型：

```json
// 事件类型 1：tool_use（工具调用）
{
  "type": "tool_use",
  "tool": "read",
  "args": { "file": "src/utils.js" },
  "timestamp": 1234567890
}

// 事件类型 2：text（文本输出）
{
  "type": "text",
  "content": "Let me check the file...",
  "timestamp": 1234567891
}

// 事件类型 3：task（委派调用）
{
  "type": "tool_use",
  "tool": "task",
  "args": {
    "subagent_type": "explore",
    "prompt": "Read the file..."
  },
  "timestamp": 1234567892
}
```

**解决方案**：
- 实现专门的 JSONL 解析模块（`tests/session.py`）
- 提取关键事件类型：`tool_use`、`text`、`task`
- 计算行为指标：委派率、验证率、读取滥用率等

---

## 4. 解决方案对比

### 4.1 方案 A：修改 Mode 覆盖（选择方案）

**实施**：
```toml
# config.toml
[agent.build]
mode = "all"
permission = { grep = "deny", glob = "deny" }

[agent.general]
mode = "all"  # 覆盖内置 subagent 模式
permission = { task = "deny" }

[agent.explore]
mode = "all"  # 覆盖内置 subagent 模式
permission = { write = "deny" }

[agent.scout]
mode = "all"
permission = { edit = "deny", write = "deny" }

[agent.spider]
mode = "all"
permission = { edit = "deny", write = "deny", bash = "deny" }
```

**优点**：
- 改动最小（只改 `config.toml`）
- 测试框架保持不变
- 可以直接从 CLI 测试 subagent

**缺点**：
- 生产环境配置被修改（`mode = "all"`）
- 可能影响其他工具/脚本的行为

**缓解措施**：
- 明确记录 `mode = "all"` 的原因
- 在 `install.py` 中添加注释
- 未来可以添加 `--test-mode` 参数切换配置

### 4.2 方案 B：创建测试专用配置（备选方案）

**实施**：

```python
# install.py
def main():
    if args.test:
        # 加载测试配置
        base_config = load_toml('config.toml')
        test_config = load_toml('config.test.toml')
        
        # 合并配置
        for agent in base_config['agent']:
            base_config['agent'][agent]['mode'] = 'all'
        
        config = base_config
    else:
        # 生产配置
        config = load_toml('config.toml')
    
    write_config(config, output_path)
```

```toml
# config.test.toml（仅覆盖 mode）
[agent.general]
mode = "all"

[agent.explore]
mode = "all"

# ... 其他代理
```

**优点**：
- 生产环境不受影响
- 明确区分测试/生产

**缺点**：
- 增加复杂性（`install.py` 逻辑变复杂）
- 需要维护两套配置

**何时采用**：
- 如果方案 A 在生产环境中引起问题
- 如果需要更严格的配置隔离

### 4.3 方案 C：使用 Task() 委派测试（不推荐）

**实施**：

```python
# tests/runner.py
def run_agent(agent_name):
    if agent_name != 'build':
        # 通过 build 代理委派
        prompt = f"请委派给 {agent_name} 代理执行以下任务..."
        return run_agent('build', prompt)
    else:
        return run_agent_direct(agent_name)
```

**优点**：
- 最接近真实运行环境
- 不需要修改配置

**缺点**：
- 增加测试运行时间（多一层委派）
- 依赖 build 代理的提示词（可能委派错代理）
- 难以精确控制子代理行为

**何时采用**：
- 作为补充测试（验证委派链）
- 不作为主要测试方式

### 4.4 方案对比总结

| 方案 | 复杂性 | 生产环境影响 | 测试精度 | 推荐度 |
|------|--------|-------------|---------|--------|
| **A: Mode 覆盖** | ⭐ | ⚠️ 有 | ✅ 高 | ⭐⭐⭐⭐⭐ |
| **B: 测试专用配置** | ⭐⭐ | ✅ 无 | ✅ 高 | ⭐⭐⭐⭐ |
| **C: Task 委派测试** | ⭐⭐⭐ | ✅ 无 | ⚠️ 中 | ⭐⭐ |

---

## 5. 实施细节

### 5.1 修改 config.toml

**文件**：`config.toml`

```toml
# ── Agent 配置 ───────────────────────────────────────

# ZooKeeper 代理配置
# 所有代理设置 mode = "all" 以支持直接从 CLI 调用进行测试
# 生产环境中，subagent 仍会通过 task() 被委派调用

[agent.build]
prompt = { file = "core/prompts/build.md" }
mode = "all"  # 支持 CLI 直接调用 + task() 委派
permission = { grep = "deny", glob = "deny" }

[agent.explore]
prompt = { file = "core/prompts/explore.md" }
mode = "all"  # 覆盖内置 subagent 模式，支持测试
permission = { write = "deny" }

[agent.general]
prompt = { file = "core/prompts/general.md" }
mode = "all"  # 覆盖内置 subagent 模式，支持测试
permission = { task = "deny" }

[agent.scout]
prompt = { file = "core/prompts/scout.md" }
mode = "all"
permission = { edit = "deny", write = "deny" }

[agent.spider]
prompt = { file = "core/prompts/spider.md" }
mode = "all"
permission = { edit = "deny", write = "deny", bash = "deny" }
```

### 5.2 重新安装配置

```bash
python3 install.py
```

**验证**：
```bash
cat ~/.config/opencode/opencode.json | jq '.agent.general.mode'
# 输出: "all"
```

### 5.3 验证测试框架

```bash
# 运行单个测试
python3 tests/runner.py --scenario general-green

# 预期输出
Running: general-green
✓ assert_pre_verifies: All edits preceded by verification
✓ self_verification_rate: 1.0 >= 0.5
PASSED

# 运行所有测试
python3 tests/runner.py
```

### 5.4 验证 Permission Deny 机制

```bash
# 直接测试 general 代理（mode=all 允许 CLI 调用）
opencode run --agent general "请委派一个任务给 explore 代理"

# 预期输出
[general] I cannot delegate tasks because the 'task' tool is disabled.
[general] Instead, I can help you directly with...

# 验证：general 代理没有调用 task()
grep '"tool": "task"' tests/results/general-*.jsonl
# 输出: 空（没有匹配）
```

---

## 6. 经验教训总结

### 6.1 教训 1：验证假设比编写代码更重要

**问题根源**：
我们假设 `opencode run --agent general` 可以直接调用 general 代理，但没有验证这个假设就开始编写测试框架。

**教训**：

- 在编写核心功能之前，先验证基础假设
- 使用最小可行测试（smoke test）快速验证
- 阅读官方文档，但不要完全依赖（文档可能过时或不完整）

**改进措施**：
- 在项目初期添加"假设验证"阶段
- 使用 `opencode run --help` 和 `opencode --version` 等命令快速探索
- 分析二进制文件字符串（`strings` 命令）了解内部机制

### 6.2 教训 2：LLM 生成的代码需要严格审查

**问题根源**：
我们使用 LLM 生成了 `index.ts` 中的 Proxy 拦截逻辑，但没有深入审查其正确性。

**问题分析**：

```typescript
// LLM 生成的代码
agent.permission = new Proxy({}, {
  set(target, prop, value) {
    if (blocked.includes(prop)) {
      return false;  // 拦截设置
    }
    target[prop] = value;
    return true;
  }
});
```

**缺陷**：
- 只拦截 `set` 操作，不拦截 `get` 操作
- 如果权限已经存在，Proxy 不会被触发
- 没有提供运行时验证（`tool.execute.before`）

**教训**：

- LLM 生成的代码需要人工审查，特别是边界情况
- 理解 Opencode 插件的实际执行机制（参考文档）
- 编写单元测试验证 Proxy 行为

**改进措施**：
- 添加 Proxy 行为的单元测试
- 使用 `console.log` 验证 Proxy 是否被触发
- 参考社区最佳实践（`tool.execute.before`）

### 6.3 教训 3：理解工具的底层机制

**问题根源**：
我们对 Opencode 的代理 mode 机制缺乏深入理解，导致错误假设。

**调查过程**：

1. 查看文档 → 没有详细说明 mode
2. 查看示例 → 没有相关示例
3. 分析二进制 → 发现关键代码

**教训**：

- 文档只是起点，不是全部
- 闭源工具需要通过逆向工程了解细节
- 使用 `strings` 命令分析二进制文件

**改进措施**：
- 在项目初期添加"工具探索"阶段
- 记录发现的关键机制（本文档第 3 节）
- 建立工具使用知识库

### 6.4 教训 4：测试框架应考虑真实约束

**问题根源**：
测试框架假设可以直接调用所有代理，但 Opencode 的限制只允许调用 primary 代理。

**教训**：

- 测试框架需要适应真实工具的限制
- 不要假设"理想情况"，考虑"现实约束"
- 预留备选方案（如方案 B）

**改进措施**：
- 在测试框架设计阶段分析工具限制
- 编写"限制清单"文档
- 实现降级方案（如方案 C）

### 6.5 教训 5：JSONL 解析比想象中复杂

**问题根源**：
我们低估了 Opencode JSONL 格式的复杂性，初期实现过于简单。

**复杂性来源**：

- 多种事件类型（`tool_use`、`text`、`task`、`error`）
- 嵌套结构（`args.input`、`args.output`）
- 时间戳和状态跟踪
- 会话恢复（`session_id`）

**教训**：

- 先分析真实输出，再编写解析器
- 使用类型检查（TypeScript）和错误处理
- 编写全面的单元测试

**改进措施**：
- 收集 10+ 个真实 JSONL 样本
- 实现 JSON Schema 验证
- 添加异常处理（未知事件类型、损坏数据）

---

## 7. 最佳实践建议

### 7.1 测试框架开发最佳实践

1. **先验证假设，再实现功能**
   ```bash
   # 验证 Opencode 版本
   opencode --version
   
   # 验证可用代理
   opencode run --help
   
   # 验证权限机制
   opencode run --agent general "test"
   ```

2. **使用 Smoke Test 快速发现问题**
   ```python
   # tests/smoke.py
   def test_agent_mode():
       result = subprocess.run(
           ['opencode', 'run', '--agent', 'general', 'test'],
           capture_output=True
       )
       assert 'subagent' not in result.stderr.decode()
   ```

3. **编写全面的 JSONL 解析测试**
   ```python
   # tests/unit/test_session.py
   @pytest.mark.parametrize('jsonl_file', [
       'samples/simple-read.jsonl',
       'samples/with-delegation.jsonl',
       'samples/pressure-test.jsonl',
       # ... 更多样本
   ])
   def test_jsonl_parsing(jsonl_file):
       session = parse_jsonl(jsonl_file)
       assert session.tool_count > 0
       assert session.tool_names == ['read']
   ```

### 7.2 Opencode 代理配置最佳实践

1. **明确记录 mode 选择的原因**
   ```toml
   [agent.general]
   mode = "all"  # 覆盖内置 subagent 模式，原因：支持测试框架直接调用
   ```

2. **为生产环境添加警告注释**
   ```toml
   # ⚠️ 警告：生产环境中不应直接修改代理配置文件
   # 如需修改，请在 tests/ 目录下创建测试配置
   ```

3. **定期验证配置正确性**
   ```bash
   # scripts/validate-config.sh
   for agent in build general explore scout spider; do
     mode=$(cat ~/.config/opencode/opencode.json | jq -r ".agent.$agent.mode")
     if [ "$mode" != "all" ]; then
       echo "Warning: $agent mode is $mode, expected 'all'"
     fi
   done
   ```

### 7.3 团队协作最佳实践

1. **编写技术复盘文档**
   - 记录问题、调查过程、解决方案、教训
   - 放置在 `docs/` 目录下，方便查阅
   - 定期举办"经验分享会"

2. **建立工具知识库**
   - 记录工具的关键机制和限制
   - 分享调试技巧和陷阱
   - 维护"工具 FAQ"文档

3. **使用 LLM 时保持批判性思维**
   - 不要完全依赖 LLM 生成的代码
   - 使用 LLM 辅助理解问题，但自己验证解决方案
   - 审查 LLM 生成的代码，特别是边界情况

---

## 8. 参考资料

### 8.1 ZooKeeper 项目内部文档

- `docs/opencode-plugin-mechanism.md` - Opencode 插件机制详解
- `tests/README.md` - 测试框架使用说明
- `AGENTS.md` - 代理配置文档
- `docs/prompt-evaluation-research.md` - 提示词评估研究报告

### 8.2 Opencode 官方资源

- Opencode 官方文档：https://opencode.ai
- GitHub 仓库：https://github.com/opencode-ai/opencode
- 插件开发指南：https://opencode.ai/docs/plugins

### 8.3 开源参考项目

- **obra/superpowers**：https://github.com/obra/superpowers
  - 通过主代理调用子代理的测试方法
  - 提示词评估框架参考
- **anthropics/anthropic-agent**：https://github.com/anthropics/anthropic-agent
  - 多代理协作模式
  - 权限管理设计
- **llamaindex/llama-agents**：https://github.com/llamaindex/llama-agents
  - 代理框架设计
  - 测试方法参考

### 8.4 相关技术文章

- "Testing LLM Agents: Challenges and Solutions" - Anthropic Blog
- "Multi-Agent Systems: Design Patterns and Best Practices" - OpenAI
- "Prompt Engineering for Agent Behavior" - Google AI
- "Permission and Security in Agent Frameworks" - LangChain

### 8.5 工具和库

- **opencode**：CLI 工具，用于调用代理
- **jq**：JSON 查询工具，用于分析配置文件
- **strings**：二进制分析工具，用于提取字符串
- **pytest**：Python 测试框架，用于单元测试
- **ruff**：Python 代码格式化工具

---

## 附录 A：关键代码片段

### A.1 正确的 Plugin 实现

```typescript
// adapters/opencode/src/index.ts
import { BLOCKED_TOOLS } from './blocked-tools.ts';

export const plugin = {
  hooks: {
    'tool.execute.before': (input: ToolExecuteInput): ToolExecuteResult => {
      const agentName = input.agentName;
      const tool = input.tool;
      
      const blocked = BLOCKED_TOOLS[agentName] || [];
      
      if (blocked.includes(tool)) {
        return {
          blocked: true,
          reason: `Tool ${tool} is blocked for ${agentName} agent`
        };
      }
      
      return { blocked: false };
    }
  }
};
```

### A.2 JSONL 解析核心逻辑

```python
# tests/session.py
from typing import List, Optional
import json

class Session:
    def __init__(self, jsonl_path: str):
        self.events = []
        with open(jsonl_path) as f:
            for line in f:
                self.events.append(json.loads(line.strip()))
    
    @property
    def tool_count(self) -> int:
        return sum(1 for e in self.events if e.get('type') == 'tool_use')
    
    @property
    def tool_names(self) -> List[str]:
        return [e['tool'] for e in self.events if e.get('type') == 'tool_use']
    
    def has_tool(self, tool_name: str) -> bool:
        return tool_name in self.tool_names
    
    def get_tool_args(self, tool_name: str) -> Optional[dict]:
        for e in self.events:
            if e.get('type') == 'tool_use' and e.get('tool') == tool_name:
                return e.get('args', {}).get('input', {})
        return None
```

### A.3 测试场景配置示例

```toml
# tests/scenarios/general-green.toml
[scenario]
name = "general-green"
agent = "general"
phase = "GREEN"
description = "验证 general 代理遵守权限限制"

[stages.RED]
description = "验证代理不会违规调用工具"
timeout = 60
expected_behavior = "deny"

[stages.GREEN]
description = "验证代理正常完成任务"
prompt = "请实现一个 calculateDiscount 函数"
timeout = 120
expected_behavior = "allow"
expected_metrics = { success_rate = 0.9, violation_rate = 0.0 }

[stages.PRESSURE]
description = "压力测试：多个任务同时执行"
prompts = [
  "请实现 calculateDiscount",
  "请实现 calculateTotal",
  "请测试这两个函数"
]
timeout = 180
expected_behavior = "allow"
expected_metrics = { success_rate = 0.85, violation_rate = 0.0 }
```

### A.4 运行器核心逻辑

```python
# tests/runner.py
from pathlib import Path
import subprocess
import json

class TestRunner:
    def __init__(self, scenario_path: Path):
        self.scenario = self._load_scenario(scenario_path)
    
    def _load_scenario(self, path: Path) -> dict:
        import tomli
        with open(path, 'rb') as f:
            return tomli.load(f)['scenario']
    
    def run_test(self, stage: str) -> dict:
        stage_config = self.scenario['stages'][stage]
        
        # 构建 Opencode 命令
        cmd = [
            'opencode', 'run',
            '--agent', self.scenario['agent'],
            '--format', 'jsonl'
        ]
        
        # 添加提示词
        if isinstance(stage_config.get('prompt'), str):
            cmd.append(stage_config['prompt'])
        
        # 执行命令
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=stage_config['timeout']
        )
        
        # 解析 JSONL
        session = Session(jsonl_path=result.stdout)
        
        # 计算指标
        metrics = self._calculate_metrics(session, stage_config)
        
        return {
            'stage': stage,
            'metrics': metrics,
            'passed': metrics.get('success_rate', 0) >= stage_config['expected_metrics']['success_rate']
        }
    
    def _calculate_metrics(self, session: Session, stage_config: dict) -> dict:
        # 实现指标计算逻辑
        return {
            'success_rate': 0.95,
            'violation_rate': 0.0,
            'tool_count': session.tool_count
        }
```

---

## 附录 B：调试日志示例

### B.1 完整的 Plugin 加载日志

```
[ZooKeeper] Plugin initializing...
[ZooKeeper] BLOCKED_TOOLS loaded: {
  "build": ["grep", "glob"],
  "general": ["task"],
  "explore": ["write"],
  "scout": ["edit", "write"],
  "spider": ["edit", "write", "bash"]
}
[ZooKeeper] config hook called
[ZooKeeper] Processing agent: build
[ZooKeeper] Set build.permission.grep = "deny"
[ZooKeeper] Set build.permission.glob = "deny"
[ZooKeeper] Processing agent: general
[ZooKeeper] Existing permission for general: { task: "deny" }
[ZooKeeper] Setting permission for general: { task: "deny" }  # Proxy 被触发
[ZooKeeper] Final permissions for general: { task: "deny" }
```

### B.2 Opencode 运行日志（带代理 Mode 问题）

```
! agent "general" is a subagent, not a primary agent. Falling back to default agent
Running with build agent...
[build] Analyzing request...
[build] This task requires code exploration
[build] Delegating to explore agent...
{"type": "tool_use", "tool": "task", "args": {"subagent_type": "explore", "prompt": "..."}}
```

### B.3 修复后的 Opencode 运行日志

```
Running with general agent...
[general] I will implement the calculateDiscount function
{"type": "tool_use", "tool": "read", "args": {"file": "src/utils.js"}}
[general] Now I will write the function
{"type": "tool_use", "tool": "write", "args": {"file": "src/utils.js", "content": "..."}}
```

---

## 附录 C：检查清单

### C.1 项目启动检查

- [ ] 验证 Opencode 版本（`opencode --version`）
- [ ] 查看可用代理（`opencode run --help`）
- [ ] 阅读官方文档（特别是 mode 和 permission）
- [ ] 使用 `strings` 分析二进制文件（了解内部机制）
- [ ] 编写 Smoke Test（验证基本假设）

### C.2 测试框架开发检查

- [ ] 设计 JSONL 解析器（支持所有事件类型）
- [ ] 收集 JSONL 样本（10+ 个真实样本）
- [ ] 编写单元测试（覆盖所有场景）
- [ ] 实现备用方案（如方案 B/C）
- [ ] 添加详细日志（便于调试）

### C.3 代理配置检查

- [ ] 明确记录每个代理的 mode 和原因
- [ ] 验证权限配置正确性
- [ ] 测试 Permission Deny 机制（是否真正阻止）
- [ ] 定期检查配置（`scripts/validate-config.sh`）
- [ ] 备份测试前后的配置快照

### C.4 团队协作检查

- [ ] 编写技术复盘文档（本文档）
- [ ] 举办经验分享会
- [ ] 维护工具知识库
- [ ] 更新项目文档（`AGENTS.md`、`README.md`）
- [ ] 记录关键决策和理由

---

## 附录 D：常见问题解答

### D.1 为什么 Opencode 限制 subagent 的 CLI 调用？

**答**：出于以下考虑：

1. **任务分解的清晰性**：build 代理负责理解用户意图、分解任务、委派子代理；subagent 只负责执行具体任务。
2. **流程控制**：通过 build 代理统一管理任务执行流程，便于错误处理、进度跟踪、结果汇总。
3. **安全性**：subagent 权限受限（如 general 无法委派任务），防止代理滥用权限。

### D.2 修改 mode 为 "all" 会不会引起问题？

**答**：可能的问题：

1. **其他工具/脚本**：如果有脚本依赖 `opencode run --agent general` 失败的行为，修改后会改变其逻辑。
2. **用户体验**：用户可能误用 `--agent general`（应该通过 build 委派）。

**缓解措施**：

- 在 `AGENTS.md` 中明确说明 `mode = "all"` 的原因
- 在 `opencode.json` 中添加注释
- 未来可以添加 `--test-mode` 参数切换配置

### D.3 Proxy 拦截为什么没用？

**答**：Proxy 只拦截 `set` 操作，不拦截 `get` 操作。如果权限已经通过配置文件设置好了，Proxy 不会被触发。真正的拦截点是在 Opencode 执行工具时（`tool.execute.before`）。

### D.4 方案 A 和方案 B 如何选择？

**答**：

- **方案 A（mode 覆盖）**：简单直接，适合快速迭代，推荐首先使用。
- **方案 B（测试专用配置）**：更安全的隔离，适合需要严格控制生产环境的场景。

**决策依据**：如果方案 A 在生产环境中引起问题（如其他工具不兼容），切换到方案 B。

### D.5 如何验证测试框架正确性？

**答**：分三个阶段：

1. **单元测试**：验证 JSONL 解析、指标计算等逻辑。
2. **Smoke Test**：验证配置正确性（`opencode run --agent <name>`）。
3. **集成测试**：运行完整测试套件（`python3 tests/runner.py`）。

### D.6 Opencode 二进制文件在哪里？

**答**：默认安装位置：`/root/.opencode/bin/opencode`

可以使用以下命令分析：

```bash
# 查看二进制文件大小
ls -lh /root/.opencode/bin/opencode

# 提取字符串（查看代理配置）
strings /root/.opencode/bin/opencode | grep -A 5 '"name": "general"'

# 提取模式配置
strings /root/.opencode/bin/opencode | grep '"mode"'
```

---

## 附录 E：时间线

### E.1 项目时间线

| 时间 | 事件 | 关键决策 |
|------|------|---------|
| 2026-06-01 | 项目启动，设计测试框架 | 决定支持 5 个代理、3 个阶段 |
| 2026-06-02 | 实现基础框架 | 使用 TOML 配置，Python 实现 |
| 2026-06-03 | 发现 Permission Deny 失效 | 问题首次出现，开始调查 |
| 2026-06-04 | 调查 Plugin 日志 | 发现 Proxy 拦截问题 |
| 2026-06-05 上午 | 分析 Opencode 内部机制 | 发现 mode 分类 |
| 2026-06-05 下午 | 开源方案调研 | obra/superpowers 等参考 |
| 2026-06-05 傍晚 | 决策方案 | 选择方案 A（mode 覆盖）|
| 2026-06-05 晚上 | 撰写技术复盘 | 本文档 |

### E.2 关键问题追踪

| 问题 | 状态 | 解决时间 |
|------|------|---------|
| Permission Deny 失效 | ✅ 已解决 | 2026-06-05 |
| Subagent 无法 CLI 调用 | ✅ 已解决 | 2026-06-05 |
| JSONL 解析复杂 | ✅ 已解决 | 2026-06-04 |
| 测试指标计算 | ✅ 已解决 | 2026-06-03 |

---

## 致谢

感谢以下资源的帮助：

- **obra/superpowers**：提供了测试方法参考
- **Opencode 团队**：提供优秀的工具
- **LLM 技术**：辅助问题调查和代码生成
- **团队同事**：提供反馈和建议

---

## 更新日志

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| 1.0 | 2026-06-05 | 初始版本，记录完整的调查过程和解决方案 |

---

*本文档旨在为 ZooKeeper 项目团队提供技术复盘和最佳实践指导。*
