/**
 * Tests for the mode-conditional dolphin prompt builder.
 *
 * Covers the poly/mono mode gate, the prompt sections that must remain
 * available in each mode, shared Chinese communication guidance, continuation
 * handling, and the unit descriptor's active-set forwarding.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveSet, Deps } from "../core/slots.js";
import { buildDolphinPrompt, unit } from "./dolphin.js";

/** Minimal deps for unit descriptor instantiation. */
const DEPS: Deps = {
  limits: {},
  contextConfig: {},
  client: {},
  directory: "",
  resolveAgent: () => undefined,
};

/** Poly active set: beaver + lynx + spider present. */
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

/** Mono active set: no beaver / lynx / spider. */
const MONO_SET: ActiveSet = {
  agents: new Set(["dolphin", "mola"]),
  skills: new Set(),
  hooks: new Set(),
  tools: new Set(),
  commands: new Set(),
};

/** The continuation note shared by both prompt variants. */
const CONTINUATION_NOTE =
  "- 本轮结束时仍有未完成的待办事项，系统会自动唤醒你继续工作，并受有限的提醒次数约束。不要为了结束本轮而仓促收尾。如需用户作出决定才能继续，请使用结构化的 ask/question 工具提问；直接以纯文本提问可能无法暂停自动续写。";

/** Extract one <Tag>...</Tag> section verbatim from a prompt. */
function section(text: string, name: string): string {
  const match = new RegExp(`<${name}>[\\s\\S]*?</${name}>`).exec(text);
  assert.ok(match, `<${name}> section must exist`);
  return match[0];
}

/** Assert that top-level prompt sections appear in the expected order. */
function assertSectionOrder(text: string, names: string[]): void {
  let previous = -1;
  for (const name of names) {
    const current = text.indexOf(`<${name}>`);
    assert.ok(current > previous, `<${name}> must follow the previous section`);
    previous = current;
  }
}

describe("buildDolphinPrompt", () => {
  it("poly prompt contains the global routing contract", () => {
    const poly = buildDolphinPrompt(POLY_SET);
    assert.ok(poly.includes("<Agents>"));
    assert.ok(poly.includes("**beaver** — 代码实现"));
    assert.ok(poly.includes("**lynx** — 只读代码库探索"));
    assert.ok(poly.includes("**spider** — 只读网页调研"));
    assert.ok(poly.includes("**SUMMARY:**"));
    assert.ok(poly.includes("全局判断和交付连续性的有限资源"));
    assert.ok(poly.includes("可验收的结果"));
    assert.ok(poly.includes("可验收结果作为判断单位"));
    assert.ok(poly.includes("默认委派"));
    assert.ok(poly.includes("之前已经在同一工作上消耗的材料和尝试仍计入判断"));
    assert.ok(poly.includes("你只对关键结论做定点核验"));
    assert.ok(poly.includes("代码库搜索示例："));
  });

  it("each leaf agent enables the poly variant", () => {
    for (const agent of ["beaver", "lynx", "spider"]) {
      const set: ActiveSet = {
        ...MONO_SET,
        agents: new Set(["dolphin", "mola", agent]),
      };
      assert.ok(
        buildDolphinPrompt(set).includes("<Agents>"),
        `${agent} must enable the poly variant`,
      );
    }
  });

  it("poly agent inventory follows the active profile", () => {
    const set: ActiveSet = {
      ...MONO_SET,
      agents: new Set(["dolphin", "mola", "beaver"]),
    };
    const prompt = buildDolphinPrompt(set);
    assert.ok(prompt.includes("**beaver** — 代码实现"));
    assert.ok(!prompt.includes("**lynx** — 只读代码库探索"));
    assert.ok(!prompt.includes("**eagle** — 只读代码审查"));
    assert.ok(!prompt.includes("**kiwi** — 只读知识分析"));
  });

  it("mono variant removes delegation content and tools", () => {
    const mono = buildDolphinPrompt(MONO_SET);
    assert.ok(!mono.includes("<Agents>"));
    assert.ok(!mono.includes("task("));
    assert.ok(!/eagle/i.test(mono));
    assert.ok(!mono.includes("kiwi"));
    assert.ok(!mono.includes("wiki-ingest"));
    assert.ok(!mono.includes("code-review"));
    assert.ok(!mono.includes("<Tools>"));
  });

  it("mono variant keeps the core sections without a phased checklist", () => {
    const mono = buildDolphinPrompt(MONO_SET);
    for (const name of ["Role", "Contract", "Workflow"]) {
      assert.ok(mono.includes(`<${name}>`), `<${name}> section must exist`);
    }
    const workflow = section(mono, "Workflow");
    assert.ok(!workflow.includes("## Phase"));
    for (const line of workflow.split("\n")) {
      assert.ok(!line.startsWith("|"));
      assert.ok(!line.startsWith("- [ ]"));
    }
  });

  it("aligns poly section order and keeps its rules in place", () => {
    const poly = buildDolphinPrompt(POLY_SET);

    assertSectionOrder(poly, [
      "Role",
      "Agents",
      "Workflow",
      "Communication",
      "Contract",
    ]);
    assert.ok(!poly.includes("<Anti-Patterns>"));
    assert.ok(section(poly, "Workflow").includes("每轮开始时"));
    assert.ok(section(poly, "Workflow").includes("重新核对"));
    assert.ok(!section(poly, "Workflow").includes("阶段 0"));
    assert.ok(!section(poly, "Communication").includes("不发送"));
  });

  it("both variants use the shared Chinese communication guidance", () => {
    const poly = buildDolphinPrompt(POLY_SET);
    const mono = buildDolphinPrompt(MONO_SET);
    assert.equal(
      section(poly, "Communication"),
      section(mono, "Communication"),
    );
    assert.ok(
      section(mono, "Communication").includes(
        "- 不使用空洞的夸奖、过度道歉或模糊的自我辩护",
      ),
    );
    assert.ok(!poly.includes("**No flattery.**"));
    assert.ok(section(mono, "Role").includes("你是 dolphin"));
    assert.ok(section(mono, "Workflow").includes("先复现并确认根因"));
    assert.ok(section(mono, "Contract").includes("没有证据就**不能**算完成"));
  });

  it("an empty agent set keeps the mono variant", () => {
    const set: ActiveSet = { ...MONO_SET, agents: new Set() };
    assert.ok(!buildDolphinPrompt(set).includes("<Agents>"));
  });

  it("places the continuation note in both contracts and routes decisions through ask", () => {
    const polyContract = section(buildDolphinPrompt(POLY_SET), "Contract");
    assert.ok(polyContract.includes(CONTINUATION_NOTE));
    assert.ok(
      polyContract.indexOf("没有证据就") <
        polyContract.indexOf(CONTINUATION_NOTE),
    );

    const monoContract = section(buildDolphinPrompt(MONO_SET), "Contract");
    assert.ok(monoContract.includes(CONTINUATION_NOTE));
    assert.ok(
      monoContract.indexOf("没有证据就") <
        monoContract.indexOf(CONTINUATION_NOTE),
    );

    for (const set of [POLY_SET, MONO_SET]) {
      const prompt = buildDolphinPrompt(set);
      assert.ok(prompt.includes("使用结构化的 ask/question 工具提问"));
      assert.ok(!prompt.includes("{{"));
    }
  });

  it("unit descriptor passes activeSet through to the builder", () => {
    assert.equal(
      unit.create(DEPS, POLY_SET).agents[0].prompt,
      buildDolphinPrompt(POLY_SET),
    );
    assert.equal(
      unit.create(DEPS, MONO_SET).agents[0].prompt,
      buildDolphinPrompt(MONO_SET),
    );
  });
});
