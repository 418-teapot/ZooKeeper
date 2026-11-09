/**
 * Tests for the host start publisher protocol (`src/core/publisher.ts`).
 *
 * The protocol is exercised at its own boundary: two phases, in order, and
 * a failing phase stops the start.  The shared start protocol
 * (`core/runtime.ts`) runs every host start through `runPublisher`, so this
 * suite pins the guarantees they inherit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Publisher, runPublisher } from "./publisher.js";

/** A publisher whose phases record into `calls`. */
function recordingPublisher(
  calls: string[],
  options: { failPrepare?: boolean; failPublish?: boolean } = {},
): Publisher<{ value: number }, string> {
  return {
    async prepare() {
      calls.push("prepare");
      if (options.failPrepare === true) throw new Error("prepare failed");
      return { value: 7 };
    },
    publish(prepared) {
      calls.push(`publish:${prepared.value}`);
      if (options.failPublish === true) throw new Error("publish failed");
      return `published:${prepared.value}`;
    },
  };
}

describe("runPublisher", () => {
  it("runs prepare before publish and returns the publication", async () => {
    const calls: string[] = [];
    const publication = await runPublisher(recordingPublisher(calls));

    assert.deepEqual(calls, ["prepare", "publish:7"]);
    assert.equal(publication, "published:7");
  });

  it("awaits a synchronous publication value", async () => {
    const calls: string[] = [];
    const publisher: Publisher<number, number> = {
      async prepare() {
        calls.push("prepare");
        return 3;
      },
      async publish(prepared) {
        calls.push("publish");
        return prepared * 2;
      },
    };

    assert.equal(await runPublisher(publisher), 6);
    assert.deepEqual(calls, ["prepare", "publish"]);
  });

  it("publishes nothing when prepare rejects", async () => {
    const calls: string[] = [];

    await assert.rejects(
      runPublisher(recordingPublisher(calls, { failPrepare: true })),
      /prepare failed/,
    );
    assert.deepEqual(calls, ["prepare"], "publish must not run");
  });

  it("propagates a publish failure", async () => {
    const calls: string[] = [];

    await assert.rejects(
      runPublisher(recordingPublisher(calls, { failPublish: true })),
      /publish failed/,
    );
    assert.deepEqual(calls, ["prepare", "publish:7"], "publish runs once");
  });
});
