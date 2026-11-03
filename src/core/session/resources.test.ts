/**
 * Tests for the session records and their declarations (`resources.ts`).
 *
 * Three layers are covered here.  The catalog applies each record's own
 * declaration: a runtime release runs the `release` records and leaves the
 * `retain` records alone, a deletion runs every record, and a failing
 * record never blocks the others.  The declarations of this build carry one
 * entry per record, and the session service applies them with the stop mode
 * the kernel hands over.  The agent binding is a retained record, so its
 * registry operations are covered here too.
 *
 * The expectations are what a later process would observe — the reloaded
 * state, the resolvable identity, the reported failures — never a replay of
 * the catalog's own loop or the record internals.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { makeTmpDir } from "../../testkits/tmp.js";
import { project } from "../context/lens.js";
import * as modelLimits from "../context/model-limits.js";
import { getRoundView, publishRoundView } from "../context/round-view.js";
import {
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
  setPendingViewChange,
} from "../context/runtime.js";
import { createStateStore } from "../context/store.js";
import { createLifecycleKernel } from "../lifecycle/index.js";
import { SessionAgentRegistry, sessionAgentRegistry } from "./agent.js";
import {
  createSessionResourceCatalog,
  defineSessionResourcesService,
  type ReleasedSessionResource,
  type RetainedSessionResource,
  type SessionResource,
  sessionResources,
  sessionResourcesService,
} from "./resources.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  _resetContextStateManagerForTesting();
  sessionAgentRegistry.clear();
  modelLimits._resetForTesting();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Bind the runtime to a scratch store.
 *
 * @returns The sandbox store and its directory.
 */
function sandboxStore() {
  const dir = makeTmpDir("zoo-session-records");
  tmpDirs.push(dir);
  const store = createStateStore(dir);
  _resetContextStateManagerForTesting(store);
  return { dir, store };
}

/**
 * Give one session every record this build declares.
 *
 * @param sessionID - The session to stage.
 * @returns The resident manager and the cached state object.
 */
function stageSession(sessionID: string) {
  const manager = getContextStateManager();
  const cached = manager.get(sessionID);
  cached.blocks.set(1, {
    start: 0,
    end: 3,
    summary: "kept",
    spanHash: "ffff0000",
    status: "active",
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
  });
  manager.save(sessionID);
  sessionAgentRegistry.bind(sessionID, "dolphin");
  modelLimits.setModelLimit(sessionID, 1000, "model");
  setPendingViewChange(sessionID);
  publishRoundView(sessionID, { projection: project([], []), numbered: [] });
  return { manager, cached };
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
    assert.deepEqual(
      sessionResources.resources.map((resource) => [
        resource.name,
        resource.runtime,
      ]),
      [
        ["modelLimit", "release"],
        ["roundView", "release"],
        ["pendingViewChangeFlag", "release"],
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
    const { store } = sandboxStore();
    const sessionID = "deleted-session";
    const { manager, cached } = stageSession(sessionID);

    const report = await sessionResources.delete(sessionID);

    assert.deepEqual(report.errors, []);
    assert.equal(sessionAgentRegistry.resolve(sessionID), undefined);
    assert.equal(modelLimits.getModelLimit(sessionID), undefined);
    assert.equal(getRoundView(sessionID), undefined);
    assert.equal(consumePendingViewChange(sessionID), false);
    assert.equal(
      store.load(sessionID).blocks.size,
      0,
      "the persisted state must be removed, not written back",
    );
    const after = manager.get(sessionID);
    assert.notEqual(after, cached, "the cached entry must be dropped");
    assert.equal(after.blocks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Runtime release
// ---------------------------------------------------------------------------

describe("session record release", () => {
  it("keeps the persisted state and the agent binding", async () => {
    const { store } = sandboxStore();
    const sessionID = "released-session";
    const { manager, cached } = stageSession(sessionID);

    const report = await sessionResources.release(sessionID);

    assert.deepEqual(report.errors, []);
    assert.equal(
      store.load(sessionID).blocks.get(1)?.summary,
      "kept",
      "the next process instance restores the same context",
    );
    assert.equal(
      sessionAgentRegistry.resolve(sessionID),
      "dolphin",
      "identity belongs to the process, not to a runtime",
    );
    assert.equal(modelLimits.getModelLimit(sessionID), undefined);
    assert.equal(getRoundView(sessionID), undefined);
    assert.equal(consumePendingViewChange(sessionID), false);
    const after = manager.get(sessionID);
    assert.notEqual(after, cached, "the cached entry must be dropped");
    assert.equal(
      after.blocks.get(1)?.summary,
      "kept",
      "the dropped entry reloads from the file it was saved to",
    );
  });
});

// ---------------------------------------------------------------------------
// Session service
// ---------------------------------------------------------------------------

describe("session resources service", () => {
  it("applies the mode the kernel records", async () => {
    const { store } = sandboxStore();
    const kernel = createLifecycleKernel({
      extension: [],
      session: [sessionResourcesService],
    });

    for (const [sessionID, mode] of [
      ["released", "release-runtime"],
      ["deleted", "delete-session"],
    ] as const) {
      await kernel.ensureSession(sessionID);
      stageSession(sessionID);

      const report = await kernel.stopSession(sessionID, mode, mode);

      assert.deepEqual(report.errors, []);
      assert.equal(
        store.load(sessionID).blocks.size,
        mode === "delete-session" ? 0 : 1,
      );
      assert.equal(
        sessionAgentRegistry.resolve(sessionID),
        mode === "delete-session" ? undefined : "dolphin",
      );
      assert.equal(modelLimits.getModelLimit(sessionID), undefined);
    }
  });

  it("reports a failing record through the kernel", async () => {
    const broken = createSessionResourceCatalog([
      {
        name: "brokenDelete",
        runtime: "retain",
        delete: () => {
          throw new Error("boom");
        },
      },
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
    await kernel.ensureSession("s2");

    const deleted = await kernel.stopSession(
      "s1",
      "session.deleted",
      "delete-session",
    );
    const released = await kernel.stopSession(
      "s2",
      "dispose",
      "release-runtime",
    );

    assert.equal(deleted.errors.length, 1);
    assert.equal(deleted.errors[0]?.service, "sessionResources");
    assert.match(
      String(deleted.errors[0]?.error),
      /failed to delete session records: brokenDelete \(Error: boom\)/,
    );
    assert.equal(released.errors.length, 1);
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
