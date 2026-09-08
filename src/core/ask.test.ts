/**
 * Direct unit tests for core/ask.ts.
 *
 * Covers the three pure functions of the ask protocol: `normalizeQuestion`
 * (defaults + enforcement rules), `validateAnswer` (answered-slot legality),
 * and `formatResultForModel` (model-facing single-line text).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AskQuestion,
  type AskResult,
  formatResultForModel,
  normalizeQuestion,
  validateAnswer,
} from "./ask.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two-option question, fully normalized. */
function normalizedTwoOption(
  overrides?: Partial<ReturnType<typeof normalizeQuestion>>,
) {
  return {
    question: "Pick one",
    options: [{ label: "yes" }, { label: "no" }],
    multiple: false,
    allowFreeform: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeQuestion — defaults
// ---------------------------------------------------------------------------

describe("normalizeQuestion defaults", () => {
  it("fills in multiple=false and allowFreeform=true for a bare question", () => {
    const q: AskQuestion = { question: "How?" };
    const n = normalizeQuestion(q);
    assert.deepEqual(n.options, []);
    assert.equal(n.multiple, false);
    assert.equal(n.allowFreeform, true);
  });

  it("preserves explicit multiple and allowFreeform when options exist", () => {
    const n = normalizeQuestion({
      question: "How?",
      options: [{ label: "a" }],
      multiple: true,
      allowFreeform: false,
    });
    assert.equal(n.multiple, true);
    assert.equal(n.allowFreeform, false);
  });

  it("carries option descriptions through untouched", () => {
    const n = normalizeQuestion({
      question: "How?",
      options: [{ label: "a", description: "first" }],
    });
    assert.deepEqual(n.options, [{ label: "a", description: "first" }]);
  });
});

// ---------------------------------------------------------------------------
// normalizeQuestion — enforcement rules
// ---------------------------------------------------------------------------

describe("normalizeQuestion enforcement", () => {
  it("forces allowFreeform=true when options are missing", () => {
    const n = normalizeQuestion({ question: "How?", allowFreeform: false });
    assert.equal(n.allowFreeform, true);
  });

  it("forces allowFreeform=true when options is an empty array", () => {
    const n = normalizeQuestion({
      question: "How?",
      options: [],
      allowFreeform: false,
    });
    assert.equal(n.allowFreeform, true);
  });

  it("leaves allowFreeform=false intact when options are present", () => {
    const n = normalizeQuestion({
      question: "How?",
      options: [{ label: "a" }],
      allowFreeform: false,
    });
    assert.equal(n.allowFreeform, false);
  });
});

// ---------------------------------------------------------------------------
// validateAnswer — answered slot, single-select
// ---------------------------------------------------------------------------

describe("validateAnswer single-select", () => {
  it("accepts exactly one picked label", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["yes"],
      wasCustom: false,
    };
    assert.equal(validateAnswer(normalizedTwoOption(), r).valid, true);
  });

  it("rejects two answers on a single-select question", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["yes", "no"],
      wasCustom: false,
    };
    const v = validateAnswer(normalizedTwoOption(), r);
    assert.equal(v.valid, false);
    assert.match(v.errors.join("\n"), /single-select/);
  });

  it("rejects an empty answer list", () => {
    const r: AskResult = { status: "answered", answer: [], wasCustom: false };
    const v = validateAnswer(normalizedTwoOption(), r);
    assert.equal(v.valid, false);
    assert.match(v.errors.join("\n"), /empty/i);
  });

  it("rejects an answer with a blank entry", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["  "],
      wasCustom: true,
    };
    const v = validateAnswer(normalizedTwoOption(), r);
    assert.equal(v.valid, false);
    assert.match(v.errors.join("\n"), /blank/);
  });

  it("accepts multiple answers on a multi-select question", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["yes", "no"],
      wasCustom: false,
    };
    assert.equal(
      validateAnswer(normalizedTwoOption({ multiple: true }), r).valid,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// validateAnswer — option membership
// ---------------------------------------------------------------------------

describe("validateAnswer option membership", () => {
  it("rejects a non-custom answer not among the option labels", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["maybe"],
      wasCustom: false,
    };
    const v = validateAnswer(normalizedTwoOption(), r);
    assert.equal(v.valid, false);
    assert.match(v.errors.join("\n"), /not one of the provided options/);
  });

  it("reports every offending entry in a multi-select answer", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["x", "yes", "y"],
      wasCustom: false,
    };
    const v = validateAnswer(normalizedTwoOption({ multiple: true }), r);
    assert.equal(v.valid, false);
    assert.equal(v.errors.length, 2);
  });

  it("matches labels exactly, not by description or substring", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["ye"],
      wasCustom: false,
    };
    assert.equal(validateAnswer(normalizedTwoOption(), r).valid, false);
  });
});

// ---------------------------------------------------------------------------
// validateAnswer — custom answers
// ---------------------------------------------------------------------------

describe("validateAnswer custom answers", () => {
  it("accepts a custom answer when allowFreeform is true", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["something else entirely"],
      wasCustom: true,
    };
    assert.equal(validateAnswer(normalizedTwoOption(), r).valid, true);
  });

  it("rejects a custom answer when allowFreeform is false", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["typed anyway"],
      wasCustom: true,
    };
    const v = validateAnswer(normalizedTwoOption({ allowFreeform: false }), r);
    assert.equal(v.valid, false);
    assert.match(v.errors.join("\n"), /[Cc]ustom answer is not allowed/);
  });
});

// ---------------------------------------------------------------------------
// validateAnswer — non-answered slots
// ---------------------------------------------------------------------------

describe("validateAnswer non-answered slots", () => {
  it("treats declined as valid", () => {
    assert.equal(
      validateAnswer(normalizedTwoOption(), { status: "declined" }).valid,
      true,
    );
  });

  it("treats unavailable as valid", () => {
    const r: AskResult = { status: "unavailable", reason: "timeout" };
    assert.equal(validateAnswer(normalizedTwoOption(), r).valid, true);
  });
});

// ---------------------------------------------------------------------------
// formatResultForModel
// ---------------------------------------------------------------------------

describe("formatResultForModel", () => {
  const q = normalizedTwoOption();

  it("formats a picked single answer on one line", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["yes"],
      wasCustom: false,
    };
    assert.equal(formatResultForModel(q, r), "User answered: yes");
  });

  it("joins multi-select picks with commas", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["yes", "no"],
      wasCustom: false,
    };
    assert.equal(formatResultForModel(q, r), "User answered: yes, no");
  });

  it("uses the 'User wrote: ' prefix for custom answers", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["redo it"],
      wasCustom: true,
    };
    assert.equal(formatResultForModel(q, r), "User wrote: redo it");
  });

  it("formats declined", () => {
    assert.equal(
      formatResultForModel(q, { status: "declined" }),
      "User declined to answer",
    );
  });

  it("formats unavailable (timeout)", () => {
    assert.equal(
      formatResultForModel(q, { status: "unavailable", reason: "timeout" }),
      "User unavailable (timeout)",
    );
  });

  it("formats unavailable (aborted)", () => {
    assert.equal(
      formatResultForModel(q, { status: "unavailable", reason: "aborted" }),
      "User unavailable (aborted)",
    );
  });

  it("formats unavailable (no-ui)", () => {
    assert.equal(
      formatResultForModel(q, { status: "unavailable", reason: "no-ui" }),
      "User unavailable (no-ui)",
    );
  });

  it("never emits a newline", () => {
    const r: AskResult = {
      status: "answered",
      answer: ["multi\nline\nanswer"],
      wasCustom: true,
    };
    // Freeform text is passed through verbatim; hosts must sanitize input.
    assert.match(formatResultForModel(q, r), /^User wrote: /);
  });
});
