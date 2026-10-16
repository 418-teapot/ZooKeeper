/**
 * Detect `rg`/`fd` availability and build the agents' Contract rules.
 *
 * Availability is a machine-level fact, detected once at module load
 * into `ENV_TOOLS`.  Detection is fail-closed: a name counts only when
 * an executable regular file with that name exists on `PATH`; no
 * subprocess is spawned.
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
 *
 * On Windows `X_OK` is equivalent to `F_OK`, so an existing but
 * non-executable bare-name file would also count.  That cannot hide a real
 * tool here: installs ship `rg.exe`/`fd.exe`, which a bare-name lookup
 * never matches, so Windows reports them absent — fail-closed and silent
 * rather than probing `PATHEXT`.
 */
function isExecutable(dirs: readonly string[], name: string): boolean {
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
 * Machine-level tool availability, detected once when this module loads.
 *
 * The fact is static, so every consumer shares this single evaluation
 * instead of re-scanning `PATH`.
 */
export const ENV_TOOLS: EnvTools = detectEnvTools();

/**
 * Build the interpolation fragment for the agents' Contract sections.
 *
 * `rg` and `fd` each contribute one independent bullet; only the detected
 * tools contribute.  The `fd` bullet names the detected command so a
 * `fdfind` host is not told to run a command it lacks.
 *
 * The fragment ends without a trailing newline, so each template places
 * it on its own line and `</Contract>` on the next line.  When neither
 * tool is available the fragment is `""`, which leaves a single blank
 * line before `</Contract>`.
 *
 * @param tools - The detection result; defaults to the module-level
 *   `ENV_TOOLS`.
 * @returns One bullet per line, or `""` when none apply.
 */
export function envToolsRules(tools: EnvTools = ENV_TOOLS): string {
  const bullets: string[] = [];
  if (tools.rg) {
    bullets.push("- 搜索文本内容时使用 `rg`，**不得**使用 `grep`");
  }
  if (tools.fd !== null) {
    bullets.push(`- 查找文件时使用 \`${tools.fd}\`，**不得**使用 \`find\``);
  }
  return bullets.join("\n");
}
