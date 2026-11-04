/**
 * Tests for the pi session contexts (`session-contexts.ts`).
 *
 * The store is the one place a session's pi event context is published, so
 * the assertions read what a reader sees after an entry path binds one: the
 * tool host, the fleet widget, the todo scan and the switch / handoff
 * command contexts all ask this store by session id instead of sharing a
 * "latest event" pointer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PiCommandCtx } from "./handoff-target.js";
import { createPiSessionContexts } from "./session-contexts.js";

/** A pi event context naming one session. */
function sessionCtx(id: string): unknown {
  return { sessionManager: { getSessionId: () => id } };
}

/** A pi command context (the session-replacement API). */
function commandCtx(): PiCommandCtx {
  return { newSession: async () => ({ cancelled: false }) };
}

describe("pi session contexts", () => {
  it("serves each session the context bound for it", () => {
    const contexts = createPiSessionContexts();
    const first = sessionCtx("sess-1");
    const second = sessionCtx("sess-2");

    contexts.bind("sess-1", first);
    contexts.bind("sess-2", second);

    // A reader that names a session gets THAT session's context, whatever
    // order the events arrived in.
    assert.equal(contexts.forSession("sess-1"), first);
    assert.equal(contexts.forSession("sess-2"), second);
  });

  it("serves no session for an absent, blank or unknown id", () => {
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx("sess-1"));

    // Fail closed: an unnamed session never falls back to another one's
    // context.
    assert.equal(contexts.forSession(undefined), undefined);
    assert.equal(contexts.forSession(""), undefined);
    assert.equal(contexts.forSession("   "), undefined);
    assert.equal(contexts.forSession("sess-2"), undefined);
  });

  it("binds nothing without a session id", () => {
    const contexts = createPiSessionContexts();
    const ctx = sessionCtx("sess-1");

    contexts.bind(undefined, ctx);
    contexts.bind("", ctx);
    contexts.bind("   ", ctx);

    assert.equal(contexts.forSession("sess-1"), undefined);
  });

  it("binds nothing for an absent context", () => {
    const contexts = createPiSessionContexts();
    const ctx = sessionCtx("sess-1");
    contexts.bind("sess-1", ctx);

    // pi never retracts a context: a bind without one must not blank a live
    // session.
    contexts.bind("sess-1", undefined);
    contexts.bind("sess-1", null);

    assert.equal(contexts.forSession("sess-1"), ctx);
  });

  it("replaces only the re-bound session's context", () => {
    const contexts = createPiSessionContexts();
    const first = sessionCtx("sess-1");
    const second = sessionCtx("sess-2");
    contexts.bind("sess-1", first);
    contexts.bind("sess-2", second);

    // A session's next turn re-binds its own entry; the sibling keeps its.
    const again = sessionCtx("sess-1");
    contexts.bind("sess-1", again);

    assert.equal(contexts.forSession("sess-1"), again);
    assert.equal(contexts.forSession("sess-2"), second);
  });

  it("drops only the released session's context", () => {
    const contexts = createPiSessionContexts();
    const first = sessionCtx("sess-1");
    const second = sessionCtx("sess-2");
    contexts.bind("sess-1", first);
    contexts.bind("sess-2", second);

    contexts.releaseSession("sess-1");

    assert.equal(contexts.forSession("sess-1"), undefined);
    assert.equal(contexts.forSession("sess-2"), second);
  });

  it("keeps a released session released against a late bind", () => {
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx("sess-1"));
    contexts.releaseSession("sess-1");

    // The session scope stopped.  The kernel never hands that id out again,
    // so a late event of it must not index a context.
    contexts.bind("sess-1", sessionCtx("sess-1"));

    assert.equal(contexts.forSession("sess-1"), undefined);
  });

  it("keeps a sibling readable after a late bind of a stopped session", () => {
    const contexts = createPiSessionContexts();
    const sibling = sessionCtx("sess-2");
    contexts.bind("sess-1", sessionCtx("sess-1"));
    contexts.bind("sess-2", sibling);

    contexts.releaseSession("sess-1");
    contexts.bind("sess-1", sessionCtx("sess-1"));

    assert.equal(contexts.forSession("sess-1"), undefined);
    assert.equal(contexts.forSession("sess-2"), sibling);
  });

  it("serves no context once the extension scope released", () => {
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx("sess-1"));

    contexts.release();
    // A late event of the stopped extension must not revive a binding.
    contexts.bind("sess-2", sessionCtx("sess-2"));

    assert.equal(contexts.forSession("sess-1"), undefined);
    assert.equal(contexts.forSession("sess-2"), undefined);
  });

  it("drops every session's context on release", () => {
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx("sess-1"));
    contexts.bind("sess-2", sessionCtx("sess-2"));

    contexts.release();

    assert.equal(contexts.forSession("sess-1"), undefined);
    assert.equal(contexts.forSession("sess-2"), undefined);
  });

  it("keeps the command context against an ordinary bind of its session", () => {
    const contexts = createPiSessionContexts();
    const command = commandCtx();
    const event = sessionCtx("sess-1");

    contexts.bindCommand("sess-1", command);
    // Every event re-binds the session's own event context.  The command
    // the same session was admitted with must survive it, whatever order
    // the two arrive in.
    contexts.bind("sess-1", event);

    assert.equal(contexts.commandForSession("sess-1"), command);
    assert.equal(contexts.forSession("sess-1"), event);
  });

  it("serves no command context for a session that bound only an event", () => {
    const contexts = createPiSessionContexts();
    const event = sessionCtx("sess-1");

    contexts.bind("sess-1", event);

    // An event context is not a command context: the reader must not see
    // the event surface where it expects the replacement API.
    assert.equal(contexts.commandForSession("sess-1"), undefined);
    assert.equal(contexts.forSession("sess-1"), event);
  });

  it("drops both contexts of a released session", () => {
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx("sess-1"));
    contexts.bindCommand("sess-1", commandCtx());

    contexts.releaseSession("sess-1");

    assert.equal(contexts.forSession("sess-1"), undefined);
    assert.equal(contexts.commandForSession("sess-1"), undefined);
  });

  it("drops every command context on release", () => {
    const contexts = createPiSessionContexts();
    contexts.bindCommand("sess-1", commandCtx());
    contexts.bindCommand("sess-2", commandCtx());

    contexts.release();

    assert.equal(contexts.commandForSession("sess-1"), undefined);
    assert.equal(contexts.commandForSession("sess-2"), undefined);
  });

  it("keeps every active session readable, however many bind", () => {
    const contexts = createPiSessionContexts();
    const ids = Array.from({ length: 40 }).map((_, index) => `sess-${index}`);
    const bound = new Map<string, unknown>();
    for (const id of ids) {
      const ctx = sessionCtx(id);
      bound.set(id, ctx);
      contexts.bind(id, ctx);
    }

    // Liveness is decided by a session's own release, never by how many
    // sessions the runtime has served.
    for (const id of ids) {
      assert.equal(contexts.forSession(id), bound.get(id), id);
    }
  });
});
