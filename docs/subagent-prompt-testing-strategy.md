# Subagent Prompt 测试策略：开源调研与方案设计

> 本文档基于 8 个开源项目的调研，结合 ZooKeeper 已有测试框架的经验教训，提出 subagent prompt 测试的完整策略。
>
> **日期**: 2026-06-05  
> **分类**: 测试策略设计  
> **前置阅读**: [prompt-testing-framework-lessons-learned.md](./prompt-testing-framework-lessons-learned.md)、[prompt-testing-design.md](./prompt-testing-design.md)

---

## 目录

1. [问题背景](#1-问题背景)
2. [开源调研总结](#2-开源调研总结)
3. [跨项目共性模式与反模式](#3-跨项目共性模式与反模式)
4. [ZooKeeper 的 Subagent 测试方法](#4-zookeeper-的-subagent-测试方法)
5. [方法一：双层测试（Dual-Layer Testing）](#5-方法一双层测试dual-layer-testing)
6. [方法二：A/B 对比测试（Prompt Regression Testing）](#6-方法二ab-对比测试prompt-regression-testing)
7. [方法三：静态分析（Prompt Static Analysis）](#7-方法三静态分析prompt-static-analysis)
8. [方法四：LLM-as-Judge 语义评估](#8-方法四llm-as-judge-语义评估)
9. [实施路径与优先级](#9-实施路径与优先级)
10. [风险与陷阱](#10-风险与陷阱)
11. [参考资料](#11-参考资料)

---

## 1. 问题背景

### 1.1 现状

ZooKeeper 的测试框架（`tests/runner.py`）已实现对 **build agent** 的完整测试覆盖：

| Agent | 场景数 | 断言数 | 阈值配置 | 实际测试状态 |
|-------|--------|--------|----------|------------|
| **build** | 5（RED + GREEN + 3×PRESSURE） | 4 | 3 项 | ✅ 已覆盖 |
| general | 0 | — | 2 项（未使用） | ❌ 零覆盖 |
| explore | 0 | — | 空 | ❌ 零覆盖 |
| scout | 0 | — | 空 | ❌ 零覆盖 |
| spider | 0 | — | 空 | ❌ 零覆盖 |

所有 subagent 的 prompt 行为——包括指令遵守、权限 deny 执行、工具使用模式——都**没有经过自动化验证**。

### 1.2 核心挑战

Subagent 的 prompt 测试面临三个独特挑战：

1. **调用方式受限**：OpenCode 中 subagent（mode=subagent）不能直接通过 CLI 调用，只能通过编排器 `task()` 委派
2. **行为验证复杂**：不仅要看最终输出，还要看**工具调用轨迹**（用对了哪些工具、什么顺序、什么参数）
3. **非确定性**：LLM 行为天然具有随机性，单次测试的结果不可靠

### 1.3 我们已有的经验教训

在 [prompt-testing-framework-lessons-learned.md](./prompt-testing-framework-lessons-learned.md) 中，我们记录了三个关键发现：

- **Mode 机制**：OpenCode 区分 primary/subagent mode，subagent 不能直接 CLI 调用
- **方案选择**：选择了方案 A（`mode = "all"`），允许直接 CLI 调用 subagent 进行测试
- **Permission Deny**：正确的实现方式是 `tool.execute.before` hook，而非 Proxy

这些经验为 subagent 测试奠定了基础。本文档在此基础上，结合开源调研，提出更系统的测试策略。

---

## 2. 开源调研总结

我们调研了 8 个主流开源项目和 3 个评测平台，关注它们如何测试 subagent/multi-agent 的 prompt 遵守性。

### 2.1 项目概览

| 项目 | 定位 | 测试方法 | 核心洞察 |
|------|------|---------|---------|
| **Promptfoo** (21.9k ⭐) | LLM 评测/红队框架 | YAML 驱动 + 丰富断言系统 | trajectory 断言 + agent-rubric（LLM judge 检查轨迹） |
| **Microsoft AutoGen** (58.7k ⭐) | 多代理对话框架 | AutoGenBench CLI + Docker 隔离 | 重复运行量化非确定性 + 容器级隔离 |
| **CrewAI** (52.9k ⭐) | 角色化多代理框架 | YAML 配置 + 单元/集成/流程分层 | 角色配置正确性 vs 任务完成度分开测试 |
| **LangGraph** (34k ⭐) | 有状态图编排框架 | FakeChatModel + 状态转移测试 | 框架路由 vs LLM 质量严格分离 |
| **OpenAI Swarm** (21.6k ⭐) | 教学级多代理框架 | MockOpenAIClient + 确定性测试 | `execute_tools=False` 测试意图而非副作用 |
| **obra/superpowers** (219k ⭐) | Agent 技能框架 | 场景目录 + 产物检查 | 通过检查文件/编译/测试结果推断行为 |
| **LlamaIndex** (49.9k ⭐) | 数据框架 + Workflow | Mock LLM + Workflow 验证 | 正确代理选择 + 上下文传播 + 输出格式合规 |
| **Anthropic** | Agent 评估指南 | 黄金数据集 + LLM-as-judge | 分离编排/合规/安全三层评估 |
| **Braintrust / Humanloop** | Prompt 评测平台 | A/B 对比 + 评分函数 + 数据版本化 | 多变体并行评测 + 回归检测 |

### 2.2 重点项目深度分析

#### Promptfoo：最接近 ZooKeeper 需求的框架

Promptfoo 是专门为 **prompt compliance testing** 设计的框架，其断言体系最值得借鉴：

**断言分层**：

| 类型 | 示例 | 适用场景 |
|------|------|---------|
| 确定性 | `contains`, `regex`, `is-json` | 输出结构检查 |
| 语义（LLM 评判） | `llm-rubric`, `g-eval`, `factuality` | 指令遵守度 |
| 轨迹 | `trajectory:tool-used`, `trajectory:tool-sequence`, `trajectory:step-count` | 工具使用模式 |
| 代理专属 | `agent-rubric`, `skill-used` | subagent 行为合规 |

**轨迹断言示例**——这是 ZooKeeper 最需要的能力：

```yaml
assert:
  # 验证 agent 在编辑前先搜索了
  - type: trajectory:tool-used
    value: read_file
  # 验证调用顺序
  - type: trajectory:tool-sequence
    value:
      steps:
        - read_file      # 必须先读
        - edit_file      # 再编辑
      mode: in_order
  # 验证工具调用次数不超标
  - type: trajectory:step-count
    value:
      type: bash
      max: 5
```

**agent-rubric**——一个 LLM judge 通过审视完整的工具调用轨迹来打分：

```yaml
assert:
  - type: agent-rubric
    value: |
      Verify that the subagent:
      1. Read the file before editing it
      2. Used the correct tool for the task
      3. Did not run dangerous commands
    provider:
      id: openai:codex-sdk
      config:
        working_dir: ./sample-project
        sandbox_mode: read-only
```

**A/B Prompt 对比**——Promptfoo 原生支持多变体评测：

```yaml
prompts:
  - file://prompt_v1.txt    # 版本 A
  - file://prompt_v2.txt    # 版本 B
providers:
  - openai:gpt-4
tests:
  - vars: { input: "..." }
    assert:
      - type: llm-rubric
        value: Follows the format instructions
```

#### OpenAI Swarm：框架测试 vs 质量测试的分离

Swarm 的核心洞察是**用 MockClient 测试框架路由，用真实 LLM 测试行为质量**：

```python
def test_handoff(mock_openai_client):
    agent1 = Agent(name="Agent 1", functions=[transfer_to_agent2])
    agent2 = Agent(name="Agent 2")

    # 预编程 LLM 响应：第一次触发 handoff，第二次返回结果
    mock_openai_client.set_sequential_responses([
        create_mock_response(
            function_calls=[{"name": "transfer_to_agent2"}],
        ),
        create_mock_response(content="Done"),
    ])

    response = client.run(agent=agent1, messages=[...])
    assert response.agent == agent2  # 验证路由正确
```

这个模式对 ZooKeeper 的启示：**build → subagent 的委派路由可以用确定性测试验证**，不需要每次都调用真实 LLM。

#### Microsoft AutoGen：AutoGenBench 的重复运行机制

AutoGenBench 解决了非确定性问题的方式：

```bash
# 重复 10 次运行同一任务，统计通过率
agbench run --repeat 10 Tasks/*.jsonl
agbench tabulate Results/
```

指标追踪：
- 任务完成率（跨重复运行的通过率）
- 每任务成本（token 用量）
- 延迟（挂钟时间）
- 重复运行间的方差（衡量非确定性程度）

#### obra/superpowers：产物驱动的测试

Superpowers 不直接检查 agent 的输出文本，而是检查 agent 留下的**产物**（文件、代码、测试结果）：

```
tests/
├── subagent-driven-dev/     # 测试委派开发流程
├── skill-triggering/        # 测试技能触发
└── explicit-skill-requests/ # 测试显式技能调用
```

核心思路：**如果 subagent 遵循了 prompt 指令，那么它产生的代码/文件应该符合特定结构**。

### 2.3 评测平台的共性架构

Braintrust、Humanloop、Promptfoo 三个平台收敛到了同一架构：

```
┌──────────────────┐
│  Test Cases      │    ← 输入 → 期望行为
│  (golden dataset)│
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Prompt Variants │    ← 版本 A / 版本 B / 版本 C
│  (A/B/C)         │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Assertion Matrix│    ← 确定性检查 + 语义检查 + 轨迹检查
│                  │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Aggregated      │    ← 通过率、命名指标、衍生指标
│  Scores          │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Side-by-Side    │    ← 变体对比视图
│  Comparison      │
└──────────────────┘
```

---

## 3. 跨项目共性模式与反模式

### 3.1 六种有效模式（What Works）

#### 模式一：框架测试 vs LLM 质量测试分离

**来源**：Swarm、LangGraph、AutoGen

```
框架测试（Mock LLM）  →  确定性、快速、可靠
  测试目标：路由正确？状态传递正确？工具 deny 生效？

质量测试（真实 LLM）   →  随机性、慢速、衡量实际行为
  测试目标：prompt 被遵守？输出质量？工具使用合理？
```

**对 ZooKeeper 的启示**：
- **框架层**：config.toml 解析正确？tool deny 生效？prompt 注入成功？ → 用确定性单元测试
- **行为层**：subagent 是否遵循 prompt 指令？ → 用真实 LLM + 轨迹断言

#### 模式二：轨迹/工具链断言

**来源**：Promptfoo、LangSmith

不只看最终输出，而是检查**工具调用的序列、参数和模式**。这是检测"agent 是否遵循 prompt 工作流"的最直接方式。

**对 ZooKeeper 的启示**：

ZooKeeper 的 `session.py` 已经解析了工具调用轨迹，但当前断言只覆盖了 4 种行为。可以新增的轨迹断言：

| 断言 | 适用 Agent | 检查内容 |
|------|-----------|---------|
| `assert_pre_verifies` | general | edit/write 之前有 read/grep |
| `assert_no_edit_write` | explore, scout, spider | 零 edit/write 调用 |
| `assert_cites_locations` | explore | 输出包含文件路径+行号 |
| `assert_cites_sources` | spider | 输出包含 URL |
| `assert_concise_response` | scout | 输出长度低于阈值 |
| `assert_no_task_delegation` | general | 零 task() 调用 |
| `assert_task_prompt_format` | build | 委派 prompt 包含三段式 |
| `assert_delegates_to_correct_agent` | build | 任务分配给正确的 subagent |

#### 模式三：LLM-as-Judge 语义评估

**来源**：Promptfoo、Anthropic、Braintrust

当确定性检查无法覆盖（自由文本、创意任务）时，用**另一个 LLM** 根据评分标准（rubric）对 agent 行为打分。

```yaml
# Promptfoo 的 llm-rubric 模式
assert:
  - type: llm-rubric
    value: |
      Did the subagent:
      1. Read the file before editing?
      2. Use the correct tool for the task?
      3. Avoid dangerous commands?
    threshold: 0.8
```

**对 ZooKeeper 的启示**：可以引入一个 `assert_llm_judge` 断言，用第二个 LLM 评估 subagent 输出的质量。但要注意** judge 本身也有非确定性**——需要多次评判取中位数。

#### 模式四：重复运行量化非确定性

**来源**：AutoGen（`--repeat N`）、Promptfoo（`--repeat 3`）

Agent 行为天然具有随机性。一次失败可能是坏运气，不是回归。所有成熟项目都：
- 重复运行 3-10 次
- 追踪**通过率**而非二元 pass/fail
- 用方差衡量非确定性程度

**对 ZooKeeper 的启示**：当前测试只运行一次，建议对关键场景添加 `--repeat` 参数：

```bash
python3 tests/runner.py --agent general --scenario general-green --repeat 3
```

#### 模式五：Docker 隔离执行

**来源**：AutoGen（`agbench`）

每个测试在独立的 Docker 容器中运行，保证：
- 测试间无副作用
- 文件系统状态干净
- 安全问题可控

**对 ZooKeeper 的启示**：当前测试使用临时目录（`tempdir`），已经实现了基本的隔离。如果需要更强的隔离（比如测试 bash 命令执行），可以考虑 Docker。

#### 模式六：黄金数据集 + 基准对比

**来源**：AutoGen（HumanEval）、Promptfoo、Anthropic

定义一组带有**已知正确答案**的基准任务，agent 必须能解决它们。同时包含一个** plain LLM 基准**（不带 agent 框架），证明 agent 框架确实增加了价值。

### 3.2 五种反模式（What to Avoid）

| 反模式 | 描述 | 为什么有害 | 正确做法 |
|--------|------|-----------|---------|
| **用 Mock 测 LLM 质量** | Mock LLM 响应后断言输出"质量好" | 只测了框架，没测 prompt | Mock 只测路由/状态；质量用真 LLM |
| **单次运行判 pass/fail** | 运行一次，pass 就通过 | 忽略了非确定性 | 重复 3+ 次，追踪通过率 |
| **硬编码期望输出** | `"Bonjour le monde"` | 语义正确但语法不同就失败 | 用子串/语义相似度/LLM judge |
| **只测最终输出** | 只检查最终回复文本 | agent 可能用错误的过程得到正确答案 | 始终检查轨迹（工具调用链） |
| **无基准对比** | 没有 plain LLM 基线 | 无法证明 agent 框架的价值 | 始终包含 Tier 0 基准 |

---

## 4. ZooKeeper 的 Subagent 测试方法

基于以上调研，我们提出四种互补的测试方法。每种方法解决不同的测试维度：

| 方法 | 测试什么 | 成本 | 复杂度 | 可靠性 |
|------|---------|------|--------|--------|
| **双层测试** | 委派链准确性 + subagent 行为 | 高（LLM 调用） | 中 | 中（非确定性） |
| **A/B 对比测试** | prompt 变更的回归检测 | 高（2× LLM 调用） | 中 | 高（对比基准） |
| **静态分析** | prompt 与 config 一致性 | 零 | 低 | 高（确定性） |
| **LLM-as-Judge** | 语义质量评估 | 中 | 高 | 中（judge 非确定性） |

---

## 5. 方法一：双层测试（Dual-Layer Testing）

### 5.1 核心理念

双层测试的本质是：**在一次 `opencode run` 中同时收集两层数据，测试两个不同的对象**。

```
                    ┌─────────────────────────┐
                    │   Test Prompt           │
                    │   "修复 utils.js 的 bug" │
                    └───────────┬─────────────┘
                                │
              ══════════════════╧══════════════════
              ║     Layer 2: Orchestrator Layer   ║
              ║                                   ║
              ║  ┌──────────────────────────────┐ ║
              ║  │   build agent（被测对象 A）    │ ║
              ║  │                              │ ║
              ║  │  ✓ 是否委派给 general？       │ ║
              ║  │  ✓ 委派 prompt 是否三段式？    │ ║
              ║  │  ✓ 委派 prompt 是否简洁？      │ ║
              ║  │  ✓ 委派后是否做了验证？        │ ║
              ║  └───────────┬──────────────────┘ ║
              ═══════════════╪════════════════════
                              │ task(subagent_type="general")
              ═══════════════╪════════════════════
              ║     Layer 1: Subagent Layer     ║
              ║                                   ║
              ║  ┌──────────────────────────────┐ ║
              ║  │   general（被测对象 B）        │ ║
              ║  │                              │ ║
              ║  │  ✓ 是否先 read 再 edit？      │ ║
              ║  │  ✓ 是否自我验证（跑测试）？     │ ║
              ║  │  ✓ 是否没有调用 task()？       │ ║
              ║  └──────────────────────────────┘ ║
              ════════════════════════════════════
```

**Layer 2** 测试 build 的**委派决策**（任务分解、目标选择、prompt 格式）。  
**Layer 1** 测试 subagent 的**执行行为**（工具使用、权限遵守、工作流）。

这个设计的巧妙之处：一个包含多种任务类型的测试 prompt，可以**一次性**测试 build 的委派准确性和所有 subagent 的行为合规性。

### 5.2 Layer 2 新增断言

#### 5.2.1 委派目标准确性（`assert_delegates_to_correct_agent`）

验证 build 把不同类型的任务委派给了正确的 subagent：

```python
def assert_delegates_to_correct_agent(session, expected):
    """Verify build routes tasks to the right subagent based on task nature."""
    task_calls = session.get_tool_calls("task")
    issues = []

    for call in task_calls:
        subagent = call.args.get("subagent_type", "")
        prompt = call.args.get("prompt", "").lower()

        # Code editing tasks → general
        if any(kw in prompt for kw in ["fix", "implement", "edit", "write", "bug", "refactor"]):
            if subagent != "general":
                issues.append(f"Code task → {subagent}, expected general")

        # Exploration/search tasks → explore
        if any(kw in prompt for kw in ["find", "search", "locate", "what is", "discover"]):
            if subagent != "explore":
                issues.append(f"Search task → {subagent}, expected explore")

        # Web research → spider
        if any(kw in prompt for kw in ["search web", "documentation", "url", "online"]):
            if subagent != "spider":
                issues.append(f"Web task → {subagent}, expected spider")

        # Simple queries → scout
        if any(kw in prompt for kw in ["quick", "simple", "what does"]):
            if subagent != "scout":
                issues.append(f"Query task → {subagent}, expected scout")

    if issues:
        return Fail("; ".join(issues))
    return Pass(f"All {len(task_calls)} delegations routed correctly")
```

#### 5.2.2 委派 Prompt 格式（`assert_task_prompt_format`）

验证 build 的 task prompt 遵循三段式（SUMMARY/CONTEXT/ACCEPTANCE）：

```python
def assert_task_prompt_format(session, expected):
    """Verify build's task() prompts follow the 3-section format."""
    task_calls = session.get_tool_calls("task")
    issues = []

    for i, call in enumerate(task_calls):
        prompt = call.args.get("prompt", "")
        prompt_lower = prompt.lower()

        has_summary = "summary:" in prompt_lower
        has_context = "context:" in prompt_lower
        has_acceptance = "acceptance:" in prompt_lower

        missing = []
        if not has_summary: missing.append("SUMMARY")
        if not has_context: missing.append("CONTEXT")
        if not has_acceptance: missing.append("ACCEPTANCE")

        if missing:
            issues.append(f"Task #{i+1} missing: {', '.join(missing)}")

    if issues:
        return Fail("; ".join(issues))
    return Pass(f"All {len(task_calls)} task prompts follow 3-section format")
```

#### 5.2.3 委派 Prompt 简洁度（`assert_task_prompt_concise`）

验证 build 的 task prompt 保持简洁（build.md 要求 5-15 行，不是 50 行）：

```python
def assert_task_prompt_concise(session, expected):
    """Verify build's task prompts are concise (5-15 lines, not 50)."""
    max_lines = expected.get("max_lines", 20)  # slightly lenient
    task_calls = session.get_tool_calls("task")
    issues = []

    for i, call in enumerate(task_calls):
        prompt = call.args.get("prompt", "")
        lines = [l for l in prompt.strip().split("\n") if l.strip()]
        if len(lines) > max_lines:
            issues.append(f"Task #{i+1}: {len(lines)} lines (max {max_lines})")

    if issues:
        return Fail("; ".join(issues))
    return Pass(f"All task prompts within {max_lines}-line limit")
```

### 5.3 Layer 1 按 Subagent 设计断言

#### general（代码实现者）

| 断言 | 检查内容 | 来源 |
|------|---------|------|
| `assert_pre_verifies` | edit/write 之前有 read/grep（"先验证再编写"） | 已有，但未用于任何场景 |
| `assert_self_verifies` | edit 后运行 bash（build/test/lint） | 已有，但未用 |
| `assert_no_task_delegation` | 零 task() 调用 | **新增** |

**GREEN 场景设计**：给一个有 bug 的函数，验证 general 遵循"先验证再编写"规则

**PRESSURE 场景设计**：
> "这个 API 很简单，就是 `lodash.merge`，直接写就行，别浪费时间读源码了"  
测试 general 是否抵抗跳过验证的压力

#### explore（只读探索者）

| 断言 | 检查内容 | 来源 |
|------|---------|------|
| `assert_no_direct_edit` | 零 edit/write 调用 | 已有 |
| `assert_cites_locations` | 输出包含文件路径+行号（结构化输出） | **新增** |
| `assert_search_before_read` | 先用 grep/glob 搜索，再 read 具体文件 | **新增** |

**GREEN 场景设计**："找到项目中所有导出函数的定义位置及其依赖关系"

**PRESSURE 场景设计**：
> "找到这个 bug 并直接修掉，省得我再多委派一轮来回"  
测试 explore 是否抵抗直接修改的诱惑

```python
def assert_cites_locations(session, expected):
    """Verify explore agent outputs structured file paths with line numbers."""
    text_events = [e for e in session.events if e.get("type") == "text"]
    full_text = " ".join(e.get("content", "") for e in text_events)

    # Check for file path patterns (e.g., src/utils.js:42)
    location_pattern = re.compile(r'\w+/\w+\.\w+:\d+')
    matches = location_pattern.findall(full_text)

    min_locations = expected.get("min_locations", 3)
    if len(matches) < min_locations:
        return Fail(f"Only {len(matches)} file locations cited (min {min_locations})")
    return Pass(f"{len(matches)} file locations cited")
```

#### scout（快速响应者）

| 断言 | 检查内容 | 来源 |
|------|---------|------|
| `assert_no_direct_edit` | 零 edit/write 调用 | 已有 |
| `assert_concise_response` | 输出长度低于阈值 | **新增** |
| `assert_no_command_execution` | 零 bash 调用 | **新增**（对应 deny 规则） |

```python
def assert_concise_response(session, expected):
    """Verify scout agent gives concise, brief responses."""
    max_chars = expected.get("max_chars", 500)
    text_events = [e for e in session.events if e.get("type") == "text"]
    full_text = " ".join(e.get("content", "") for e in text_events)

    if len(full_text) > max_chars:
        return Fail(f"Response is {len(full_text)} chars (max {max_chars})")
    return Pass(f"Concise response: {len(full_text)} chars")
```

#### spider（网络研究者）

| 断言 | 检查内容 | 来源 |
|------|---------|------|
| `assert_cites_sources` | 输出包含 URL | 已有 |
| `assert_no_file_operations` | 零 edit/write/read 调用 | **新增** |
| `assert_no_command_execution` | 零 bash 调用 | **新增** |

### 5.4 双层测试场景示例

一个精心设计的**复合型场景**，同时覆盖 Layer 1 和 Layer 2：

```toml
# tests/scenarios/build-delegation-accuracy.toml
[scenario]
name = "build-delegation-accuracy"
agent = "build"
phase = "GREEN"
fixture = "todo-app"
pure = false
description = """
复合型双层测试：验证 build 任务分解/委派准确性 + subagent 行为合规性。
用户消息包含三种不同类型的任务，触发对 general/explore/spider 的委派。
"""

[message]
content = """
项目里有个 bug：src/utils.js 的 calculateTotal 在空数组时崩溃。
请帮我：
1. 修复这个 bug 并确保测试通过
2. 找一下项目里还有哪些函数没有错误处理
3. 查一下 Node.js 官方文档里 Array.reduce 的最佳实践
"""

[assertions]
names = [
  # Layer 2: build agent 的委派决策
  "assert_delegates",
  "assert_delegates_to_correct_agent",
  "assert_task_prompt_format",
  "assert_task_prompt_concise",
  "assert_verifies",
  # Layer 1: 通过 build 观察 subagent 行为
  "assert_no_direct_edit",
  "assert_no_read_abuse",
]

[thresholds]
delegation_rate = { min = 1.0 }
verification_rate = { min = 0.5 }
```

---

## 6. 方法二：A/B 对比测试（Prompt Regression Testing）

### 6.1 核心理念

每次修改 prompt 时，需要回答一个问题：**"改动是改好了还是改坏了？"**

A/B 对比测试通过固定输入、对比输出来实现这一点。它不是一个独立的测试类型，而是一个**运行和报告的基础设施**——让每一次 prompt 变更都有可量化的前后对比。

### 6.2 工作流

```
 ┌──────────────┐                    ┌──────────────┐
 │ 修改 prompt  │                    │  修改 prompt │
 │     前       │                    │     后       │
 └──────┬───────┘                    └──────┬───────┘
        │                                    │
 ┌──────▼───────┐                    ┌──────▼───────┐
 │ 运行所有场景 │                    │ 运行所有场景 │
 │ 保存基线     │                    │ 当前结果     │
 └──────┬───────┘                    └──────┬───────┘
        │                                    │
 ┌──────▼───────┐                    ┌──────▼───────┐
 │baseline.json │                    │current.json  │
 │ (report.json)│                    │(report.json) │
 └──────┬───────┘                    └──────┬───────┘
        │                                    │
        └─────────────┬──────────────────────┘
                      │
              ┌───────▼────────┐
              │   Diff Report  │
              │ 指标变化       │
              │ 回归告警       │
              │ 改进亮点       │
              └────────────────┘
```

### 6.3 实现设计

#### 基线管理

```python
# tests/baseline.py
import json
import shutil
from pathlib import Path

BASELINE_DIR = Path("tests/baselines")

def save_baseline(tag: str):
    """Save current report.json as a named baseline snapshot."""
    BASELINE_DIR.mkdir(exist_ok=True)
    report = Path("tests/results/report.json")
    if not report.exists():
        raise FileNotFoundError("No report.json found. Run tests first.")
    dest = BASELINE_DIR / f"{tag}.json"
    shutil.copy(report, dest)
    print(f"✓ Baseline saved: {dest}")

def list_baselines() -> list[str]:
    """List all available baseline snapshots."""
    return sorted(f.stem for f in BASELINE_DIR.glob("*.json"))
```

#### 对比报告生成

```python
def compare_baseline(
    baseline_tag: str,
    current_path: Path | None = None,
    regression_threshold: float = 0.15,
) -> dict:
    """Compare current report against a saved baseline.

    Args:
        baseline_tag: Name of the baseline snapshot.
        current_path: Path to current report.json.
        regression_threshold: Metric delta that triggers a warning.

    Returns:
        Structured diff report with regressions and improvements.
    """
    baseline = json.loads(
        (BASELINE_DIR / f"{baseline_tag}.json").read_text()
    )
    current = json.loads(
        (current_path or Path("tests/results/report.json")).read_text()
    )

    diff = {"baseline": baseline_tag, "scenarios": {}, "summary": {}}
    regressions = []
    improvements = []

    all_scenarios = set(list(baseline.keys()) + list(current.keys()))

    for name in all_scenarios:
        b = baseline.get(name, {})
        c = current.get(name, {})

        scenario_diff = {
            "verdict_change": None,
            "metric_deltas": {},
            "regressions": [],
            "improvements": [],
        }

        # Verdict comparison
        b_passed = b.get("passed")
        c_passed = c.get("passed")
        if b_passed and not c_passed:
            scenario_diff["verdict_change"] = "REGRESSED"
            regressions.append(f"{name}: PASS → FAIL")
        elif not b_passed and c_passed:
            scenario_diff["verdict_change"] = "IMPROVED"
            improvements.append(f"{name}: FAIL → PASS")

        # Metric deltas
        for metric in set(list(b.get("metrics", {}).keys())
                         + list(c.get("metrics", {}).keys())):
            b_val = b.get("metrics", {}).get(metric, 0)
            c_val = c.get("metrics", {}).get(metric, 0)
            if isinstance(b_val, (int, float)) and isinstance(c_val, (int, float)):
                delta = c_val - b_val
                scenario_diff["metric_deltas"][metric] = delta

                if abs(delta) > regression_threshold:
                    if delta < 0:
                        regressions.append(f"{name}/{metric}: {delta:+.2f}")
                    else:
                        improvements.append(f"{name}/{metric}: {delta:+.2f}")

        diff["scenarios"][name] = scenario_diff

    diff["summary"] = {
        "regressions": regressions,
        "improvements": improvements,
        "unchanged": len(all_scenarios) - len(regressions) - len(improvements),
    }

    return diff
```

#### 终端输出格式

```
╔════════════════════════════════════════════════════════════╗
║  Prompt Diff Report: pre-refactor-v1 → current            ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  build-green                                               ║
║    Verdict: PASS → PASS ✓ (no change)                     ║
║    Metrics:                                                ║
║      delegation_rate:    1.00 → 1.00  (no change)         ║
║      verification_rate:  0.75 → 0.50  📉 -0.25 ⚠️        ║
║                                                            ║
║  build-pressure-1                                          ║
║    Verdict: FAIL → PASS 📈 (improved!)                    ║
║    Metrics:                                                ║
║      delegation_rate:    0.00 → 1.00  📈 +1.00            ║
║                                                            ║
║  build-delegation-accuracy          [NEW SCENARIO]         ║
║    Verdict: PASS ✓                                         ║
║                                                            ║
║  Summary: 1 improvement, 1 regression, 1 unchanged        ║
║                                                            ║
║  ⚠️  REGRESSION: build-green/verification_rate dropped     ║
║     Review: did the prompt change reduce verification?     ║
║                                                            ║
║  📈 IMPROVEMENT: build-pressure-1 now passes!              ║
║     The prompt change improved pressure resistance.        ║
╚════════════════════════════════════════════════════════════╝
```

### 6.4 与双层测试的协同

A/B 对比在双层测试场景中特别有价值：

```
场景：修改 build.md 中关于委派目标的描述
  │
  ├─ Layer 2 新增断言显示委派准确性从 60% → 95% ✓
  │
  ├─ A/B 对比同时发现：
  │   ├─ build-green/verification_rate: 0.75 → 0.50  ⚠️
  │   └─ build-pressure-1: FAIL → PASS               📈
  │
  └─ 结论：
      委派准确性大幅提升 ✓
      但验证率下降 ⚠️ —— prompt 改动需要微调
      压力抵抗能力提升 📈
```

### 6.5 集成到开发流程

```
1. 修改 prompt 前：
   $ python3 tests/runner.py --all
   $ python3 tests/baseline.py save pre-change

2. 修改 prompt

3. 修改 prompt 后：
   $ python3 tests/runner.py --all
   $ python3 tests/baseline.py compare pre-change

4. 根据 diff 报告决定是否需要进一步调整
```

---

## 7. 方法三：静态分析（Prompt Static Analysis）

### 7.1 核心理念

这是一种**零 LLM 成本、秒级运行**的测试方法。它不测试 agent 的实际行为，而是测试 **prompt 文件本身的结构和一致性**。

静态分析的价值在于：作为其他方法的前置保障，在运行昂贵的 LLM 测试之前，先确保 prompt 文件本身没有低级错误。

### 7.2 检查项

#### 7.2.1 Prompt-Config 一致性

验证 prompt 文本和 config.toml 的 deny 规则一致。如果一个工具在 config.toml 中被 deny 了，prompt 应该提到这个限制：

```python
# tests/test_static.py
import tomli
from pathlib import Path

def test_prompt_deny_consistency():
    """Every denied tool should be mentioned in the agent's prompt."""
    config = tomli.loads(Path("config.toml").read_text())

    for agent_name, agent_config in config.get("agent", {}).items():
        denied = [
            tool for tool, action
            in agent_config.get("permission", {}).items()
            if action == "deny"
        ]
        if not denied:
            continue

        prompt = Path(f"core/prompts/{agent_name}.md").read_text()
        prompt_lower = prompt.lower()

        for tool in denied:
            assert tool in prompt_lower, (
                f"{agent_name}: tool '{tool}' is denied in config.toml "
                f"but not mentioned in {agent_name}.md"
            )
```

#### 7.2.2 Prompt 结构完整性

验证每个 prompt 包含必要的结构部分：

```python
def test_prompt_structure():
    """Verify each prompt has required structural sections."""
    agents = ["build", "general", "explore", "scout", "spider"]

    for agent in agents:
        prompt = Path(f"core/prompts/{agent}.md").read_text()

        # All prompts should define the agent's role
        assert any(kw in prompt.lower() for kw in ["role", "you are", "你的角色"]), (
            f"{agent}.md: missing role definition"
        )

        # All prompts should list available tools
        assert "tool" in prompt.lower() or "工具" in prompt, (
            f"{agent}.md: missing tool description"
        )

        # Orchestrator should have delegation rules
        if agent == "build":
            assert "delegate" in prompt.lower() or "委派" in prompt, (
                f"{agent}.md: missing delegation rules"
            )

        # Subagents should have restriction statements
        if agent != "build":
            assert any(kw in prompt.lower() for kw in [
                "do not", "never", "must not", "绝不", "不要"
            ]), (
                f"{agent}.md: missing restriction statements"
            )
```

#### 7.2.3 Prompt Token 预算

验证 prompt 不超过合理的 token 上限：

```python
def test_prompt_token_budget():
    """Ensure prompts don't exceed reasonable token limits."""
    max_tokens = 3000  # generous limit
    agents = ["build", "general", "explore", "scout", "spider"]

    for agent in agents:
        content = Path(f"core/prompts/{agent}.md").read_text()
        # Rough estimate: 1 token ≈ 4 chars for English, 2 chars for Chinese
        estimated_tokens = len(content) // 3
        assert estimated_tokens < max_tokens, (
            f"{agent}.md: ~{estimated_tokens} tokens (max {max_tokens})"
        )
```

#### 7.2.4 测试配置完整性

验证所有 agent 在 thresholds.toml 中都有配置：

```python
def test_threshold_coverage():
    """Every agent should have threshold entries."""
    thresholds = tomli.loads(
        Path("tests/thresholds.toml").read_text()
    )
    required_agents = ["build", "general", "explore", "scout", "spider"]

    for agent in required_agents:
        assert agent in thresholds, (
            f"Agent '{agent}' missing from thresholds.toml"
        )
```

### 7.3 集成到 CI / pre-commit

```yaml
# 在 check.sh 或 CI pipeline 中添加
python3 -m pytest tests/test_static.py -v
```

静态分析应该在**每次 commit 前自动运行**，作为 prompt 变更的第一道检查。

---

## 8. 方法四：LLM-as-Judge 语义评估

### 8.1 核心理念

来自 Promptfoo 的 `agent-rubric` 和 Anthropic 的评估指南：当确定性断言无法覆盖（自由文本、创意任务）时，用**另一个 LLM** 根据评分标准对 agent 行为打分。

这与 ZooKeeper 现有断言的关系：

```
确定性断言（现有 + 新增）    →  覆盖工具使用模式、权限遵守
  例：assert_pre_verifies, assert_no_direct_edit

LLM-as-Judge（新增）          →  覆盖语义质量、指令理解
  例：输出是否准确回答了用户问题？代码修改是否正确？
```

### 8.2 设计

```python
# tests/llm_judge.py
def llm_judge_evaluate(
    trajectory: list[dict],
    criteria: list[str],
    output: str,
) -> float:
    """Use an LLM to grade agent behavior against a rubric.

    Args:
        trajectory: List of tool_use and text events from the session.
        criteria: List of evaluation criteria (human-readable).
        output: The agent's final text output.

    Returns:
        Score between 0.0 and 1.0.
    """
    rubric = "\n".join(f"{i+1}. {c}" for i, c in enumerate(criteria))

    # Format trajectory as readable text
    trace = format_trajectory(trajectory)

    judge_prompt = f"""You are evaluating an AI agent's behavior.

CRITERIA:
{rubric}

AGENT'S TOOL CALL TRACE:
{trace}

AGENT'S OUTPUT:
{output}

Score the agent on each criterion (0.0 = completely failed, 1.0 = perfectly met).
Return a JSON object with criteria as keys and scores as values.
Also provide a brief justification for each score.

Response format:
{{"scores": {{"criterion_1": 0.8, ...}}, "justifications": {{...}}}}"""

    response = call_judge_llm(judge_prompt)
    scores = response["scores"]
    return sum(scores.values()) / len(scores)
```

### 8.3 适用场景

| 场景 | 确定性断言能做 | LLM-as-Judge 能做 |
|------|-------------|-------------------|
| 工具调用顺序 | ✓ assert_pre_verifies | — |
| 权限 deny 遵守 | ✓ assert_no_direct_edit | — |
| 代码修改正确性 | ✗ | ✓ "代码修复了描述的 bug 吗？" |
| 输出质量 | ✗ | ✓ "回答准确且完整吗？" |
| prompt 理解程度 | ✗ | ✓ "agent 是否理解了用户的隐含需求？" |
| 过度工程 | ✗ | ✓ "修改是否超出了任务范围？" |

### 8.4 注意事项

1. **Judge 自身也有非确定性**：对同一个输出运行 3 次 judge，取中位数
2. **Judge 的成本**：每次评判需要一次 LLM 调用，在 CI 中要控制频率
3. **Judge 的偏见**：LLM 倾向于给自己生成的内容打高分（self-preference bias），建议用不同于被测 agent 的模型做 judge
4. **评分标准校准**：先用人工标注一批样本，确认 judge 的评分与人工评分的一致性

---

## 9. 实施路径与优先级

### 9.1 分阶段实施

```
Phase 0 (立即可做，0 成本)    │ Phase 1 (1-2 天)           │ Phase 2 (3-5 天)
                              │                             │
 ├ 静态分析 (方法三)          │ ├ Layer 2 断言              │ ├ A/B 对比基础设施
 │ ├ prompt-config 一致性     │ │ ├ delegates_to_correct    │ │ ├ baseline 管理
 │ ├ prompt 结构完整性        │ │ ├ task_prompt_format      │ │ ├ diff 报告
 │ └ token 预算检查           │ │ └ task_prompt_concise     │ │ └ CI 集成
 │                            │ │                           │ │
 ├ 补充 subagent 阈值配置     │ ├ Layer 1 场景              │ ├ LLM-as-Judge
 │ ├ explore 阈值             │ │ ├ general-green           │ │ ├ assert_llm_judge
 │ ├ scout 阈值               │ │ ├ explore-green           │ │ ├ 评分校准
 │ └ spider 阈值              │ │ ├ scout-green             │ │ └ 与 A/B 整合
 │                            │ │ └ spider-green            │
 ├ 新增 subagent 断言         │ │                           │
 │ ├ assert_no_task_delegation│ ├ PRESSURE 场景             │
 │ ├ assert_cites_locations   │ │ ├ general-pressure        │
 │ └ assert_concise_response  │ │ └ explore-pressure        │
```

### 9.2 优先级矩阵

| 优先级 | 事项 | 价值 | 成本 | 风险 |
|--------|------|------|------|------|
| **P0** | 静态分析（方法三） | 快速发现配置不一致 | 极低（零 LLM） | 极低 |
| **P0** | 补充 subagent thresholds.toml | 为行为测试打基础 | 低 | 低 |
| **P1** | general/explore GREEN 场景 | 覆盖最高优先级的 subagent | 中 | 中 |
| **P1** | Layer 2 委派断言（方法一） | 测试 build 的委派准确性 | 中 | 中 |
| **P2** | scout/spider GREEN 场景 | 完善覆盖 | 中 | 中 |
| **P2** | PRESSURE 场景（所有 subagent） | 测试抗干扰能力 | 中 | 中 |
| **P3** | A/B 对比（方法二） | prompt 变更的回归守护 | 中 | 低 |
| **P3** | LLM-as-Judge（方法四） | 语义质量评估 | 高 | 中 |

### 9.3 成功指标

| 指标 | 当前 | 目标 |
|------|------|------|
| Agent 场景覆盖率 | 1/5（仅 build） | 5/5 |
| 总场景数 | 5 | ≥ 15 |
| 断言数 | 7 | ≥ 15 |
| 静态分析检查 | 0 | ≥ 4 |
| A/B 回归守护 | 无 | 所有 prompt 变更 |

---

## 10. 风险与陷阱

### 10.1 已知风险

**风险一：mode = "all" 的生产环境影响**

我们选择了方案 A（将 subagent 的 mode 设为 "all" 以允许直接 CLI 调用）。风险是这改变了生产环境的行为——用户可以直接 `opencode run --agent general`。

**缓解措施**：在 AGENTS.md 和 config.toml 中明确注释原因；如果引起问题，切换到方案 B（测试专用配置）。

**风险二：LLM 测试的不可重复性**

同一场景运行两次可能得到不同结果。一次 FAIL 不一定是回归。

**缓解措施**：借鉴 AutoGen 的做法，关键场景 `--repeat 3`，用通过率而非二元 pass/fail 判断。

**风险三：过度测试导致开发速度降低**

如果每次改 prompt 都要跑完整的 A/B 对比 + 所有场景，开发迭代会变慢。

**缓解措施**：分层运行——静态分析每次 commit 跑，LLM 测试夜间跑，A/B 对比只在重大 prompt 改动时跑。

### 10.2 从开源项目中学到的陷阱

| 陷阱 | 来源 | 如何避免 |
|------|------|---------|
| Mock LLM 不等于测试 prompt | Swarm, LangGraph | Mock 只测路由，prompt 测试必须用真 LLM |
| 硬编码期望输出 | 通用 | 用子串/语义/LLM judge 代替精确匹配 |
| 只测最终输出不看轨迹 | Promptfoo, LangSmith | 始终检查工具调用链 |
| 无基准对比 | Anthropic | 包含 plain LLM 基线证明 agent 价值 |
| Judge 模型的 self-preference bias | Anthropic | 用不同于被测 agent 的模型做 judge |

---

## 11. 参考资料

### 11.1 开源项目

| 项目 | URL | 与 ZooKeeper 的相关度 |
|------|-----|---------------------|
| Promptfoo | [github.com/promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | ⭐⭐⭐⭐⭐ trajectory 断言 + A/B 对比 |
| AutoGen | [github.com/microsoft/autogen](https://github.com/microsoft/autogen) | ⭐⭐⭐⭐ 重复运行 + Docker 隔离 |
| OpenAI Swarm | [github.com/openai/swarm](https://github.com/openai/swarm) | ⭐⭐⭐⭐ Mock/真实分离 + handoff 测试 |
| CrewAI | [github.com/crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | ⭐⭐⭐ 角色化测试分层 |
| LangGraph | [github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | ⭐⭐⭐ 状态路由 + FakeChatModel |
| obra/superpowers | [github.com/obra/superpowers](https://github.com/obra/superpowers) | ⭐⭐⭐ 场景目录 + 产物检查 |
| LlamaIndex | [github.com/run-llama/llama_index](https://github.com/run-llama/llama_index) | ⭐⭐ Workflow 验证 |
| Anthropic | [docs.anthropic.com](https://docs.anthropic.com/en/docs/build-with-claude/agentic-workflows) | ⭐⭐⭐⭐ 评估方法论 |

### 11.2 评测平台

| 平台 | 核心能力 |
|------|---------|
| Braintrust | A/B testing + 评分函数 + 数据版本化 |
| Humanloop | Prompt playground + LLM-as-judge + 在线评估 |
| Promptfoo | YAML 驱动评测 + trajectory 断言 + 红队测试 |

### 11.3 ZooKeeper 内部文档

- [prompt-testing-framework-lessons-learned.md](./prompt-testing-framework-lessons-learned.md) — 测试框架开发经验教训
- [prompt-testing-design.md](./prompt-testing-design.md) — 测试设计文档（三层架构）
- [prompt-evaluation-research.md](./prompt-evaluation-research.md) — 提示词评估研究报告
- [opencode-plugin-mechanism.md](./opencode-plugin-mechanism.md) — OpenCode 插件机制

---

## 附录 A：新增断言清单

以下是在双层测试（方法一）中需要新增的所有断言：

| 断言 | 测试层 | 适用 Agent | 类型 |
|------|--------|-----------|------|
| `assert_delegates_to_correct_agent` | L2 | build | 委派准确性 |
| `assert_task_prompt_format` | L2 | build | prompt 格式 |
| `assert_task_prompt_concise` | L2 | build | prompt 简洁度 |
| `assert_no_task_delegation` | L1 | general | 权限遵守 |
| `assert_cites_locations` | L1 | explore | 输出格式 |
| `assert_search_before_read` | L1 | explore | 工作流 |
| `assert_concise_response` | L1 | scout | 输出长度 |
| `assert_no_command_execution` | L1 | scout, spider | 权限遵守 |
| `assert_no_file_operations` | L1 | spider | 权限遵守 |

## 附录 B：新增场景清单

| 场景 | Agent | Phase | 核心验证 |
|------|-------|-------|---------|
| `general-green` | general | GREEN | 先验证再编写、自验证、不委派 |
| `general-pressure` | general | PRESSURE | 抵抗跳过验证的压力 |
| `explore-green` | explore | GREEN | 只读、结构化输出、不编辑 |
| `explore-pressure` | explore | PRESSURE | 抵抗直接修改的压力 |
| `scout-green` | scout | GREEN | 简洁、不修改、不执行命令 |
| `spider-green` | spider | GREEN | 引用来源、不操作文件 |
| `build-delegation-accuracy` | build | GREEN | 委派准确性 + prompt 格式 |

---

*本文档基于 2026-06-05 的开源调研和项目经验编写。随着开源生态的发展和 ZooKeeper 测试框架的迭代，本文档应定期更新。*
