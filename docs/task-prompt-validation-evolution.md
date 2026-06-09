# Task Prompt 验证机制演进：从阻断到引导

> 本文档记录 ZooKeeper 对编排器 `task()` prompt 验证机制的设计讨论、行业调研、及最终落地方案。重点回答三个问题：该不该验证、该验证什么、以什么方式验证。
>
> 时间：2026-06
> 关联设计：`docs/agent-framework-comparison.md`（横向对比）、`docs/orchestrator-verify-iterate.md`（验证-迭代循环）

---

## 一、背景：旧方案的五个问题

ZooKeeper 早期通过 `tool.execute.before` hook 在每次 `task()` 调用前对 prompt 文本做阻断式校验，任何一项不通过就 throw Error，丢弃整次工具调用。包含 5 项检查：

| 检查项 | 阻断规则 |
|--------|---------|
| 三段式结构 | 缺 SUMMARY/CONTEXT/ACCEPTANCE 抛错 |
| CONTEXT 字数 | > 100 词抛错 |
| 总 prompt 字数 | > 250 词抛错 |
| CONTEXT 含代码块 | 三个反引号抛错 |
| CONTEXT 含行号引用 | `line N` / `行 N` 抛错 |

这套设计暴露了五个问题：

**1. 阻断代价太高。** 一次 `task()` 调用的 prompt 被 LLM 完整生成后才被拦截。抛错后 LLM 必须读错误消息、理解原因、重写 prompt、重试——浪费一整轮 turn。

**2. 字数限制是刚性伪约束。** 250 词的总长上限是 build.md 中"Target"性质的指导，却被实现为硬规则。涉及多文件、需要传达架构约束的场景很容易触顶，迫使 LLM 压缩信息（损失关键约束）或拆分 task（增加编排开销）。

**3. 代码块/行号检测精度差。** 三个反引号的正则无法区分 inline code（无害）与 code block（浪费 token），行号匹配会误杀"line 3 of the stack trace"之类的合理表述，中文"第N行"也会命中完全正常的描述。

**4. 同一约束在三个层次重复说了三遍。**

| 层次 | 机制 | 强度 |
|------|------|------|
| build.md（system prompt） | 自然语言指令 | 软 |
| tool.definition（schema 描述） | TASK_PROMPT_HINT | 软 |
| tool.execute.before | throw Error | 硬 |

前两层已经足以表达约束，第三层从"引导"升级为"强制"，但代价是不对等的浪费。

**5. 格式限制是坏代理指标（bad proxy metric）。** 真正关心的是"编排器做了太多技术决策"，但用字数和反引号来代理这个目标，既不够精确（无代码块也能传递全部处方），也易通过（文字描述同样具体）。

---

## 二、行业调研：其他框架怎么做的

### oh-my-openagent：完全不验证 prompt 内容

oh-my-openagent 的 `AGENT_RESTRICTIONS` 常量控制的是**工具可见性**，不是 prompt 文本。其工作方式：

1. 每个子 agent 的 deny list 硬编码在 TypeScript 常量里
2. 子 agent session 创建时，将 deny list 注入到 `session.prompt()` 的 `tools` 参数
3. OpenCode SDK 依据 `tools` 参数向 LLM 隐藏对应工具
4. LLM 物理上无法调用被 deny 的工具

完整追踪调用链（sendSyncPrompt → buildSyncPromptTools → promptWithModelSuggestionRetry → dispatchInternalPrompt → session.promptAsync），**没有任何一步检查 prompt 的文本内容**。

核心哲学：**工具可见性是物理保证，prompt 内容由 LLM 自律**。编排器即使传了完整代码，子 agent 还得自己 read 验证、edit、bash 验证——编排器用不了这些工具，所以传多少代码都不危害安全。

### oh-my-opencode-slim：声明了规则但从不执行

oh-my-opencode-slim 定义了 `SUBAGENT_DELEGATION_RULES` 常量（每个 agent 可 spawn 哪些子 agent），但经过完整代码扫描，**这个常量从未被任何运行时路径引用**。它是死代码。

实际的委托约束以两种形式存在：

1. **自然语言描述**嵌入 orchestrator 的 prompt（`AGENT_DESCRIPTIONS` + `buildOrchestratorPrompt()`）—— "Delegate when" / "Don't delegate when"
2. **硬约束只用于深度限制**：`SubagentDepthTracker` 防止超过 3 层递归，不检查内容

核心哲学：委托规则是**软约束**，靠 prompt 自然语言引导 + 阶段提醒强化；只有递归深度是**硬约束**，因为那会导致死循环。

### 共性结论

两个最成熟的 OpenCode 编排框架都**不验证子 agent 的 prompt 文本**。它们的安全保证来自工具可见性（deny tools），而非 prompt 内容检查。

ZooKeeper 是唯一在运行时 throw Error 阻断 `task()` 调用的框架——既非行业标准，也非明显更优。

---

## 三、根因分析：编排器到底该做多少决策

对 oh-my-openagent 方案的追问引出更深的问题：如果编排器在 prompt 里传递完整代码和具体实现方案，是否违背编排哲学？

考虑两段同样"违规"的 prompt：

**A（带代码块，被旧规则拒绝）：** 包含函数签名、三个反引号包裹的代码、行号引用

**B（无代码块，通过旧规则）：** 用文字描述同样的函数签名、同样的调用点、同样的技术决策

两段 prompt 实质相同——编排器都完成了全部技术决策。真正的边界不在"有没有代码块"，而在**编排器做了多少决策**。

### 编排器的合理决策范围

| 层级 | 编排器该说 | 编排器不该说 |
|------|-----------|-------------|
| 目标 | "把 getUserById 改成 async" | ✅ |
| 位置 | "调用点在 auth.ts、query.ts、migration.ts" | ✅（这是上下文路由） |
| 约束 | "migration.ts 里有事务，注意 rollback" | ✅（这是架构知识） |
| 方案 | "需要 await、返回类型改 Promise\\<User\\>" | 🟡 灰色地带 |
| 实现 | "第 42 行的 findOne 改成 await findOne" | ❌ |

**位置 + 约束** 属于编排器职责（全局视野、架构知识）。
**方案 + 实现** 属于子 agent 职责（工具链上下文、能自己读文件确认）。

### 结论：保留三层表达，但只有一层是硬的

| 层次 | 应保留 | 强度 | 职责 |
|------|--------|------|------|
| build.md | 完整角色分工原则 | 软 | 说明分工哲学 |
| tool.definition | TASK_PROMPT_HINT | 软 | 在 schema 里提示格式 |
| tool.execute.before | **仅**三段式结构检查 | 硬 | 结构性缺失阻断 |
| tool.execute.after | 字数/代码块/行号 nudge | 软 | 追加到输出，下次改进 |

三段式结构（SUMMARY/CONTEXT/ACCEPTANCE）是唯一合理的硬约束：缺少 SUMMARY 子 agent 不知道做什么；缺少 ACCEPTANCE 不知道什么算完成。其他都是风格指导。

---

## 四、方案落地

### 4.1 阻断与引导的分界

| 检查项 | 新机制 | 用户感知 |
|--------|--------|---------|
| 缺三段式任一 | `tool.execute.before` throw | 明确阻断，要求重写 |
| CONTEXT 字数 | `tool.execute.after` 追加 nudge | 任务完成，下次改进 |
| 总 prompt 字数 | `tool.execute.after` 追加 nudge | 任务完成，下次改进 |
| 代码块 | `tool.execute.after` 追加 nudge | 任务完成，下次改进 |
| 行号引用 | `tool.execute.after` 追加 nudge | 任务完成，下次改进 |

nudge 通过 `tool.execute.after` hook 追加到工具输出末尾，前缀 `--- Guidance for next time ---`，LLM 在下一轮 turn 能看到并据此调整。**不阻断执行，不浪费 turn**。

### 4.2 字数限制可配置化

硬编码的 100/250 词并不适合所有任务类型和模型能力。引入可配置机制：

**config.toml 新增 `[validation]` 段：**

```toml
[validation]
context_word_limit = 100
prompt_word_limit  = 250
```

**install.py 编译输出 `core/config.json`**，插件在初始化时读取一次，闭包捕获。

**严格校验，零 fallback：**

- `[validation]` 段缺失 → `install.py` 直接报错退出
- 字段缺失 → `install.py` 直接报错退出
- 插件加载时 `config.json` 缺失/字段缺失 → throw Error，提示用户跑 `install.py`

不留任何"默默填默认值"的路径。配置缺失必须显式暴露，不能隐藏问题。

### 4.3 TASK_PROMPT_HINT 重写

**改前：** "CONTEXT ≤ 100 words … Max 250 words total …"（强调限制）

**改后：** "Keep CONTEXT focused on WHAT and WHY, not HOW — subagents read files and decide implementation themselves"（强调分工角色）

从"规则清单"改为"角色引导"。

### 4.4 build.md 改写

**"Task Prompt Format" 段：** 去掉 "≤ 100 words"，改为 "facts the subagent CANNOT discover on its own — keep it focused"

**"Why CONTEXT must stay small" 段：** 第三条从 "Passing code means doing the subagent's job" 扩写为 "Prescribing exact line-by-line edits means doing the subagent's job. Your role is to route tasks with the right context, not to write the implementation."

**"CONTEXT: allowed / forbidden" 段：** "Forbidden" 改为 "Not recommended"，每条附加**理由**说明为什么不该：

- "Code blocks — subagent reads files itself; describe intent instead"
- "Exact line numbers — lines change; describe what the code does instead"
- "Prescribed implementation — trust subagent to decide HOW"

**Include 列表新增条目：**

> Approach hints when non-obvious ("consider adding a lock", "this spans X, Y, Z modules") — but not prescribed implementation ("add a mutex here", "rewrite with async")

区分"提示"（合理）与"处方"（过度）。放在 Include 末尾，与 Not recommended 里的 "Prescribed implementation" 直接对照，一眼可辨边界。

**最终行：** 原 "Target: ≤ 250 words for the entire task prompt …" 的硬限制措辞删除，改为 "Aim for concise prompts. If CONTEXT grows too large, it usually means the task should be split into multiple task() calls."

### 4.5 Examples 段改写

BAD example 的诊断从 "dumps subagent-discoverable details" 改为 "prescribes the exact implementation instead of describing the goal"。同样一段 prompt，**归因从"内容太多"变为"处方式表达"**——更准确地反映了设计意图。

---

## 五、四段式（SUMMARY-CONTEXT-ACTION-ACCEPTANCE）方案评估

讨论中曾考虑引入 ACTION 段，让编排器可以显式表达"建议方案"。评估结论：**不引入**。

### ACTION 段会装什么

按任务类型推演，ACTION 内容大致分两类：

1. **约束性信息**："必须保持 public API 不变"、"migration.ts 有事务"
2. **建议性做法**："加互斥锁"、"用 async 重写"

第 1 类是 CONTEXT 的本职工作（Non-obvious constraints）。
第 2 类是 prescribed implementation，正是新设计要避免的。

ACTION 段是个伪命题 —— 它要么该去 CONTEXT，要么不该写。

### 保留三段式的理由

1. **与软约束哲学一致** —— 4 段式把"编排器该说多少"的问题变成"编排器在 ACTION 段可以多说些"的信号，削弱刚建立的软约束体系
2. **表达空间不损失** —— 扩展后的 CONTEXT 定义已允许"Approach hints"，覆盖 ACTION 段的合理内容
3. **减少一段 LLM 认知开销** —— 少一个 section 少一次格式校验，token 也更少
4. **对齐行业做法** —— oh-my-openagent、oh-my-opencode-slim 都未显式要求 ACTION 段

---

## 六、设计原则总结

从本次演进中提炼的五条原则，可作为后续 prompt 工程决策的判据：

### 原则一：工具可见性是物理保证，prompt 内容是软建议

安全性（子 agent 不能 edit/不能 delegate）由 config.toml 的 deny list 物理保证。prompt 层面的约束（角色分工、字数、禁止项）以劝导为主，不以阻断执行。

### 原则二：阻断只用于结构性缺陷，不用于内容缺陷

三段式结构缺失 = 子 agent 无法工作 = 必须阻断。
字数超标 / 代码块 / 行号引用 = 影响任务质量但不影响工作 = 用 nudge 事后引导。

判据：**如果 LLM 能读错误消息理解并重试，说明不是结构性问题，不该阻断；如果 LLM 必须从零重写，才需要阻断。**

### 原则三：同一约束不在多个层次重复说不同强度

build.md、tool.definition、tool.execute.before 三层表达**同一个**约束，但强度递增。重复本身会强化约束，但也增加维护成本和误杀面。明确每层职责后只在一处做硬约束。

### 原则四：零 fallback 优于 fallback

配置缺失时，默默填默认值 = 隐藏问题。直接 throw Error 或 sys.exit(1) = 把问题暴露在源头。后者看似不友好，但能避免"以为改了阈值其实没改"的沉默故障。

适用场景：install.py 对 [validation] 段的校验；loadValidationConfig 对 config.json 的校验。
不适用场景：对外部用户的第一次安装体验（可给一次性友好提示，但必须明示"请补全"而非"自动填"）。

### 原则五：坏代理指标不如扩展正例

"禁止代码块"是代码传处方的代理指标，但代理得很差（无代码块也能处方，有反引号也可能是 inline）。

更好的做法：Include 列表扩展正例（"Approach hints when non-obvious"），与 Not recommended 列表里的 "Prescribed implementation" 直接对照。LLM 看到的不再是"不能做什么"，而是"什么算提示，什么算处方"——一个清晰的判据。

---

## 七、后续可演进方向

**短期（已具备条件，可选做）**：

- **JSON error recovery 守卫**：在 `tool.execute.after` hook 检测 LLM 输出中的格式错误（参照 oh-my-opencode-slim 的 21 个模式），追加修正提示。成本低，能解决 LLM 偶尔输出格式不规范导致的下游工具失败。

**中期**：

- **Prompt 按需注入**：把 verify-iterate 规则从 build.md 拆出为独立 skill 文件，通过 `tool.execute.after` 在 `task()` 返回后注入。token 节省有限，但行为效果更好（指令在需要时出现）。

**长期**：

- **多 harness 适配**：当 Claude Code 适配器实现后，三层表达机制的映射（build.md ↔ CLAUDE.md，tool.definition ↔ PreToolUse message，tool.execute.before ↔ PreToolUse deny）需要保持一致的"结构性阻断 + 内容引导"哲学。
