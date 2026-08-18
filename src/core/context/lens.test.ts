/**
 * Tests for the host-agnostic context lens (`lens.ts`) and its in-memory
 * testkit (`lens-testkit.ts`).
 *
 * Covers: region read/write semantics (set must mutate shared memory),
 * hidden/usage field shapes, ViewItem discriminated-union narrowing, the
 * three testkit constructors' region-kind layouts, the region helper, and
 * the first/last non-hidden user ordinal helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage, ViewItem } from "./lens.js";
import {
  findFirstUserOrdinal,
  findLastUserOrdinal,
  regionsOfKind,
} from "./lens.js";
import { makeAssistantMsg, makeMsg, makeToolMsg } from "./lens-testkit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a message to its observable text surface: per-region
 * `[kind, text]` pairs.  Avoids coupling assertions to testkit internals.
 */
function regionSurface(msg: HostMessage): Array<[string, string]> {
  return msg.regions.map((r) => [r.kind, r.get()]);
}

/** Narrow a ViewItem to a short description, exercising union narrowing. */
function describeViewItem(item: ViewItem): string {
  if (item.type === "original") {
    return `original:${item.ordinal}`;
  }
  return `summary:${item.block.start}-${item.block.end}:${item.block.summary}`;
}

// ---------------------------------------------------------------------------
// makeMsg
// ---------------------------------------------------------------------------

describe("makeMsg", () => {
  it("builds content regions from the given texts, in order", () => {
    const msg = makeMsg("user", ["hello", "world"]);
    assert.equal(msg.role, "user");
    assert.equal(msg.hidden, false);
    assert.deepEqual(regionSurface(msg), [
      ["content", "hello"],
      ["content", "world"],
    ]);
  });

  it("defaults hidden to false and honors the hidden option", () => {
    assert.equal(makeMsg("user", ["a"]).hidden, false);
    assert.equal(makeMsg("user", ["a"], { hidden: true }).hidden, true);
  });

  it("carries the usage option through verbatim", () => {
    const usage = {
      input: 100,
      output: 50,
      reasoning: 10,
      cacheRead: 200,
      cacheWrite: 30,
    };
    const msg = makeMsg("assistant", ["a"], { usage });
    assert.deepEqual(msg.usage, usage);
  });

  it("leaves usage undefined when the option is omitted", () => {
    assert.equal(makeMsg("user", ["a"]).usage, undefined);
  });
});

// ---------------------------------------------------------------------------
// Region set semantics
// ---------------------------------------------------------------------------

describe("region set", () => {
  it("mutates shared memory so a later get reads back the new text", () => {
    const msg = makeMsg("user", ["before"]);
    msg.regions[0].set("after");
    assert.equal(msg.regions[0].get(), "after");
  });

  it("keeps sibling regions independent", () => {
    const msg = makeMsg("user", ["a", "b"]);
    msg.regions[0].set("a2");
    assert.equal(msg.regions[0].get(), "a2");
    assert.equal(msg.regions[1].get(), "b");
  });
});

// ---------------------------------------------------------------------------
// makeToolMsg
// ---------------------------------------------------------------------------

describe("makeToolMsg", () => {
  it("produces tool-input then tool-output regions with the given texts", () => {
    const msg = makeToolMsg("bash", "ls -la", "file output");
    assert.equal(msg.role, "assistant");
    assert.deepEqual(regionSurface(msg), [
      ["tool-input", "ls -la"],
      ["tool-output", "file output"],
    ]);
  });

  it("carries the tool name and status on both tool regions", () => {
    const msg = makeToolMsg("bash", "in", "out", { status: "error" });
    assert.deepEqual(msg.regions[0].tool, { name: "bash", status: "error" });
    assert.deepEqual(msg.regions[1].tool, { name: "bash", status: "error" });
  });

  it("defaults tool status to completed", () => {
    const msg = makeToolMsg("bash", "in", "out");
    assert.deepEqual(msg.regions[0].tool, {
      name: "bash",
      status: "completed",
    });
  });

  it("honors hidden and usage options", () => {
    const usage = { input: 5, output: 7 };
    const msg = makeToolMsg("bash", "in", "out", { hidden: true, usage });
    assert.equal(msg.hidden, true);
    assert.deepEqual(msg.usage, usage);
  });

  it("leaves tool undefined on non tool regions", () => {
    assert.equal(makeMsg("user", ["x"]).regions[0].tool, undefined);
    const assistant = makeAssistantMsg({ text: "t", thinking: "th" });
    assert.equal(assistant.regions[0].tool, undefined);
    assert.equal(assistant.regions[1].tool, undefined);
  });
});

// ---------------------------------------------------------------------------
// makeAssistantMsg
// ---------------------------------------------------------------------------

describe("makeAssistantMsg", () => {
  it("lays out content, thinking, then tool call pairs in order", () => {
    const msg = makeAssistantMsg({
      text: "let me check",
      thinking: "reasoning trace",
      toolCalls: [
        { name: "bash", input: "ls", output: "files" },
        { name: "read", input: "a.ts", output: "source", status: "error" },
      ],
    });
    assert.equal(msg.role, "assistant");
    assert.deepEqual(regionSurface(msg), [
      ["content", "let me check"],
      ["thinking", "reasoning trace"],
      ["tool-input", "ls"],
      ["tool-output", "files"],
      ["tool-input", "a.ts"],
      ["tool-output", "source"],
    ]);
    assert.deepEqual(msg.regions[2].tool, {
      name: "bash",
      status: "completed",
    });
    assert.deepEqual(msg.regions[3].tool, {
      name: "bash",
      status: "completed",
    });
    assert.deepEqual(msg.regions[4].tool, { name: "read", status: "error" });
    assert.deepEqual(msg.regions[5].tool, { name: "read", status: "error" });
  });

  it("omits absent parts of the shape", () => {
    assert.deepEqual(regionSurface(makeAssistantMsg({ text: "t" })), [
      ["content", "t"],
    ]);
    assert.deepEqual(regionSurface(makeAssistantMsg({ thinking: "th" })), [
      ["thinking", "th"],
    ]);
    assert.deepEqual(
      regionSurface(
        makeAssistantMsg({
          toolCalls: [{ name: "bash", input: "i", output: "o" }],
        }),
      ),
      [
        ["tool-input", "i"],
        ["tool-output", "o"],
      ],
    );
    assert.deepEqual(regionSurface(makeAssistantMsg()), []);
  });

  it("writes through to tool regions via set", () => {
    const msg = makeAssistantMsg({
      text: "t",
      toolCalls: [{ name: "bash", input: "i", output: "o" }],
    });
    msg.regions[1].set("i2");
    msg.regions[2].set("o2");
    assert.equal(msg.regions[1].get(), "i2");
    assert.equal(msg.regions[2].get(), "o2");
    assert.equal(msg.regions[0].get(), "t");
  });

  it("honors hidden and usage options", () => {
    const usage = { output: 9 };
    const msg = makeAssistantMsg({ text: "t", hidden: true, usage });
    assert.equal(msg.hidden, true);
    assert.deepEqual(msg.usage, usage);
  });
});

// ---------------------------------------------------------------------------
// ViewItem
// ---------------------------------------------------------------------------

describe("ViewItem", () => {
  it("narrows the discriminated union on the type field", () => {
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      {
        type: "summary",
        block: { start: 1, end: 4, title: "history", summary: "compressed" },
      },
      { type: "original", ordinal: 4 },
    ];
    assert.deepEqual(items.map(describeViewItem), [
      "original:0",
      "summary:1-4:compressed",
      "original:4",
    ]);
  });

  it("allows a summary block without a title", () => {
    const item: ViewItem = {
      type: "summary",
      block: { start: 2, end: 5, summary: "s" },
    };
    assert.equal(describeViewItem(item), "summary:2-5:s");
  });
});

// ---------------------------------------------------------------------------
// regionsOfKind
// ---------------------------------------------------------------------------

describe("regionsOfKind", () => {
  it("filters regions by kind, preserving order", () => {
    const msg = makeAssistantMsg({
      text: "t",
      thinking: "th",
      toolCalls: [{ name: "bash", input: "i", output: "o" }],
    });
    assert.deepEqual(
      regionsOfKind(msg, "content").map((r) => r.get()),
      ["t"],
    );
    assert.deepEqual(
      regionsOfKind(msg, "tool-output").map((r) => r.get()),
      ["o"],
    );
    assert.deepEqual(regionsOfKind(msg, "tool-input").length, 1);
    assert.deepEqual(regionsOfKind(makeMsg("user", ["a"]), "thinking"), []);
  });
});

// ---------------------------------------------------------------------------
// first / last user ordinal
// ---------------------------------------------------------------------------

describe("user ordinal helpers", () => {
  it("finds the first non-hidden user message", () => {
    const messages = [
      makeMsg("system", ["sys"]),
      makeMsg("user", ["hidden"], { hidden: true }),
      makeMsg("assistant", ["a"]),
      makeMsg("user", ["visible"]),
    ];
    assert.equal(findFirstUserOrdinal(messages), 3);
  });

  it("finds the last non-hidden user message, skipping hidden ones", () => {
    const messages = [
      makeMsg("user", ["first"]),
      makeMsg("assistant", ["a"]),
      makeMsg("user", ["hidden"], { hidden: true }),
      makeMsg("user", ["last"]),
    ];
    assert.equal(findLastUserOrdinal(messages), 3);
  });

  it("returns -1 when no non-hidden user message exists", () => {
    const messages = [
      makeMsg("assistant", ["a"]),
      makeMsg("user", ["hidden"], { hidden: true }),
    ];
    assert.equal(findFirstUserOrdinal(messages), -1);
    assert.equal(findLastUserOrdinal(messages), -1);
    assert.equal(findFirstUserOrdinal([]), -1);
    assert.equal(findLastUserOrdinal([]), -1);
  });
});
