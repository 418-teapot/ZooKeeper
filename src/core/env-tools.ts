/**
 * Environment tool detection for PATH-provided CLI tools.
 *
 * Detects whether `rg` (ripgrep) and `fd` are available as executables on
 * `PATH` so the host entry points can inject the matching usage rule into
 * every agent prompt (`envToolsBullets`).  Detection is fail-closed: a
 * name is reported available only when an executable regular file with
 * that name exists in a `PATH` directory — no subprocess is spawned and
 * no shell is consulted.  The `PATH` string is a parameter (defaulting to
 * `process.env.PATH`) so tests can inject a deterministic value.
 *
 * @module
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Availability of the preferred CLI tools.
 */
export interface EnvTools {
  /** `rg` (ripgrep) resolves to an executable on `PATH`. */
  rg: boolean;
  /**
   * The detected `fd` command name, or `null` when absent.  Debian and
   * Ubuntu install `fd` as `fdfind`, so both names are checked — `fd`
   * wins when both are present.
   */
  fd: "fd" | "fdfind" | null;
}

/**
 * True when `name` resolves to an executable regular file in one of
 * `dirs`.
 *
 * Directories named like the tool must not count: they carry the execute
 * bit by default on POSIX, so `accessSync(X_OK)` alone would report a
 * subdirectory named `rg` as the ripgrep binary.
 */
function isExecutable(dirs: string[], name: string): boolean {
  for (const dir of dirs) {
    try {
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      // Not an executable regular file in this directory — keep scanning.
    }
  }
  return false;
}

/**
 * Detect `rg` and `fd` on `PATH`.
 *
 * @param pathEnv - The `PATH` string to scan; defaults to
 *   `process.env.PATH` (treated as empty when unset).
 * @returns The detected tool availability.
 */
export function detectEnvTools(pathEnv?: string): EnvTools {
  const raw = pathEnv ?? process.env.PATH ?? "";
  const dirs = raw.split(delimiter).filter((dir) => dir !== "");
  return {
    rg: isExecutable(dirs, "rg"),
    fd: isExecutable(dirs, "fd")
      ? "fd"
      : isExecutable(dirs, "fdfind")
        ? "fdfind"
        : null,
  };
}

/**
 * Build the contract-bullet text injected into agent prompts.
 *
 * `rg` and `fd` each contribute one independent bullet; only the detected
 * tools contribute.  The `fd` bullet names the detected command so a
 * `fdfind` host is not told to run a command it lacks.  Returns the empty
 * string when neither tool is available (nothing to inject).
 *
 * @param tools - The detection result.
 * @returns One bullet per line, or `""` when none apply.
 */
export function envToolsBullets(tools: EnvTools): string {
  const bullets: string[] = [];
  if (tools.rg) {
    bullets.push("- 搜索文本内容时使用 `rg`，**不得**使用 `grep`");
  }
  if (tools.fd !== null) {
    bullets.push(`- 查找文件时使用 \`${tools.fd}\`，**不得**使用 \`find\``);
  }
  return bullets.join("\n");
}
