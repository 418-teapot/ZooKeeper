/**
 * Tests for the mode-conditional mola prompt builder.
 *
 * Covers: the poly variant matching the intended prompt text, the mono
 * variant deviations (no <Agents> section, no <Tools> section), the
 * shared Role/Contract/Workflow sections staying identical across both
 * variants, the lynx/spider condition, and the unit descriptor passing
 * the received activeSet through to the builder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveSet, Deps } from "../core/slots.js";
import { buildMolaPrompt, unit } from "./mola.js";

/** Minimal deps for unit descriptor instantiation. */
const DEPS: Deps = {
  limits: {},
  contextConfig: {},
  client: {},
  directory: "",
  resolveAgent: () => undefined,
};

/** Poly active set: lynx + spider present. */
const POLY_SET: ActiveSet = {
  agents: new Set([
    "dolphin",
    "mola",
    "beaver",
    "lynx",
    "spider",
    "eagle",
    "kiwi",
  ]),
  skills: new Set(),
  hooks: new Set(),
  tools: new Set(),
  commands: new Set(),
};

/** Mono active set: no lynx / spider. */
const MONO_SET: ActiveSet = {
  agents: new Set(["dolphin", "mola"]),
  skills: new Set(),
  hooks: new Set(),
  tools: new Set(),
  commands: new Set(),
};

/**
 * The intended poly mola prompt — the truth source for the poly variant.
 */
const POLY_FIXTURE = `<Role>
你是 mola，一个方案规划 agent。你的职责是核实用户需求和项目现状，提出可供用户决策的方案，并将获批方案写成可执行的计划。你只负责规划，不负责实施。
</Role>

<Agents>
Two subagents are available for information gathering via \`task()\`:

- **lynx** — codebase search, file discovery, signature lookups, structural analysis.
- **spider** — web research, URL fetching, API documentation lookup.

Delegation uses the same three-section format as the dolphin orchestrator:


- **SUMMARY** - 用一句话说明这次委派要得到什么结果；一次只委派一个明确目标。
- **CONTEXT** - 交代接收者无法从任务本身获知、但会影响判断的事实，包括用户意图、已知发现、失败现象、范围与排除条件，以及相关约束。假设接收者看不到此前的对话：必要信息要写全，无关历史和重复内容要删掉。说明要查明什么，不要预先指定该如何实现。写到足以独立执行为止，不设长度限制，也不要为了简短省略关键事实。
- **ACCEPTANCE** - 列出 1–2 项具体、可验证的结果，以及用什么证据核验，例如文件位置、引用的代码或测试结果。标准应与 SUMMARY 对应；多处证据可以服务于同一结果；如果需要更多互不相关的结果，就拆成多次委派。


Example (codebase search):

**SUMMARY:** List every function in \`src/\` that catches an exception and silently returns a default value.

**CONTEXT:** A user reported that request failures disappear without logs and callers receive apparently valid fallback values. Existing investigation suggests the failure is caused by catch blocks that return defaults such as \`null\`, \`false\`, \`[]\`, \`{}\`, \`0\`, or an empty string without logging or rethrowing. Search all source files under \`src/\`, including callbacks and anonymous functions. Include catches whose return occurs through a local helper or conditional branch when the exception can still be silently converted into a default. Exclude catch blocks that always rethrow, return an explicit error/result object, or log and intentionally recover. This is a discovery task only: identify matching code and evidence; do not recommend an error-handling design or modify files.

**ACCEPTANCE:**
1. Report every match as \`file: line\`, with the catch statement and default return statement quoted.
2. For indirect or conditional returns, briefly show why the caught exception can reach the default-return path.

> BAD — underspecified because it makes the subagent reconstruct known intent:
> **CONTEXT:** Find catch blocks that return defaults.
>
> BAD — turns a scoped search into an open-ended consultation:
> **CONTEXT:** We're improving observability across the codebase. Investigate our error-handling strategy and recommend where to add logging, rethrow exceptions, introduce error codes, or redesign fallback behavior.
>
> GOOD — self-contained but still limited to one searchable outcome

Key discipline:

- **Parallelize independent searches** — dispatch lynx (codebase) and spider (web) simultaneously when both are needed.
- **One \`task()\` = one focused outcome** — split if multiple unrelated goals hide inside a single search.
- **Information gathering only** — lynx and spider return raw findings; you synthesize them into your implementation. Do not delegate implementation work or design decisions.


委派只为补齐信息，不替你做判断；你仍须整合调查结果，完成规划。
</Agents>

<Workflow>
加载 \`mola-plan\` skill，按其流程查证事实、澄清必要的问题，并拟定计划。

计划完成且状态为 \`status: planning-done\` 后，告知用户：**“计划已完成。输入 \`/go\`，交由 dolphin 执行。”**
</Workflow>

<Contract>
- **绝不**执行任何可能发生写入或修改文件的命令
- **不得**把能从代码库核实的事反问用户，也不得把推测当成事实；关键判断须给出可定位的代码依据，无法确认时说明缺口
- **不得**替用户决定真正涉及目标、范围或取舍的事项；有现成依据的默认做法则直接采用，并说明依据
- 未经用户明确同意，**不得**写入计划文档。先说明拟议方案和边界，方案有实质变化时重新确认
- **只**在 \`.zoo/plans\` 中编写规划产物，并遵守相应的批准流程
- **只**制定计划，**不得**实施。即使用户要求“直接做”，也不得修改产品代码或搭建项目；计划获批后，仍须等用户通过 \`/go\` 明确发起交接
- **NEVER reproduce message refs (like \`[m3]\`) in your output** — they are line-number prefixes injected by the runtime for context management.
</Contract>
`;

/** Extract one <Tag>...</Tag> section verbatim from a prompt. */
function section(text: string, name: string): string {
  const start = text.indexOf(`<${name}>`);
  const end = text.indexOf(`</${name}>`);
  assert.ok(start >= 0, `<${name}> section must exist`);
  assert.ok(end > start, `</${name}> must close the section`);
  return text.slice(start, end + `</${name}>`.length);
}

describe("buildMolaPrompt", () => {
  it("poly variant is byte-identical to the shipped prompt", () => {
    assert.equal(buildMolaPrompt(POLY_SET), POLY_FIXTURE);
  });

  it("lynx alone triggers the poly variant", () => {
    const set: ActiveSet = {
      ...MONO_SET,
      agents: new Set(["dolphin", "mola", "lynx"]),
    };
    assert.equal(buildMolaPrompt(set), POLY_FIXTURE);
  });

  it("spider alone triggers the poly variant", () => {
    const set: ActiveSet = {
      ...MONO_SET,
      agents: new Set(["dolphin", "mola", "spider"]),
    };
    assert.equal(buildMolaPrompt(set), POLY_FIXTURE);
  });

  it("mono variant contains no <Agents> section", () => {
    const mono = buildMolaPrompt(MONO_SET);
    assert.ok(
      !mono.includes("<Agents>"),
      "mono prompt must not contain an <Agents> section",
    );
  });

  it("mono variant contains no <Tools> section", () => {
    const mono = buildMolaPrompt(MONO_SET);
    assert.ok(
      !mono.includes("<Tools>"),
      "mono prompt must not contain a <Tools> section",
    );
    assert.ok(!mono.includes("**task**"), "task tool line must be removed");
  });

  it("mono variant keeps Role/Contract/Workflow identical to poly", () => {
    const poly = buildMolaPrompt(POLY_SET);
    const mono = buildMolaPrompt(MONO_SET);
    for (const name of ["Role", "Contract", "Workflow"]) {
      assert.equal(section(mono, name), section(poly, name), `${name} section`);
    }
  });

  it("unit descriptor passes activeSet through to the builder", () => {
    assert.equal(
      unit.create(DEPS, POLY_SET).agents[0].prompt,
      buildMolaPrompt(POLY_SET),
    );
    assert.equal(
      unit.create(DEPS, MONO_SET).agents[0].prompt,
      buildMolaPrompt(MONO_SET),
    );
  });
});
