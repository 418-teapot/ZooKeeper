/**
 * Unit registry — the single ordered list of loadable units.
 *
 * Every unit in the system is declared exactly once here, in
 * registration order.  The order is significant — it is the single
 * execution order for the four handler slots (`tool.execute.before`,
 * `tool.execute.after`, `experimental.chat.messages.transform`, and
 * `experimental.text.complete`).
 * The per-category profile lists in `config.toml` (`[zoo.mode.poly]`)
 * only declare which units are enabled; they never order execution —
 * load order is decided exclusively by this array:
 *
 *   1. hook units — task-prompt → task-delegation (beforeExec),
 *      task-prompt → json-error-nudge → direct-work-nudge →
 *      post-task-nudge (afterExec), context-pruning (transform),
 *      reply-strip (textComplete).
 *   2. tool units — compress, decompress.
 *   3. command units — go, dcp.
 *   4. agent units — the seven prompt-injection units.
 *   5. skill units — one data-only unit per directory under
 *      core/skills/, discovered at module load (see below).
 *
 * `composeProfile` walks this array in order and instantiates exactly
 * the profile-enabled units, so the registry array is the single
 * source of truth for load order.
 *
 * @module
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unit as beaverUnit } from "./agents/beaver.js";
import { unit as dolphinUnit } from "./agents/dolphin.js";
import { unit as eagleUnit } from "./agents/eagle.js";
import { unit as kiwiUnit } from "./agents/kiwi.js";
import { unit as lynxUnit } from "./agents/lynx.js";
import { unit as molaUnit } from "./agents/mola.js";
import { unit as spiderUnit } from "./agents/spider.js";
import { unit as dcpCommandUnit } from "./commands/dcp/index.js";
import { unit as goCommandUnit } from "./commands/go/index.js";
import { unit as switchCommandUnit } from "./commands/switch/index.js";
import type { SkillUnitDescriptor, UnitDescriptor } from "./core/slots.js";
import { unit as contextPruningUnit } from "./hooks/context-pruning/index.js";
import { unit as directWorkNudgeUnit } from "./hooks/direct-work-nudge/index.js";
import { unit as jsonErrorNudgeUnit } from "./hooks/json-error-nudge/index.js";
import { unit as postTaskNudgeUnit } from "./hooks/post-task-nudge/index.js";
import { unit as replyStripUnit } from "./hooks/reply-strip/index.js";
import { unit as taskDelegationUnit } from "./hooks/task-delegation/index.js";
import { unit as taskPromptUnit } from "./hooks/task-prompt/index.js";
import { unit as compressToolUnit } from "./tools/compress.js";
import { unit as decompressToolUnit } from "./tools/decompress.js";

// ---------------------------------------------------------------------------
// Skill units — pure data (name only), discovered from core/skills/.
// ---------------------------------------------------------------------------

/**
 * Resolve the source directory of this module.
 *
 * `realpathSync` follows a host auto-discovery symlink (pi) to the real
 * src/ location, so `../core/skills` resolves to the project directory
 * even when this module is loaded through the symlink.  On realpath
 * failure (unusual loader) the raw module path is used as a fallback.
 */
function sourceDir(): string {
  const moduleUrl = fileURLToPath(import.meta.url);
  try {
    return dirname(realpathSync(moduleUrl));
  } catch {
    return dirname(moduleUrl);
  }
}

/**
 * Discover the data-only skill units from a skills directory.
 *
 * Scans the given directory for subdirectories, one unit per directory
 * name, sorted for determinism.  Symbolic links that resolve to a
 * directory are followed and accepted, matching the `statSync` semantics
 * of the host adapters; broken links (dangling or cyclic) are skipped
 * silently.  Fail-closed: a missing or unreadable directory yields an
 * empty list (never throws), matching the silent skip style of skill
 * registration.
 *
 * @param skillsDir - The directory to scan (normally core/skills/).
 * @returns The sorted skill units.
 */
export function discoverSkillUnits(skillsDir: string): SkillUnitDescriptor[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        // Follow the link (statSync resolves the target); a dead link or
        // link cycle throws here and the entry is skipped silently.
        try {
          return statSync(resolve(skillsDir, entry.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name)
      .sort()
      .map((name) => makeSkillUnit(name));
  } catch {
    return [];
  }
}

/**
 * A data-only skill unit: registers the directory name, nothing else.
 */
function makeSkillUnit(name: string): SkillUnitDescriptor {
  return {
    name,
    kind: "skill",
    create() {
      return { kind: "skill", skills: [{ name }] };
    },
  };
}

/**
 * The skill units, generated by scanning core/skills/ at module load.
 *
 * Adding a new skill requires only a new directory there (containing
 * SKILL.md) plus an entry in the `[zoo.mode.*]` profile skills list —
 * no code change.  Skill unit order is behaviorally irrelevant (the
 * final skill path order is decided by the directory scan in the host
 * adapters); the sort only keeps registration order deterministic.
 */
const skillUnits: SkillUnitDescriptor[] = discoverSkillUnits(
  resolve(sourceDir(), "../core/skills"),
);

// ---------------------------------------------------------------------------
// Unit registry
// ---------------------------------------------------------------------------

/**
 * Every loadable unit in registration order.
 *
 * Hook units come first so the shared handler slots receive their
 * contributions in registry order; the tool, command, and agent
 * categories follow in their `config.toml` poly list order, and the
 * skill units in core/skills/ directory scan order.
 */
export const REGISTRY: UnitDescriptor[] = [
  // ── Hook units (registry order) ──────────────────────────────────
  taskPromptUnit,
  taskDelegationUnit,
  jsonErrorNudgeUnit,
  directWorkNudgeUnit,
  postTaskNudgeUnit,
  contextPruningUnit,
  replyStripUnit,
  // ── Tool units ──────────────────────────────────────────────────
  compressToolUnit,
  decompressToolUnit,
  // ── Command units ───────────────────────────────────────────────
  goCommandUnit,
  dcpCommandUnit,
  switchCommandUnit,
  // ── Agent units ─────────────────────────────────────────────────
  dolphinUnit,
  molaUnit,
  beaverUnit,
  lynxUnit,
  spiderUnit,
  eagleUnit,
  kiwiUnit,
  // ── Skill units ─────────────────────────────────────────────────
  ...skillUnits,
];
