/**
 * Self-tests for the JSONL RPC client and its cleanup guarantees.
 *
 * The client drives a real pi process in the suite, so these tests exercise
 * the same code against a stub Node process: framing, id correlation,
 * request timeouts and the orderly/killed shutdown paths.  A stub keeps the
 * tests fast and independent from pi.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "./errors.js";
import { isAlive } from "./process.js";
import { RpcClient, splitRecords } from "./rpc-client.js";

/** Node binary used for stub processes. */
const NODE = process.execPath;

/** Script that answers every command with a correlated response. */
const ECHO_SCRIPT = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    process.stdout.write(
      JSON.stringify({
        id: command.id ?? null,
        type: "response",
        command: command.type,
        success: true,
        data: { echo: command.type, note: "line\\u2028separator" },
      }) + "\\n",
    );
    index = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Script that never answers and keeps the event loop alive. */
const MUTE_SCRIPT = "process.stdin.resume(); setInterval(() => {}, 1000);";

/** Create an isolated output directory for one test. */
function workspace(): {
  dir: string;
  recordsPath: string;
  stderrPath: string;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zookeeper-e2e-selftest-"));
  return {
    dir,
    recordsPath: join(dir, "records.jsonl"),
    stderrPath: join(dir, "stderr.log"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Start a stub RPC client. */
function startStub(
  script: string,
  paths: { recordsPath: string; stderrPath: string },
): RpcClient {
  return new RpcClient({
    label: "stub",
    binary: NODE,
    args: ["-e", script],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    recordsPath: paths.recordsPath,
    stderrPath: paths.stderrPath,
  }).start();
}

describe("splitRecords", () => {
  test("splits on LF only and keeps Unicode separators inside a record", () => {
    const first = splitRecords("", '{"text":"a\u2028b"}\n{"type":"x"}\n');
    expect(first.records.length).toBe(2);
    expect(first.records[0]).toBe('{"text":"a\u2028b"}');
    expect(first.rest).toBe("");
  });

  test("strips a trailing CR and holds an incomplete record", () => {
    const result = splitRecords("", '{"id":"a"}\r\n{"id":"b"');
    expect(result.records).toEqual(['{"id":"a"}']);
    expect(result.rest).toBe('{"id":"b"');
  });

  test("drops blank lines", () => {
    expect(splitRecords("", "\n\n").records).toEqual([]);
  });
});

describe("RpcClient", () => {
  test("correlates responses by id and records the raw lines", async () => {
    const paths = workspace();
    const client = startStub(ECHO_SCRIPT, paths);
    try {
      const first = await client.send({ type: "get_state" }, 5_000);
      const second = await client.send({ type: "get_entries" }, 5_000);
      expect(first.success).toBe(true);
      expect(first.data?.echo).toBe("get_state");
      expect(second.data?.echo).toBe("get_entries");
      expect(client.since(0).length).toBe(2);
      expect(readFileSync(paths.recordsPath, "utf8").split("\n").length).toBe(
        3,
      );
    } finally {
      const exit = await client.close({ timeoutMs: 5_000 });
      await client.close();
      expect(exit.code).toBe(0);
      paths.cleanup();
    }
  });

  test("fails a request that never gets a response", async () => {
    const paths = workspace();
    const client = startStub(MUTE_SCRIPT, paths);
    try {
      const error = await client
        .send({ type: "get_state" }, 150)
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error instanceof HarnessError).toBe(true);
      expect((error as HarnessError).code).toBe("rpc.timeout");
    } finally {
      const exit = await client.close({ timeoutMs: 300 });
      expect(exit.code).toBe("timeout");
      expect(isAlive(client.pid ?? 0)).toBe(false);
      paths.cleanup();
    }
  });

  test("reports an unexpected exit instead of waiting for the deadline", async () => {
    const paths = workspace();
    const client = startStub("process.exit(3);", paths);
    try {
      const error = await client
        .send({ type: "get_state" }, 10_000)
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error instanceof HarnessError).toBe(true);
      expect((error as HarnessError).code).toBe("rpc.exited");
    } finally {
      const exit = await client.close({ timeoutMs: 5_000 });
      expect(exit.code).toBe(3);
      paths.cleanup();
    }
  });

  test("rejects a wait that the process never satisfies", async () => {
    const paths = workspace();
    const client = startStub(MUTE_SCRIPT, paths);
    try {
      const error = await client
        .waitFor((record) => record.type === "never", {
          label: "never",
          timeoutMs: 120,
        })
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect((error as HarnessError).code).toBe("rpc.timeout");
    } finally {
      await client.close({ timeoutMs: 300 });
      paths.cleanup();
    }
  });
});
