/**
 * Tests for the pi message injector
 * (`src/adapters/pi/message-injector.ts`).
 *
 * The injector wraps pi's fire-and-forget `sendUserMessage`: the text is
 * delivered with the `followUp` delivery mode (safe while streaming), a
 * missing API rejects so the command reports the failure, and an
 * asynchronous delivery rejection is logged instead of thrown.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  createPiMessageInjector,
  type PiMessageSender,
} from "./message-injector.js";

afterEach(() => {
  _resetForTesting();
});

describe("pi message injector", () => {
  it("sends the text with followUp delivery", async () => {
    const calls: Array<{
      content: string;
      options?: { deliverAs?: "steer" | "followUp" };
    }> = [];
    const pi: PiMessageSender = {
      sendUserMessage: (content, options) => {
        calls.push({ content, options });
      },
    };

    await createPiMessageInjector(pi).inject("sess-1", "启动调查");

    assert.deepEqual(calls, [
      { content: "启动调查", options: { deliverAs: "followUp" } },
    ]);
  });

  it("rejects when sendUserMessage is unavailable", async () => {
    const injector = createPiMessageInjector({} as PiMessageSender);
    await assert.rejects(
      () => injector.inject("sess-1", "x"),
      /sendUserMessage/,
    );
  });

  it("logs an async delivery rejection instead of throwing", async () => {
    const pi: PiMessageSender = {
      sendUserMessage: () => Promise.reject(new Error("pi delivery failed")),
    };

    await assert.doesNotReject(() =>
      createPiMessageInjector(pi).inject("sess-9", "启动调查"),
    );

    // Let the detached catch handler run.
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    const logs = _getBufferForTesting().filter(
      (entry) => entry.event === "inject_async_failed",
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].sessionId, "sess-9");
    assert.equal(logs[0].error, "pi delivery failed");
  });
});
