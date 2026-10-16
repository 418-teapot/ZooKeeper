/**
 * Host-neutral tool-definition enhancement helpers.
 *
 * Both hosts run the same `tool.definition` chain against a neutral
 * {@link ToolDefinitionView} before writing the result back into their
 * native definition — OpenCode at its `tool.definition` event, pi at its
 * tool registration boundary.  This module owns the host-independent
 * half: building a deep-copied view so a contributor never aliases the
 * native schema, awaiting the contributions in order, and detecting what
 * the view actually changed relative to the original.
 *
 * The host adapters keep only the write-back: pi rebuilds its tool map,
 * OpenCode mutates its native `output` in place.
 *
 * @module
 */

import type {
  ToolArgDefinition,
  ToolDefinitionContribution,
  ToolDefinitionView,
} from "./slots.js";

/**
 * Build the host-neutral view from a native tool definition.
 *
 * Every argument schema is deep-copied onto the view's map so a
 * contributor's mutation — the entry's `description` or any nested field
 * (`items`, `properties`, `enum`) — never reaches the native schema
 * objects.  The copy lands only when the host writes it back in a later
 * pass.  Non-object argument schemas are skipped (the view carries only
 * structured argument definitions).
 *
 * The deep copy uses `structuredClone`, which throws on function values;
 * every tool contribution's args are JSON-schema data (strings, numbers,
 * booleans, arrays and nested objects), so no function is ever cloned.
 *
 * @param name - The canonical (host-normalized) tool name.
 * @param description - The native top-level tool description.
 * @param args - The native per-argument schemas (or `undefined`).
 * @returns A view whose argument entries are independent deep copies.
 */
export function createToolDefinitionView(
  name: string,
  description: string | undefined,
  args: Record<string, unknown> | undefined,
): ToolDefinitionView {
  const viewArgs: Record<string, ToolArgDefinition> = {};
  for (const [key, schema] of Object.entries(args ?? {})) {
    if (schema !== null && typeof schema === "object") {
      viewArgs[key] = structuredClone(schema as Record<string, unknown>);
    }
  }
  return { name, description, args: viewArgs };
}

/**
 * Run the `tool.definition` contributions against a view in order.
 *
 * Each handler is awaited before the next runs, so an asynchronous
 * contributor's changes are visible to later handlers and land in the
 * write-back pass.  Errors are not isolated here — the chain is the
 * host's own and a throw aborts the enhancement, matching both hosts.
 *
 * @param view - The view the contributors mutate.
 * @param contributions - The enhancers in registration order.
 */
export async function runToolDefinitionContributions(
  view: ToolDefinitionView,
  contributions: readonly ToolDefinitionContribution[],
): Promise<void> {
  for (const contribution of contributions) {
    await contribution.handle(view);
  }
}

/**
 * The differences a contribution chain left on a view.
 */
export interface ToolDefinitionChanges {
  /**
   * The new top-level description, present only when it changed.
   *
   * A contributor clearing the description to `undefined` is ignored —
   * the contract keeps the native description rather than erasing it.
   */
  description?: string;
  /**
   * New per-argument descriptions, keyed by argument name, present only
   * for arguments whose description changed.  An argument omitted from
   * the map is unchanged and keeps its native identity; arguments the
   * contributor added to the view (absent from the original) never
   * appear.
   */
  args: Record<string, string | undefined>;
}

/**
 * Compare an enhanced view against the original native definition.
 *
 * @param view - The (possibly mutated) host-neutral view.
 * @param originalDescription - The native top-level description.
 * @param originalArgs - The native per-argument schemas.
 * @returns Only the pieces that actually changed.
 */
export function collectToolDefinitionChanges(
  view: ToolDefinitionView,
  originalDescription: string | undefined,
  originalArgs: Record<string, unknown> | undefined,
): ToolDefinitionChanges {
  const changes: ToolDefinitionChanges = { args: {} };
  if (
    view.description !== undefined &&
    view.description !== originalDescription
  ) {
    changes.description = view.description;
  }
  for (const [name, schema] of Object.entries(originalArgs ?? {})) {
    if (schema === null || typeof schema !== "object") continue;
    const argView = view.args?.[name];
    if (argView === undefined) continue;
    if (
      argView.description !== (schema as { description?: unknown }).description
    ) {
      changes.args[name] = argView.description;
    }
  }
  return changes;
}
