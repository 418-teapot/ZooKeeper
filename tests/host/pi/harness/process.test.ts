/**
 * Self-tests for process liveness and descendant discovery.
 *
 * Leftover processes are a real failure mode for a suite that spawns pi per
 * scenario, so the helper the shutdown checks rely on is verified here
 * against a stub child.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { descendantPids, isAlive, waitForGone } from "./process.js";

/** Whether `/proc` based discovery works on this host. */
const procAvailable = descendantPids(process.pid) !== null;

describe("isAlive", () => {
  test("is false for a finished child process", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => child.on("exit", resolve));
    expect(isAlive(child.pid ?? 0)).toBe(false);
  });

  test("is true while the child runs", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    try {
      expect(isAlive(child.pid ?? 0)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await waitForGone(child.pid ?? 0, 5_000);
    }
  });

  test("is false for pid 0 and for a pid that never existed", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(2_147_483_646)).toBe(false);
  });
});

describe("descendantPids", () => {
  test("finds a live grandchild", async () => {
    if (!procAvailable) return;
    const child = spawn(process.execPath, [
      "-e",
      [
        'const { spawn } = require("node:child_process");',
        'const inner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'process.stdout.write(String(inner.pid) + "\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ]);
    try {
      const childPid = child.pid ?? 0;
      const grandchild = await new Promise<number>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(
          () => reject(new Error("grandchild pid timeout")),
          5_000,
        );
        child.stdout.on("data", (chunk) => {
          buffered += chunk.toString("utf8");
          const line = buffered.split("\n")[0] ?? "";
          if (/^\d+$/.test(line)) {
            clearTimeout(timer);
            resolve(Number(line));
          }
        });
      });
      expect(descendantPids(childPid)?.includes(grandchild)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await waitForGone(child.pid ?? 0, 5_000);
    }
  });
});

describe("waitForGone", () => {
  test("reports whether the process disappeared before the deadline", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid ?? 0;
    expect(await waitForGone(pid, 5_000)).toBe(true);
    expect(await waitForGone(2_147_483_646, 100)).toBe(true);
  });
});
