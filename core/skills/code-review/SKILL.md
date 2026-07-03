---
name: code-review
description: 用于所有代码审查操作。通过两路并行审查自动检查实现是否正确、完整、可合入——Eagle 1 检查代码质量与安全，Eagle 2 验证目标与上下文完备性。完成编码任务后或提交 PR 前使用。只要涉及代码审查或实现验证的请求，就请加载此技能。
---

# 代码审查技能

完成实现后，按顺序执行以下阶段。本技能编排两路并行 Eagle 审查：Eagle 1 检查代码质量与安全，Eagle 2 验证目标与上下文完备性。

---

## Phase 0 — 收集上下文

先读取审查模板，再收集所有上下文。

### 读取模板

```
Read references/eagle-code-security.md
Read references/eagle-goal-context.md
```

> 大文件使用 offset/limit 参数分段读取，Read 输出带行号方便 Eagle 引用。

### 收集 GOAL

提取用户的原始需求。如果多次修正，以**最终确认版本**为准。

### 收集 CONSTRAINTS

整理技术栈约束、架构限制、性能要求、兼容性要求等。

### 获取 diff 基准引用

根据变更状态确定 `{DIFF_BASE}`：

| 场景 | `{DIFF_BASE}` |
|------|---------------|
| 代码未提交（staged 或 unstaged 变更） | `HEAD` |
| 已提交的单笔 commit | `HEAD~1` |
| Feature branch 多笔 commit | `git merge-base HEAD <target>`（target 从对话上下文提取，通常是 `main` 或 `origin/main`） |

### 获取变更文件列表

```bash
git diff --name-only {DIFF_BASE}
```

输出干净的变更路径列表（每行一个文件），可直接用于 git 命令的路径参数。

> 可额外参考 `git diff --stat {DIFF_BASE}` 中的增删行信息编写变更概要。

### 收集变更概要

基于变更文件列表和对话上下文，编写 3-5 句的人类可读变更概要，记录为 `{CHANGE_SUMMARY}`。描述变更目的和影响范围，不包含原始 diff。

例：
```
本次变更为认证模块新增 JWT refresh token 机制。新增了 refresh.ts 文件，修改了 auth.ts 中的 token 验证逻辑。后端新增 /auth/refresh 端点，前端登录流程同步更新以支持 token 自动刷新。
```

### 收集 BACKGROUND

从对话中提取：为什么需要这个变更？关联了哪些系统？是否有讨论过的替代方案？

---

## Phase 1 — 填充模板

对两个模板执行 {占位符} → 实际值的替换。填充完成后，模板即是可直接传给子 agent 的三段式 prompt。

### 占位符来源映射

| 占位符 | 来源 | 用于 |
|--------|------|------|
| `{GOAL}` | Phase 0 · 收集 GOAL | 两个 Eagle |
| `{CONSTRAINTS}` | Phase 0 · 收集 CONSTRAINTS | Eagle 2 |
| `{CHANGED_FILES}` | Phase 0 · 获取变更文件列表（路径列表） | 两个 Eagle |
| `{DIFF_BASE}` | Phase 0 · 获取 diff 基准引用 | 两个 Eagle |
| `{CHANGE_SUMMARY}` | Phase 0 · 收集变更概要 | 两个 Eagle |
| `{BACKGROUND}` | Phase 0 · 收集 BACKGROUND | 两个 Eagle |

---

## Phase 2 — 并行启动两路 Eagle

**同一轮次同时启动，不允许串行。**

### Eagle 1 — 代码质量与安全审查

启动 Eagle 1 子 agent，传入填充后的 `eagle-code-security` 模板作为 prompt。在后台并行运行，不等待结果。Eagle 1 半自主，可执行只读命令（git diff、Read、git blame）获取代码，不修改任何文件。

### Eagle 2 — 目标与上下文完备性审查

同一轮次，启动 Eagle 2 子 agent，传入填充后的 `eagle-goal-context` 模板作为 prompt。同样在后台并行运行。Eagle 2 半自主，可执行只读命令（git diff、Read、git log、git blame、gh pr list、gh issue list）搜索额外上下文。

---

## Phase 3 — 收集结果

等待两个 Eagle 完成后，记录各自 verdict。

### 结果分类

| 状态 | 含义 |
|------|------|
| PASS | 审查通过，无可报告问题 |
| FAIL | 发现至少一个 Must Fix 问题 |
| INCONCLUSIVE | Eagle 无法形成确定结论（上下文不足、歧义、超时等） |

### INCONCLUSIVE 重试逻辑

如果任一 Eagle 返回 INCONCLUSIVE，执行一次简化重试：

1. 构造简化版 prompt：只包含 `{CHANGE_SUMMARY}`, `{CHANGED_FILES}`, `{DIFF_BASE}` 和 `{GOAL}`，去掉其他上下文
2. 指示 Eagle 聚焦与目标相关的特定文件/函数，而非自由探索
3. 重新启动同一 Eagle，传入简化版 prompt，仍然后台并行运行
4. 如果重试后仍然 INCONCLUSIVE → 保持为 INCONCLUSIVE，**继续执行不阻塞**

### 注意事项

- 两个 Eagle 各自输出独立 verdict
- 即使全部 INCONCLUSIVE 且重试后仍无法通过，仍然继续到 Phase 4
- 不允许无限重试，最多一次

---

## Phase 4 — 生成报告

### 总体判定规则

| 条件 | 结果 | 图标 |
|------|------|------|
| 所有 Eagle 均 PASS | 审查通过 | ✅ |
| 任一 Eagle FAIL | 审查不通过 | ❌ |
| 无 FAIL，有 INCONCLUSIVE | 审查不确定 | ⚠️ |

### 报告格式

```
## 审查报告

### 总体判定
[✅ | ❌ | ⚠️] [审查通过 / 审查不通过 / 审查不确定]

### 各 Eagle 摘要

#### Eagle 1 — 代码质量与安全
- **判定**: PASS / FAIL / INCONCLUSIVE
- **置信度**: HIGH / MEDIUM / LOW
- **主要发现**: [2-3 句总结]

#### Eagle 2 — 目标与上下文完备性
- **判定**: PASS / FAIL / INCONCLUSIVE
- **置信度**: HIGH / MEDIUM / LOW
- **主要发现**: [2-3 句总结]

### 聚合问题清单

#### 🔴 Must Fix（必须修复）
每条：文件路径及行号、问题描述、推荐修复方式

#### 🟡 Should Fix（建议修复）
同 Must Fix 格式，可附带紧迫程度说明

#### 🔵 Could Fix（可选修复）
同 Must Fix 格式，仅供记录

### Ready to merge?
[**Yes** | **No** | **With fixes**]
```

---

## Phase 5 — 自检清单

聚合报告后、呈现给用户前，由编排器（而非 Eagle）执行以下自检：

| 检查项 | 标准 |
|--------|------|
| **完整性** | 是否审查了所有变更文件？两个 Eagle 是否都已完成（含重试）？ |
| **质量** | 报告是否清晰、具体、可操作？每条问题是否都有文件定位？ |
| **纪律性** | Must Fix / Should Fix / Could Fix 的归类和实际条件是否匹配？是否严格按条件判断，没有因为"感觉不好"而升档？ |
| **公平性** | 是否同时报告了亮点（设计正确、结构清晰的代码）和问题？ |
| **简洁性** | 报告是否避免了废话和重复？ |

如果一个 Eagle 返回 INCONCLUSIVE 但另一个 PASS，报告中需清楚说明未覆盖的风险区域。

---

## Phase 6 — 接收反馈行为

当用户对本审查报告给出反馈时，按以下流程处理：

### READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT

1. **READ** — 完整阅读反馈，确认用户想表达什么。区分"这是误报"和"这是正确的但优先级需要调整"
2. **UNDERSTAND** — 定位反馈针对哪条问题或哪个 Eagle 的判定
3. **VERIFY** — 如果用户对某个问题有异议，重新检查相关代码。确认问题确实存在（或不存在）
4. **EVALUATE** — 判断用户的论据是否成立。如果成立：更新判定或移除问题。如果不成立：用代码证据解释为什么该问题应保留
5. **RESPOND** — 直接给出技术回应，不软化、不铺垫。格式："[问题 X]：检查了代码，发现 Y，所以该问题应该[保留 / 降级 / 移除]。因为 [具体代码引用]"
6. **IMPLEMENT** — 如果接受反馈且有需要修改的代码，按以下顺序修复：
   - 阻塞性问题（Must Fix）
   - 简单修复（Should Fix 中修改量小的问题）
   - 复杂修复（Should Fix 中修改量大的问题）
   每个修复单独测试，不批量提交

### 行为红线

- ❌ 禁止使用空洞的肯定语："说得对！"、"很好的反馈！"、"完全正确！"
- ✅ 使用技术陈述："问题 X 确实存在，因为 `foo.ts:42` 中的 `handleNull` 分支缺少空值检查。修复方案是在第 43 行前加入 `if (value == null) return`"
- ❌ 禁止在用户驳倒一条问题后还在报告中保留它
- ✅ 用户驳倒的 → 更新或移除
- ❌ 禁止在用户的论证有道理时继续坚持原判定
- ✅ 更新判定，描述为什么转变
- ❌ 禁止隐瞒、过滤或省略 Eagle 报告的任何 Must Fix / Should Fix / Could Fix 发现
- ✅ 聚合问题清单必须完整呈现两个 Eagle 的全部发现，编排者不得以"无行为影响"、"不在本次范围"、"显然不重要"等理由自行裁剪。是否修复由用户决定，是否报告由编排者保证
