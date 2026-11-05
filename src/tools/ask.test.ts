/**
 * Tests for the ask tool adapter (`ask.ts`).
 *
 * Covers the adapter's three jobs:
 *  - argument parsing (core defaults applied through `normalizeQuestion`,
 *    lenient `recommended` handling, terminal control sequences stripped from
 *    the model's texts, loud errors for malformed input);
 *  - result assembly (one `Q<n>: <question> => <core rendering>` line per
 *    question, and the structured `data` carried in the tool result);
 *  - the contribution's own paths, driven through a fake `ui.custom` that
 *    mounts the REAL dialog headless behind the pi question channel: the
 *    defence path taken by a call without a channel (`no-ui`), a real
 *    answer run, a `ui.custom` that rejects, and the `guardAnswers`
 *    replacement of a structurally illegal `answered` slot.
 *
 * Also the unit descriptor's pi-only fail-closed behaviour (no
 * `askQuestionChannel` → zero tools) and the internal gate that keeps two
 * forms from mounting on top of each other.  The presentation contract
 * itself (`presentAskForm`) is covered in `src/adapters/pi/ask-form.test.ts`.
 *
 * @module
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AskDialogComponent,
  type AskDialogOutcome,
  createPiQuestionChannel,
} from "../adapters/pi/ask-form.js";
import type { AskResult, NormalizedQuestion } from "../core/ask.js";
import type { ModeProfile } from "../core/config-types.js";
import type { Capabilities } from "../core/ports/index.js";
import { formHarness } from "../testkits/ask-form.js";
import { composeForTest, facts } from "../testkits/compose.js";
import { assembleAskResults, guardAnswers, parseAskArgs, unit } from "./ask.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Let the queued tool bodies run (microtask-safe, no timers involved). */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/** Send one raw key to a mounted dialog. */
function key(component: AskDialogComponent, data: string): void {
  component.handleInput(data);
}

/**
 * Build the call context an ask call receives on pi.
 *
 * The question channel is the one the pi adapter builds from its own
 * execution context, so a pi context without an interactive surface gets
 * no channel and the tool reports the system-side slot.
 */
function askCall(piCtx: unknown, overrides: { signal?: AbortSignal } = {}) {
  const questionChannel = createPiQuestionChannel(piCtx);
  return {
    sessionID: "sess-ask",
    signal: overrides.signal ?? new AbortController().signal,
    ...(questionChannel !== undefined ? { questionChannel } : {}),
  };
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

  it("writes one line per question and the structured data", () => {
    const results: AskResult[] = [
      { status: "answered", answer: ["Yes"], wasCustom: false },
      { status: "unavailable", reason: "timeout" },
    ];
    const { text, data } = assembleAskResults(questions, results);
    assert.equal(
      text,
      "Q1: Ship it? => User answered: Yes\nQ2: Which files? => User unavailable (timeout)",
    );
    assert.deepEqual(data.questions[0], {
      question: "Ship it?",
      result: results[0],
    });
    assert.deepEqual(data.questions[1], {
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
    const { text, data } = assembleAskResults(questions, [
      { status: "declined" },
    ]);
    assert.equal(text.split("\n").length, 2);
    assert.deepEqual(data.questions[1].result, {
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
// The tool contribution
// ---------------------------------------------------------------------------

describe("ask tool — contribution", () => {
  const args = {
    questions: [
      { question: "One?", options: [{ label: "A1" }] },
      { question: "Two?", options: [{ label: "A2" }], multiple: true },
    ],
  };

  it("asks through the call's question channel and returns text plus data", async () => {
    const tool = unitTools()[0];
    const asked: number[] = [];
    const result = await tool.execute(args, {
      sessionID: "sess-ask",
      signal: new AbortController().signal,
      questionChannel: {
        async ask(request) {
          asked.push(request.questions.length);
          return [
            { status: "answered", answer: ["A1"], wasCustom: false },
            { status: "declined" },
          ];
        },
      },
    });
    assert.deepEqual(asked, [2], "the channel receives both questions");
    assert.deepEqual(result, {
      text: "Q1: One? => User answered: A1\nQ2: Two? => User declined to answer",
      data: {
        questions: [
          {
            question: "One?",
            result: { status: "answered", answer: ["A1"], wasCustom: false },
          },
          { question: "Two?", result: { status: "declined" } },
        ],
      },
    });
  });

  it("reports no-ui when the call arrives without a channel", async () => {
    const tool = unitTools()[0];
    const result = await tool.execute(args, askCall({ mode: "print" }));
    assert.equal(
      result.text,
      "Q1: One? => User unavailable (no-ui)\nQ2: Two? => User unavailable (no-ui)",
    );
    assert.deepEqual(
      (result.data as { questions: { question: string }[] }).questions.map(
        (entry) => entry.question,
      ),
      ["One?", "Two?"],
    );
  });

  it("reports no-ui when the host has no custom-component surface", async () => {
    const tool = unitTools()[0];
    const result = await tool.execute(args, askCall({ mode: "tui", ui: {} }));
    assert.match(result.text, /User unavailable \(no-ui\)/);
  });

  it("assembles a real dialog run into text + data", async () => {
    const tool = unitTools()[0];
    const form = formHarness();
    const running = tool.execute(args, askCall({ mode: "tui", ui: form }));
    const component = form.component();
    assert.ok(component);
    key(component, "\r"); // Q1 = A1 -> Q2
    key(component, "\x1b"); // decline Q2
    const result = await running;
    assert.equal(
      result.text,
      "Q1: One? => User answered: A1\nQ2: Two? => User declined to answer",
    );
    const data = result.data as {
      questions: { question: string; result: AskResult }[];
    };
    assert.deepEqual(data.questions, [
      {
        question: "One?",
        result: { status: "answered", answer: ["A1"], wasCustom: false },
      },
      { question: "Two?", result: { status: "declined" } },
    ]);
  });

  it("drops a forged answered slot reported by the dialog", async () => {
    const tool = unitTools()[0];
    const form = {
      custom: (_factory: unknown, _options: unknown) =>
        Promise.resolve({
          results: [
            { status: "answered", answer: ["never-offered"], wasCustom: false },
            { status: "declined" },
          ] as AskResult[],
          closure: "submit" as const,
        }),
    };
    const result = await tool.execute(args, askCall({ mode: "tui", ui: form }));
    assert.match(result.text, /Q1: One\? => User unavailable \(aborted\)/);
    assert.match(result.text, /Q2: Two\? => User declined to answer/);
  });

  it("hands the dialog the sanitized question and labels", async () => {
    const tool = unitTools()[0];
    const form = formHarness();
    const running = tool.execute(
      {
        questions: [
          {
            question: "\x1b[1mOne?\x1b[0m",
            options: [{ label: "\x1b[31mA1\x1b[0m" }],
          },
        ],
      },
      askCall({ mode: "tui", ui: form }),
    );
    const component = form.component();
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
    assert.equal((await running).text, "Q1: One? => User answered: A1");
  });

  it("reports aborted slots when the host's ui.custom rejects", async () => {
    const tool = unitTools()[0];
    const result = await tool.execute(
      args,
      askCall({
        mode: "tui",
        ui: { custom: () => Promise.reject(new Error("boom")) },
      }),
    );
    assert.equal(
      result.text,
      "Q1: One? => User unavailable (aborted)\nQ2: Two? => User unavailable (aborted)",
    );
    assert.deepEqual(
      (result.data as { questions: { result: AskResult }[] }).questions.map(
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
      () => tool.execute({ questions: [] }, askCall({ mode: "print" })),
      /ask \u5de5\u5177\u53c2\u6570\u9519\u8bef/,
    );
  });

  it("never mounts two dialogs at once — the queue is inside the tool", async () => {
    const tool = unitTools()[0];
    let onScreen = 0;
    let maxOnScreen = 0;
    const dismiss: Array<(outcome: AskDialogOutcome) => void> = [];
    const form = {
      custom: (_factory: unknown, _options: unknown) => {
        onScreen += 1;
        maxOnScreen = Math.max(maxOnScreen, onScreen);
        return new Promise<AskDialogOutcome>((resolve) => {
          dismiss.push((outcome) => {
            onScreen -= 1;
            resolve(outcome);
          });
        });
      },
    };
    const answered = (label: string): AskDialogOutcome => ({
      results: [
        { status: "answered", answer: [label], wasCustom: false },
        { status: "declined" },
      ] as AskResult[],
      closure: "submit" as const,
    });

    const first = tool.execute(args, askCall({ mode: "tui", ui: form }));
    await settle();
    assert.equal(dismiss.length, 1, "the first call draws the form");

    // Dispatched while the first form is still on screen: it must wait.
    const second = tool.execute(args, askCall({ mode: "tui", ui: form }));
    await settle();
    assert.equal(onScreen, 1, "the second call never stacks a form");

    dismiss[0](answered("A1"));
    assert.match((await first).text, /Q1: One\? => User answered: A1/);
    await settle();
    assert.equal(dismiss.length, 2, "the queued call gets its turn");

    dismiss[1](answered("A1"));
    assert.match((await second).text, /Q1: One\? => User answered: A1/);
    assert.equal(maxOnScreen, 1, "no two forms ever shared the terminal");
  });

  it("rejects a malformed call immediately even while the gate is busy", async () => {
    // Argument parsing runs ahead of the serialising gate, so a bad call is
    // corrected at once instead of queueing behind the open dialog.
    const tool = unitTools()[0];
    const dismiss: Array<(outcome: AskDialogOutcome) => void> = [];
    const form = {
      custom: (_factory: unknown, _options: unknown) =>
        new Promise<AskDialogOutcome>((resolve) => {
          dismiss.push((outcome) => resolve(outcome));
        }),
    };
    const first = tool.execute(args, askCall({ mode: "tui", ui: form }));
    await settle();
    assert.equal(dismiss.length, 1, "the first call draws the form");

    await assert.rejects(
      () => tool.execute({ questions: [] }, askCall({ mode: "tui", ui: form })),
      /ask \u5de5\u5177\u53c2\u6570\u9519\u8bef/,
    );
    assert.equal(
      dismiss.length,
      1,
      "the refused call never took a turn in the queue",
    );

    dismiss[0]({
      results: [{ status: "declined" }, { status: "declined" }] as AskResult[],
      closure: "submit" as const,
    });
    await first;
  });

  it("lets a queued call see an abort that landed while it waited", async () => {
    // Interrupt handling stays the dialog's own already-aborted-signal
    // check, which runs at the call's turn rather than at submission time.
    const tool = unitTools()[0];
    let customCalls = 0;
    const dismiss: Array<(outcome: AskDialogOutcome) => void> = [];
    const form = {
      custom: (_factory: unknown, _options: unknown) => {
        customCalls += 1;
        return new Promise<AskDialogOutcome>((resolve) => {
          dismiss.push((outcome) => resolve(outcome));
        });
      },
    };
    const controller = new AbortController();
    const first = tool.execute(args, askCall({ mode: "tui", ui: form }));
    const second = tool.execute(
      args,
      askCall({ mode: "tui", ui: form }, { signal: controller.signal }),
    );
    controller.abort();

    // The queued call only reaches its turn after the open form is
    // dismissed — and by then its own signal is already aborted.
    dismiss[0]({
      results: [{ status: "declined" }, { status: "declined" }] as AskResult[],
      closure: "submit" as const,
    });
    await first;

    const text = (await second).text;
    assert.match(text, /Q1: One\? => User unavailable \(aborted\)/);
    assert.match(text, /Q2: Two\? => User unavailable \(aborted\)/);
    assert.equal(
      customCalls,
      1,
      "the cancelled call never reached the terminal",
    );
  });

  it("keeps no-ui calls out of the way of the gate", async () => {
    // The channel-less path returns without touching the terminal, so it
    // still flows through the same queue and stays a normal result.
    const tool = unitTools()[0];
    const [a, b] = await Promise.all([
      tool.execute(args, askCall({ mode: "print" })),
      tool.execute(args, askCall({ mode: "print" })),
    ]);
    assert.match(a.text, /no-ui/);
    assert.match(b.text, /no-ui/);
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
  it("skips the unit and reports askQuestionChannel without the provider (OpenCode)", () => {
    const result = composeForTest(ASK_TOOL_PROFILE, [unit], makeDeps({}));
    assert.deepEqual(result.tools, {});
    assert.deepEqual(result.report.skipped, [
      { name: "ask", missing: ["askQuestionChannel"] },
    ]);
  });

  it("contributes the ask tool when the provider is present", () => {
    const contributions = unit.create(
      makeDeps({ askQuestionChannel: FORM_HOST }),
      activeSet(),
    );
    assert.equal(contributions.kind, "tool");
    assert.equal(contributions.tools.length, 1);
    assert.equal(contributions.tools[0].name, "ask");
  });

  it("passes the configured timeout through to the dialog", async () => {
    const contributions = unit.create(
      makeDeps({ askQuestionChannel: FORM_HOST, askTimeoutSeconds: 7 }),
      activeSet(),
    );
    assert.equal(contributions.kind, "tool");
    const tool = contributions.tools[0];
    const form = formHarness();
    const running = tool.execute(
      { questions: [{ question: "One?", options: [{ label: "A" }] }] },
      askCall({ mode: "tui", ui: form }),
    );
    assert.match((form.component()?.render(60) ?? []).join("\n"), /Ask \(7s\)/);
    form.component()?.handleInput("\x1b");
    assert.match((await running).text, /User declined to answer/);
  });
});

// ---------------------------------------------------------------------------
// Capabilities helpers (same shape the neighbour tool tests use)
// ---------------------------------------------------------------------------

const FORM_HOST: NonNullable<Partial<Capabilities>["askQuestionChannel"]> =
  createPiQuestionChannel;

/** The tools contributed by a pi-enabled deps set (exactly one). */
function unitTools() {
  const contributions = unit.create(
    makeDeps({ askQuestionChannel: FORM_HOST }),
    activeSet(),
  );
  assert.equal(contributions.kind, "tool");
  assert.equal(contributions.tools.length, 1);
  return contributions.tools;
}

function makeDeps(
  overrides: Partial<Partial<Capabilities>> = {},
): Partial<Capabilities> {
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
  } as unknown as Partial<Capabilities>;
}

function activeSet() {
  return facts();
}

/** A minimal mode profile enabling exactly the ask tool unit. */
const ASK_TOOL_PROFILE: ModeProfile = {
  name: "test",
  agents: [],
  skills: [],
  hooks: [],
  tools: ["ask"],
  commands: [],
};
