/**
 * Host resolution for the pi end-to-end suite.
 *
 * The host under test is the `pi` executable the developer actually runs,
 * so the binary is resolved from PATH — the same PATH the child process
 * inherits — instead of from the repository dependency tree.  No version is
 * preset or asserted: an unusable host surfaces as a spawn or RPC failure,
 * and a missing host fails closed before the first scenario.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { HarnessError } from "./errors.js";

/** Executable name searched on PATH. */
const PI_COMMAND = "pi";

/**
 * Normalized path of a repository's package-manager shim directory.
 *
 * @param repoRoot - Repository root.
 * @returns Path of `<repoRoot>/node_modules/.bin`.
 */
function repoShimDir(repoRoot: string): string {
  return resolve(repoRoot, "node_modules", ".bin");
}

/**
 * Whether a PATH entry is the repository's own package-manager shim.
 *
 * `bun run` and `npm run` prepend `<repo>/node_modules/.bin` to PATH for the
 * duration of a package script, so the pi installed as a repository dependency
 * would otherwise shadow the host the developer installed.  Shims of other
 * package trees stay searchable: only this repository is skipped.
 *
 * @param entry - One PATH entry.
 * @param shimDir - Normalized repository shim directory.
 * @returns Whether the entry is this repository's shim directory.
 */
function isRepoShim(entry: string, shimDir: string): boolean {
  return resolve(entry) === shimDir;
}

/** Reports whether a candidate path is an executable file. */
export type ExecutableProbe = (path: string) => boolean;

/**
 * Default probe: the path is executable by the current user.
 *
 * @param path - Candidate executable path.
 * @returns Whether the file exists and is executable.
 */
export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the host `pi` executable from PATH.
 *
 * The first PATH entry holding an executable `pi` wins, matching the lookup
 * `command -v pi` performs for the same PATH.  The result is the PATH entry
 * joined with the command name rather than a symlink target, so it compares
 * equal to `command -v` output.  Empty entries are skipped: an empty PATH
 * element must not make the suite depend on the current directory.  The
 * repository's own package-manager shim is skipped as well, so a `bun run`
 * script does not silently test the repository package instead of the host;
 * `bun run` adds that entry itself, so `command -v pi` inside such a script
 * may legitimately report the shim this resolver declines to use.
 *
 * @param options - PATH value, repository root and injectable probe.
 * @param options.repoRoot - Repository whose `node_modules/.bin` is skipped.
 * @param options.path - PATH value; defaults to the harness `process.env.PATH`.
 * @param options.probe - Executable probe; defaults to the real filesystem.
 * @returns Absolute path of the host `pi`.
 * @throws HarnessError `pi.host_not_found` when no PATH entry provides it.
 */
export function resolvePiBinary(
  options: { repoRoot?: string; path?: string; probe?: ExecutableProbe } = {},
): string {
  const path = options.path ?? process.env.PATH ?? "";
  const probe = options.probe ?? isExecutableFile;
  const shimDir =
    options.repoRoot === undefined ? undefined : repoShimDir(options.repoRoot);
  for (const entry of path.split(delimiter)) {
    if (entry === "") continue;
    if (shimDir !== undefined && isRepoShim(entry, shimDir)) continue;
    const candidate = join(entry, PI_COMMAND);
    if (probe(candidate)) return candidate;
  }
  throw new HarnessError(
    "pi.host_not_found",
    `PATH 中未找到可执行的 ${PI_COMMAND}`,
    `PATH=${path}`,
  );
}
