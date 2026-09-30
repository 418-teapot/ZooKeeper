/**
 * Shared prompt fragments for ZooKeeper agents.
 *
 * DELEGATION_FORMAT_TEXT — the canonical delegation-format block used by
 *   orchestrator and subagents.
 * SUBAGENT_PROMPT_HINT — format guidance injected into the `task` tool's
 *   parameter description.
 *
 * Scope: fragments composing agent prompts only. Hook/tool-injected nudge
 * texts live in `src/core/prompts.ts`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Delegation format — single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical delegation-format block.
 *
 * Three required sections (SUMMARY / CONTEXT / ACCEPTANCE) with concise
 * structural guidance. Used by all agents that can delegate.
 */
export const DELEGATION_FORMAT_TEXT = `**SUMMARY:** 用一句话说明这次委派要得到什么结果；一次只委派一个明确目标。

**CONTEXT:** 交代接收者无法从任务本身获知、但会影响判断的事实，包括用户意图、已知发现、失败现象、范围与排除条件，以及相关约束。假设接收者看不到此前的对话：必要信息要写全，无关历史和重复内容要删掉。说明要查明什么，不要预先指定该如何实现。写到接收者能够独立执行为止，不设长度限制，不要为了简短省略关键事实；同时避免加入与当前结果无关的背景。

**ACCEPTANCE:** 列出 1–2 项具体、可验证的结果，以及用什么证据核验，例如文件位置、引用的代码或测试结果。标准应与 SUMMARY 对应；多处证据可以服务于同一结果；如果需要更多互不相关的结果，就拆成多次委派。
`;

// ---------------------------------------------------------------------------
// Subagent prompt hint
// ---------------------------------------------------------------------------

export const SUBAGENT_PROMPT_HINT = `所有委派目标都必须遵循此格式：

${DELEGATION_FORMAT_TEXT}`;

/**
 * Format guidance shown in the `task` tool's `prompt` parameter description.
 * The LLM sees this in the schema on every call.
 */
// ---------------------------------------------------------------------------
// Agent role descriptions — shared across all agents that reference them
// ---------------------------------------------------------------------------

export const LYNX_AGENT_LINE = `- **lynx** — 只读代码库探索：查找实现、调用关系和结构，并提供可定位的代码依据。`;

export const SPIDER_AGENT_LINE = `- **spider** — 只读网页调研：查找外部资料和 API 文档，并提供带 URL 的可核查依据。`;

export const BEAVER_AGENT_LINE = `- **beaver** — 代码实现：编写或修改代码、补充测试，并验证变更结果。`;

export const EAGLE_AGENT_LINE = `- **eagle** — 只读代码审查：识别有具体证据、足以影响合并决策的问题；需要审查时加载 \`code-review\` skill。`;

export const KIWI_AGENT_LINE = `- **kiwi** — 只读知识分析：整理和核验外部 URL、文档或 wiki 内容；按任务加载相应的 wiki skill。`;

// ---------------------------------------------------------------------------
// Leaf subagent listing — shared across beaver + mola
// ---------------------------------------------------------------------------

/**
 * Shared introduction listing available leaf subagents.
 *
 * Both beaver and mola delegate to lynx (codebase) and spider (web)
 * for information gathering.  This header introduces them with their
 * one-line roles.
 */
export const DELEGATION_LEAF_AGENTS_HEADER = `通过委派工具可以调用以下两个子 agent 收集信息：

${LYNX_AGENT_LINE}
${SPIDER_AGENT_LINE}
`;

// ---------------------------------------------------------------------------
// Delegation discipline — shared across beaver + mola
// ---------------------------------------------------------------------------

/**
 * Common delegation discipline rules.
 *
 * Three rules that apply identically to agents that delegate to leaf
 * subagents (lynx/spider) for information gathering.  Consumed by
 * beaver and mola with their own identity closing lines.
 */
export const DELEGATION_DISCIPLINE_TEXT = `委派时遵守以下原则：

- 委派应**只**把可以从代码库或资料中查明的具体问题交给 lynx 或 spider，**不得**让它们评估最佳方案、调查整体策略，或替你做设计判断
- lynx 和 spider **只**负责返回发现及其依据；由你整合结果，完成自己的规划或实现。**不得**把实现工作或方案设计交给它们
- 彼此独立且都确实需要的搜索可以并行；依赖前一项结果的搜索**必须**等前一项完成后再进行
`;

// ---------------------------------------------------------------------------
// Leaf delegation example — shared across beaver + mola
// ---------------------------------------------------------------------------

/**
 * Filled three-section example for leaf-subagent delegation.
 *
 * Shows a concrete SUMMARY / CONTEXT / ACCEPTANCE block for a lynx
 * codebase-search task. Uses a generic scenario (error-handling audit)
 * so agents pattern-match the structure, not project-specific symbols.
 */
export const DELEGATION_LEAF_EXAMPLE = `代码库搜索示例：

**SUMMARY:** 找出 \`src/\` 下捕获异常后静默返回默认值的所有 catch 块。

**CONTEXT:** 用户反馈请求失败后没有日志，调用方却收到了看似有效的返回值。需要确认代码库中是否存在捕获异常后静默返回默认值的处理。

- 搜索范围：\`src/\` 下的所有源文件，包括回调函数和匿名函数。
- 匹配条件：catch 捕获异常后，既没有重新抛出异常，也没有通过现有日志机制记录异常，同时直接或间接向调用方返回 \`null\`、\`false\`、\`[]\`、\`{}\`、\`0\` 或空字符串等默认值。间接返回包括通过局部辅助函数或条件分支返回。
- 排除条件：始终重新抛出异常、返回明确错误或结果对象，或记录日志后有意恢复的 catch。
- 任务边界：这是一项只读代码库探索任务，只报告匹配代码及其依据，不修改文件，不提出错误处理方案。

**ACCEPTANCE:**
1. 对每个匹配项报告 \`path/to/file:line\`，引用 catch 语句和默认返回路径，并标明所在函数。
2. 对间接或条件返回，说明捕获的异常如何到达默认返回路径；如果没有匹配项，说明搜索范围和使用过的搜索方式。

---

常见反例：

反例一：上下文不足

> **SUMMARY:** ...
> **CONTEXT:** 这个问题可能与错误处理有关，请调查。
> **ACCEPTANCE:** ...
> 说明：没有说明现象、判断标准、排除条件或任务边界。

反例二：目标或验收不清

> **SUMMARY:** 调查代码库中的错误处理问题。
> **CONTEXT:** ...
> **ACCEPTANCE:** 报告调查结果。
> 说明：没有明确搜索范围、证据格式，以及间接返回是否算匹配。

反例三：越过信息收集边界

> **SUMMARY:** ...
> **CONTEXT:** 调查整个代码库的错误处理策略，并建议在哪里加日志、重新抛出异常或重设计兜底逻辑。
> **ACCEPTANCE:** ...
> 说明：这已经要求 agent 做方案设计，而不是收集事实。`;

// ---------------------------------------------------------------------------
// Message ref no-echo instruction
// ---------------------------------------------------------------------------

/**
 * Instructs the model never to reproduce line-start `[mN] ` ref prefixes
 * in its output.
 *
 * These refs are line-number addresses injected by the render layer at
 * line start of every visible view item; the model sees them in its
 * input and could echo them back.  Reproducing them in free text is
 * never useful — they are an addressing convention, not content — so
 * "never reproduce" is safe across the whole prompt surface today.
 *
 * When a model-driven compress tool lands that accepts refs in tool
 * calls, this wording must change to allow referencing refs inside tool
 * arguments while still suppressing verbatim echo in free text.
 */
export const MSG_REF_NO_ECHO =
  "**不要在输出中复述消息引用（例如 `[m3]`）**——它们是运行时注入、用于上下文管理的行号前缀。";
