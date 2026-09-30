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

describe("buildDolphinPrompt", () => {
  it("poly prompt contains the delegation contract and Chinese agent guidance", () => {
    const poly = buildDolphinPrompt(POLY_SET);
    assert.ok(poly.includes("<Agents>"));
    assert.ok(poly.includes("**beaver** — 代码实现"));
    assert.ok(poly.includes("**lynx** — 只读代码库探索"));
    assert.ok(poly.includes("**spider** — 只读网页调研"));
    assert.ok(poly.includes("**SUMMARY:**"));
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
      polyContract.includes(
        `NO EVIDENCE = NOT COMPLETE.\n${CONTINUATION_NOTE}`,
      ),
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
