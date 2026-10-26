/**
 * Cross-host contract: a disabled or invalid selection on either host.
 *
 * The two hosts spell their registrations differently, so this suite
 * compares semantics only: which profile-driven capabilities each host
 * exposes, the structured reason the assembly recorded (`selection_invalid`
 * carried by the shared logger), and the always-on surface each host keeps.
 * No event key, capability vocabulary or error string is compared across
 * hosts — an empty capability list and an equal reason object are the
 * contract.
 *
 * Boundary: both host entry surfaces driven end to end (`buildPlugin` for
 * OpenCode, `buildPiHandlers` + `registerPiHandlers` for pi), because the
 * contract is about what a host gets after the wiring step, not about the
 * assembly internals (covered by `core/compose.test.ts`).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildPiHandlers } from "./adapters/pi/wire.js";
import { registerPiHandlers } from "./compose-pi.js";
import { initPluginLogger } from "./core/config-parse.js";
import { buildPlugin } from "./opencode.js";
import { mockApi, resetPiTestState } from "./testkits/pi-wiring.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";

afterEach(() => {
  resetPiTestState();
});

/** The profile both hosts are given. */
const PROFILE = {
  agents: ["mola"],
  skills: ["wiki-query"],
  hooks: ["subagent-delegation"],
  tools: ["compress"],
  commands: ["go"],
};

/** The zoo config declaring that profile. */
const ZOO: Record<string, unknown> = { mode: { poly: PROFILE } };

/**
 * The host role table: only mola is primary, so the product's orchestrator
 * (dolphin) is not enabled by the profile.
 */
const RAW: Record<string, unknown> = { agent: { mola: { mode: "primary" } } };

/** The structured reason of an invalid selection, as both hosts record it. */
interface Reason {
  readonly orchestrator: unknown;
  readonly cause: unknown;
  readonly primaries: unknown;
}

/** One host's observable answer to a selection. */
interface Observed {
  /** Names of the profile-driven capabilities the host exposed. */
  readonly capabilities: readonly string[];
  /** Names of the always-on surfaces the host kept. */
  readonly resident: readonly string[];
  /** The recorded reason, or `null` when the selection was not invalid. */
  readonly reason: Reason | null;
}

/**
 * Run one host and read its observation back out of the shared log.
 *
 * The log is reset first so the reason read belongs to this host alone.
 *
 * @param body - Drives the host and returns its capability/resident names.
 * @returns The observation including the recorded invalid reason.
 */
async function observe(
  body: () => Promise<{
    capabilities: readonly string[];
    resident: readonly string[];
  }>,
): Promise<Observed> {
  _resetForTesting();
  const { capabilities, resident } = await body();
  const entry = _getBufferForTesting().find(
    (e) => e.event === "selection_invalid",
  );
  const reason =
    entry === undefined
      ? null
      : {
          orchestrator: entry.orchestrator,
          cause: entry.cause,
          primaries: entry.primaries,
        };
  return { capabilities, resident, reason };
}

/** The OpenCode hook keys that carry profile-driven contributions. */
const OPENCODE_CAPABILITY_KEYS = [
  "tool.definition",
  "tool",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.chat.messages.transform",
  "experimental.text.complete",
  "command.execute.before",
] as const;

/** The OpenCode hook keys that stay regardless of the selection. */
const OPENCODE_RESIDENT_KEYS = [
  "config",
  "event",
  "experimental.chat.system.transform",
] as const;

/**
 * Observe the OpenCode host for one zoo config.
 *
 * @param zoo - The zoo config; an empty one declares no profile.
 * @param agentTable - The host `config.agent` table served to the pre-read.
 * @returns The OpenCode observation.
 */
function observeOpenCode(
  zoo: Record<string, unknown>,
  agentTable: Record<string, unknown>,
): Promise<Observed> {
  return observe(async () => {
    const client = {
      config: { get: async () => ({ data: { agent: agentTable } }) },
    };
    const plugin = (await buildPlugin({ client }, zoo, RAW)) as Record<
      string,
      any
    >;
    return {
      capabilities: OPENCODE_CAPABILITY_KEYS.filter(
        (key) => typeof plugin[key] === "function",
      ),
      resident: OPENCODE_RESIDENT_KEYS.filter(
        (key) => typeof plugin[key] === "function",
      ),
    };
  });
}

/**
 * Observe the pi host for one zoo config.
 *
 * @param zoo - The zoo config; an empty one declares no profile.
 * @returns The pi observation.
 */
function observePi(zoo: Record<string, unknown>): Promise<Observed> {
  return observe(async () => {
    // The pi entry point initialises the logger before composing; mirror it
    // so the observation reads the same log the real host writes.
    initPluginLogger(zoo, "pi");
    const api = mockApi();
    const handlers = await buildPiHandlers(zoo, api as any, RAW);
    registerPiHandlers(api as any, handlers);
    return {
      capabilities: [
        ...api.tools.map((tool) => (tool as { name: string }).name),
        ...api.commands.map((command) => command.name),
      ],
      resident: [
        ...(Object.keys(api.handlers).length > 0 ? ["event-handlers"] : []),
        ...api.renderers.map((entry) => entry.customType),
      ],
    };
  });
}

describe("host contract — disabled selection", () => {
  it("closes every profile-driven capability on both hosts", async () => {
    // An empty zoo config declares no profile: the profile-driven surfaces
    // of both hosts stay closed, while each host keeps its own resident
    // surface (its infrastructure hooks / its notice renderer and
    // handlers).
    const openCode = await observeOpenCode({}, {});
    const pi = await observePi({});

    assert.deepEqual(openCode.capabilities, []);
    assert.deepEqual(pi.capabilities, []);
    assert.deepEqual(openCode.resident, [...OPENCODE_RESIDENT_KEYS]);
    assert.ok(pi.resident.includes("zoo-notice"));
    assert.ok(pi.resident.includes("event-handlers"));
  });

  it("records no invalid reason on either host", async () => {
    // "Not configured" is not a failure, so neither host logs a reason.
    const openCode = await observeOpenCode({}, {});
    const pi = await observePi({});

    assert.equal(openCode.reason, null);
    assert.equal(pi.reason, null);
  });
});

describe("host contract — invalid selection (orchestrator not enabled)", () => {
  it("closes every profile-driven capability on both hosts", async () => {
    const openCode = await observeOpenCode(ZOO, {
      mola: { mode: "primary" },
    });
    const pi = await observePi(ZOO);

    assert.deepEqual(openCode.capabilities, []);
    assert.deepEqual(pi.capabilities, []);
    assert.deepEqual(openCode.resident, [...OPENCODE_RESIDENT_KEYS]);
    assert.ok(pi.resident.includes("zoo-notice"));
    assert.ok(pi.resident.includes("event-handlers"));
  });

  it("records the same structured reason on both hosts", async () => {
    const openCode = await observeOpenCode(ZOO, {
      mola: { mode: "primary" },
    });
    const pi = await observePi(ZOO);

    // The literal is the independent source: dolphin is the product's
    // orchestrator, the profile enables only mola.
    const expected: Reason = {
      orchestrator: "dolphin",
      cause: "not-enabled",
      primaries: ["mola"],
    };
    assert.deepEqual(openCode.reason, expected);
    assert.deepEqual(pi.reason, expected);
    assert.deepEqual(openCode.reason, pi.reason);
  });
});
