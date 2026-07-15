/**
 * Plan lifecycle hook barrel export.
 *
 * Re-exports the `/go` command handler from the hook module.
 *
 * @module
 */

export type { PlanClient } from "./hook.js";
export { handleGoCommand } from "./hook.js";
