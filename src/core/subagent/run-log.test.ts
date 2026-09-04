/**
 * Tests for the run data stream (`src/core/subagent/run-log.ts`).
 *
 * The stream carries the run's immutable fact record (everything a host
 * driver observes first-hand: a user message arrived, a tool started, a tool
 * finished, an assistant message completed) plus its forming head — the
 * streamed partial of the message being written — over ONE totally-ordered
 * delivery.  This suite locks the storage contract (full untruncated
 * content, append order, the pi-shaped fact envelopes), the event order a
 * consumer sees, mechanical partial retirement, and the fact-only feed
 * that feeds the run-change machinery.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _getBufferForTesting,
  _resetForTesting as _resetLoggerForTesting,
  initLogger,
} from "../../utils/logger.js";
import {
  createRunLog,
  type LogEvent,
  type MessagePart,
  type RunFact,
  RunLog,
  type TextPart,
  type ThinkingPart,
  usageTokens,
} from "./run-log.js";

// Listener isolation reports through the shared logger; keep every test's
// buffer to itself so report-count assertions stay deterministic.
afterEach(() => {
  _resetLoggerForTesting();
});

describe("run-log — append keeps facts verbatim", () => {
  it("stores a full untruncated bash command in the tool-start args", () => {
    const log = createRunLog();
    const command = `echo ${"x".repeat(5000)}`;
    log.appendToolStart("bash", { command }, 10);
    const [fact] = log.facts();
    assert.equal(fact?.type, "tool_start");
    if (fact?.type !== "tool_start") return;
    assert.equal(fact.toolName, "bash");
    assert.equal(fact.args.command, command, "args must not be truncated");
    assert.equal(fact.at, 10);
  });

  it("stores the full untruncated tool result content", () => {
    const log = createRunLog();
    const text = "line\n".repeat(2000);
    log.appendToolEnd("read", [{ type: "text", text }], false, 20, "call-1");
    const fact = log.facts()[0];
    assert.equal(fact?.type, "tool_end");
    if (fact?.type !== "tool_end") return;
    assert.equal(fact.content[0]?.text, text, "result must not be truncated");
    assert.equal(fact.isError, false);
    assert.equal(fact.toolCallId, "call-1");
  });

  it("marks a failed tool end with isError", () => {
    const log = createRunLog();
    log.appendToolEnd("bash", [{ type: "text", text: "boom" }], true, 21);
    const fact = log.facts()[0];
    assert.equal(fact?.type, "tool_end");
    if (fact?.type !== "tool_end") return;
    assert.equal(fact.isError, true);
  });

  it("stores all content parts and the usage of a completed message", () => {
    const log = createRunLog();
    const text = "the whole answer, uncapped ".repeat(100);
    log.appendMessage(
      [
        { type: "thinking", thinking: "reasoning kept verbatim" },
        { type: "text", text },
      ],
      { input: 10, output: 20, totalTokens: 30 },
      30,
    );
    const fact = log.facts()[0];
    assert.equal(fact?.type, "message_end");
    if (fact?.type !== "message_end") return;
    assert.equal(fact.content.length, 2);
    assert.equal(fact.content[1]?.type, "text");
    if (fact.content[1]?.type !== "text") return;
    assert.equal(fact.content[1].text, text, "message text must not be capped");
    assert.deepEqual(fact.usage, { input: 10, output: 20, totalTokens: 30 });
  });

  it("stores the delegation prompt verbatim as a user-message fact", () => {
    // The fact that carries the instruction the run was started with: the
    // transcript overlay is its only display surface, so nothing may shrink
    // or reshape the text at collection time.
    const log = createRunLog();
    const prompt = `SUMMARY: ${"y".repeat(5000)}\n\nACCEPTANCE:\n1. works`;
    log.appendUserMessage(prompt, 5);
    const fact = log.facts()[0];
    assert.equal(fact?.type, "user_message");
    if (fact?.type !== "user_message") return;
    assert.equal(fact.text, prompt, "the instruction must not be truncated");
    assert.equal(fact.at, 5);
    assert.deepEqual(Object.keys(fact).sort(), ["at", "text", "type"]);
  });

  it("defaults a user-message fact's timestamp to the current clock", () => {
    const log = createRunLog();
    const before = Date.now();
    const fact = log.appendUserMessage("do the work");
    assert.ok(fact.at >= before && fact.at <= Date.now());
  });

  it("omits the usage field entirely when the provider reported none", () => {
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "hi" }], undefined, 1);
    const fact = log.facts()[0];
    assert.ok(fact?.type === "message_end");
    assert.equal("usage" in fact, false);
  });
});

describe("run-log — ordering and size", () => {
  it("keeps facts in append order across all four kinds", () => {
    const log = createRunLog();
    log.appendUserMessage("the instruction", 0);
    log.appendToolStart("bash", { command: "a" }, 1);
    log.appendMessage([{ type: "text", text: "think" }], undefined, 2);
    log.appendToolEnd("bash", [], false, 3);
    log.appendToolStart("read", { file_path: "b" }, 4);
    assert.deepEqual(
      log.facts().map((f) => `${f.type}@${f.at}`),
      [
        "user_message@0",
        "tool_start@1",
        "message_end@2",
        "tool_end@3",
        "tool_start@4",
      ],
    );
    assert.equal(log.size, 5);
  });

  it("starts empty", () => {
    const log = createRunLog();
    assert.deepEqual(log.facts(), []);
    assert.equal(log.size, 0);
  });

  it("never drops earlier facts no matter how many are appended", () => {
    const log = createRunLog();
    for (let i = 0; i < 1000; i++) {
      log.appendToolStart("bash", { command: `echo ${i}` }, i);
    }
    assert.equal(log.size, 1000, "the log is unbounded — projections window");
    const first = log.facts()[0];
    assert.ok(first?.type === "tool_start");
    assert.equal(first.args.command, "echo 0");
  });

  it("defaults the timestamp to the current clock when none is given", () => {
    const log = createRunLog();
    const before = Date.now();
    log.appendToolStart("bash", {});
    const fact = log.facts()[0];
    assert.ok(fact !== undefined);
    assert.ok(fact.at >= before && fact.at <= Date.now());
  });
});

describe("run-log — append notification", () => {
  it("notifies each listener once per append with the fact and log", () => {
    const log = new RunLog();
    const seen: RunFact[] = [];
    const alsoSeen: RunFact[] = [];
    const off1 = log.onFact((fact) => seen.push(fact));
    log.onFact((fact, source) => {
      assert.equal(source, log);
      alsoSeen.push(fact);
    });
    const fact = log.appendToolStart("bash", { command: "ls" }, 5);
    assert.deepEqual(seen, [fact]);
    assert.deepEqual(alsoSeen, [fact]);
    off1();
    log.appendMessage([{ type: "text", text: "x" }], undefined, 6);
    assert.equal(seen.length, 1, "unsubscribed listener must go silent");
    assert.equal(alsoSeen.length, 2, "other listeners keep receiving");
  });

  it("the raw append path notifies too", () => {
    const log = createRunLog();
    let count = 0;
    log.onFact(() => {
      count += 1;
    });
    log.append({ type: "tool_start", at: 1, toolName: "bash", args: {} });
    assert.equal(count, 1);
  });

  it("notifies listeners for a user-message append like for any other fact", () => {
    const log = createRunLog();
    const seen: RunFact[] = [];
    log.onFact((fact) => seen.push(fact));
    const fact = log.appendUserMessage("the instruction", 0);
    assert.deepEqual(seen, [fact]);
  });

  it("isolates a throwing listener: the fact stays, the append does not throw", () => {
    // The guarantee the run relies on: a driver appends synchronously from
    // inside the host's event delivery, so no listener may unwind into it.
    const log = createRunLog();
    log.onFact(() => {
      throw new Error("listener boom");
    });
    assert.doesNotThrow(() => log.appendToolStart("bash", {}, 1));
    assert.equal(log.size, 1, "the fact must still be stored");
  });

  it("keeps notifying the other listeners and later appends after a throw", () => {
    const log = createRunLog();
    const seen: string[] = [];
    log.onFact(() => {
      throw new Error("listener boom");
    });
    log.onFact((fact) => seen.push(fact.type));
    log.appendToolStart("bash", {}, 1);
    log.appendMessage([{ type: "text", text: "x" }], undefined, 2);
    // The throwing listener runs first (subscription order) and must not
    // starve the listener behind it on either append.
    assert.deepEqual(seen, ["tool_start", "message_end"]);
  });

  it("reports a throwing listener once instead of on every append", () => {
    initLogger("pi");
    const runLog = createRunLog();
    runLog.onFact(() => {
      throw new Error("listener boom");
    });
    runLog.appendToolStart("bash", {}, 1);
    runLog.appendToolStart("bash", {}, 2);
    runLog.appendToolStart("bash", {}, 3);
    const warns = _getBufferForTesting().filter(
      (entry) => entry.hook === "run-log" && entry.level === "warn",
    );
    assert.equal(warns.length, 1, "one report per log, not one per append");
    assert.equal(warns[0]?.event, "listener_threw");
  });
});

const textPart = (text: string): TextPart => ({ type: "text", text });
const thinkingPart = (thinking: string): ThinkingPart => ({
  type: "thinking",
  thinking,
});

describe("run-log — the forming head (transient partials)", () => {
  /** Subscribe to a log's stream, collecting the deliveries verbatim. */
  const collect = (log: RunLog): LogEvent[] => {
    const events: LogEvent[] = [];
    log.subscribe((event) => events.push(event));
    return events;
  };

  /** The part lists delivered as partial events, in stream order. */
  const partialsOf = (events: readonly LogEvent[]) =>
    events.flatMap((event) => (event.kind === "partial" ? [event.parts] : []));

  it("holds the streamed content outside the fact record", () => {
    // The contract: a partial is projection state, never a fact.  A log that
    // only ever streamed must still read as an empty immutable record.
    const log = createRunLog();
    log.setPartial([textPart("hel")]);
    assert.deepEqual(log.partial(), [textPart("hel")]);
    log.setPartial([textPart("hello")]);
    assert.deepEqual(
      log.partial(),
      [textPart("hello")],
      "last write wins (accumulated parts)",
    );
    assert.deepEqual(log.facts(), []);
    assert.equal(log.size, 0, "a partial must never grow the fact log");
  });

  it("carries thinking parts as content, in stream order", () => {
    // The point of the parts-based contract: a reasoning stream is
    // projection state just like text, so a surface can render thinking live
    // instead of waiting for the message to finalize.
    const log = createRunLog();
    log.setPartial([thinkingPart("Let me think")]);
    assert.deepEqual(log.partial(), [thinkingPart("Let me think")]);
    log.setPartial([thinkingPart("Let me think"), textPart("So")]);
    assert.deepEqual(log.partial(), [
      thinkingPart("Let me think"),
      textPart("So"),
    ]);
    log.setPartial([
      thinkingPart("first"),
      textPart("then text"),
      thinkingPart("then thinking again"),
    ]);
    assert.deepEqual(
      log.partial().map((part) => part.type),
      ["thinking", "text", "thinking"],
      "interleaving order is preserved",
    );
  });

  it("notifies the stream on every change and on the retirement", () => {
    const log = createRunLog();
    const seen: Array<readonly MessagePart[]> = [];
    const off = log.subscribe((event) => {
      assert.equal(event.kind, "partial");
      if (event.kind !== "partial") return;
      seen.push(event.parts);
    });
    log.setPartial([textPart("a")]);
    log.setPartial([textPart("ab")]);
    log.setPartial([]);
    assert.deepEqual(seen, [[textPart("a")], [textPart("ab")], []]);
    off();
    log.setPartial([textPart("c")]);
    assert.equal(seen.length, 3, "an unsubscribed listener goes silent");
  });

  it("stays silent for a repeat of the same partial", () => {
    // pi can emit several update events per visible character; a surface
    // must not re-render for a delta that added nothing.  Comparison is by
    // content — every delta arrives as a freshly built array.
    const log = createRunLog();
    const events = collect(log);
    log.setPartial([textPart("same")]);
    log.setPartial([textPart("same")]);
    assert.equal(partialsOf(events).length, 1);
    // Same parts in a different order is a change (the render would differ).
    log.setPartial([textPart("same"), thinkingPart("same")]);
    log.setPartial([thinkingPart("same"), textPart("same")]);
    assert.equal(
      partialsOf(events).length,
      3,
      "part order is part of the value",
    );
    // Retiring when nothing streams is a no-op too.
    log.setPartial([]);
    log.setPartial([]);
    assert.equal(
      partialsOf(events).length,
      4,
      "only the retirement that removed a partial fires",
    );
  });

  it("treats a partial with nothing streamable as none", () => {
    // Whitespace-only bodies render nothing in pi's own assistant component,
    // so a partial made only of them must not mount a live surface.  A part
    // without a visible body is dropped, the rest survives.
    const log = createRunLog();
    log.setPartial([textPart("   ")]);
    assert.deepEqual(log.partial(), []);
    log.setPartial([textPart("text")]);
    log.setPartial([]);
    assert.deepEqual(log.partial(), [], "an empty list is a cleared partial");
    log.setPartial([textPart("lead"), thinkingPart("  \n ")]);
    assert.deepEqual(
      log.partial(),
      [textPart("lead")],
      "a blank thinking delta does not erase the text beside it",
    );
  });

  it("never delivers a partial to the fact-only listener", () => {
    // The mechanism that keeps fleet-level churn off the streaming path:
    // run-change wiring subscribes with `onFact`, so a token delta can never
    // reach it.
    const log = createRunLog();
    let appends = 0;
    log.onFact(() => {
      appends += 1;
    });
    log.setPartial([thinkingPart("streaming")]);
    log.setPartial([]);
    assert.equal(appends, 0, "partials must not look like appends");
  });

  it("retires the partial BEFORE the fact, in one dispatch", () => {
    // The ordering contract the stream exists to provide: a streaming
    // surface drops on the empty-partial event and projects the
    // finalized message on the fact event that follows it immediately — the
    // consumer never has to know the two came from one append.
    const log = createRunLog();
    const events = collect(log);
    const streamed = [thinkingPart("half a message")];
    log.setPartial(streamed);
    log.appendMessage([thinkingPart("half a message")]);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["partial", "partial", "fact"],
      "the retirement precedes the fact it makes room for",
    );
    assert.deepEqual(
      events.map((event) =>
        event.kind === "partial" ? event.parts.length : event.fact.type,
      ),
      [1, 0, "message_end"],
    );
    assert.deepEqual(log.partial(), []);
    assert.equal(log.size, 1);
  });

  it("emits no partial event for an append with nothing streaming", () => {
    // A tool fact (and every append after a message finalized) must stay a
    // single delivery, so a consumer's batched change never sees a spurious
    // retirement.
    const log = createRunLog();
    const events = collect(log);
    log.appendToolStart("bash", { command: "ls" }, 1);
    log.appendMessage([{ type: "text", text: "x" }], undefined, 2);
    log.appendToolEnd("bash", [], false, 3);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["fact", "fact", "fact"],
    );
  });

  it("keeps the whole stream totally ordered", () => {
    // One interleaved run: the delivery order must equal the order the
    // driver observed, with every retirement sitting between the last delta
    // of its message and the fact that finalizes it.
    const log = createRunLog();
    const events = collect(log);
    log.appendUserMessage("the instruction", 1);
    log.setPartial([textPart("he")]);
    log.setPartial([textPart("hello")]);
    log.appendMessage([{ type: "text", text: "hello" }], undefined, 2);
    log.appendToolStart("bash", {}, 3);
    log.setPartial([thinkingPart("thinking")]);
    log.appendToolEnd("bash", [], true, 4);
    assert.deepEqual(
      events.map((event) =>
        event.kind === "fact"
          ? `fact:${event.fact.type}`
          : `partial:${event.parts.length}`,
      ),
      [
        "fact:user_message",
        "partial:1",
        "partial:1",
        "partial:0",
        "fact:message_end",
        "fact:tool_start",
        "partial:1",
        "partial:0",
        "fact:tool_end",
      ],
    );
    assert.deepEqual(
      log.facts().map((fact) => fact.type),
      ["user_message", "message_end", "tool_start", "tool_end"],
      "facts() stays the persisted record: no partial joins it",
    );
  });

  it("obsoletes the partial for every fact kind, not just messages", () => {
    const log = createRunLog();
    log.setPartial([textPart("streaming into a tool call")]);
    log.appendToolStart("bash", { command: "ls" }, 1);
    assert.deepEqual(log.partial(), []);
  });

  it("isolates a throwing stream listener from the driver", () => {
    // Throw isolation covers the unified dispatch: the same append delivers
    // its retirement and its fact to the healthy listener even though the
    // first subscriber throws on both.
    initLogger("pi");
    const log = createRunLog();
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error("paint boom");
    });
    log.subscribe((event) =>
      seen.push(event.kind === "fact" ? `fact:${event.fact.type}` : "partial"),
    );
    assert.doesNotThrow(() => log.setPartial([textPart("text")]));
    log.setPartial([textPart("more text")]);
    log.appendMessage([{ type: "text", text: "more text" }], undefined, 1);
    assert.deepEqual(
      seen,
      ["partial", "partial", "partial", "fact:message_end"],
      "the next listener still gets every delivery",
    );
    assert.deepEqual(log.partial(), []);
    assert.equal(log.size, 1, "the fact must survive a throwing projection");
    const warns = _getBufferForTesting().filter(
      (entry) => entry.hook === "run-log" && entry.level === "warn",
    );
    assert.equal(warns.length, 1, "one report per log, not one per delta");
    assert.equal(warns[0]?.event, "listener_threw");
  });

  it("keeps facts() pure while a partial streams", () => {
    // A surface may read `facts()` from inside a stream callback: it must see
    // exactly the persisted record, never the forming head.
    const log = createRunLog();
    const shapes: string[] = [];
    log.subscribe((event) => {
      shapes.push(
        `${event.kind}[${log
          .facts()
          .map((fact) => fact.type)
          .join(",")}]`,
      );
    });
    log.setPartial([textPart("streaming")]);
    log.appendToolStart("bash", {}, 1);
    assert.deepEqual(shapes, [
      "partial[]",
      // The retirement is delivered after the fact is stored (that is what
      // makes it safe to read `facts()` from a stream callback), but strictly
      // before the fact event itself.
      "partial[tool_start]",
      "fact[tool_start]",
    ]);
  });
});

describe("run-log — dispatch is never reentrant", () => {
  /** The delivery shape an event projects to (order-comparison helper). */
  const shape = (event: LogEvent): string =>
    event.kind === "fact"
      ? `fact:${event.fact.type}`
      : `partial[${event.parts.length}]`;

  it("delivers a fact appended by a listener after the fact in flight", () => {
    // The order inversion the guard closes: without a queue, the nested
    // append would run its OWN full delivery inside the outer loop, so the
    // listener subscribed after the writer would see the nested fact BEFORE
    // the outer one it is still mid-delivery of.
    const log = createRunLog();
    const writer: string[] = [];
    const later: string[] = [];
    log.onFact((fact) => {
      writer.push(fact.type);
      if (fact.type === "user_message") log.appendToolStart("bash", {}, 2);
    });
    log.onFact((fact) => later.push(fact.type));
    log.appendUserMessage("go", 1);
    assert.deepEqual(writer, ["user_message", "tool_start"]);
    assert.deepEqual(
      later,
      ["user_message", "tool_start"],
      "a later listener must never see a nested event first",
    );
  });

  it("keeps every listener on one total order across nested writes", () => {
    const log = createRunLog();
    const seen: string[][] = [[], [], []];
    log.subscribe((event, source) => {
      seen[0]?.push(shape(event));
      // The middle listener writes twice from one delivery: a partial and a
      // fact, both of which must land behind the event being delivered.
      if (event.kind === "fact" && event.fact.type === "tool_start") {
        source.setPartial([textPart("streaming")]);
        source.appendMessage([{ type: "text", text: "tail" }], undefined, 3);
      }
    });
    log.subscribe((event) => seen[1]?.push(shape(event)));
    log.subscribe((event) => seen[2]?.push(shape(event)));
    log.appendToolStart("bash", {}, 1);
    const expected = [
      "fact:tool_start",
      // Flushed FIFO: the nested partial first (it was raised first), then
      // the nested fact's own retirement, then the fact.
      "partial[1]",
      "partial[0]",
      "fact:message_end",
    ];
    assert.deepEqual(seen[0], expected);
    assert.deepEqual(seen[1], expected);
    assert.deepEqual(seen[2], expected);
    assert.equal(log.size, 2, "the nested writes must both be stored");
    assert.deepEqual(log.partial(), []);
  });

  it("keeps flushing the queue after a listener throws mid-delivery", () => {
    // Throw isolation and the queue share one loop: a nested event raised by
    // a listener that then throws still has to reach the other surfaces.
    const log = createRunLog();
    const seen: string[] = [];
    log.onFact(() => {
      throw new Error("listener boom");
    });
    log.onFact((fact) => {
      seen.push(fact.type);
      if (fact.type === "tool_start") log.appendMessage([], undefined, 2);
    });
    log.onFact((fact) => seen.push(`later:${fact.type}`));
    assert.doesNotThrow(() => log.appendToolStart("bash", {}, 1));
    assert.deepEqual(seen, [
      "tool_start",
      "later:tool_start",
      "message_end",
      "later:message_end",
    ]);
    // The log is idle again: a plain append still delivers.
    assert.doesNotThrow(() => log.appendToolStart("read", {}, 3));
    assert.equal(seen.filter((s) => s === "tool_start").length, 2);
  });

  it("records the store-before-delivery order when a listener reads facts()", () => {
    // A nested append is stored at call time but delivered later: a surface
    // reading `facts()` from a callback sees the full record, so the ordering
    // it derives from the stream must stay a subsequence of the record.
    const log = createRunLog();
    const observed: string[] = [];
    log.onFact((fact, source) => {
      observed.push(
        `${fact.type}|${source
          .facts()
          .map((f) => f.type)
          .join(",")}`,
      );
      if (fact.type === "user_message") source.appendToolStart("bash", {}, 2);
    });
    log.appendUserMessage("go", 1);
    assert.deepEqual(observed, [
      // The first delivery sees only the stored fact; the nested append
      // joins the record after it, and its own delivery sees both.
      "user_message|user_message",
      "tool_start|user_message,tool_start",
    ]);
  });
});

describe("run-log — usageTokens", () => {
  it("prefers totalTokens and falls back to input + output", () => {
    assert.equal(usageTokens({ totalTokens: 100, input: 1, output: 1 }), 100);
    assert.equal(usageTokens({ input: 10, output: 5 }), 15);
  });

  it("returns undefined when the report is absent or not positive", () => {
    assert.equal(usageTokens(undefined), undefined);
    assert.equal(usageTokens({}), undefined);
    assert.equal(usageTokens({ input: 0, output: 0 }), undefined);
    // A non-finite value never reaches the log through the driver's own
    // reader, but the shared helper must not poison a running total.
    assert.equal(usageTokens({ totalTokens: Number.NaN }), undefined);
    assert.equal(usageTokens({ totalTokens: -5 }), undefined);
  });
});
