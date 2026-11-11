/**
 * Tests for the session records and their declarations (`resources.ts`).
 *
 * Three layers are covered here.  The catalog applies each record's own
 * declaration: a runtime release runs the `release` records and leaves the
 * `retain` records alone, a deletion runs every record, and a failing
 * record never blocks the others.  The context records of one runtime plus
 * the explicit agent record carry one entry per record, and the session
 * service applies them with the stop mode the kernel hands over.  The agent
 * binding is a retained record, so its registry operations are covered here
 * too.
 *
 * The expectations are what a later process would observe — the reloaded
 * state, the resolvable identity, the reported failures — never a replay of
 * the catalog's own loop or the record internals.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { project } from "../context/lens.js";
import { createContextRuntime } from "../context/runtime.js";
import { createStateStore } from "../context/store.js";
import { createLifecycleKernel } from "../lifecycle/index.js";
import { createSessionAgentResource, SessionAgentRegistry } from "./agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
  defineSessionResourcesService,
  type ReleasedSessionResource,
  type RetainedSessionResource,
  type SessionResource,
  type SessionResourceCatalog,
} from "./resources.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

/** The session → agent bindings of the instance under test. */
let sessionAgents = new SessionAgentRegistry();

beforeEach(() => {
  sessionAgents = new SessionAgentRegistry();
});

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a runtime over a fresh scratch store and its instance catalog.
 *
 * @returns The runtime, the store, and the catalog of this instance.
 */
function sandboxRuntime() {
  const dir = makeTmpDir("zoo-session-records");
  tmpDirs.push(dir);
  const store = createStateStore(dir);
  const runtime = createContextRuntime(store);
  const catalog = createSessionResourceCatalog([
    ...contextSessionResources(runtime),
    createSessionAgentResource(sessionAgents),
  ]);
  return { runtime, store, catalog };
}

/**
 * Give one session every record this instance declares.
 *
 * @param runtime - The instance's context runtime.
 * @param sessionID - The session to stage.
 * @returns The permit the staging ran under.
 */
async function stageSession(
  runtime: ReturnType<typeof createContextRuntime>,
  sessionID: string,
) {
  const permit = permitFor(sessionID);
  await runtime.commit(permit, (state) => {
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
    state.pendingViewChange = true;
  });
  sessionAgents.bind(sessionID, "dolphin");
  runtime.setModelLimit(permit, 1000, "model");
  runtime.publishRoundView(sessionID, {
    projection: project([], []),
    numbered: [],
  });
  return permit;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** A release record that logs every step it receives. */
function releasedRecord(
  log: string[],
  name = "released",
  failWith?: Error,
): ReleasedSessionResource {
  const step = (mode: string) => () => {
    log.push(`${name}:${mode}`);
    if (failWith !== undefined) throw failWith;
  };
  return {
    name,
    runtime: "release",
    release: step("release"),
    delete: step("delete"),
  };
}

/** A retain record that logs every step it receives. */
function retainedRecord(
  log: string[],
  name = "retained",
  failWith?: Error,
): RetainedSessionResource {
  return {
    name,
    runtime: "retain",
    delete: () => {
      log.push(`${name}:delete`);
      if (failWith !== undefined) throw failWith;
    },
  };
}

describe("session resource catalog", () => {
  it("releases only the release records on a runtime release", async () => {
    const log: string[] = [];

    const report = await createSessionResourceCatalog([
      releasedRecord(log),
      retainedRecord(log),
    ]).release("s1");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(log, ["released:release"]);
  });

  it("deletes every record on a deletion", async () => {
    const log: string[] = [];
    const catalog = createSessionResourceCatalog([
      releasedRecord(log),
      retainedRecord(log),
    ]);

    const report = await catalog.delete("s1");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(log, ["released:delete", "retained:delete"]);
  });

  it("applies the remaining records after a failure and reports it", async () => {
    const log: string[] = [];
    const failure = new Error("boom");
    const catalog = createSessionResourceCatalog([
      releasedRecord(log, "broken", failure),
      releasedRecord(log, "after"),
      retainedRecord(log),
    ]);

    for (const stop of [
      () => catalog.release("s1"),
      () => catalog.delete("s1"),
    ]) {
      log.length = 0;
      const report = await stop();

      assert.deepEqual(
        report.errors.map((error) => [
          error.scope,
          error.sessionID,
          error.service,
        ]),
        [["session", "s1", "broken"]],
      );
      assert.equal(report.errors[0]?.error, failure, "the error is kept as is");
      assert.ok(
        log.some((entry) => entry.startsWith("after:")),
        "a failing record must not block the records after it",
      );
    }
  });

  it("reports one failure per failing record", async () => {
    const log: string[] = [];
    const records: SessionResource[] = [
      releasedRecord(log, "first", new Error("first failed")),
      retainedRecord(log, "second", new Error("second failed")),
    ];

    const report = await createSessionResourceCatalog(records).delete("s1");

    assert.deepEqual(
      report.errors.map((error) => error.service),
      ["first", "second"],
    );
  });
});

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

describe("session record declarations", () => {
  it("declares each record once with its runtime class", () => {
    const { catalog } = sandboxRuntime();
    assert.deepEqual(
      catalog.resources.map((resource) => [resource.name, resource.runtime]),
      [
        ["modelLimit", "release"],
        ["roundView", "release"],
        ["sessionStateFile", "retain"],
        ["sessionStateCache", "release"],
        ["sessionAgent", "retain"],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe("session record deletion", () => {
  it("leaves no record and no persisted state behind", async () => {
    const { runtime, store, catalog } = sandboxRuntime();
    const sessionID = "deleted-session";
    const permit = await stageSession(runtime, sessionID);

    const report = await catalog.delete(sessionID);

    assert.deepEqual(report.errors, []);
    assert.equal(sessionAgents.resolve(sessionID), undefined);
    assert.equal(runtime.modelLimit(sessionID), undefined);
    assert.equal(runtime.roundView(sessionID), undefined);
    assert.equal(
      runtime.read(permit, (state) => state.pendingViewChange),
      undefined,
      "the pending view change rides on the state cache",
    );
    assert.equal(
      store.load(sessionID).blocks.size,
      0,
      "the persisted state must be removed, not written back",
    );
    assert.equal(
      runtime.read(permit, (state) => state.blocks.size),
      0,
      "the reloaded cache must not resurrect the deleted file",
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime release
// ---------------------------------------------------------------------------

describe("session record release", () => {
  it("keeps the persisted state and the agent binding", async () => {
    const { runtime, store, catalog } = sandboxRuntime();
    const sessionID = "released-session";
    const permit = await stageSession(runtime, sessionID);

    const report = await catalog.release(sessionID);

    assert.deepEqual(report.errors, []);
    assert.equal(
      store.load(sessionID).blocks.get(1)?.summary,
      "kept",
      "the next process instance restores the same context",
    );
    assert.equal(
      sessionAgents.resolve(sessionID),
      "dolphin",
      "identity belongs to the process, not to a runtime",
    );
    assert.equal(runtime.modelLimit(sessionID), undefined);
    assert.equal(runtime.roundView(sessionID), undefined);
    assert.equal(
      runtime.read(permit, (state) => state.pendingViewChange),
      undefined,
      "the pending view change rides on the state cache",
    );
    assert.equal(
      runtime.read(permit, (state) => state.blocks.get(1)?.summary),
      "kept",
      "the dropped entry reloads from the file it was saved to",
    );
  });
});

// ---------------------------------------------------------------------------
// State write failures
// ---------------------------------------------------------------------------

describe("state write failure", () => {
  it("reports the failure of a release instead of dropping the state", async () => {
    const { runtime, store, catalog } = sandboxRuntime();
    const sessionID = "unwritable-session";
    await stageSession(runtime, sessionID);
    // Block the atomic write: the temp path becomes a directory.
    const blocked = join(store.dir, `.${sessionID}.json.tmp`);
    mkdirSync(blocked);

    const report = await catalog.release(sessionID);

    assert.deepEqual(
      report.errors.map((error) => error.service),
      ["sessionStateCache"],
      "the lifecycle mechanism sees the unwritten state",
    );
    rmSync(blocked, { recursive: true, force: true });
    assert.equal(
      runtime.read(permitFor(sessionID), (state) => state.blocks.size),
      1,
      "the unsaved state stays cached for the next release",
    );
  });
});

// ---------------------------------------------------------------------------
// Session service
// ---------------------------------------------------------------------------

describe("session resources service", () => {
  it("releases the records of a stopping scope", async () => {
    const { runtime, store, catalog } = sandboxRuntime();
    const kernel = createLifecycleKernel({
      extension: [],
      session: [defineSessionResourcesService(catalog)],
    });

    await kernel.ensureSession("released");
    await stageSession(runtime, "released");

    const report = await kernel.stopSession(
      "released",
      "dispose",
      "release-runtime",
    );

    assert.deepEqual(report.errors, []);
    assert.equal(
      store.load("released").blocks.size,
      1,
      "a runtime release keeps the persisted context",
    );
    assert.equal(sessionAgents.resolve("released"), "dolphin");
    assert.equal(runtime.modelLimit("released"), undefined);
  });

  it("leaves the records of a deletion to the coordinator", async () => {
    const { runtime, store, catalog } = sandboxRuntime();
    const kernel = createLifecycleKernel({
      extension: [],
      session: [defineSessionResourcesService(catalog)],
    });

    await kernel.ensureSession("deleted");
    await stageSession(runtime, "deleted");

    const report = await kernel.stopSession(
      "deleted",
      "session.deleted",
      "delete-session",
    );

    assert.deepEqual(report.errors, []);
    assert.equal(
      store.load("deleted").blocks.size,
      1,
      "the deletion applies the records after the scope stopped",
    );
    assert.equal(sessionAgents.resolve("deleted"), "dolphin");
  });

  it("reports a failing record through the kernel", async () => {
    const broken: SessionResourceCatalog = createSessionResourceCatalog([
      {
        name: "brokenRelease",
        runtime: "release",
        release: () => {
          throw new Error("bang");
        },
        delete: () => {},
      },
      { name: "fine", runtime: "retain", delete: () => {} },
    ]);
    const kernel = createLifecycleKernel({
      extension: [],
      session: [defineSessionResourcesService(broken)],
    });
    await kernel.ensureSession("s1");

    const released = await kernel.stopSession(
      "s1",
      "dispose",
      "release-runtime",
    );

    assert.equal(released.errors.length, 1);
    assert.equal(released.errors[0]?.service, "sessionResources");
    assert.match(
      String(released.errors[0]?.error),
      /failed to release session records: brokenRelease \(Error: bang\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Agent binding
// ---------------------------------------------------------------------------

describe("SessionAgentRegistry", () => {
  it("resolve returns undefined for an unbound session (fail-closed)", () => {
    const registry = new SessionAgentRegistry();
    assert.equal(registry.resolve("s-unknown"), undefined);
  });

  it("bind then resolve returns the bound agent name", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    assert.equal(registry.resolve("s1"), "dolphin");
  });

  it("a later bind for the same session overwrites the previous name", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.bind("s1", "beaver");
    assert.equal(registry.resolve("s1"), "beaver");
  });

  it("delete removes only the given session's binding", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.bind("s2", "mola");
    registry.delete("s1");
    assert.equal(registry.resolve("s1"), undefined);
    assert.equal(registry.resolve("s2"), "mola");
  });

  it("delete of an unknown session is a no-op", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.delete("s-nope");
    assert.equal(registry.resolve("s1"), "dolphin");
  });

  it("clear drops every binding", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.bind("s2", "beaver");
    registry.clear();
    assert.equal(registry.resolve("s1"), undefined);
    assert.equal(registry.resolve("s2"), undefined);
  });
});
