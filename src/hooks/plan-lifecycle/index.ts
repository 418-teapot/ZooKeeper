/**
 * Plan lifecycle hook barrel export.
 *
 * Re-exports the `/go` command handler and the plan path rewriting
 * helper from the core module.
 *
 * @module
 */

export { rewritePlanPath } from "../../core/plan.js";
export type { PlanClient } from "./hook.js";
export { handleGoCommand } from "./hook.js";
