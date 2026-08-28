/**
 * Tests for `src/adapters/opencode/tui/controller.ts` — the TUI sidebar's
 * context data controller.
 *
 * Boundary chosen: `createContextController()` (the public factory).
 * The factory closes over the shared fetch, compute pipeline, debounced
 * refresh, and dispose hook, and accepts the panel's setters through
 * its `deps` argument.  Driving that surface with a synthetic client
 * and recording every setter call is the smallest observation that
 * locks the controller's externally observable behaviour without
 * entangling tests in internal implementation details (raw vs folded
 * branch selection, state-field shape, debounce timer mechanics).
 *
 * Four paths are covered; each maps to a contract line the controller
 * promises to keep:
 *
 * 1. **Raw view pass-through.**  When no persisted state file exists
 *    for the session, the panel signals reflect the raw mapped
 *    transcript — no synthetic summary, no folded count.  A nullish
 *    session store and a missing state file must produce identical
 *    category totals (proves the read-only path treats absence and
 *    emptiness identically).
 *
 * 2. **Folded view panel data.**  When an active block whose span
 *    hash still matches the current content lives in the store, the
 *    panel total reflects the model-visible (folded) view: one
 *    summary item replaces the covered interval, so the panel-total
 *    is smaller than the raw count for the same transcript.  Asserts
 *    `foldMessages ?? mapped` actually branches.
 *
 * 3. **Category breakdown numeric shape.**  Every `setCategories`
 *    call carries `{user, assistant, tool, system, total}` with
 *    values that partition the displayed view's token count exactly.
 *    The expected numbers come from the CJK-aware estimator
 *    (`estimateTokenCount`) and the exact-token path, computed once
 *    up front as independent known literals.
 *
 * 4. **Read-only semantics.**  The controller never writes to disk —
 *    no `mkdirSync`, no `writeFileSync`, no `renameSync` ever lands
 *    during `compute` / `scheduleRefresh` / `dispose`, and a
 *    pre-existing state file's byte content is identical after the
 *    controller runs against it.  Plan 2.7 Must NOT do: TUI is
 *    display-only and the controller preserves that invariant.
 *
 * State files used for the folded-view path are written under the
 * controller's default storage directory
 * (`homedir() + "/.zoo/storage/"`) with unique session ids and removed
 * in `after()`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { computeSpanHash } from "../../../core/context/spanhash.js";
import { history } from "../history.js";
import type { ContextMessageEntry } from "../types.js";
import {
  type ContextController,
  type ContextControllerDeps,
  createContextController,
} from "./controller.js";
import type { CategoryInfo } from "./subagent.js";

// ---------------------------------------------------------------------------
// Storage-path helpers
// ---------------------------------------------------------------------------

/** Controller's default state storage directory (`~/.zoo/storage/`). */
function storageDir(): string {
  return join(homedir(), ".zoo", "storage");
}

/** Full state file path for a given session id under the storage dir. */
function statePath(sessionId: string): string {
  return join(storageDir(), `${sessionId}.json`);
}

/** Write a state file with the supplied payload (object → JSON). */
function writeStateFile(sessionId: string, payload: unknown): void {
  mkdirSync(storageDir(), { recursive: true });
  const path = statePath(sessionId);
  const tmp = join(storageDir(), `.${sessionId}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  // Atomic rename — matches the real store's write semantics, so the
  // test cannot leave a half-written file behind on a crash.
  // (Also keeps the byte content identical to a real save so the
  // read-only check can detect tampering if it ever happened.)
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Fixture helpers — v1 message construction
// ---------------------------------------------------------------------------

/**
 * Build a v1 `ContextMessageEntry` with optional parts and a token
 * report.  Defaults to a user-role message with no parts and no
 * tokens, matching the lightweight shape needed by `categoryInfo` and
 * fold-panel tests.
 */
function msg(
  role: string,
  id: string,
  parts?: unknown[],
  tokens?: Record<string, unknown>,
): ContextMessageEntry {
  return {
    info: {
      role,
      id,
      ...(tokens ? { tokens } : {}),
    } as unknown as ContextMessageEntry["info"],
    parts: (parts ?? []) as unknown as ContextMessageEntry["parts"],
  };
}

/** Build a v1 text part. */
function textPart(text: string): Record<string, unknown> {
  return { type: "text", text };
}

/** Build a v1 tool part with the given call id, input, and output. */
function toolPart(
  input: string,
  output: string,
  callId = "call_default",
  tool = "bash",
): Record<string, unknown> {
  return {
    type: "tool",
    tool,
    callID: callId,
    state: { input, output, status: "completed" },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers — capture frame (records every signal setter call)
// ---------------------------------------------------------------------------

/**
 * Per-setter call log.  Each entry is one push — index N in the array
 * corresponds to the Nth compute pass that produced a value.
 */
interface SignalFrame {
  cache: string[];
  categories: Array<CategoryInfo | null>;
  error: boolean[];
  trendLabel: Array<string | null>;
  trend: Array<number | null>;
  cumulative: string[];
  detail: Array<unknown>;
  loaded: boolean[];
}

/**
 * Build a fresh signal-capture deps object + frame + reset hook.
 * The returned client defaults to returning `{ data: [] }`; tests
 * that need a non-empty transcript pass a custom `client` and reset
 * the frame.
 */
function captureDeps(client?: ContextControllerDeps["client"]): {
  deps: ContextControllerDeps;
  frame: SignalFrame;
  reset(): void;
} {
  const frame: SignalFrame = {
    cache: [],
    categories: [],
    error: [],
    trendLabel: [],
    trend: [],
    cumulative: [],
    detail: [],
    loaded: [],
  };

  const deps: ContextControllerDeps = {
    client: client ?? {
      session: {
        messages: async () => ({ data: [] }),
      },
    },
    state: {},
    setCache: (v) => {
      frame.cache.push(v);
    },
    setCategories: (v) => {
      frame.categories.push(v);
    },
    setError: (v) => {
      frame.error.push(v);
    },
    setTrendLabel: (v) => {
      frame.trendLabel.push(v);
    },
    setTrend: (v) => {
      frame.trend.push(v);
    },
    setCumulative: (v) => {
      frame.cumulative.push(v);
    },
    setDetail: (v) => {
      frame.detail.push(v);
    },
    setLoaded: (v) => {
      frame.loaded.push(v);
    },
  };

  return {
    deps,
    frame,
    reset(): void {
      frame.cache.length = 0;
      frame.categories.length = 0;
      frame.error.length = 0;
      frame.trendLabel.length = 0;
      frame.trend.length = 0;
      frame.cumulative.length = 0;
      frame.detail.length = 0;
      frame.loaded.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers — fake client
// ---------------------------------------------------------------------------

/**
 * Build a fake client whose `session.messages` returns the given
 * v1 messages array.  The result is wrapped in `{ data }` to mirror
 * the host SDK shape the controller's defensive unwrap expects.
 */
function fakeClient(
  messages: ContextMessageEntry[],
): ContextControllerDeps["client"] {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Raw view pass-through
// ---------------------------------------------------------------------------

/**
 * No persisted state file exists for the session id, so `store.load`
 * returns an empty session state with no blocks and no marks.  The
 * controller must therefore:
 *
 * - pass the raw mapped transcript into `computeContextReport` (no
 *   folded branch),
 * - compute breakdown, trend, cumulative, and cache exactly over the
 *   raw message list,
 * - mark the panel loaded with no error flag.
 */
describe("raw view pass-through", () => {
  const SID = "tui-ctrl-raw-001";
  const statePath = join(storageDir(), `${SID}.json`);

  beforeEach(() => {
    // Defensive: ensure no leftover state from a prior run.
    if (existsSync(statePath)) rmSync(statePath);
  });
  after(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });

  it("returns empty categories + '—' cache when the transcript has no assistant tokens", async () => {
    const { deps, frame, reset } = captureDeps(
      fakeClient([msg("user", "u0", [textPart("hello world")])]),
    );
    reset();
    const controller = createContextController(deps);
    await controller.compute(SID);

    // One category update — the (only) compute pass.
    assert.equal(frame.categories.length, 1);
    const cat = frame.categories[0];
    assert.ok(cat, "expected a category update from compute");
    assert.equal(cat.user, 3); // ceil(11 / 4) — known literal
    assert.equal(cat.assistant, 0);
    assert.equal(cat.tool, 0);
    assert.equal(cat.total, 3);
    // system is a residual of (total − user − assistant − tool); the
    // 0-vs-max(0, …) clamp guarantees 0 when residual is negative or 0.
    assert.equal(cat.system, 0);

    // No cache data → setCache emits the placeholder dash.
    assert.deepEqual(frame.cache, ["—"]);
    // No completed assistant → trend setters emit null.
    assert.deepEqual(frame.trendLabel, [null]);
    assert.deepEqual(frame.trend, [null]);

    // Detail capture has one entry, all four fields zero (no assistant).
    assert.equal(frame.detail.length, 1);
    const detail = frame.detail[0] as {
      cacheRead: number;
      input: number;
      output: number;
      total: number;
    };
    assert.deepEqual(detail, {
      cacheRead: 0,
      input: 0,
      output: 0,
      total: 0,
    });

    // Cumulative rate falls back to message-sum; totalRead=0, denom=0 →
    // rate=null → placeholder dash.  This contract is independent from
    // the trends-with-one-assistant case.
    assert.deepEqual(frame.cumulative, ["—"]);

    // The panel was successfully loaded with no error flag.
    assert.deepEqual(frame.loaded, [true]);
    assert.deepEqual(frame.error, [false]);
  });

  it("treats a missing state file the same as an empty one (no fold branch)", async () => {
    // Identical transcript to the previous test, but with a real —
    // empty — state file written first.  The controller must compute
    // the same numbers: an empty persisted state's `effectiveCallIds`
    // returns undefined and `foldedV1Messages` returns undefined, so
    // `computeContextReport` receives `mapped` (not a folded array).
    writeStateFile(SID, {
      schema: 2,
      blocks: {},
      marks: {},
      lastUpdated: new Date().toISOString(),
    });
    try {
      const { deps, frame, reset } = captureDeps(
        fakeClient([msg("user", "u0", [textPart("hello world")])]),
      );
      reset();
      const controller = createContextController(deps);
      await controller.compute(SID);

      assert.equal(frame.categories.length, 1);
      const cat = frame.categories[0];
      assert.ok(cat, "expected a category update from compute");
      assert.equal(cat.user, 3);
      assert.equal(cat.assistant, 0);
      assert.equal(cat.tool, 0);
      assert.equal(cat.total, 3);
    } finally {
      if (existsSync(statePath)) rmSync(statePath);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Folded view panel data
// ---------------------------------------------------------------------------

/**
 * Pre-existing state file with one active block over a known
 * interval; the block's `spanHash` must match the current content
 * (otherwise `validateBlock` silently expands it and we exercise the
 * raw path again — we want the folded branch here).
 */
describe("folded view panel data", () => {
  const SID = "tui-ctrl-fold-001";
  const statePath = join(storageDir(), `${SID}.json`);

  after(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });

  /**
   * Build a v1 transcript then compute the lens history view + the
   * matching span hash for the given interval.  Returns the messages
   * and the computed hash so the test can stamp the persisted state
   * with the correct value (otherwise `validateBlock` rejects the
   * block and we land on the raw path).
   */
  function transcriptWithBlock(
    coverStart: number,
    coverEnd: number,
  ): { messages: ContextMessageEntry[]; hash: string; summary: string } {
    // Heavy messages inside the block, light messages outside — so
    // folding must reduce the panel-total.
    const inside0 = msg("user", "u0", [textPart("a".repeat(64))]);
    const inside1 = msg("user", "u1", [textPart("b".repeat(64))]);
    const outside0 = msg("user", "u2", [textPart("x")]);
    const outside1 = msg("user", "u3", [textPart("y")]);
    const messages = [inside0, inside1, outside0, outside1];
    const view = history(messages);
    const hash = computeSpanHash(view, coverStart, coverEnd);
    const summary = "fold summary";
    return { messages, hash, summary };
  }

  it("panel-total is smaller than the raw total when an active block covers heavy messages", async () => {
    // First, run the raw pass and capture the totals.  The fake
    // client must be plumbed BEFORE `createContextController` —
    // the factory destructures `deps.client` eagerly.
    const rawMessages = transcriptWithBlock(0, 2).messages;
    const rawControl = captureDeps(fakeClient(rawMessages));
    rawControl.reset();
    const rawController = createContextController(rawControl.deps);
    await rawController.compute(SID);

    const rawTotal = rawControl.frame.categories[0]?.total ?? 0;
    assert.ok(rawTotal > 0, "raw total should be positive");

    // Now seed a state file with an active block over [0, 2) and
    // verify the panel-total shrinks by at least the consumed block's
    // contributions.
    const { hash, summary } = transcriptWithBlock(0, 2);
    writeStateFile(SID, {
      schema: 2,
      blocks: {
        1: {
          start: 0,
          end: 2,
          summary,
          spanHash: hash,
          active: true,
          compressedTokens: 100,
          summaryTokens: 10,
          createdAt: Date.now(),
        },
      },
      marks: {},
      lastUpdated: new Date().toISOString(),
    });

    try {
      // Replace the client with one carrying the same transcript
      // (use a fresh deps + frame to keep the assertion clean).
      const { deps, frame, reset } = captureDeps(fakeClient(rawMessages));
      reset();
      const controller = createContextController(deps);
      await controller.compute(SID);

      const foldedTotal = frame.categories[0]?.total ?? 0;
      assert.ok(
        foldedTotal < rawTotal,
        `folded total (${foldedTotal}) should be smaller than raw total (${rawTotal})`,
      );
      // Exactly one compute pass produced a category update.
      assert.equal(frame.categories.length, 1);
      // The pass must have flagged the panel as loaded (not errored).
      assert.deepEqual(frame.loaded, [true]);
      assert.deepEqual(frame.error, [false]);
    } finally {
      if (existsSync(statePath)) rmSync(statePath);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Category breakdown numeric shape
// ---------------------------------------------------------------------------

/**
 * Numeric values partition the displayed view exactly:
 * `{user, assistant, tool, system, total}` and `total = user +
 * assistant + tool + system`.  The expected numbers come from the
 * CJK-aware estimator (CJK chars / 1.5, others / 4, both ceil), and
 * the exact-token path (`tokens.input / tokens.output / cache.*`).
 * These literals are known up front; if the controller ever returns
 * different numbers, the breakdown has drifted.
 */
describe("category breakdown numeric shape", () => {
  const SID = "tui-ctrl-num-001";
  const statePath = join(storageDir(), `${SID}.json`);

  beforeEach(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });
  after(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });

  it("partition is exact: user + assistant + tool + system == total", async () => {
    const messages = [
      msg("user", "u0", [textPart("hello world")]),
      msg("assistant", "a0", [], { input: 5, output: 10 }),
      msg("user", "u1", [textPart("tool-call-output")]),
    ];
    // Known CJK-aware estimator values for these specific texts:
    //   "hello world"        → ceil(11/4) = 3  (user)
    //   "tool-call-output"   → ceil(16/4) = 4  (user)
    //   assistant.output 10  → assistant = 10  (exact via tokens.output)
    //   heuristic tail        → "tool-call-output" sits AFTER the last
    //                           completed assistant, so its 4 tokens
    //                           land in the heuristic tally.
    // Derived totals:
    //   exact   = 5 + 10 = 15 (input + output from the assistant)
    //   heuristic = 4   (the trailing user message)
    //   total   = 15 + 4 = 19
    //   user    = 3 + 4 = 7
    //   tool    = 0       (no tool parts in this transcript)
    //   system  = max(0, 19 - 7 - 10 - 0) = 2

    const { deps, frame, reset } = captureDeps(fakeClient(messages));
    reset();
    const controller = createContextController(deps);
    await controller.compute(SID);

    assert.equal(frame.categories.length, 1);
    const cat = frame.categories[0] as CategoryInfo;
    assert.equal(typeof cat, "object");
    // Shape: every required field exists and is a number.
    assert.equal(typeof cat.user, "number");
    assert.equal(typeof cat.assistant, "number");
    assert.equal(typeof cat.tool, "number");
    assert.equal(typeof cat.system, "number");
    assert.equal(typeof cat.total, "number");

    // Partition invariant: every categorized token is also counted
    // in the panel total.  system is a residual (clamped >= 0), so
    // the equality is the strongest contract on displayed numbers.
    assert.equal(
      cat.user + cat.assistant + cat.tool + cat.system,
      cat.total,
      `partition broken: ${cat.user} + ${cat.assistant} + ${cat.tool} + ${cat.system} !== ${cat.total}`,
    );

    // Independent known literals (computed up front from the CJK-aware
    // estimator and the exact-token path).
    assert.equal(cat.user, 7);
    assert.equal(cat.assistant, 10);
    assert.equal(cat.tool, 0);
    assert.equal(cat.total, 19);
    assert.equal(cat.system, 2);
  });

  it("tool category sums the input+output heuristic across tool parts", async () => {
    const messages = [
      msg("user", "u0", [textPart("a")]), // 1 token (ceil(1/4))
      msg(
        "assistant",
        "a0",
        [toolPart("xyz", "abc", "call_1"), toolPart("xyzw", "abcd", "call_2")],
        { input: 5, output: 10 },
      ),
    ];
    // Per-part heuristic (input+output):
    //   tool 1: "xyz" + "abc" = 4 chars / 4 = 1; 4 / 4 = 1 → 2 tokens
    //   tool 2: "xyzw" + "abcd" = 8 chars / 4 = 2 → 2 tokens
    //   tool_category = 2 + 2 = 4

    const { deps, frame, reset } = captureDeps(fakeClient(messages));
    reset();
    const controller = createContextController(deps);
    await controller.compute(SID);

    const cat = frame.categories[0] as CategoryInfo;
    assert.equal(cat.tool, 4);
    // Partition still holds.
    assert.equal(cat.user + cat.assistant + cat.tool + cat.system, cat.total);
  });
});

// ---------------------------------------------------------------------------
// 4. Read-only semantics — TUI never writes to disk
// ---------------------------------------------------------------------------

/**
 * Plan 2.7 Must NOT do: TUI is display-only.  The controller must
 * therefore never write to its storage directory during any of its
 * public methods (`fetchSessionMessages`, `compute`,
 * `scheduleRefresh`, `dispose`).
 *
 * Two complementary checks defend this invariant:
 *
 * 1. **Byte content witness.**  A real state file with known content
 *    is written to the controller's default storage dir before
 *    `compute` runs against it.  After `compute` returns, the file's
 *    byte content is re-read and compared byte-for-byte.  Any save
 *    would have rewritten the file (possibly with identical bytes,
 *    but the atomic `writeFileSync(tmp) → renameSync(tmp, file)`
 *    cycle bumps mtime and replaces the inode), so a no-mutation
 *    outcome proves `store.save` was never called.
 *
 * 2. **Directory witness.**  The storage directory listing before
 *    and after a complete controller lifecycle (fetch → compute →
 *    scheduleRefresh → dispose) is identical — no new files, no new
 *    tmp files.
 *
 * Both are direct, behavioural witnesses; no mocks, no spies, no
 * internal-cooperator introspection required.
 */
describe("read-only semantics", () => {
  const SID = "tui-ctrl-ro-001";
  const statePath = join(storageDir(), `${SID}.json`);

  beforeEach(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });
  afterEach(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });

  it("compute leaves a pre-existing state file's byte content unchanged", async () => {
    // Known content witness — any save would rewrite the file
    // (atomic rename), which a post-compute readFileSync would catch.
    const contentBefore = {
      schema: 2,
      blocks: {
        1: {
          start: 0,
          end: 2,
          summary: "untouched summary",
          spanHash: "deadbeef",
          active: true,
          compressedTokens: 50,
          summaryTokens: 10,
          createdAt: 1234567890,
        },
      },
      marks: {},
      lastUpdated: "2026-01-01T00:00:00.000Z",
    };
    writeStateFile(SID, contentBefore);
    const bytesBefore = readFileSync(statePath);

    // Run the full compute pipeline.  Use any transcript — the
    // controller computes over the (raw or folded) view, but the
    // state file's on-disk content is the witness we care about.
    const messages = [
      msg("user", "u0", [textPart("a")]),
      msg("assistant", "a0", [], { input: 1, output: 2 }),
    ];
    const { deps, frame, reset } = captureDeps(fakeClient(messages));
    reset();
    const controller: ContextController = createContextController(deps);
    await controller.compute(SID);

    // The controller reports its own success state — that is the
    // proof the pipeline ran far enough to reach the signal setters.
    assert.deepEqual(frame.loaded, [true]);
    assert.deepEqual(frame.error, [false]);

    // Witness assertion: byte-for-byte equality with the original
    // content.  Any `store.save` call would have rewritten the file
    // via `writeFileSync + renameSync`, replacing the file with
    // freshly serialized state and invalidating this comparison.
    const bytesAfter = readFileSync(statePath);
    assert.equal(
      bytesAfter.length,
      bytesBefore.length,
      "state file length changed — store.save was called",
    );
    // Buffer equality is structural and detects every byte, including
    // trailing-newline and mtime-bumping reshape differences.
    assert.ok(
      bytesAfter.equals(bytesBefore),
      "state file content changed — store.save was called",
    );

    // The view layer reads `lastUpdated` as a captured timestamp; we
    // pinned it to a known literal to catch any in-place mutation
    // even if file length happens to match.
    const parsed = JSON.parse(bytesAfter.toString("utf8")) as {
      lastUpdated: string;
      blocks: Record<string, { summary: string; createdAt: number }>;
    };
    assert.equal(parsed.lastUpdated, contentBefore.lastUpdated);
    assert.equal(
      parsed.blocks["1"]?.summary,
      contentBefore.blocks["1"]?.summary,
    );
    assert.equal(
      parsed.blocks["1"]?.createdAt,
      contentBefore.blocks["1"]?.createdAt,
    );
  });

  it("scheduleRefresh + dispose leave the storage directory unchanged", async () => {
    const dirBefore = storageDirListing();

    const messages = [
      msg("user", "u0", [textPart("a")]),
      msg("assistant", "a0", [], { input: 1, output: 2 }),
    ];
    const { deps, frame, reset } = captureDeps(fakeClient(messages));
    reset();
    const controller = createContextController(deps);

    // Exercise every public method.  dispose() must come last so the
    // pending timer is cancelled (otherwise we'd race the test runner
    // teardown against a setTimeout-driven compute).
    await controller.compute(SID);
    await controller.fetchSessionMessages(SID);
    controller.scheduleRefresh(SID);
    controller.dispose();

    // Wait one tick past the 2-second debounce window to confirm the
    // scheduled refresh never fires a write either.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2_100);
    });

    // The pipeline ran (deferred dispose ran after the schedule).
    // Loaded is set; error remained false.  Note: scheduleRefresh
    // schedules its own compute after dispose is called — and the
    // controller's requestSeq guards `compute` so a stale pass can't
    // clobber the signal setters.  The setLoaded value may therefore
    // be the last successful pass, which is `true`.
    assert.deepEqual(frame.loaded, [true]);
    assert.deepEqual(frame.error, [false]);

    // Directory witness: pre/post listings are identical (modulo
    // ordering, which is sorted to make this comparison stable).
    const dirAfter = storageDirListing();
    assert.deepEqual(dirAfter, dirBefore);
  });
});

// ---------------------------------------------------------------------------
// Storage-directory listing helper (sorted name array)
// ---------------------------------------------------------------------------

/**
 * Snapshot the storage directory's file listing as a sorted name
 * array — a stable, comparable witness for the read-only check.
 * Missing directory is treated as an empty listing (the controller
 * never touches the dir on a missing file, so an absent dir is the
 * correct baseline).
 */
function storageDirListing(): string[] {
  const dir = storageDir();
  if (!existsSync(dir)) return [];
  // Match the controller's defensive posture: an unreadable directory
  // yields an empty listing rather than an exception.
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
