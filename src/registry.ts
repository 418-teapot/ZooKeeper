/**
 * Unit registry — the single ordered list of loadable units.
 *
 * Every unit in the system is declared exactly once here, in
 * registration order.  The order is significant — it is the single
 * execution order for the three handler slots (`tool.execute.before`,
 * `tool.execute.after`, and `experimental.chat.messages.transform`).
 * The per-category profile lists in `config.toml` (`[zoo.mode.poly]`)
 * only declare which units are enabled; they never order execution —
 * load order is decided exclusively by this array:
 *
 *   1. hook units — task-prompt → task-delegation (beforeExec),
 *      task-prompt → json-error-nudge → direct-work-nudge →
 *      post-task-nudge (afterExec), context-pruning → context-metrics
 *      (transform).
 *   2. tool units — compress, decompress.
 *   3. command units — go, dcp.
 *   4. agent units — the seven prompt-injection units.
 *   5. skill units — the ten data-only registration units.
 *
 * `composeProfile` walks this array in order and instantiates exactly
 * the profile-enabled units, so the registry array is the single
 * source of truth for load order.
 *
 * @module
 */

import { unit as beaverUnit } from "./agents/beaver.js";
import { unit as dolphinUnit } from "./agents/dolphin.js";
import { unit as eagleUnit } from "./agents/eagle.js";
import { unit as kiwiUnit } from "./agents/kiwi.js";
import { unit as lynxUnit } from "./agents/lynx.js";
import { unit as molaUnit } from "./agents/mola.js";
import { unit as spiderUnit } from "./agents/spider.js";
import { unit as dcpCommandUnit } from "./commands/dcp/index.js";
import { unit as goCommandUnit } from "./commands/go/index.js";
import type { SkillUnitDescriptor, UnitDescriptor } from "./core/slots.js";
import { unit as contextMetricsUnit } from "./hooks/context-metrics/index.js";
import { unit as contextPruningUnit } from "./hooks/context-pruning/index.js";
import { unit as directWorkNudgeUnit } from "./hooks/direct-work-nudge/index.js";
import { unit as jsonErrorNudgeUnit } from "./hooks/json-error-nudge/index.js";
import { unit as postTaskNudgeUnit } from "./hooks/post-task-nudge/index.js";
import { unit as taskDelegationUnit } from "./hooks/task-delegation/index.js";
import { unit as taskPromptUnit } from "./hooks/task-prompt/index.js";
import { unit as compressToolUnit } from "./tools/compress.js";
import { unit as decompressToolUnit } from "./tools/decompress.js";

// ---------------------------------------------------------------------------
// Skill units — pure data (name only), declared here.
// ---------------------------------------------------------------------------

/** The ten skill directory names, in `[zoo.mode.poly]` list order. */
const SKILL_NAMES = [
  "beaver-tdd",
  "code-review",
  "git-commit",
  "grill",
  "kiwi-distill",
  "kiwi-verify",
  "mola-plan",
  "wiki-ingest",
  "wiki-query",
  "wiki-verify",
] as const;

/** A data-only skill unit: registers the directory name, nothing else. */
const skillUnits: SkillUnitDescriptor[] = SKILL_NAMES.map((name) => ({
  name,
  kind: "skill",
  create() {
    return { kind: "skill", skills: [{ name }] };
  },
}));

// ---------------------------------------------------------------------------
// Unit registry
// ---------------------------------------------------------------------------

/**
 * Every loadable unit in registration order.
 *
 * Hook units come first so the shared handler slots receive their
 * contributions in registry order; the tool, command, agent, and
 * skill categories follow in their `config.toml` poly list order.
 */
export const REGISTRY: UnitDescriptor[] = [
  // ── Hook units (registry order) ──────────────────────────────────
  taskPromptUnit,
  taskDelegationUnit,
  jsonErrorNudgeUnit,
  directWorkNudgeUnit,
  postTaskNudgeUnit,
  contextPruningUnit,
  contextMetricsUnit,
  // ── Tool units ──────────────────────────────────────────────────
  compressToolUnit,
  decompressToolUnit,
  // ── Command units ───────────────────────────────────────────────
  goCommandUnit,
  dcpCommandUnit,
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
