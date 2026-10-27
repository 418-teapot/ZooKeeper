/**
 * Tests for the pi live extension context (`live-context.ts`).
 *
 * The port is the one place the latest pi event context is published, so
 * the assertions read what a reader sees after a handler publishes: the
 * adapter, the tool host, the fleet widget and the switch host all ask this
 * port instead of sharing a mutable local.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPiLiveContext } from "./live-context.js";

/** A pi event context naming one session. */
function sessionCtx(id: string): unknown {
  return { sessionManager: { getSessionId: () => id } };
}

describe("pi live context", () => {
  it("serves the latest published context and its session id", () => {
    const live = createPiLiveContext();
    assert.equal(live.current(), undefined);
    assert.equal(live.sessionId(), undefined);

    const first = { sessionManager: { getSessionId: () => "sess-1" } };
    const second = { sessionManager: { getSessionId: () => "sess-2" } };

    live.publish(first);
    assert.equal(live.current(), first);
    assert.equal(live.sessionId(), "sess-1");

    live.publish(second);
    assert.equal(live.current(), second);
    assert.equal(
      live.sessionId(),
      "sess-2",
      "the port always answers with the last publisher",
    );
  });

  it("keeps the published context when a handler has none", () => {
    const live = createPiLiveContext();
    const ctx = { sessionManager: { getSessionId: () => "sess-1" } };
    live.publish(ctx);

    // Entry paths without a context (session-less tests, the command
    // holder fallback) must not blank a live surface.
    live.publish(undefined);
    live.publish(null);

    assert.equal(live.current(), ctx);
    assert.equal(live.sessionId(), "sess-1");
  });

  it("stops serving a context once released", () => {
    const live = createPiLiveContext();
    live.publish({ sessionManager: { getSessionId: () => "sess-1" } });

    live.release();

    assert.equal(live.current(), undefined);
    assert.equal(live.sessionId(), undefined);
  });

  it("serves each session the context published for it", () => {
    const live = createPiLiveContext();
    const first = sessionCtx("sess-1");
    const second = sessionCtx("sess-2");

    live.publish(first);
    live.publish(second);

    // A reader that names a session gets THAT session's context, not
    // whichever session happened to be handled last.
    assert.equal(live.forSession("sess-1"), first);
    assert.equal(live.forSession("sess-2"), second);
    assert.equal(live.current(), second);
    // Fail closed: an unpublished / absent / blank id has no context, so a
    // reader never falls back to another session's.
    assert.equal(live.forSession("sess-3"), undefined);
    assert.equal(live.forSession(undefined), undefined);
    assert.equal(live.forSession(""), undefined);
    assert.equal(live.forSession("   "), undefined);
  });

  it("drops only the released session's view", () => {
    const live = createPiLiveContext();
    const first = sessionCtx("sess-1");
    const second = sessionCtx("sess-2");
    live.publish(first);
    live.publish(second);

    live.releaseSession("sess-1");

    assert.equal(live.forSession("sess-1"), undefined);
    assert.equal(live.forSession("sess-2"), second);
    // Releasing one session is not a clear: the latest pointer stays live.
    assert.equal(live.current(), second);
    assert.equal(live.sessionId(), "sess-2");
  });

  it("keeps a released session released against a late publish", () => {
    const live = createPiLiveContext();
    live.publish(sessionCtx("sess-1"));
    live.releaseSession("sess-1");

    // The session scope stopped, so its context left the index.  A late
    // event of that session must neither re-index it nor make it the live
    // surface again.
    live.publish(sessionCtx("sess-1"));

    assert.equal(live.forSession("sess-1"), undefined);
    assert.equal(live.current(), undefined);
    assert.equal(live.sessionId(), undefined);
  });

  it("keeps a late event of a stopped session off its sibling", () => {
    const live = createPiLiveContext();
    const sibling = sessionCtx("sess-2");
    live.publish(sessionCtx("sess-1"));
    live.publish(sibling);

    live.releaseSession("sess-1");
    live.publish(sessionCtx("sess-1"));

    assert.equal(live.forSession("sess-1"), undefined);
    assert.equal(
      live.forSession("sess-2"),
      sibling,
      "a sibling's context is untouched by a sibling's release",
    );
    assert.equal(live.current(), sibling);
    assert.equal(live.sessionId(), "sess-2");
  });

  it("indexes no session context after release", () => {
    const live = createPiLiveContext();
    live.publish(sessionCtx("sess-1"));

    live.release();
    // A late event of the stopped extension must not resurrect a surface.
    live.publish(sessionCtx("sess-2"));

    assert.equal(live.current(), undefined);
    assert.equal(live.sessionId(), undefined);
    assert.equal(live.forSession("sess-2"), undefined);
    assert.equal(live.forSession("sess-1"), undefined);
  });

  it("publishes a stale context without indexing it", () => {
    const live = createPiLiveContext();
    // pi invalidates a captured context on session replacement / reload;
    // reading through the stale one throws.  Publishing must never propagate
    // that: the latest pointer keeps the context, but no session view is
    // created for it.
    const stale = {
      get sessionManager(): never {
        throw new Error("stale ctx");
      },
    };

    assert.doesNotThrow(() => live.publish(stale));
    assert.equal(live.current(), stale);
    assert.equal(live.forSession("sess-1"), undefined);
  });

  it("keeps every active session readable, however many publish", () => {
    const live = createPiLiveContext();
    const ids = Array.from({ length: 40 }).map((_, index) => `sess-${index}`);
    const published = new Map<string, unknown>();
    for (const id of ids) {
      const ctx = sessionCtx(id);
      published.set(id, ctx);
      live.publish(ctx);
    }

    // Liveness is decided by a session's own release, never by how many
    // sessions the runtime has handled: every active session still reads
    // its own context.
    for (const id of ids) {
      assert.equal(live.forSession(id), published.get(id), id);
    }
    assert.equal(live.current(), published.get("sess-39"));
    assert.equal(live.sessionId(), "sess-39");
  });

  it("keeps a re-published session readable alongside the others", () => {
    const live = createPiLiveContext();
    const ids = Array.from({ length: 40 }).map((_, index) => `sess-${index}`);
    for (const id of ids) live.publish(sessionCtx(id));

    // A session that publishes again (its next turn) replaces only its own
    // entry; no other session is dropped for it.
    const again = sessionCtx("sess-0");
    live.publish(again);

    assert.equal(live.forSession("sess-0"), again);
    for (const id of ids.slice(1)) {
      assert.notEqual(live.forSession(id), undefined, id);
    }
  });
});
