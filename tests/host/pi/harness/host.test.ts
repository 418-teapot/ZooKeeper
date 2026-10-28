/**
 * Self-tests for host resolution.
 *
 * The suite runs the `pi` the developer actually uses, so the resolver must
 * behave like `command -v pi`: the first PATH entry holding an executable
 * wins, and a missing host fails closed instead of falling back to the
 * repository dependency tree.  Ordering and absence are exercised with an
 * injected probe, so no process is spawned.
 */

import { describe, expect, test } from "bun:test";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "./errors.js";
import { isExecutableFile, resolvePiBinary } from "./host.js";

/** Repository root, resolved from this file (no hardcoded path). */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Resolve and return the thrown harness error, if any. */
function resolutionError(options: Parameters<typeof resolvePiBinary>[0]) {
  try {
    resolvePiBinary(options);
    return undefined;
  } catch (error) {
    return error instanceof HarnessError ? error : undefined;
  }
}

describe("resolvePiBinary", () => {
  test("takes the first PATH entry that holds an executable pi", () => {
    const probed: string[] = [];
    const resolved = resolvePiBinary({
      path: ["/opt/a/bin", "/opt/b/bin", "/opt/c/bin"].join(delimiter),
      probe: (candidate) => {
        probed.push(candidate);
        return candidate === "/opt/b/bin/pi";
      },
    });
    expect(resolved).toBe("/opt/b/bin/pi");
    // Order matters: the resolver must stop at the first hit, not the last.
    expect(probed).toEqual(["/opt/a/bin/pi", "/opt/b/bin/pi"]);
  });

  test("skips entries whose pi is absent or not executable", () => {
    const resolved = resolvePiBinary({
      path: ["/opt/a/bin", "/opt/b/bin"].join(delimiter),
      probe: (candidate) => candidate === "/opt/b/bin/pi",
    });
    expect(resolved).toBe("/opt/b/bin/pi");
  });

  test("ignores empty PATH entries instead of searching the cwd", () => {
    const resolved = resolvePiBinary({
      path: `${delimiter}/opt/b/bin${delimiter}`,
      probe: (candidate) => candidate === "/opt/b/bin/pi",
    });
    expect(resolved).toBe("/opt/b/bin/pi");
  });

  test("searches node_modules/.bin directories outside the repository", () => {
    // Only the repository's own shim shadows the host; a `pi` shipped by a
    // sibling package tree is a legitimate hit.
    const entry = "/work/other/node_modules/.bin";
    const resolved = resolvePiBinary({
      repoRoot: "/repo",
      path: entry,
      probe: (candidate) => candidate === `${entry}/pi`,
    });
    expect(resolved).toBe(`${entry}/pi`);
  });

  test("skips the repository shim and keeps the rest in PATH order", () => {
    // bun/npm prepend `<repo>/node_modules/.bin` to PATH while running a
    // package script; that shim is the repository package, not the host.
    const probed: string[] = [];
    const other = "/work/other/node_modules/.bin";
    const resolved = resolvePiBinary({
      repoRoot: "/repo/",
      path: ["/repo/node_modules/.bin/", other, "/opt/real/bin"].join(
        delimiter,
      ),
      probe: (candidate) => {
        probed.push(candidate);
        return true;
      },
    });
    expect(resolved).toBe(`${other}/pi`);
    expect(probed).toEqual([`${other}/pi`]);
  });

  test("does not skip a shim when no repository root is given", () => {
    const entry = "/repo/node_modules/.bin";
    const resolved = resolvePiBinary({
      path: entry,
      probe: (candidate) => candidate === `${entry}/pi`,
    });
    expect(resolved).toBe(`${entry}/pi`);
  });

  test("fails closed when no PATH entry provides pi", () => {
    const error = resolutionError({
      path: "/opt/a/bin:/opt/b/bin",
      probe: () => false,
    });
    expect(error?.code).toBe("pi.host_not_found");
    expect(error?.detail).toContain("/opt/a/bin:/opt/b/bin");
  });
});

describe("host on this machine", () => {
  test("resolves an executable pi under a PATH entry", () => {
    // The suite passes the repository root, so the same lookup is exercised
    // here even when a package script prepended the shim to PATH.
    const resolved = resolvePiBinary({ repoRoot: REPO_ROOT });
    expect(resolved.endsWith(`${delimiter === ":" ? "/" : "\\"}pi`)).toBe(true);
    const entries = (process.env.PATH ?? "").split(delimiter);
    expect(entries).toContain(dirname(resolved));
    expect(isExecutableFile(resolved)).toBe(true);
    expect(resolved).toBe(join(dirname(resolved), "pi"));
  });
});
