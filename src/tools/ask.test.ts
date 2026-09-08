/**
 * Tests for the ask tool adapter (`ask.ts`).
 *
 * Covers the adapter's three jobs:
 *  - argument parsing (core defaults applied through `normalizeQuestion`,
 *    lenient `recommended` handling, terminal control sequences stripped from
 *    the model's texts, loud errors for malformed input);
 *  - result assembly (one `Q<n>: <question> => <core rendering>` line per
 *    question, and the structured `details` written back through the host
 *    context's details slot);
 *  - the presentation paths, driven through a fake `ui.custom` that mounts
 *    the REAL dialog headless: the TUI answer flow, the non-TUI `no-ui`
 *    fallback, an already-aborted signal (the UI is never opened), an
 *    abort mid-form (answers already committed survive), a host that closes
 *    the overlay without reporting, a `ui.custom` that rejects (the tool
 *    still never throws), and the `guardAnswers` replacement of a
 *    structurally illegal `answered` slot.
 *
 * Also the unit descriptor's pi-only fail-closed behaviour (no
 * `piSwitchHost` → zero tools) and the `sequential` scheduling hint.
 *
 * @module
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AskDialogComponent,
  AskDialogOutcome,
  AskDialogThemeLike,
  AskDialogTuiLike,
} from "../adapters/pi/tui/ask-dialog.js";
import type { AskResult, NormalizedQuestion } from "../core/ask.js";
import type { ActiveSet, Deps } from "../core/slots.js";
import {
  assembleAskResults,
  guardAnswers,
  parseAskArgs,
  presentAskForm,
  unit,
} from "./ask.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A TUI that swallows render requests. */
function fakeTui(): AskDialogTuiLike {
  return { requestRender() {}, terminal: { rows: 24, columns: 80 } };
}

/** An identity theme — no ANSI, so the assembled text matches literally. */
function fakeTheme(): AskDialogThemeLike {
  return { fg: (_color, text) => text, bold: (text) => text };
}

/** A `ui.custom` surface that mounts the real dialog and exposes it. */
function overlayHarness(): {
  custom(factory: unknown, options: unknown): unknown;
  /** The mounted component (undefined until the factory ran). */
  component(): AskDialogComponent | undefined;
  /** Resolve the pending `ui.custom` call with an arbitrary outcome. */
  resolve(outcome: AskDialogOutcome | undefined): void;
} {
  let mounted: AskDialogComponent | undefined;
  let resolver: ((outcome: AskDialogOutcome | undefined) => void) | undefined;
  return {
    custom(factory, _options) {
      // The promise resolver is installed BEFORE the factory runs: a dialog
      // that closes during its own mount (the abort-before-mount replay)
      // must not lose its result.
      const pending = new Promise<AskDialogOutcome | undefined>((resolve) => {
        resolver = resolve;
      });
      mounted = (
        factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (outcome: AskDialogOutcome) => void,
        ) => AskDialogComponent
      )(fakeTui(), fakeTheme(), {}, (outcome) => resolver?.(outcome));
      return pending;
    },
    component: () => mounted,
    resolve: (outcome) => resolver?.(outcome),
  };
}

/** Send one raw key to a mounted dialog. */
function key(component: AskDialogComponent, data: string): void {
  component.handleInput(data);
}
// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe("ask tool — argument parsing", () => {
  it("applies the core defaults and keeps options concrete", () => {
    const [question] = parseAskArgs({
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
    });
    assert.equal(question.multiple, false);
    assert.equal(question.allowFreeform, true);
    assert.deepEqual(question.options, [{ label: "A" }]);
    assert.equal(question.recommended, undefined);
  });

  it("a question without candidates is forced freeform by the core", () => {
    const [question] = parseAskArgs({
      questions: [{ question: "What happened?", allowFreeform: false }],
    });
    assert.equal(question.allowFreeform, true);
    assert.deepEqual(question.options, []);
  });

  it("keeps a valid recommended index and drops a nonsense one", () => {
    const [keep] = parseAskArgs({
      questions: [{ question: "q", options: [{ label: "A" }], recommended: 0 }],
    });
    assert.equal(keep.recommended, 0);
    const [drop] = parseAskArgs({
      questions: [
        { question: "q", options: [{ label: "A" }], recommended: "first" },
      ],
    });
    assert.equal(drop.recommended, undefined);
  });

  it("carries an option description through", () => {
    const [question] = parseAskArgs({
      questions: [
        {
          question: "q",
          options: [{ label: "A", description: "the first one" }],
        },
      ],
    });
    assert.equal(question.options[0].description, "the first one");
  });

  it("strips terminal control sequences from the model's texts", () => {
    const [question] = parseAskArgs({
      questions: [
        {
          question: "\x1b[2JWhich DB?\x1b]0;evil\x07",
          options: [
            {
              label: "\x1b[31mSQLite\x1b[0m",
              description: "\x1b_\x07fast, no server",
            },
          ],
        },
      ],
    });
    assert.equal(question.question, "Which DB?");
    assert.equal(question.options[0].label, "SQLite");
    assert.equal(question.options[0].description, "fast, no server");
  });

  it("rejects a text that is nothing but control sequences", () => {
    assert.throws(
      () =>
        parseAskArgs({
          questions: [{ question: "q", options: [{ label: "\x1b[31m" }] }],
        }),
      /label/,
    );
    assert.throws(
      () => parseAskArgs({ questions: [{ question: "\x1b[2J\x1b[0m" }] }),
      /question/,
    );
  });

  it("rejects malformed arguments with loud guidance", () => {
    const bad: unknown[] = [
      undefined,
      [],
      { questions: "q?" },
      { questions: [] },
      { questions: [{ question: "  " }] },
      { questions: [{ question: 42 }] },
      { questions: ["nope"] },
      { questions: [{ question: "q", options: "A" }] },
      { questions: [{ question: "q", options: [null] }] },
      { questions: [{ question: "q", options: [{ label: "" }] }] },
    ];
    for (const args of bad) {
      assert.throws(
        () => parseAskArgs(args),
        /ask \u5de5\u5177\u53c2\u6570\u9519\u8bef/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

describe("ask tool — result assembly", () => {
  const questions: NormalizedQuestion[] = [
    {
      question: "Ship it?",
      options: [{ label: "Yes" }],
      multiple: false,
      allowFreeform: true,
    },
    {
      question: "Which files?",
      options: [{ label: "a.ts" }],
      multiple: true,
      allowFreeform: true,
    },
  ];

  it("writes one line per question and the structured details", () => {
    const results: AskResult[] = [
      { status: "answered", answer: ["Yes"], wasCustom: false },
      { status: "unavailable", reason: "timeout" },
    ];
    const { text, details } = assembleAskResults(questions, results);
    assert.equal(
      text,
      "Q1: Ship it? => User answered: Yes\nQ2: Which files? => User unavailable (timeout)",
    );
    assert.deepEqual(details.questions[0], {
      question: "Ship it?",
      result: results[0],
    });
    assert.deepEqual(details.questions[1], {
      question: "Which files?",
      result: results[1],
    });
  });

  it("renders custom, declined and multi-answer slots via the core", () => {
    const one: NormalizedQuestion[] = [
      { question: "Note?", options: [], multiple: false, allowFreeform: true },
    ];
    assert.equal(
      assembleAskResults(one, [
        { status: "answered", answer: ["a", "b"], wasCustom: false },
      ]).text,
      "Q1: Note? => User answered: a, b",
    );
    assert.equal(
      assembleAskResults(one, [
        { status: "answered", answer: ["typed"], wasCustom: true },
      ]).text,
      "Q1: Note? => User wrote: typed",
    );
    assert.equal(
      assembleAskResults(one, [{ status: "declined" }]).text,
      "Q1: Note? => User declined to answer",
    );
    assert.equal(
      assembleAskResults(one, [{ status: "unavailable", reason: "no-ui" }])
        .text,
      "Q1: Note? => User unavailable (no-ui)",
    );
  });

  it("collapses an embedded newline onto the question's single line", () => {
    const multiline: NormalizedQuestion[] = [
      {
        question: "Two\nlines?",
        options: [],
        multiple: false,
        allowFreeform: true,
      },
    ];
    const { text } = assembleAskResults(multiline, [{ status: "declined" }]);
    assert.equal(text.split("\n").length, 1);
    assert.match(text, /^Q1: Two lines\? => /);
  });

  it("fills a missing result slot as aborted rather than dropping the line", () => {
    const { text, details } = assembleAskResults(questions, [
      { status: "declined" },
    ]);
    assert.equal(text.split("\n").length, 2);
    assert.deepEqual(details.questions[1].result, {
      status: "unavailable",
      reason: "aborted",
    });
  });
});

describe("ask tool — guardAnswers", () => {
  const question: NormalizedQuestion[] = [
    {
      question: "q",
      options: [{ label: "A" }],
      multiple: false,
      allowFreeform: true,
    },
  ];

  it("keeps legal results untouched", () => {
    const legal: AskResult[] = [
      { status: "answered", answer: ["A"], wasCustom: false },
    ];
    assert.deepEqual(guardAnswers(question, legal), legal);
    const declined: AskResult[] = [{ status: "declined" }];
    assert.deepEqual(guardAnswers(question, declined), declined);
  });

  it("replaces an answered slot that the question cannot produce", () => {
    const [result] = guardAnswers(question, [
      { status: "answered", answer: ["invented"], wasCustom: false },
    ]);
    assert.deepEqual(result, { status: "unavailable", reason: "aborted" });
  });

  it("replaces a custom answer for a question that forbids freeform", () => {
    const noFreeform: NormalizedQuestion[] = [
      {
        question: "q",
        options: [{ label: "A" }],
        multiple: false,
        allowFreeform: false,
      },
    ];
    const [result] = guardAnswers(noFreeform, [
      { status: "answered", answer: ["typed"], wasCustom: true },
    ]);
    assert.deepEqual(result, { status: "unavailable", reason: "aborted" });
  });
});

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

  it("drives the real dialog through the fake overlay to a result", async () => {
    const overlay = overlayHarness();
    const running = presentAskForm({ questions: two, custom: overlay.custom });
    const component = overlay.component();
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
    const overlay = overlayHarness();
    const controller = new AbortController();
    controller.abort();
    const results = await presentAskForm({
      questions: two,
      custom: overlay.custom,
      signal: controller.signal,
    });
    assert.equal(overlay.component(), undefined);
    assert.deepEqual(
      results,
      two.map(() => ({ status: "unavailable", reason: "aborted" })),
    );
  });

  it("aborting mid-form keeps committed answers and aborts the rest", async () => {
    const overlay = overlayHarness();
    const controller = new AbortController();
    const running = presentAskForm({
      questions: two,
      custom: overlay.custom,
      signal: controller.signal,
    });
    overlay.component()?.handleInput("\r"); // Q1 answered
    controller.abort();
    assert.deepEqual(await running, [
      { status: "answered", answer: ["A1"], wasCustom: false },
      { status: "unavailable", reason: "aborted" },
    ]);
  });

  it("a host that closes the overlay without a result yields aborted", async () => {
    const overlay = overlayHarness();
    const running = presentAskForm({ questions: two, custom: overlay.custom });
    overlay.resolve(undefined);
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
    const exploding = () => Promise.reject(new Error("overlay torn down"));
    const results = await presentAskForm({ questions: two, custom: exploding });
    assert.deepEqual(results, [
      { status: "unavailable", reason: "aborted" },
      { status: "unavailable", reason: "aborted" },
    ]);
  });

  it("a ui.custom whose factory throws yields aborted slots", async () => {
    const custom = (_factory: unknown, _options: unknown) => {
      throw new Error("host has no overlay");
    };
    const results = await presentAskForm({ questions: two, custom });
    assert.deepEqual(
      results,
      two.map(() => ({ status: "unavailable", reason: "aborted" })),
    );
  });

  it("passes the timeout budget into the dialog title", async () => {
    const overlay = overlayHarness();
    const running = presentAskForm({
      questions: two,
      custom: overlay.custom,
      timeoutSeconds: 42,
    });
    const lines = overlay.component()?.render(60) ?? [];
    assert.match(lines.join("\n"), /Ask \(42s\)/);
    overlay.component()?.handleInput("\x1b");
    const results = await running;
    assert.deepEqual(results, [
      { status: "declined" },
      { status: "unavailable", reason: "aborted" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The tool contribution
// ---------------------------------------------------------------------------

describe("ask tool — contribution", () => {
  const args = {
    questions: [
      { question: "One?", options: [{ label: "A1" }] },
      { question: "Two?", options: [{ label: "A2" }], multiple: true },
    ],
  };

  it("reports no-ui without a TUI (still a normal result, never an error)", async () => {
    const tool = unitTools()[0];
    const hostCtx: { details?: unknown } = {};
    const text = await tool.execute(args, { mode: "print" }, hostCtx);
    assert.equal(
      text,
      "Q1: One? => User unavailable (no-ui)\nQ2: Two? => User unavailable (no-ui)",
    );
    assert.deepEqual(
      (hostCtx.details as { questions: { question: string }[] }).questions.map(
        (entry) => entry.question,
      ),
      ["One?", "Two?"],
    );
  });

  it("reports no-ui when the host has no custom-component surface", async () => {
    const tool = unitTools()[0];
    const text = await tool.execute(args, { mode: "tui", ui: {} });
    assert.match(text, /User unavailable \(no-ui\)/);
  });

  it("assembles a real dialog run into text + details", async () => {
    const tool = unitTools()[0];
    const overlay = overlayHarness();
    const hostCtx: { details?: unknown } = {};
    const running = tool.execute(args, { mode: "tui", ui: overlay }, hostCtx);
    const component = overlay.component();
    assert.ok(component);
    key(component, "\r"); // Q1 = A1 -> Q2
    key(component, "\x1b"); // decline Q2
    const text = await running;
    assert.equal(
      text,
      "Q1: One? => User answered: A1\nQ2: Two? => User declined to answer",
    );
    const details = hostCtx.details as {
      questions: { question: string; result: AskResult }[];
    };
    assert.deepEqual(details.questions, [
      {
        question: "One?",
        result: { status: "answered", answer: ["A1"], wasCustom: false },
      },
      { question: "Two?", result: { status: "declined" } },
    ]);
  });

  it("drops a forged answered slot reported by the dialog", async () => {
    const tool = unitTools()[0];
    const overlay = {
      custom: (_factory: unknown, _options: unknown) =>
        Promise.resolve({
          results: [
            { status: "answered", answer: ["never-offered"], wasCustom: false },
            { status: "declined" },
          ] as AskResult[],
          closure: "submit" as const,
        }),
    };
    const hostCtx: { details?: unknown } = {};
    const text = await tool.execute(
      args,
      { mode: "tui", ui: overlay },
      hostCtx,
    );
    assert.match(text, /Q1: One\? => User unavailable \(aborted\)/);
    assert.match(text, /Q2: Two\? => User declined to answer/);
  });

  it("hands the dialog the sanitized question and labels", async () => {
    const tool = unitTools()[0];
    const overlay = overlayHarness();
    const running = tool.execute(
      {
        questions: [
          {
            question: "\x1b[1mOne?\x1b[0m",
            options: [{ label: "\x1b[31mA1\x1b[0m" }],
          },
        ],
      },
      { mode: "tui", ui: overlay },
    );
    const component = overlay.component();
    assert.ok(component, "the dialog mounted");
    // The identity theme adds no ANSI of its own, so any escape in the panel
    // would have come from the model's text.
    const view = () => component.render(60).join("\n");
    assert.ok(
      !view().includes("\x1b"),
      "the dialog must not receive control sequences",
    );
    assert.match(view(), /One\?/);
    assert.match(view(), /A1/);
    key(component, "\r");
    assert.equal(await running, "Q1: One? => User answered: A1");
  });

  it("reports aborted slots when the host's ui.custom rejects", async () => {
    const tool = unitTools()[0];
    const hostCtx: { details?: unknown } = {};
    const text = await tool.execute(
      args,
      { mode: "tui", ui: { custom: () => Promise.reject(new Error("boom")) } },
      hostCtx,
    );
    assert.equal(
      text,
      "Q1: One? => User unavailable (aborted)\nQ2: Two? => User unavailable (aborted)",
    );
    assert.deepEqual(
      (hostCtx.details as { questions: { result: AskResult }[] }).questions.map(
        (entry) => entry.result,
      ),
      [
        { status: "unavailable", reason: "aborted" },
        { status: "unavailable", reason: "aborted" },
      ],
    );
  });

  it("still throws the loud guidance error on malformed arguments", async () => {
    const tool = unitTools()[0];
    await assert.rejects(
      () => tool.execute({ questions: [] }, { mode: "print" }),
      /ask \u5de5\u5177\u53c2\u6570\u9519\u8bef/,
    );
  });

  it("declares sequential execution so two forms never overlap", () => {
    assert.equal(unitTools()[0].executionMode, "sequential");
  });

  it("declares the arg surface the model must fill and the slots policy", () => {
    const tool = unitTools()[0];
    assert.deepEqual(tool.required, ["questions"]);
    const questions = tool.args?.questions as {
      items: { required: string[]; properties: Record<string, unknown> };
    };
    assert.deepEqual(questions.items.required, ["question"]);
    assert.deepEqual(Object.keys(questions.items.properties).sort(), [
      "allowFreeform",
      "multiple",
      "options",
      "question",
      "recommended",
    ]);
    // The description tells the model that a refusal or a timeout is a
    // normal result (\u62d2\u7b54 / \u8d85\u65f6), so it does not re-ask.
    assert.match(tool.description, /\u62d2\u7b54/);
    assert.match(tool.description, /\u8d85\u65f6/);
  });
});

// ---------------------------------------------------------------------------
// Unit registration
// ---------------------------------------------------------------------------

describe("ask tool — unit descriptor", () => {
  it("contributes zero tools without the pi host surface (OpenCode)", () => {
    const contributions = unit.create(makeDeps({}), activeSet());
    assert.equal(contributions.kind, "tool");
    assert.deepEqual(contributions.tools, []);
  });

  it("contributes the ask tool when the pi host surface is present", () => {
    const contributions = unit.create(
      makeDeps({ piSwitchHost: HOST }),
      activeSet(),
    );
    assert.equal(contributions.kind, "tool");
    assert.equal(contributions.tools.length, 1);
    assert.equal(contributions.tools[0].name, "ask");
  });

  it("passes the configured timeout through to the dialog", async () => {
    const contributions = unit.create(
      makeDeps({ piSwitchHost: HOST, askTimeoutSeconds: 7 }),
      activeSet(),
    );
    assert.equal(contributions.kind, "tool");
    const tool = contributions.tools[0];
    const overlay = overlayHarness();
    const running = tool.execute(
      { questions: [{ question: "One?", options: [{ label: "A" }] }] },
      { mode: "tui", ui: overlay },
    );
    assert.match(
      (overlay.component()?.render(60) ?? []).join("\n"),
      /Ask \(7s\)/,
    );
    overlay.component()?.handleInput("\x1b");
    assert.match(await running, /User declined to answer/);
  });
});

// ---------------------------------------------------------------------------
// Deps helpers (same shape the neighbour tool tests use)
// ---------------------------------------------------------------------------

const HOST: NonNullable<Deps["piSwitchHost"]> = {
  getBaselineTools: () => [],
  setActiveTools: () => {},
  setWidget: () => {},
  newSession: async () => ({ cancelled: false }),
};

/** The tools contributed by a pi-enabled deps set (exactly one). */
function unitTools() {
  const contributions = unit.create(
    makeDeps({ piSwitchHost: HOST }),
    activeSet(),
  );
  assert.equal(contributions.kind, "tool");
  assert.equal(contributions.tools.length, 1);
  return contributions.tools;
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    limits: {
      minWords: 1,
      maxWords: 100,
      maxSectionWords: 50,
      maxPromptWords: 2000,
    },
    contextConfig: undefined,
    agentModes: {},
    agentPermissions: {},
    client: {},
    directory: "/tmp/zoo",
    resolveAgent: () => undefined,
    ...overrides,
  } as unknown as Deps;
}

function activeSet(): ActiveSet {
  return {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(),
    commands: new Set(),
  };
}
