/**
 * Layers 2 & 3 — System reminder XML tags and directive prefix utilities.
 *
 * Layer 2 uses `<internal-reminder>...</internal-reminder>` XML tags to wrap
 * generated content so downstream consumers can distinguish it from real user
 * input.
 *
 * Layer 3 uses a `[SYSTEM DIRECTIVE: ZOO - {TYPE}]` header prefix that
 * clearly labels the intent of the injected text.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Layer 3 — Directive prefix
// ---------------------------------------------------------------------------

/**
 * Prefix used for all ZooKeeper system directives.
 *
 * Full format: `[SYSTEM DIRECTIVE: ZOO - {TYPE}]`
 */
export const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: ZOO";

/**
 * Registry of known system directive types.
 *
 * Extend this object as new directive types are introduced.
 */
export const SystemDirectiveTypes = {
  FOCUS_REMINDER: "FOCUS REMINDER",
} as const;

/**
 * Union type for the values of {@link SystemDirectiveTypes}.
 */
export type SystemDirectiveType =
  (typeof SystemDirectiveTypes)[keyof typeof SystemDirectiveTypes];

/**
 * Create a full system directive header string.
 *
 * @param type - The directive type (e.g. `"FOCUS REMINDER"`).
 * @returns Formatted string like `[SYSTEM DIRECTIVE: ZOO - FOCUS REMINDER]`.
 */
export function createSystemDirective(type: SystemDirectiveType): string {
  return `${SYSTEM_DIRECTIVE_PREFIX} - ${type}]`;
}

/**
 * Check whether `text` starts with the ZooKeeper system directive prefix.
 *
 * TODO: Exported for future hooks that should skip system directive
 * messages entirely (e.g. a keyword detector that exits early on
 * internal-generated turns).
 *
 * Leading whitespace is ignored.
 *
 * @param text - Text to inspect.
 * @returns `true` if the text is a recognised system directive.
 */
export function isSystemDirective(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}

// ---------------------------------------------------------------------------
// Layer 2 — XML tag reminders
// ---------------------------------------------------------------------------

/**
 * Regex to detect `<internal-reminder>...</internal-reminder>` blocks.
 *
 * Case-insensitive and **non-global** — safe for repeated `.test()` calls
 * without `lastIndex` state pollution.  A separate global pattern
 * (`INTERNAL_REMINDER_STRIP_PATTERN`) is used for `replace()`.
 */
const INTERNAL_REMINDER_DETECT_PATTERN =
  /<internal-reminder>[\s\S]*?<\/internal-reminder>/i;

/**
 * Global variant used by `removeInternalReminders` for a single `replace()` call.
 */
const INTERNAL_REMINDER_STRIP_PATTERN =
  /<internal-reminder>[\s\S]*?<\/internal-reminder>/gi;

/**
 * Check whether `text` contains an `<internal-reminder>` XML tag block.
 *
 * TODO: Exported for future hooks that must distinguish system-injected
 * content from real user text at the content level (e.g. stripping
 * reminders before keyword detection).
 *
 * @param text - Text to inspect.
 * @returns `true` if an `<internal-reminder>` tag is present.
 */
export function hasInternalReminder(text: string): boolean {
  return INTERNAL_REMINDER_DETECT_PATTERN.test(text);
}

/**
 * Strip all `<internal-reminder>...</internal-reminder>` blocks from `text`,
 * preserving non-reminder content.
 *
 * TODO: Exported for future hooks that need to analyze the user's real
 * input without interference from injected system reminders (e.g. keyword
 * detection, mode switching, intent classification).
 *
 * @param text - Text to clean.
 * @returns Cleaned text with all internal-reminder blocks removed.
 */
export function removeInternalReminders(text: string): string {
  return text.replace(INTERNAL_REMINDER_STRIP_PATTERN, "").trim();
}
