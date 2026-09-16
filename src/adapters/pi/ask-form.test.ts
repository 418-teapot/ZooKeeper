/**
 * Tests for the pi ask-form presentation (`ask-form.ts`).
 *
 * The presentation paths are driven through a fake `ui.custom` that mounts
 * the REAL dialog headless: the TUI answer flow, an already-aborted signal
 * (the UI is never opened), an abort mid-form (answers already committed
 * survive), a host that closes the form without reporting, an abort that
 * lands before the dialog mounts, a `ui.custom` that rejects or whose
 * factory throws (the presenter still never throws), and the timeout budget
 * reaching the dialog title.
 *
 * The tool's argument parsing, result assembly and contribution live in
 * `src/tools/ask.test.ts`.
 *
 * @module
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAskArgs } from "../../tools/ask.js";
import { presentAskForm } from "./ask-form.js";
import { fakeTheme, fakeTui, formHarness } from "./ask-form-harness.js";
import type { AskDialogComponent, AskDialogOutcome } from "./tui/ask-dialog.js";

// ---------------------------------------------------------------------------
// presentAskForm
// ---------------------------------------------------------------------------

describe("ask tool — presentAskForm", () => {
  const two = parseAskArgs({
    questions: [
      { question: "One?", options: [{ label: "A1" }] },
      { question: "Two?", options: [{ label: "A2" }, { label: "B2" }] },
    ],
  });

  it("drives the real dialog through the fake ui.custom to a result", async () => {
    const form = formHarness();
    const running = presentAskForm({ questions: two, custom: form.custom });
    const component = form.component();
    assert.ok(component, "the dialog mounted");
    component.handleInput("\r"); // answer Q1 -> active Q2
    component.handleInput("\x1b[B"); // cursor onto B2
    component.handleInput("\r"); // answer Q2 -> Submit page
    component.handleInput("\r"); // submit
    const results = await running;
    assert.deepEqual(results, [
      { status: "answered", answer: ["A1"], wasCustom: false },
      { status: "answered", answer: ["B2"], wasCustom: false },
    ]);
  });

  it("an already-aborted signal never opens the UI", async () => {
    const form = formHarness();
    const controller = new AbortController();
    controller.abort();
    const results = await presentAskForm({
      questions: two,
      custom: form.custom,
      signal: controller.signal,
    });
    assert.equal(form.component(), undefined);
    assert.deepEqual(
      results,
      two.map(() => ({ status: "unavailable", reason: "aborted" })),
    );
  });

  it("aborting mid-form keeps committed answers and aborts the rest", async () => {
    const form = formHarness();
    const controller = new AbortController();
    const running = presentAskForm({
      questions: two,
      custom: form.custom,
      signal: controller.signal,
    });
    form.component()?.handleInput("\r"); // Q1 answered
    controller.abort();
    assert.deepEqual(await running, [
      { status: "answered", answer: ["A1"], wasCustom: false },
      { status: "unavailable", reason: "aborted" },
    ]);
  });

  it("a host that closes the form without a result yields aborted", async () => {
    const form = formHarness();
    const running = presentAskForm({ questions: two, custom: form.custom });
    form.resolve(undefined);
    assert.deepEqual(await running, [
      { status: "unavailable", reason: "aborted" },
      { status: "unavailable", reason: "aborted" },
    ]);
  });

  it("aborts before the dialog mounts as soon as it does mount", async () => {
    const controller = new AbortController();
    let resolveCustom:
      | ((outcome: AskDialogOutcome | undefined) => void)
      | undefined;
    const custom = (factory: unknown, _options: unknown) =>
      new Promise<AskDialogOutcome | undefined>((resolve) => {
        resolveCustom = resolve;
        // The signal fires while the factory is still running — the dialog
        // has no handle yet, so the abort is replayed onto it once mounted.
        controller.abort();
        (
          factory as (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (outcome: AskDialogOutcome) => void,
          ) => AskDialogComponent
        )(fakeTui(), fakeTheme(), {}, (outcome) => resolveCustom?.(outcome));
      });
    const running = presentAskForm({
      questions: two,
      custom,
      signal: controller.signal,
    });
    const results = await running;
    assert.deepEqual(results, [
      { status: "unavailable", reason: "aborted" },
      { status: "unavailable", reason: "aborted" },
    ]);
  });

  it("a rejecting ui.custom yields aborted slots, never a throw", async () => {
    const exploding = () => Promise.reject(new Error("form torn down"));
    const results = await presentAskForm({ questions: two, custom: exploding });
    assert.deepEqual(results, [
      { status: "unavailable", reason: "aborted" },
      { status: "unavailable", reason: "aborted" },
    ]);
  });

  it("a ui.custom whose factory throws yields aborted slots", async () => {
    const custom = (_factory: unknown, _options: unknown) => {
      throw new Error("host has no custom ui");
    };
    const results = await presentAskForm({ questions: two, custom });
    assert.deepEqual(
      results,
      two.map(() => ({ status: "unavailable", reason: "aborted" })),
    );
  });

  it("passes the timeout budget into the dialog title", async () => {
    const form = formHarness();
    const running = presentAskForm({
      questions: two,
      custom: form.custom,
      timeoutSeconds: 42,
    });
    const lines = form.component()?.render(60) ?? [];
    assert.match(lines.join("\n"), /Ask \(42s\)/);
    form.component()?.handleInput("\x1b");
    const results = await running;
    assert.deepEqual(results, [
      { status: "declined" },
      { status: "unavailable", reason: "aborted" },
    ]);
  });
});
