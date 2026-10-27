/**
 * Tests for the OpenCode host service declarations (`services.ts`).
 *
 * The session-scoped runtime owns the state the always-on event hook used
 * to keep in extension-level collections: whether a turn was observed
 * aborting, and the id of the wake this host injected whose echo must not
 * reset the reminder budget.  The expectations below are the observable
 * answers of one session's runtime, so an implementation that shares
 * state between sessions fails here.
 *
 * The release expectations are split by stop reason: only the host's
 * `session.deleted` ends a session's persisted context, while a plugin
 * dispose or an unrecognised reason must leave it restorable.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
  clearModelLimit,
  getModelLimit,
  setModelLimit,
} from "../../core/context/model-limits.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../core/context/runtime.js";
import { createStateStore } from "../../core/context/store.js";
import { createLifecycleKernel } from "../../core/lifecycle/index.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { createOpenCodeHostServices } from "./services.js";

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  _resetContextStateManagerForTesting();
  // The registries are process-wide singletons; a stale binding would make
  // the release assertions pass for the wrong reason.
  for (const sessionID of ["s1", "s2"]) {
    sessionAgentRegistry.delete(sessionID);
    clearModelLimit(sessionID);
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Bind the shared manager to a scratch store and stage one cached block.
 *
 * @param sessionID - The session to stage.
 * @returns The sandbox store directory.
 */
function sandboxWithCachedBlock(sessionID: string): string {
  const dir = makeTmpDir("zoo-opencode-services");
  tmpDirs.push(dir);
  _resetContextStateManagerForTesting(createStateStore(dir));
  getContextStateManager().get(sessionID).blocks.set(1, {
    start: 0,
    end: 3,
    summary: "kept",
    spanHash: "ffff0000",
    status: "active",
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
  });
  return dir;
}

/**
 * Build a kernel over the OpenCode declarations.
 *
 * @param onSettled - The settle strategies the profile contributed.
 * @returns The kernel plus the declarations it was built from.
 */
function buildKernel(
  onSettled: Parameters<typeof createOpenCodeHostServices>[0]["onSettled"] = [],
) {
  const declarations = createOpenCodeHostServices({ onSettled });
  const kernel = createLifecycleKernel(declarations);
  return { kernel, declarations };
}

describe("OpenCode session runtime — aborted state", () => {
  it("reports an observed abort exactly once", async () => {
    const { kernel } = buildKernel();

    const session = (await kernel.ensureSession("s1"))?.services.sessionRuntime;

    assert.ok(session);
    assert.equal(session.takeAborted(), false);
    session.markAborted();
    assert.equal(session.takeAborted(), true);
    assert.equal(session.takeAborted(), false, "the abort is consumed once");
  });

  it("keeps one session's abort away from its sibling", async () => {
    const { kernel } = buildKernel();

    const first = (await kernel.ensureSession("s1"))?.services.sessionRuntime;
    const second = (await kernel.ensureSession("s2"))?.services.sessionRuntime;

    assert.ok(first);
    assert.ok(second);
    first.markAborted();

    assert.equal(second.takeAborted(), false);
    assert.equal(first.takeAborted(), true);
  });
});

describe("OpenCode session runtime — wake echo", () => {
  it("claims only the recorded echo id", async () => {
    const { kernel } = buildKernel();

    const session = (await kernel.ensureSession("s1"))?.services.sessionRuntime;

    assert.ok(session);
    session.expectEcho("msg_wake");
    assert.equal(session.takeEcho("msg_user"), false);
    // The unmatched message did not consume the recorded echo.
    assert.equal(session.takeEcho("msg_wake"), true);
    assert.equal(session.takeEcho("msg_wake"), false);
  });

  it("claims nothing when no echo is pending", async () => {
    const { kernel } = buildKernel();

    const session = (await kernel.ensureSession("s1"))?.services.sessionRuntime;

    assert.ok(session);
    assert.equal(session.takeEcho("msg_wake"), false);
  });

  it("drops a pending echo on an assistant update or a failed delivery", async () => {
    const assistant = (await buildKernel().kernel.ensureSession("s1"))?.services
      .sessionRuntime;
    assert.ok(assistant);
    assistant.expectEcho("msg_wake");
    assistant.clearEcho();
    assert.equal(assistant.takeEcho("msg_wake"), false);

    const failed = (await buildKernel().kernel.ensureSession("s2"))?.services
      .sessionRuntime;
    assert.ok(failed);
    failed.expectEcho("msg_wake");
    failed.clearEcho();
    assert.equal(failed.takeEcho("msg_wake"), false);
  });

  it("keeps one session's pending echo away from its sibling", async () => {
    const { kernel } = buildKernel();

    const first = (await kernel.ensureSession("s1"))?.services.sessionRuntime;
    const second = (await kernel.ensureSession("s2"))?.services.sessionRuntime;

    assert.ok(first);
    assert.ok(second);
    first.expectEcho("msg_wake");

    assert.equal(second.takeEcho("msg_wake"), false);
    assert.equal(first.takeEcho("msg_wake"), true);
  });
});

describe("OpenCode session runtime — release reason", () => {
  it("keeps the persisted context and the agent binding on dispose", async () => {
    const dir = sandboxWithCachedBlock("s1");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    sessionAgentRegistry.bind("s1", "dolphin");
    setModelLimit("s1", 1000, "model");

    await kernel.stopSession("s1", "dispose");

    assert.equal(
      createStateStore(dir).load("s1").blocks.get(1)?.summary,
      "kept",
      "a plugin dispose is not a deletion: the compression must survive",
    );
    assert.equal(
      sessionAgentRegistry.resolve("s1"),
      "dolphin",
      "the agent binding outlives the plugin instance",
    );
    assert.equal(getModelLimit("s1"), undefined, "runtime state is released");
  });

  it("keeps the persisted context on an unrecognised reason", async () => {
    const dir = sandboxWithCachedBlock("s1");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    sessionAgentRegistry.bind("s1", "dolphin");

    await kernel.stopSession("s1", "extension.reload");

    assert.equal(
      createStateStore(dir).load("s1").blocks.get(1)?.summary,
      "kept",
      "an unknown reason must keep the data instead of deleting it",
    );
    assert.equal(sessionAgentRegistry.resolve("s1"), "dolphin");
  });

  it("deletes the persisted context and the binding on session.deleted", async () => {
    const dir = sandboxWithCachedBlock("s1");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    sessionAgentRegistry.bind("s1", "dolphin");

    await kernel.stopSession("s1", "session.deleted");

    assert.equal(
      createStateStore(dir).load("s1").blocks.size,
      0,
      "the deleted session's file must be gone, not written back",
    );
    assert.equal(sessionAgentRegistry.resolve("s1"), undefined);
  });

  it("keeps a sibling session's context on a dispose", async () => {
    const dir = sandboxWithCachedBlock("s2");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    await kernel.ensureSession("s2");

    await kernel.stopExtension("dispose");

    assert.equal(
      createStateStore(dir).load("s2").blocks.get(1)?.summary,
      "kept",
      "the extension stop releases runtime state only",
    );
  });
});

describe("OpenCode host services — declarations", () => {
  it("exposes one extension scope and one session runtime service", async () => {
    const { kernel } = buildKernel();

    const extension = await kernel.ensureExtension();
    const session = await kernel.ensureSession("s1");

    assert.ok(extension);
    assert.deepEqual(Object.keys(extension.services), ["loop"]);
    assert.deepEqual(Object.keys(session?.services ?? {}), ["sessionRuntime"]);
  });

  it("builds no loop engine when the profile contributed no strategy", async () => {
    const { kernel } = buildKernel();

    const session = (await kernel.ensureSession("s1"))?.services.sessionRuntime;

    assert.ok(session);
    assert.equal(session.engine, undefined);
  });
});

describe("OpenCode session runtime — release", () => {
  /** A settle strategy that always wakes, so the engine has a budget key. */
  const WAKE = {
    name: "strategy",
    maxWakes: 3,
    async handle() {
      return { kind: "wake" as const, text: "keep going" };
    },
  };

  it("resets only the stopped session's reminder budget", async () => {
    const { kernel } = buildKernel([WAKE]);

    const first = (await kernel.ensureSession("s1"))?.services.sessionRuntime;
    const second = (await kernel.ensureSession("s2"))?.services.sessionRuntime;
    assert.ok(first?.engine);
    assert.equal(first.engine, second?.engine, "one engine per instance");
    first.engine.record("s1", "strategy");
    first.engine.record("s2", "strategy");

    await kernel.stopSession("s1", "session.deleted");

    assert.equal(first.engine.used("s1", "strategy"), 0);
    assert.equal(second?.engine?.used("s2", "strategy"), 1);
  });

  it("drops the stopped session's process-level records only", async () => {
    const { kernel } = buildKernel([WAKE]);
    await kernel.ensureSession("s1");
    await kernel.ensureSession("s2");
    for (const sessionID of ["s1", "s2"]) {
      sessionAgentRegistry.bind(sessionID, "dolphin");
      setModelLimit(sessionID, 1000, "model");
    }

    await kernel.stopSession("s1", "session.deleted");

    assert.equal(sessionAgentRegistry.resolve("s1"), undefined);
    assert.equal(getModelLimit("s1"), undefined);
    assert.equal(sessionAgentRegistry.resolve("s2"), "dolphin");
    assert.ok(getModelLimit("s2"));
  });
});
