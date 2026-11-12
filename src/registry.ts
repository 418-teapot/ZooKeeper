/**
 * Unit registry — the single ordered list of loadable units.
 *
 * Every unit in the system is declared exactly once here, in
 * registration order.  The order is significant — it is the single
 * execution order for the three handler slots (`tool.execute.after`,
 * `experimental.chat.messages.transform`, and
 * `experimental.text.complete`) and for the delegation judge chain.
 * The per-category profile lists in `config.toml` (`[zoo.mode.poly]`)
 * only declare which units are enabled; they never order execution —
 * load order is decided exclusively by this array:
 *
 *   1. hook units — subagent-prompt → subagent-delegation (delegation),
 *      subagent-prompt → json-error-nudge → direct-work-nudge →
 *      post-subagent-nudge (afterExec), context-pruning (transform),
 *      reply-strip (textComplete), todo-continuation → auto-debug
 *      (onSettled).
 *   2. tool units — compress, decompress, subagent, ask.
 *   3. command units — go, dcp, switch, debug.
 *   4. agent units — the two behavioral agents plus the five
 *      prompt-only agents generated from the table in
 *      `agents/prompt-agents.ts`.
 *
 * A skill is not a unit: it is a selectable resource the generation's skill
 * catalog resolves (see `core/skills.ts`), so this registry reads no
 * directory and holds no skill entry.
 *
 * The assembly pipeline walks this array in order, selects the
 * profile-enabled units whose needs the host can satisfy, and
 * instantiates exactly those, so the registry array is the single
 * source of truth for load order.
 *
 * @module
 */

import { unit as dolphinUnit } from "./agents/dolphin.js";
import { unit as molaUnit } from "./agents/mola.js";
import { promptAgentUnits } from "./agents/prompt-agents.js";
import { unit as dcpCommandUnit } from "./commands/dcp/index.js";
import { unit as debugCommandUnit } from "./commands/debug/index.js";
import { unit as goCommandUnit } from "./commands/go/index.js";
import { unit as switchCommandUnit } from "./commands/switch/index.js";
import type { UnitDescriptor } from "./core/unit.js";
import { unit as autoDebugUnit } from "./hooks/auto-debug/index.js";
import { unit as contextPruningUnit } from "./hooks/context-pruning/index.js";
import { unit as directWorkNudgeUnit } from "./hooks/direct-work-nudge/index.js";
import { unit as jsonErrorNudgeUnit } from "./hooks/json-error-nudge/index.js";
import { unit as postSubagentNudgeUnit } from "./hooks/post-subagent-nudge/index.js";
import { unit as replyStripUnit } from "./hooks/reply-strip/index.js";
import { unit as subagentDelegationUnit } from "./hooks/subagent-delegation/index.js";
import { unit as subagentPromptUnit } from "./hooks/subagent-prompt/index.js";
import { unit as todoContinuationUnit } from "./hooks/todo-continuation/index.js";
import { unit as askToolUnit } from "./tools/ask.js";
import { unit as compressToolUnit } from "./tools/compress.js";
import { unit as decompressToolUnit } from "./tools/decompress.js";
import { unit as fetchToolUnit } from "./tools/fetch.js";
import { unit as subagentToolUnit } from "./tools/subagent.js";
import { unit as todoToolUnit } from "./tools/todo.js";

// ---------------------------------------------------------------------------
// Unit registry
// ---------------------------------------------------------------------------

/**
 * Every loadable unit in registration order.
 *
 * Hook units come first so the shared handler slots receive their
 * contributions in registry order; the tool, command, and agent
 * categories follow in their `config.toml` poly list order.
 */
export const REGISTRY: UnitDescriptor[] = [
  // ── Hook units (registry order) ──────────────────────────────────
  subagentPromptUnit,
  subagentDelegationUnit,
  jsonErrorNudgeUnit,
  directWorkNudgeUnit,
  postSubagentNudgeUnit,
  contextPruningUnit,
  replyStripUnit,
  todoContinuationUnit,
  autoDebugUnit,
  // ── Tool units ──────────────────────────────────────────────────
  compressToolUnit,
  decompressToolUnit,
  fetchToolUnit,
  subagentToolUnit,
  askToolUnit,
  todoToolUnit,
  // ── Command units ───────────────────────────────────────────────
  goCommandUnit,
  dcpCommandUnit,
  switchCommandUnit,
  debugCommandUnit,
  // ── Agent units ─────────────────────────────────────────────────
  dolphinUnit,
  molaUnit,
  ...promptAgentUnits,
];
