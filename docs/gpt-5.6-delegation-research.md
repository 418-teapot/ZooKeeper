# gpt-5.6 系列模型委派行为缺陷与各家对策调研

> 调研对象：oh-my-openagent / oh-my-opencode-slim / oh-my-pi（源码均位于 `~/Code/Agent/`）
> 对照对象：ZooKeeper dolphin 编排器（`src/agents/dolphin.ts`）
> 日期：2026-08-27

## 一、背景

用户观测：**gpt-5.6-sol 驱动 ZooKeeper dolphin 编排器时表现差 —— 过度委派、给 subagent 的 task prompt 质量差**。

ZooKeeper 现状：dolphin 的 prompt 头部写着 "Default Bias: DELEGATE"（默认委派倾向），与 Claude 系模型配合良好，但在 gpt-5.6-sol 上该默认值被放大成病态的过度委派。

调研问题：三个同类型多智能体编排项目是否有针对 gpt-5.6 系列的模型专属提示词？它们如何约束委派行为？

**核心结论：三个项目都以不同形式观测到了 gpt-5.6 的委派行为缺陷，并各有对策。这不是个别现象，而是该模型族的已知问题。**

---

## 二、oh-my-pi：显式的 gpt-5.6 专属 prompt 开关（唯一直接对症）

### 2.1 判定链路（3 个文件）

**判定函数** — `packages/coding-agent/src/task/prompt-policy.ts`（全文 8 行）：

```ts
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}
```

按版本号精确判定，覆盖 luna/sol/terra 全部 gpt-5.6 变体。

**注入点** — `packages/coding-agent/src/system-prompt.ts:996` 把 `useCodexTaskPrompt` 作为模板数据传入；**消费点** — `packages/coding-agent/src/prompts/system/system-prompt.md:148` 的 `{{#if useCodexTaskPrompt}}`，是全 prompt 中唯一的模型条件块。另有 `session-tools.ts:637` 用它做 prompt 缓存失效键（`"task-policy:gpt-5.6"` vs `"task-policy:default"`），模型切换时刷新 system prompt。

### 2.2 引入动机（git 考古）

Commit `1b490044ffc26de49a7f33625090b46ba78fe8c1`（can1357，2026-07-11），标题 `feat(coding-agent): centralized task orchestration and prompt policy logic`，message 原文：

> Introduced conditional system prompt logic to handle **model-specific task policies, including support for GPT-5.6**.

即：观测到 gpt-5.6 系模型在委派行为上有缺陷，专门为其收紧。

### 2.3 对策内容：委派默认立场反转

`system-prompt.md:146-172` 的 `# Delegation` 段：

- **非 gpt-5.6 模型**（eagerTasks 模式）：默认积极委派 —— "Delegation default. Once design settles, MUST fan work to task, except ONLY: approximately-under-30-line single-file edit; direct answer; or user explicitly asks you to run a command."
- **gpt-5.6 模型**：默认 **fail-closed** —— "No subagents unless user or applicable AGENTS.md/skill explicitly requests subagents, delegation, or parallel agent work."

**同一个 prompt 模板，gpt-5.6 命中时委派默认值被反转。** 这与 dolphin 在 gpt-5.6-sol 下过度委派的问题完全同构，oh-my-pi 的治疗方案是直接关闭默认委派。

### 2.4 task brief 格式硬性要求

`packages/coding-agent/src/prompts/tools/task.md:29,46,72-75`：

- "Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED."
- 强制三段式：`# Target`（精确文件和符号 + 显式非目标）/ `# Change`（步骤化增删改 + API 和模式）/ `# Acceptance`（可观察结果，禁止项目级命令）。
- 批次共享背景 `context` 字段：`# Goal / # Constraints / # Contract`。

配套 `prompts/system/orchestrate-notice.md`（编排请求专用通知）规则 4/10：

- "Every task self-contained; subagents share no context. Specify ≤3–5 explicit target paths (no globs)… NEVER assume a shared plan."
- "Right-size offload: task only for substantial or parallelizable chunks. Trivial self-contained mechanical edits make inline; dispatch costs more than Goal/Constraints description."

反模式清单双向夹击：既禁止"该委派不委派"，也禁止"为一个琐碎编辑搭 task 脚手架"。

### 2.5 推理模型的其他处理（wire 层，非 prompt）

- gpt-5.6+ effort 五档阶梯 low..max（`packages/catalog/src/model-thinking.ts:85-91, 313-326`）。
- gpt-5+ 发请求时省略 temperature/top_p 等采样参数，否则 HTTP 400（`identity/family.ts:261-284`）。
- gpt-5 系偶发把 Harmony 协议控制 token 裸文本泄漏进工具参数，agent-loop 检测后丢弃重试（`docs/ERRATA-GPT5-HARMONY.md` + `packages/ai/src/utils/harmony-leak.ts`）。
- 每轮按任务难度自动选 effort（`prompts/system/auto-thinking-difficulty.md`）。

---

## 三、oh-my-openagent：按模型族路由整套编排器 prompt

### 3.1 家族路由（单一事实来源）

`packages/omo-opencode/src/agents/sisyphus-agent-factory.ts:67-80` — `resolveSisyphusPromptFamily(model)`，共 12 个 variant：

```ts
if (isGpt5_5Model(model) || isGpt5_6Model(model)) return "gpt-5-5";  // gpt-5.6-sol 命中
if (isGptNativeSisyphusModel(model)) return "gpt-5-4";
```

- gpt-5.6-sol/terra/luna → `"gpt-5-5"` 家族 → `buildGpt55SisyphusPrompt`（`sisyphus/gpt-5-5.ts`，434 行专属 prompt 体），5.6 与 5.5 共用一份，仅身份文本不同（`gpt-prompt-identity.ts:3-19`）。
- 模型检测器：`agents/types.ts:133-149`。
- 运行时换体：`sisyphus-runtime-prompt-reconciler.ts:51-77` —— TUI 实际选中的模型与配置烘焙的不同时，system-transform hook 按运行时模型重建整个编排器 prompt。

### 3.2 硬性护栏："NEVER Use Sisyphus with GPT"

`packages/omo-opencode/src/hooks/no-sisyphus-gpt/hook.ts:47-83`：编排器（Sisyphus）跑在**非原生 GPT 模型**上时被强制改道到深层 worker（Hephaestus），并弹 toast "Do NOT use Sisyphus with GPT (except GPT-5.4, GPT-5.5, and GPT-5.6 Sol…)"。

**核心立场：只有 GPT-5.4/5.5/5.6-sol 被认可为"可当编排器"的 GPT 模型**，且显式配 `variant: medium` effort（`packages/model-core/src/agent-model-requirements.ts:4-24`）。

### 3.3 防过度委派：量化门槛表

GPT 家族专属的 ultrawork 注入体 `packages/prompts-core/prompts/ultrawork/gpt.md:39-54`：

| Complexity | Criteria | Decision |
|---|---|---|
| Trivial | <10 lines, single file, obvious pattern | **DO IT YOURSELF** |
| Moderate | Single domain, clear pattern, <100 lines | **DO IT YOURSELF**（快过委派开销） |
| Complex | Multi-file, unfamiliar domain, >100 lines | **DELEGATE** |
| Research | Need broad codebase/external context | **DELEGATE** to explore/librarian |

> "Delegation overhead ≈ 10-15 seconds. If task takes less, do it yourself. If you already have full context loaded, do it yourself."

对照：Claude 默认体 `default.md:142` 是激进委派（"DEFAULT BEHAVIOR: DELEGATE. DO NOT WORK YOURSELF."）——同一项目对不同模型族的默认立场相反，进一步印证"gpt 系需要收紧委派默认值"是实战结论。

### 3.4 委派 prompt 契约

`sisyphus/gpt-5-5.ts:181-192` 六段式：**TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT**；探索类 subagent 四字段：CONTEXT / GOAL / DOWNSTREAM / REQUEST。并要求"Never trust self-reports"——以返回的 EVIDENCE 对照 STOP WHEN 条件评判子代理。

---

## 四、oh-my-opencode-slim：无模型专属 prompt，走角色-模型匹配路线

### 4.1 结论

**没有**针对 gpt-5.6 的模型专属提示词。编排器 prompt 是单一常量模板（`src/agents/orchestrator.ts:130-309` 的 `buildOrchestratorPrompt()`，4 个参数均与模型无关）。模型差异化全部通过**每角色模型分配 + variant（reasoning effort）旋钮**实现。

### 4.2 角色-模型匹配策略

`src/cli/providers.ts:12-19`（openai 预设）：

```
orchestrator: gpt-5.6-terra, variant high
oracle:       gpt-5.6-sol,   variant high   ← sol 是顾问，不是编排器
librarian:    gpt-5.6-luna,  variant low
explorer:     gpt-5.6-luna,  variant low
fixer:        gpt-5.6-luna,  variant high
```

**编排器始终用 terra 保持调度敏捷，深度推理模型（sol）放在 oracle 顾问角色**。这与 dolphin 用 sol 当编排器时"想太多/过度委派"形成直接对照。

### 4.3 防过度委派的 prompt 硬规则

`orchestrator.ts:185-190` Routing threshold：

> "Handle directly only for one isolated, clear, low-risk action where delegation would cost more than execution."
> "**Do not delegate merely because an agent exists.** Do not keep substantive work entirely in the orchestrator merely because each individual step seems easy."

另有每个 specialist 的 Delegate/Don't-delegate 阶梯（如 fixer："Single small change (<20 lines, one file)" 不委派，"Explaining to fixer > doing" 不委派）。

---

## 五、横向对比

| 维度 | oh-my-pi | oh-my-openagent | oh-my-opencode-slim |
|---|---|---|---|
| gpt-5.6 专属 prompt | **有**（`{{#if useCodexTaskPrompt}}`，semver 判定） | **有**（12 个 prompt 家族路由） | 无 |
| 委派默认值 | gpt-5.6 → **fail-closed 禁委派**；其他模型 → eager | GPT 族 → 量化门槛表；Claude → 激进委派 | 统一：单点低险才自己做 |
| 防过度委派核心句 | "No subagents unless explicitly requested" | "<100 行单域自己做；委派开销 10-15s" | "Do not delegate merely because an agent exists" |
| task brief 契约 | `# Target/# Change/# Acceptance`，一句话 brief 被禁 | 六段式 TASK/OUTCOME/TOOLS/MUST/MUST NOT/CONTEXT | 宽松：引用路径不贴全文 + 每 agent 委派阶梯 |
| 模型治理 | wire 层（effort 阶梯、采样参数、harmony 泄漏重试） | 非原生 GPT 强制改道 worker + medium effort | 角色-模型匹配（sol 不当编排器） |

---

## 六、对 ZooKeeper dolphin 的启示

dolphin prompt 的 "Default Bias: DELEGATE" 正是 oh-my-pi 已证实的 gpt-5.6 翻车点。可选方向按侵入性排序：

1. **Prompt 层收紧（最小改动）**：给 dolphin 增加量化门槛（"≤N 行单文件 inline 做"）+ "不要仅因为 agent 存在就委派" 硬规则。可做成 gpt-5.6 专属变体 —— oh-my-pi 已示范最小实现仅需 8 行判定函数 + 一个模板条件块，ZooKeeper 可挂到 `[zoo.mode]` profile 机制或运行时模型检测上。
2. **Brief 格式强化**：dolphin 已有 SUMMARY/CONTEXT/ACCEPTANCE 三段式，可补充 oh-my-pi 的细则 —— "禁止一句话 brief"、"显式列出 ≤3-5 个目标路径"、"禁止假设 subagent 间共享上下文"，并可沉淀到 `src/core/validate.ts` 的运行时校验（现有词数限制 + 反模式检测框架可扩展）。
3. **角色重排（opencode-slim 思路）**：编排器换 gpt-5.6-terra，sol 降格为深推理顾问角色。改动在 config.toml 模型分配层，不动 prompt。

注意三家对策并不互斥：oh-my-openagent 自己就同时做了 1+2+护栏。ZooKeeper 可先做 1+2 的 prompt 手术观察效果，3 作为兜底方案。
