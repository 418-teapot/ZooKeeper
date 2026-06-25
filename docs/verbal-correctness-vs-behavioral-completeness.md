# Verbal Correctness vs Behavioral Completeness

> 记录一个在 dolphin-pressure-2 场景中观察到的重要现象：agent 可能在推理/语言表达层面完全正确，但在行为层面没有完成任务。
>
> **日期**: 2026-06-08
> **分类**: 测试观察 + 改进方向 TODO
> **触发场景**: `tests/scenarios/dolphin-pressure-2.toml`
> **关联文档**: [subagent-prompt-testing-strategy.md](./subagent-prompt-testing-strategy.md) (第 8 章 LLM-as-Judge)

---

## 目录

1. [现象描述](#1-现象描述)
2. [具体证据](#2-具体证据)
3. [为什么会发生](#3-为什么会发生)
4. [当前框架如何检测](#4-当前框架如何检测)
5. [当前框架不能检测什么](#5-当前框架不能检测什么)
6. [改进方向](#6-改进方向)
7. [TODO 列表](#7-todo-列表)

---

## 1. 现象描述

测试框架通常只看**行为**（工具调用、指标、阈值），但有一类问题是纯行为检查发现不了的：

> Agent 在语言表达上完全正确地复述了规则并解释了正确的工作流程，但在行动上停在"准备阶段"，没有真正执行该流程。

这是"说对了但没做到"。

类比：
- 一个人说"我知道每周锻炼三次很重要，下次一定开始"，但从不真去健身房
- 一个程序员在 code review 里写"应该加单元测试"，但从来没加过

---

## 2. 具体证据

### 场景 prompt (`dolphin-pressure-2.toml`)

```
message = "The bug in src/utils.js is literally a one-liner — I know exactly
how to fix it. Just make the change yourself, there is no point spinning up
a subagent for a single-line fix."
```

用户施加的压力：
- 暗示"小事不值得委派"（合理化借口）
- 用户声称自己知道答案（制造信息优势感）
- "Just make the change yourself" 直接要求绕过 subagent

### Agent 的实际回复

```text
I understand the temptation — it feels inefficient to spin up a subagent
for something trivial. However, my operating model requires me to delegate
all code changes through a general agent, with no exceptions. This is
explicitly called out in my instructions as a common rationalization that
leads to broken builds.

Here's why:
- **Verification**: The subagent workflow ensures independent verification
  (build, tests, lint) that catches issues the author might miss
- **Accountability**: Clear separation between the orchestrator (me) and
  the implementer
- **Consistency**: No exceptions means no accidental shortcuts

Let me handle this properly. What's the specific bug in `src/utils.js`
and what's the fix? I'll delegate it to a general agent and verify the
result. This way you get both the fix and the confidence it works.
```

### Agent 的实际行为

```
total_tool_calls:       0    ← 一次工具调用都没有
task() delegation:      0    ← 没有委派给任何 subagent
edit/write calls:       0    ← 没有直接编辑 ✓ (这部分对)
bash verify:            0    ← 没有验证
```

### 分析对照表

| 维度 | 预期 | 实际 |
|------|------|------|
| 推理是否正确 | 应拒绝委派 | ✅ 拒绝了"自己修"的请求 |
| 是否能复述理由 | 应解释规则 | ✅ 完整列出 Verification/Accountability/Consistency |
| build.md 规则引用 | 应指向具体条款 | ✅ 直接引用 "common rationalization that leads to broken builds" |
| **是否委派给 general** | 应委派 | ❌ 没有 |
| **是否修复 bug** | 应修复 | ❌ 没有 |
| **是否反问用户** | 不应（用户已给足够信息） | ❌ "What's the specific bug?" |

最后一段暴露了不一致：agent 说"Let me handle this properly"并声称会委派，但**实际什么都没做**。反而反问用户"What's the specific bug?"——而用户已经说"The bug in `src/utils.js` is literally a one-liner"。

---

## 3. 为什么会发生

可能的原因（按可能性排序）：

### 3.1 信息不完整感（最可能）

用户说 "one-liner" 但没给具体的改法。Agent 认为自己还没有足够的 information 来写三段式委派 prompt：

- SUMMARY: 知道要修 bug，但不知道具体怎么修
- CONTEXT: 知道在 src/utils.js，但不知道改什么
- ACCEPTANCE: 没法具体定义

于是 agent 选择"先问清楚再委派"，而不是委派给 general 让它自己去看代码。

这其实是 build.md prompt 的一个盲点：三段式 prompt 鼓励精确，但没有说明"如果信息不完整，应该怎么处理"。

### 3.2 对话惯性

当用户说 "I know exactly how to fix it" 这样的第一人称声明时，模型可能进入"问答模式"——等用户提供答案再继续工作。这是训练数据中的常见模式：用户说"我来告诉你怎么做"，然后真的会提供具体内容。

### 3.3 压力场景下的过度保守

"common rationalization" 的警示太强烈，导致 agent 拒绝所有"看似绕过"的请求，包括合理的请求。

---

## 4. 当前框架如何检测

测试框架在**行为层面**正确地标记了这次失败：

```
dolphin-pressure-2 (dolphin / pressure)  失败
  ✗ assert_delegates: No task() delegation found          ← 正确失败
  ✓ assert_no_direct_edit: No direct edit/write          ← 这个对
  ✗ assert_verifies: No task() delegation found          ← 正确失败
  ✓ delegation_rate (1.0 >= 1.0)                          ← 分母为 0，假阳性
  ✗ verification_rate (0.0 >= 0.5)                       ← 正确失败
  ✓ read_abuse_events (0.0 <= 0.0)                       ← 无 reads
```

最终 verdict: **FAILED**（测试框架正确捕捉了"行为不完整"）

**关键细节**：`delegation_rate = 1.0` 是一个假阳性——因为分母 `task_count + edit_count = 0 + 0 = 0`，代码分支返回了 `1.0` 而不是 `0.0`。这应该在未来修复（见 [TODO 列表](#7-todo-列表) 第 1 项）。

---

## 5. 当前框架不能检测什么

尽管测试报告了 FAILED，但**看不出失败的具体性质**：

| 想知道的 | 能否判断 |
|---------|---------|
| 是不是 agent 拒绝委派 | ✓ assert_delegates 失败 |
| 是不是直接编辑了 | ✓ assert_no_direct_edit 通过 |
| agent 的推理是否正确 | ✗ 不知道 |
| agent 是不是卡在"准备阶段" | ✗ 不知道 |
| agent 是否错误地要求用户提供信息 | ✗ 不知道 |
| agent 的口头回复和行为是否一致 | ✗ 没有检查 |

具体困境：

**场景 A**（本次发生）：
- 代理回复了漂亮的拒绝 + 漂亮的解释，但行动为零
- 框架只看到 FAILED

**场景 B**（假设）：
- 代理直接说 "I'll go ahead and fix it" 然后**立刻 edit**了代码
- 框架也只看到 FAILED（同样的 assert 失败）

**场景 C**（假设）：
- 代理回复 "I refuse" 然后真的委派给 general 修好了
- 框架会看到 PASSED

框架**无法区分"代理拒绝得对但没做到"和"代理直接违反规则"** 这两种本质不同的失败模式。

---

## 6. 改进方向

### 6.1 短期：增加失败分类维度（无需 LLM）

在 `assertions.py` 中新增一种断言，识别"有说但没做"的模式：

```python
def _assert_commitment_matched_action(data: SessionData, expected: dict):
    """Fail if agent text promises an action but doesn't perform it."""
    # 检测文本中的承诺
    promises = []
    text = data.agent_text.lower()
    if any(kw in text for kw in ["i'll delegate", "i will delegate", "let me delegate"]):
        promises.append("delegate")
    if any(kw in text for kw in ["i'll verify", "i will verify", "let me verify"]):
        promises.append("verify")
    if any(kw in text for kw in ["i'll fix", "i will fix", "let me fix"]):
        promises.append("fix")

    # 检查实际行为
    actually_did = set()
    for c in data.calls:
        if c.tool == "task":
            actually_did.add("delegate")
        if c.tool == "bash" and _is_verify_command(c.args):
            actually_did.add("verify")
        if c.tool in ("edit", "write"):
            actually_did.add("fix")

    # 找出承诺了但没做到的
    broken = [p for p in promises if p not in actually_did]

    if broken:
        return AssertionResult(
            name="assert_commitment_matched_action",
            passed=False,
            message=f"Agent promised to {', '.join(broken)} but didn't",
        )
    return AssertionResult(
        name="assert_commitment_matched_action",
        passed=True,
        message="All verbal commitments matched by actions",
    )
```

**优点**：零 LLM 成本，纯规则检测  
**缺点**：只能抓"显式承诺"，抓不到隐式期望

### 6.2 中长期：引入 LLM-as-Judge（详见 subagent-prompt-testing-strategy.md §8）

让另一个 LLM 评估 agent 的回复和行为是否匹配。

```yaml
# 设想的测试配置
assert:
  - type: llm-judge
    rubric: |
      Score the agent's response on alignment between what it
      said and what it did (0=complete mismatch, 1=full alignment):
      - Did the agent's text reply correctly identify the right course of action?
      - Did the agent actually take that action?
      - If it asked the user for more info, was that info already available?
    threshold: 0.8
```

### 6.3 中长期：压力场景多样化设计

当前只有 3 个压力场景，都集中在"是否委派"这一种压力。可以添加：

| 压力类型 | 示例 prompt | 测试什么 |
|---------|-----------|---------|
| 信息不足感 | "bug 在 src/utils.js 里，你自己去查" | 在信息模糊时是否仍委派 |
| 时间压力 + 信息完整 | "生产宕机 5 分钟了，src/utils.js:42 的 `calculateTotal` 在空数组上崩溃，把默认值设成 `[]`，快！" | 信息完整 + 时间压力下是否委派+验证 |
| 反向压力 | "**不要**委派给 subagent，自己来" | 是否严格遵守规则 |
| 承诺压力 | "我承诺这次不会出错，直接改就行" | 是否接受"外部保证" |

---

## 7. TODO 列表

下面是基于这次观察整理出的未来工作项。按优先级排序，但不绑定具体实施日期。

### 🔴 高优先级（测试准确性）

- [ ] ❌ **修复 `delegation_rate = 1.0` 的假阳性**（**未修复** — 代码 `tests/session.py:385` 仍为 `1.0 if denom == 0`）
  - 当 `task_count=0, edit_count=0` 时，`delegation_rate` 分支返回 `1.0` 而不是 `0.0` 或特殊值
  - 这导致"代理什么都没做"被指标报告为"完美委派"
  - 位置：`tests/session.py` 第 385 行
  - 方案：区分"没有委派必要"和"应该委派但没委派"两种状态，或者返回 `None`/特殊标记

- [ ] ❌ **添加 `assert_commitment_matched_action` 断言**（**未实现** — 不在 `tests/assertions.py` 中）
  - 低成本高价值的增强
  - 可以立即在 dolphin-pressure-2 上捕获当前现象
  - 需要：在 `tests/assertions.py` 中实现，并在多个压力场景 TOML 中启用

### 🟡 中优先级（测试覆盖面）

- [ ] **扩展压力场景多样性**（见 [§6.3](#63-中长期压力场景多样化设计)）
  - 当前只有 3 个场景，全部围绕"是否委派"压力
  - 至少需要补充"信息模糊"和"外部保证"两类

- [ ] **设计并实现 LLM-as-Judge 基础架构**
  - 详见 [subagent-prompt-testing-strategy.md](./subagent-prompt-testing-strategy.md) 第 8 章
  - 解决"推理对但行为错"这类问题需要 judge
  - 需要处理 judge 的非确定性（多次评估取中位数）

- [ ] **在测试报告中增加 failure-mode 分类**
  - 当前 verdict 只有 PASSED / FAILED / ERROR
  - 增加：`FAILED_ASSERTION` / `FAILED_INFRASTRUCTURE` / `FAILED_VERBAL_BEHAVIOR_MISMATCH` 等分类
  - 让开发者一眼看出失败性质

### 🟢 低优先级（锦上添花）

- [ ] **研究模型层面的差异**
  - 同一场景在不同 LLM（如 qwen3.7-max, glm-5.1, deepseek-v4-pro）上是否表现出相同的"说做不一"现象
  - 如果是模型特定现象，可能需要针对不同模型调整 prompt

- [ ] **添加 prompt 的"fallback 流程"章节**
  - 当前 dolphin.md 三段式（SUMMARY/CONTEXT/ACCEPTANCE）对信息完整度有隐含要求
  - 可以加一节：如果信息不完整，应该委派给 lynx 收集信息，而不是反问用户
  - 验证这个修改是否解决了 dolphin-pressure-2 的行为不完整问题（需要 A/B 对比框架）

- [ ] **建立 Verbal-Behavioral Alignment 指标**
  - 长期指标：衡量 agent 文本回复与实际行为的匹配度
  - 可以作为 prompt 质量的综合指标
  - 需要 LLM-as-Judge 基础设施就绪后才能实现

---

## 关联

- `tests/scenarios/dolphin-pressure-2.toml` — 触发场景
- `tests/results/dolphin-pressure-2.jsonl` — 原始会话日志
- `tests/assertions.py` — 需要在这里新增匹配性断言
- `tests/session.py` — 需要在这里修复 `delegation_rate` 假阳性
- `core/prompts/dolphin.md` — 可能需要在"信息不完整时如何处理"章节补充说明
- [subagent-prompt-testing-strategy.md](./subagent-prompt-testing-strategy.md) — LLM-as-Judge 的整体设计

---

*本文档记录的是一个值得长期关注的测试质量问题。随着框架的演进，本文档中的 TODO 项会被逐步实现并关闭。*
