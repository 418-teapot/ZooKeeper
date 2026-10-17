/**
 * Validation capability port.
 *
 * Pure types: the word-count limits parsed from `[zoo.validation]`, which
 * the subagent-prompt unit injects into its prompt-format judgment.  The
 * file imports types only — never an implementation.
 *
 * @module
 */

import type { ValidationLimits } from "../validate.js";

/** The validation-limits capability. */
export interface ValidationPort {
  /** Word-count limits from `[zoo.validation]`. */
  limits: ValidationLimits;
}
