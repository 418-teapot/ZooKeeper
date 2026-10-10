/**
 * Tests for the OpenCode message injector
 * (`src/adapters/opencode/message-injector.ts`).
 *
 * The injector is exercised against a fake `InjectorClient`: the
 * injected text goes to `session.promptAsync` with the resolved session
 * agent (never omitting it, which would switch the session identity),
 * the agent falls back to `session.get`, and every unavailable or
 * unresolvable case rejects so the command surfaces the failure.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeTmpDir } from "../../testkits/tmp.js";
import { _resetForTesting, initLogger } from "../../utils/logger.js";
import {
  createOpenCodeMessageInjector,
  type InjectorClient,
} from "./message-injector.js";

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  _loggerDir = makeTmpDir("zoo-msg-injector-oc");
  initLogger("opencode", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  try {
    rmSync(_loggerDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** One recorded `promptAsync` invocation. */
interface PromptCall {
  path: { id: string };
  body?: {
    agent?: string;
    parts: Array<{ type: "text"; text: string }>;
  };
}

/** Build a fake client recording `promptAsync` calls. */
function makeClient(options: { promptRejects?: Error; agent?: string }): {
  client: InjectorClient;
  calls: PromptCall[];
} {
  const calls: PromptCall[] = [];
  const client: InjectorClient = {
    session: {
      promptAsync: async (input) => {
        calls.push(input as PromptCall);
        if (options.promptRejects) throw options.promptRejects;
      },
      get: async () => ({ agent: options.agent }),
    },
  };
  return { client, calls };
}

describe("OpenCode message injector", () => {
  it("injects text with the registry-resolved agent", async () => {
    const { client, calls } = makeClient({});
    const injector = createOpenCodeMessageInjector(client, (id) =>
      id === "sess-1" ? "dolphin" : undefined,
    );

    await injector.inject("sess-1", "启动调查");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path.id, "sess-1");
    assert.equal(calls[0].body?.agent, "dolphin");
    assert.deepEqual(calls[0].body?.parts, [
      { type: "text", text: "启动调查" },
    ]);
  });

  it("falls back to session.get when the registry has no agent", async () => {
    const { client, calls } = makeClient({ agent: "beaver" });
    const injector = createOpenCodeMessageInjector(client, () => undefined);

    await injector.inject("sess-2", "目标");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body?.agent, "beaver");
  });

  it("rejects when promptAsync is unavailable", async () => {
    const injector = createOpenCodeMessageInjector({}, () => "dolphin");
    await assert.rejects(() => injector.inject("sess-1", "x"), /promptAsync/);
  });

  it("rejects when the session agent cannot be resolved", async () => {
    const { client, calls } = makeClient({});
    const injector = createOpenCodeMessageInjector(client, () => undefined);

    await assert.rejects(() => injector.inject("sess-3", "x"), /agent/);
    assert.equal(calls.length, 0, "must not prompt without an agent");
  });

  it("propagates a promptAsync rejection", async () => {
    const { client } = makeClient({ promptRejects: new Error("boom") });
    const injector = createOpenCodeMessageInjector(client, () => "dolphin");

    await assert.rejects(() => injector.inject("sess-1", "x"), /boom/);
  });
});
