/**
 * Tests for the primary-switch command unit (`src/commands/switch/`).
 *
 * Covers the config-driven command set (one `/<agent>` command per
 * configured primary, empty set / missing pi switch host → zero
 * commands), and the new-session switch semantics (`applySwitch`:
 * setPrimary FIRST → `newSession` with the current session id as parent
 * → post-replacement tool trim + status inside `withSession`), including
 * the same-agent no-op, cancelled-rollback, missing-API fail-closed, and
 * the round-trip non-accumulation property.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandUnitDescriptor, PiSwitchHost } from "../../core/slots.js";
import {
  _resetForTesting,
  getPrimary,
  setPrimary,
} from "../../core/subagent/identity.js";
import {
  _resetForTesting as _resetLoggerForTesting,
  initLogger,
} from "../../utils/logger.js";
import { unit } from "./index.js";
import { applySwitch } from "./switch.js";

// The switch handler logs with a session id.  Point the logger at a temp
// dir so no test run ever writes into the real `~/.zoo/log/` directory.
let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  _loggerDir = join(tmpdir(), `switch-log-${Date.now()}-${Math.random()}`);
  mkdirSync(_loggerDir, { recursive: true });
  initLogger("pi", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  _resetLoggerForTesting();
  try {
    rmSync(_loggerDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A recording pi switch host for asserting the new-session switch flow.
 *
 * Mirrors the production host: the untrimmed baseline is captured ONCE
 * at build time (before any switch can trim it) and held fixed; the live
 * `active` set is what the `withSession` FACADE's `setActiveTools`
 * writes (and `getActive` reads) so tests can observe the
 * non-accumulation property across switches.  `newSession` records its
 * options and invokes the `withSession` callback against a synthetic
 * per-fresh-session facade (`PiSwitchNewSessionOps`), so tests can
 * observe exactly what the switch does inside `withSession`.
 *
 * The host's OWN `setActiveTools` / `setStatus` record into `hostCalls`
 * and are expected to stay EMPTY: switch.ts must touch only the facade
 * inside `withSession` — the process-level host API is stale (pi
 * invalidates it) after `newSession`, so calling it there is the crash
 * this design prevents.
 */
function mockHost(initialTools: string[] = []): {
  host: PiSwitchHost;
  calls: {
    newSession: Array<{ parentSession?: string }>;
    /** Facade ops.setStatus calls inside withSession. */
    withSessionStatus: Array<[string, string | undefined]>;
    /** Facade ops.setActiveTools calls inside withSession. */
    setActiveTools: string[][];
  };
  hostCalls: {
    setActiveTools: string[][];
    setStatus: Array<[string, string | undefined]>;
  };
  active: () => string[];
  newSessionCount: () => number;
} {
  const calls: {
    newSession: Array<{ parentSession?: string }>;
    withSessionStatus: Array<[string, string | undefined]>;
    setActiveTools: string[][];
  } = {
    newSession: [],
    withSessionStatus: [],
    setActiveTools: [],
  };
  const hostCalls: {
    setActiveTools: string[][];
    setStatus: Array<[string, string | undefined]>;
  } = {
    setActiveTools: [],
    setStatus: [],
  };
  const baseline = [...initialTools];
  let active = [...initialTools];
  const host: PiSwitchHost = {
    getBaselineTools: () => [...baseline],
    // The process-level host methods record separately: they must never
    // run inside `withSession` (pi invalidates them on replacement).
    setActiveTools: (names) => {
      hostCalls.setActiveTools.push(names);
    },
    setStatus: (key, text) => {
      hostCalls.setStatus.push([key, text]);
    },
    newSession: async (options) => {
      calls.newSession.push({ parentSession: options.parentSession });
      // Simulate pi running the withSession callback against a
      // per-fresh-session facade.  The facade's setActiveTools applies
      // the trim (mirrors the deferred application at the new session's
      // first before_agent_start).
      await options.withSession?.({
        setStatus: (key, text) => calls.withSessionStatus.push([key, text]),
        setActiveTools: (names) => {
          calls.setActiveTools.push(names);
          active = names;
        },
      });
      return { cancelled: false };
    },
  };
  return {
    host,
    calls,
    hostCalls,
    active: () => active,
    newSessionCount: () => calls.newSession.length,
  };
}

/** Build a `create`-compatible Deps/ActiveSet pair for the switch unit. */
function makeDeps(
  overrides: Partial<Parameters<CommandUnitDescriptor["create"]>[0]> = {},
): Parameters<CommandUnitDescriptor["create"]>[0] {
  return {
    limits: {},
    contextConfig: {},
    client: {},
    directory: "/tmp/zoo",
    sessionAgentMap: new Map(),
    ...overrides,
  };
}

function makeActiveSet(
  agents: string[],
): Parameters<CommandUnitDescriptor["create"]>[1] {
  return {
    agents: new Set(agents),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(),
    commands: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Command-set follows config
// ---------------------------------------------------------------------------

describe("switch unit — command set follows config", () => {
  it("contributes one /<agent> command per configured primary", () => {
    const { host } = mockHost();
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { dolphin: "primary", mola: "primary", beaver: "subagent" },
      }),
      makeActiveSet(["dolphin", "mola", "beaver"]),
    );
    assert.equal(contributions.kind, "command");
    assert.deepEqual(contributions.commands.map((c) => c.name).sort(), [
      "dolphin",
      "mola",
    ]);
  });

  it("keeps primaries in profile order and skips subagents", () => {
    const { host } = mockHost();
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { mola: "primary", dolphin: "primary", lynx: "subagent" },
      }),
      makeActiveSet(["mola", "dolphin", "lynx"]),
    );
    assert.deepEqual(
      contributions.commands.map((c) => c.name),
      ["mola", "dolphin"],
    );
  });

  it("contributes zero commands for an empty primary set (fail-closed)", () => {
    const { host } = mockHost();
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { beaver: "subagent" },
      }),
      makeActiveSet(["beaver"]),
    );
    assert.equal(contributions.kind, "command");
    assert.deepEqual(contributions.commands, []);
  });

  it("contributes zero commands when agentModes is absent", () => {
    const { host } = mockHost();
    const contributions = unit.create(
      makeDeps({ piSwitchHost: host }),
      makeActiveSet(["dolphin", "mola"]),
    );
    assert.deepEqual(contributions.commands, []);
  });

  it("contributes zero commands without the pi switch host (OpenCode)", () => {
    // OpenCode never sets piSwitchHost — no /<agent> command registers.
    const contributions = unit.create(
      makeDeps({ agentModes: { dolphin: "primary" } }),
      makeActiveSet(["dolphin"]),
    );
    assert.equal(contributions.kind, "command");
    assert.deepEqual(contributions.commands, []);
  });
});

// ---------------------------------------------------------------------------
// New-session switch flow
// ---------------------------------------------------------------------------

describe("switch unit — new-session switch flow", () => {
  it("setPrimary runs BEFORE newSession; newSession parents to the current session id", async () => {
    const { host, calls } = mockHost(["webfetch", "edit", "bash"]);
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { dolphin: "primary", mola: "primary" },
        agentPermissions: { dolphin: ["webfetch", "websearch"] },
      }),
      makeActiveSet(["dolphin", "mola"]),
    );
    const dolphin = contributions.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin, "dolphin switch command must exist");

    // A switch from a DIFFERENT current primary (mola) to dolphin.
    setPrimary("mola");
    await dolphin.handle({
      command: "dolphin",
      sessionID: "sess-switch",
      arguments: "",
    });

    // The identity core reflects the target BEFORE the replacement: the
    // new session's bind-time handlers already resolve dolphin.
    assert.equal(getPrimary(), "dolphin");
    // The new session is parented to the current session id.
    assert.deepEqual(calls.newSession, [{ parentSession: "sess-switch" }]);
  });

  it("trims tools and sets status inside withSession", async () => {
    const { host, calls } = mockHost(["webfetch", "edit", "bash"]);
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { dolphin: "primary", mola: "primary" },
        agentPermissions: { dolphin: ["webfetch", "websearch"] },
      }),
      makeActiveSet(["dolphin", "mola"]),
    );
    const dolphin = contributions.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin);
    setPrimary("mola");

    await dolphin.handle({
      command: "dolphin",
      sessionID: "sess-switch",
      arguments: "",
    });

    // Tool-level deny (webfetch) removed inside the new session; bash
    // (fine-grained sub-table) kept.
    assert.deepEqual(calls.setActiveTools, [["edit", "bash"]]);
    // Status lands in the NEW session.  No confirmation card: the status
    // bar already shows the active primary immediately after the switch.
    assert.deepEqual(calls.withSessionStatus, [["zoo", "dolphin"]]);
  });

  it("leaves the active set unchanged when the target has no denies", async () => {
    const { host, calls } = mockHost(["webfetch", "edit"]);
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { dolphin: "primary", mola: "primary" },
        // mola has no tool-level denies (sub-table only).
        agentPermissions: { mola: [] },
      }),
      makeActiveSet(["dolphin", "mola"]),
    );
    const mola = contributions.commands.find((c) => c.name === "mola");
    assert.ok(mola);
    setPrimary("dolphin");
    await mola.handle({
      command: "mola",
      sessionID: "sess-switch",
      arguments: "",
    });
    assert.deepEqual(calls.setActiveTools, [["webfetch", "edit"]]);
    assert.equal(getPrimary(), "mola");
  });

  it("skips the tool trim when the baseline is unavailable", async () => {
    const { calls } = mockHost();
    // A host without a captured baseline returns undefined.
    const bareHost: PiSwitchHost = {
      getBaselineTools: () => undefined,
      setActiveTools: (names) => calls.setActiveTools.push(names),
      setStatus: (key, text) => {
        calls.withSessionStatus.push([key, text]);
      },
      newSession: async (options) => {
        await options.withSession?.({
          setStatus: (key, text) => calls.withSessionStatus.push([key, text]),
          setActiveTools: (names) => calls.setActiveTools.push(names),
        });
        return { cancelled: false };
      },
    };
    setPrimary("mola");
    await applySwitch("dolphin", ["webfetch"], bareHost, "sess");
    assert.deepEqual(calls.setActiveTools, [], "trim must be skipped");
    assert.deepEqual(calls.withSessionStatus, [["zoo", "dolphin"]]);
    assert.equal(getPrimary(), "dolphin");
  });

  it("skips the tool trim when the baseline is an empty array (first-switch capture)", async () => {
    // The baseline is captured on the first switch (pi forbids action
    // methods at extension-load time), possibly before any session
    // activates tools — pi may report `[]` rather than undefined.
    // Filtering it would wipe every tool (fail-open), so the trim must
    // be skipped and the active set must never become `[]`.
    const { calls } = mockHost();
    const emptyBaselineHost: PiSwitchHost = {
      getBaselineTools: () => [],
      setActiveTools: (names) => calls.setActiveTools.push(names),
      setStatus: (key, text) => {
        calls.withSessionStatus.push([key, text]);
      },
      newSession: async (options) => {
        await options.withSession?.({
          setStatus: (key, text) => calls.withSessionStatus.push([key, text]),
          setActiveTools: (names) => calls.setActiveTools.push(names),
        });
        return { cancelled: false };
      },
    };
    setPrimary("mola");
    await applySwitch("dolphin", ["webfetch"], emptyBaselineHost, "sess");
    assert.deepEqual(calls.setActiveTools, [], "trim must be skipped");
    assert.deepEqual(calls.withSessionStatus, [["zoo", "dolphin"]]);
    assert.equal(getPrimary(), "dolphin");
  });

  it("same-agent switch is a no-op: no newSession call", async () => {
    const { host, calls } = mockHost(["webfetch", "edit"]);
    setPrimary("dolphin");
    await applySwitch("dolphin", ["webfetch"], host, "sess");
    assert.deepEqual(calls.newSession, [], "no replacement for the same agent");
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.withSessionStatus, []);
    assert.equal(getPrimary(), "dolphin");
  });

  it("withSession touches ONLY the facade ops, never the process-level host API", async () => {
    // The crash this design fixes: pi invalidates the captured extension
    // API after `newSession`, so calling the host's own
    // `setActiveTools`/`setStatus` inside `withSession` would throw.
    // switch.ts must route every post-replacement operation through the
    // per-fresh-session facade instead.
    const { host, calls, hostCalls } = mockHost(["webfetch", "edit", "bash"]);
    const contributions = unit.create(
      makeDeps({
        piSwitchHost: host,
        agentModes: { dolphin: "primary", mola: "primary" },
        agentPermissions: { dolphin: ["webfetch", "websearch"] },
      }),
      makeActiveSet(["dolphin", "mola"]),
    );
    const dolphin = contributions.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin);
    setPrimary("mola");

    await dolphin.handle({
      command: "dolphin",
      sessionID: "sess-switch",
      arguments: "",
    });

    // All post-replacement work went through the facade...
    assert.deepEqual(calls.setActiveTools, [["edit", "bash"]]);
    assert.deepEqual(calls.withSessionStatus, [["zoo", "dolphin"]]);
    // ...and NONE of it touched the process-level host API (which pi
    // invalidates on replacement).
    assert.deepEqual(hostCalls.setActiveTools, []);
    assert.deepEqual(hostCalls.setStatus, []);
  });

  it("cancelled replacement → rolls back the primary and throws", async () => {
    // A host whose newSession reports cancelled: the session was never
    // created, so the primary must return to the previous value.
    const { calls } = mockHost();
    let withSessionRan = false;
    const cancellingHost: PiSwitchHost = {
      getBaselineTools: () => [],
      setActiveTools: (names) => calls.setActiveTools.push(names),
      setStatus: (key, text) => {
        calls.withSessionStatus.push([key, text]);
      },
      newSession: async (options) => {
        withSessionRan = true;
        await options.withSession?.({
          setStatus: (key, text) => calls.withSessionStatus.push([key, text]),
          setActiveTools: (names) => calls.setActiveTools.push(names),
        });
        return { cancelled: true };
      },
    };
    setPrimary("mola");
    await assert.rejects(
      () => applySwitch("dolphin", ["webfetch"], cancellingHost, "sess"),
      /cancelled/,
    );
    // Rollback: the session never changed, so the primary is restored.
    assert.equal(getPrimary(), "mola");
    assert.equal(withSessionRan, true);
  });

  it("missing newSession API → error with no state change", async () => {
    // A host without the replacement API must fail closed before any
    // state change: the primary stays at its previous value and no
    // post-replacement work runs.
    const { calls } = mockHost();
    // The bare host intentionally omits `newSession` (the fail-closed
    // path); the cast models a host that predates the capability.
    const bareHost = {
      getBaselineTools: () => ["webfetch", "edit"],
      setActiveTools: (names: string[]) => calls.setActiveTools.push(names),
      setStatus: (key: string, text: string | undefined) => {
        calls.withSessionStatus.push([key, text]);
      },
    } as unknown as PiSwitchHost;
    setPrimary("mola");
    await assert.rejects(
      () => applySwitch("dolphin", ["webfetch"], bareHost, "sess"),
      /newSession/,
    );
    assert.equal(getPrimary(), "mola", "primary must not change");
    assert.deepEqual(calls.setActiveTools, [], "no trim before the check");
    assert.deepEqual(calls.withSessionStatus, []);
  });
});

// ---------------------------------------------------------------------------
// applySwitch — shared switch (new-session flow)
// ---------------------------------------------------------------------------

describe("applySwitch — new-session flow", () => {
  it("removes only the denied tools and keeps the rest in the new session", async () => {
    const { host, calls } = mockHost(["a", "b", "c", "d"]);
    setPrimary("a");
    await applySwitch("mola", ["b", "d"], host, "sess");
    assert.deepEqual(calls.setActiveTools, [["a", "c"]]);
    assert.equal(getPrimary(), "mola");
    assert.deepEqual(calls.withSessionStatus, [["zoo", "mola"]]);
  });

  it("sets the status bar in the new session", async () => {
    const { host, calls } = mockHost([]);
    setPrimary("mola");
    await applySwitch("dolphin", [], host, "sess");
    assert.deepEqual(calls.withSessionStatus, [["zoo", "dolphin"]]);
  });

  it("round-trips A→B→A→B creating two new sessions without accumulating denies", async () => {
    // dolphin denies webfetch+websearch; mola denies nothing.  Each
    // switch replaces the session and recomputes `baseline minus
    // deniedTools(target)`, so the active set must be identical every
    // visit to the same agent and each switch creates a new session.
    const { host, active, newSessionCount } = mockHost([
      "webfetch",
      "websearch",
      "edit",
      "bash",
    ]);
    setPrimary("dolphin");
    await applySwitch("mola", [], host, "sess");
    assert.deepEqual(active(), ["webfetch", "websearch", "edit", "bash"]);
    await applySwitch("dolphin", ["webfetch", "websearch"], host, "sess");
    assert.deepEqual(active(), ["edit", "bash"]);
    assert.equal(newSessionCount(), 2, "each switch creates a new session");
  });

  it("restores a tool denied by A but not by B when switching back to B", async () => {
    // A (dolphin) denies webfetch; B (mola) does not.  After the A→B
    // switch, webfetch must be present again.
    const { host, active } = mockHost(["webfetch", "edit"]);
    setPrimary("dolphin");
    await applySwitch("mola", [], host, "sess");
    assert.deepEqual(active(), ["webfetch", "edit"]);
    await applySwitch("dolphin", ["webfetch"], host, "sess");
    assert.deepEqual(active(), ["edit"]);
  });

  it("a denied tool absent from the baseline stays absent", async () => {
    const { host, active } = mockHost(["edit"]);
    setPrimary("dolphin");
    await applySwitch("mola", [], host, "sess");
    assert.deepEqual(active(), ["edit"]);
    await applySwitch("dolphin", ["webfetch", "websearch"], host, "sess");
    // webfetch/websearch were never in the baseline → stay absent.
    assert.deepEqual(active(), ["edit"]);
  });
});
