/**
 * Tests for the mode-conditional mola prompt builder.
 *
 * Covers the poly/mono mode gate, delegation guidance, shared sections, and
 * the unit descriptor's active-set forwarding without duplicating the prompt
 * body as a second fixture.
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

/** Extract one <Tag>...</Tag> section verbatim from a prompt. */
function section(text: string, name: string): string {
  const start = text.indexOf(`<${name}>`);
  const end = text.indexOf(`</${name}>`);
  assert.ok(start >= 0, `<${name}> section must exist`);
  assert.ok(end > start, `</${name}> must close the section`);
  return text.slice(start, end + `</${name}>`.length);
}

describe("buildMolaPrompt", () => {
  it("poly prompt contains the Chinese delegation guidance", () => {
    const poly = buildMolaPrompt(POLY_SET);
    assert.ok(poly.includes("<Agents>"));
    assert.ok(poly.includes("**lynx** — 只读代码库探索"));
    assert.ok(poly.includes("**spider** — 只读网页调研"));
    assert.ok(poly.includes("**SUMMARY:**"));
    assert.ok(poly.includes("代码库搜索示例："));
    assert.ok(poly.includes("委派时遵守以下原则："));
  });

  it("lynx or spider alone enables the poly variant", () => {
    for (const agent of ["lynx", "spider"]) {
      const set: ActiveSet = {
        ...MONO_SET,
        agents: new Set(["dolphin", "mola", agent]),
      };
      assert.ok(
        buildMolaPrompt(set).includes("<Agents>"),
        `${agent} must enable the poly variant`,
      );
    }
  });

  it("mono variant omits delegation and tool sections", () => {
    const mono = buildMolaPrompt(MONO_SET);
    assert.ok(!mono.includes("<Agents>"));
    assert.ok(!mono.includes("<Tools>"));
    assert.ok(!mono.includes("**task**"));
  });

  it("poly and mono share Role, Workflow, and Contract", () => {
    const poly = buildMolaPrompt(POLY_SET);
    const mono = buildMolaPrompt(MONO_SET);
    for (const name of ["Role", "Workflow", "Contract"]) {
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
