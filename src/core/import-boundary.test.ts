/**
 * Mechanical boundary test: host-agnostic layers must not reach into host
 * adapters or their packages.
 *
 * Recursively scans every non-test TypeScript file under `src/core/`,
 * `src/tools/`, `src/hooks/`, `src/commands/`, and `src/agents/` and asserts
 * that no static import/export specifier contains `/adapters/` or names a
 * host-only package (`@earendil-works/`, `@opencode-ai/`, `@opentui/`,
 * `solid-js`).  Those layers are shared across hosts and reach host
 * capabilities only through the `Deps` ports, so this enforces the
 * host-agnostic invariant.
 *
 * Blind spots:
 * - Dynamic `import()` specifiers are not examined — the patterns match
 *   static `import` / `export ... from` / `import ... = require(...)`
 *   statements only.
 * - `stripLineComments` removes `//` to end-of-line naively, so a `//`
 *   inside a string literal (e.g. a URL) truncates its line and could hide
 *   a violation sharing that line.  No scanned file carries that form today
 *   (import specifiers never contain `//`), so it is unreachable, not silent.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Host-agnostic layers that must never import adapters or host packages. */
const HOST_AGNOSTIC_DIRS = ["core", "tools", "hooks", "commands", "agents"];

/** Scoped-package prefixes only host adapters may import. */
const HOST_PACKAGE_PREFIXES = [
  "@earendil-works/",
  "@opencode-ai/",
  "@opentui/",
];

/**
 * Regex matching import/export specifier strings.
 *
 * Covers:
 * - `import { x } from "path"`
 * - `export { x } from "path"`
 * - `import type { x } from "path"`
 * - `import "path"` (side-effect imports)
 *
 * Group 1 is the module specifier.
 */
const IMPORT_EXPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;

/**
 * Regex matching TypeScript's import-equals require form:
 * `import <name> = require("path")` (and the `import type` variant).
 *
 * Group 1 is the module specifier.
 */
const IMPORT_REQUIRE_PATTERN =
  /import\s+(?:type\s+)?[\w$]+\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;

/** Drop `//` line comments so prose mentions cannot trigger a false hit. */
function stripLineComments(content: string): string {
  return content.replace(/\/\/.*$/gm, "");
}

/** True when a specifier reaches into adapters or a host-only package. */
function isHostSpecifier(specifier: string): boolean {
  if (specifier.includes("/adapters/")) return true;
  if (specifier === "solid-js" || specifier.startsWith("solid-js/")) {
    return true;
  }
  return HOST_PACKAGE_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/**
 * Recursively collect all `.ts` files under `dir`, excluding test files.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

test("host-agnostic layers never import adapters or host packages", () => {
  const violations: Array<{ file: string; specifier: string }> = [];

  for (const layer of HOST_AGNOSTIC_DIRS) {
    for (const file of collectSourceFiles(join(SRC_DIR, layer))) {
      const content = stripLineComments(readFileSync(file, "utf-8"));

      for (const pattern of [IMPORT_EXPORT_PATTERN, IMPORT_REQUIRE_PATTERN]) {
        for (const match of content.matchAll(pattern)) {
          const specifier = match[1];
          if (specifier !== undefined && isHostSpecifier(specifier)) {
            violations.push({ file, specifier });
          }
        }
      }
    }
  }

  assert.strictEqual(
    violations.length,
    0,
    `host-agnostic layers must not import adapters or host packages:\n${violations
      .map((v) => `  ${v.file}: ${v.specifier}`)
      .join("\n")}`,
  );
});

test("import-equals require specifiers are matched", () => {
  const source = 'import x = require("@earendil-works/x")';
  const specifiers = [...source.matchAll(IMPORT_REQUIRE_PATTERN)].map(
    (match) => match[1],
  );
  assert.deepEqual(specifiers, ["@earendil-works/x"]);
  assert.equal(isHostSpecifier("@earendil-works/x"), true);
});
