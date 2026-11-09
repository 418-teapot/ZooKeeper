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
 * The release expectations are split by stop mode: only a `delete-session`
 * stop ends a session's persisted context, while a `release-runtime` stop (a
 * plugin dispose) must leave it restorable.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createConfigScope } from "../../core/config-snapshot.js";
import {
  type ContextRuntime,
  createContextRuntime,
} from "../../core/context/runtime.js";
import { createStateStore } from "../../core/context/store.js";
import { createLifecycleKernel } from "../../core/lifecycle/index.js";
import type { ProcessState } from "../../core/process-state.js";
import { createProcessState } from "../../core/process-state.js";
import { createSessionAgentResource } from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
  type SessionResourceCatalog,
} from "../../core/session/resources.js";
import { permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { createOpenCodeHostServices, sessionScopeState } from "./services.js";

/** The plugin instance under test. */
let process: ProcessState;

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The plugin instance of the current test. */
let runtime: ContextRuntime;
let sessionCatalog: SessionResourceCatalog;

beforeEach(() => {
  process = createProcessState();
  const dir = makeTmpDir("zoo-opencode-services");
  tmpDirs.push(dir);
  runtime = createContextRuntime(createStateStore(dir));
  sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(runtime),
    createSessionAgentResource(process.sessionAgents),
  ]);
});

/**
 * Create an instance runtime over a scratch store and stage one block.
 *
 * @param sessionID - The session to stage.
 * @returns The sandbox store directory.
 */
function sandboxWithCachedBlock(sessionID: string): string {
  const dir = makeTmpDir("zoo-opencode-services");
  tmpDirs.push(dir);
  runtime = createContextRuntime(createStateStore(dir));
  sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(runtime),
    createSessionAgentResource(process.sessionAgents),
  ]);
  void runtime.commit(permitFor(sessionID), (state) => {
    state.blocks.set(1, {
      start: 0,
      end: 3,
      summary: "kept",
      spanHash: "ffff0000",
      status: "active",
      compressedTokens: 100,
      summaryTokens: 20,
      createdAt: 1000,
    });
  });
  return dir;
}

/** The zoo config enabling one settle strategy (todo-continuation). */
const SETTLE_ZOO = {
  mode: {
    poly: {
      agents: ["dolphin"],
      skills: [],
      hooks: ["todo-continuation"],
      tools: [],
      commands: [],
    },
  },
  continuation: { max_wakes: 3 },
};

/** The agent table marking the profile agent primary. */
const SETTLE_RAW = { agent: { dolphin: { mode: "primary" } } };

/**
 * Build a kernel over the OpenCode declarations.
 *
 * @param withSettle - Whether the profile contributes a settle strategy
 *   (and thus builds a loop engine).
 * @returns The kernel plus the declarations it was built from.
 */
function buildKernel(withSettle = false) {
  const declarations = createOpenCodeHostServices({
    scope: createConfigScope(
      withSettle ? SETTLE_ZOO : {},
      withSettle ? SETTLE_RAW : {},
    ),
    client: withSettle
      ? { config: { get: async () => ({ data: SETTLE_RAW }) } }
      : {},
    directory: "",
    process,
    contextRuntime: runtime,
    sessionCatalog,
  });
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

describe("OpenCode session runtime — release mode", () => {
  it("keeps the persisted context and the agent binding on a runtime release", async () => {
    const dir = sandboxWithCachedBlock("s1");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    process.sessionAgents.bind("s1", "dolphin");
    runtime.setModelLimit(permitFor("s1"), 1000, "model");

    await kernel.stopSession("s1", "dispose", "release-runtime");

    assert.equal(
      createStateStore(dir).load("s1").blocks.get(1)?.summary,
      "kept",
      "a plugin dispose is not a deletion: the compression must survive",
    );
    assert.equal(
      process.sessionAgents.resolve("s1"),
      "dolphin",
      "the agent binding outlives the plugin instance",
    );
    assert.equal(
      runtime.modelLimit("s1"),
      undefined,
      "runtime state is released",
    );
  });

  it("decides deletion from the mode, not the reason", async () => {
    const dir = sandboxWithCachedBlock("s1");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    process.sessionAgents.bind("s1", "dolphin");

    // The reason is diagnostic only: the mode alone selects the cleanup.
    await kernel.stopSession("s1", "extension.reload", "delete-session");

    assert.equal(createStateStore(dir).load("s1").blocks.size, 0);
    assert.equal(process.sessionAgents.resolve("s1"), undefined);
  });

  it("deletes the persisted context and the binding on a session deletion", async () => {
    const dir = sandboxWithCachedBlock("s1");
    const { kernel } = buildKernel();
    await kernel.ensureSession("s1");
    process.sessionAgents.bind("s1", "dolphin");

    await kernel.stopSession("s1", "session.deleted", "delete-session");

    assert.equal(
      createStateStore(dir).load("s1").blocks.size,
      0,
      "the deleted session's file must be gone, not written back",
    );
    assert.equal(process.sessionAgents.resolve("s1"), undefined);
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
  it("exposes the loop extension and the session services", async () => {
    const { kernel } = buildKernel();

    const extension = await kernel.ensureExtension();
    const session = await kernel.ensureSession("s1");

    assert.ok(extension);
    assert.deepEqual(Object.keys(extension.services), [
      "runScope",
      "capabilities",
      "composition",
      "loop",
    ]);
    assert.deepEqual(Object.keys(session?.services ?? {}), [
      "sessionRuntime",
      "sessionResources",
    ]);
  });

  it("builds no loop engine when the profile contributed no strategy", async () => {
    const { kernel } = buildKernel();

    const session = (await kernel.ensureSession("s1"))?.services.sessionRuntime;

    assert.ok(session);
    assert.equal(session.engine, undefined);
  });
});

describe("OpenCode session runtime — release", () => {
  it("resets the deleted session's loop state only", async () => {
    const { kernel } = buildKernel(true);

    const first = (await kernel.ensureSession("s1"))?.services.sessionRuntime;
    const second = (await kernel.ensureSession("s2"))?.services.sessionRuntime;
    assert.ok(first?.engine);
    assert.equal(first.engine, second?.engine, "one engine per instance");
    first.engine.record("s1", "strategy");
    first.engine.record("s2", "strategy");

    await kernel.stopSession("s1", "session.deleted", "delete-session");

    assert.equal(first.engine.used("s1", "strategy"), 0);
    assert.equal(second?.engine?.used("s2", "strategy"), 1);
  });

  it("resets the released session's loop state on a runtime release", async () => {
    const { kernel } = buildKernel(true);

    const session = (await kernel.ensureSession("s1"))?.services.sessionRuntime;
    assert.ok(session?.engine);
    session.engine.record("s1", "strategy");

    await kernel.stopSession("s1", "dispose", "release-runtime");

    assert.equal(
      session.engine.used("s1", "strategy"),
      0,
      "a plugin dispose must drop the session's reminder budget",
    );
  });

  it("drops the stopped session's process-level records only", async () => {
    const { kernel } = buildKernel(true);
    await kernel.ensureSession("s1");
    await kernel.ensureSession("s2");
    for (const sessionID of ["s1", "s2"]) {
      process.sessionAgents.bind(sessionID, "dolphin");
      runtime.setModelLimit(permitFor(sessionID), 1000, "model");
    }

    await kernel.stopSession("s1", "session.deleted", "delete-session");

    assert.equal(process.sessionAgents.resolve("s1"), undefined);
    assert.equal(runtime.modelLimit("s1"), undefined);
    assert.equal(process.sessionAgents.resolve("s2"), "dolphin");
    assert.ok(runtime.modelLimit("s2"));
  });
});

describe("OpenCode session scope state", () => {
  it("returns the session's own runtime instance", async () => {
    const { kernel } = buildKernel();
    const scope = await kernel.ensureSession("s1");
    assert.ok(scope);

    const state = sessionScopeState(scope);

    assert.equal(state, scope.services.sessionRuntime);
    assert.equal(
      sessionScopeState(scope),
      state,
      "the state is the service instance, never a rebuilt view",
    );
  });

  it("returns null when there is no session", () => {
    assert.equal(sessionScopeState(null), null);
  });
});
