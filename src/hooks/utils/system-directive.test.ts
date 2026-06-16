/**
 * Tests for the system-directive utilities.
 *
 * Covers: system directive creation and detection, internal-reminder XML tag
 * detection and stripping.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSystemDirective,
  hasInternalReminder,
  isSystemDirective,
  removeInternalReminders,
  SYSTEM_DIRECTIVE_PREFIX,
  SystemDirectiveTypes,
} from "./system-directive.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("SYSTEM_DIRECTIVE_PREFIX matches the expected value", () => {
    assert.equal(SYSTEM_DIRECTIVE_PREFIX, "[SYSTEM DIRECTIVE: ZOO");
  });

  it("SystemDirectiveTypes contains FOCUS_REMINDER", () => {
    assert.equal(SystemDirectiveTypes.FOCUS_REMINDER, "FOCUS REMINDER");
  });
});

// ---------------------------------------------------------------------------
// createSystemDirective / isSystemDirective
// ---------------------------------------------------------------------------

describe("createSystemDirective", () => {
  it("returns correctly formatted directive for FOCUS_REMINDER", () => {
    const result = createSystemDirective(SystemDirectiveTypes.FOCUS_REMINDER);
    assert.equal(result, "[SYSTEM DIRECTIVE: ZOO - FOCUS REMINDER]");
  });

  it("is type-narrowed — only SystemDirectiveType values accepted", () => {
    // Verify the function is constrained: passing arbitrary strings is a
    // compile-time error.  We use a typed constant to prove the constraint.
    const validType = "FOCUS REMINDER" as const;
    const result = createSystemDirective(validType);
    assert.equal(result, "[SYSTEM DIRECTIVE: ZOO - FOCUS REMINDER]");
  });
});

describe("isSystemDirective", () => {
  it("returns true for a valid system directive", () => {
    const directive = createSystemDirective(
      SystemDirectiveTypes.FOCUS_REMINDER,
    );
    assert.ok(isSystemDirective(directive));
  });

  it("returns false for a normal user message", () => {
    assert.equal(isSystemDirective("Just a normal message"), false);
  });

  it("handles leading whitespace", () => {
    const directive = `  ${createSystemDirective(SystemDirectiveTypes.FOCUS_REMINDER)}`;
    assert.ok(isSystemDirective(directive));
  });

  it("returns false for system-reminder XML tags (different mechanism)", () => {
    const text = "<internal-reminder>content</internal-reminder>";
    assert.equal(isSystemDirective(text), false);
  });

  it("returns false for unrelated text beginning with bracket", () => {
    assert.equal(isSystemDirective("[NOT A DIRECTIVE]"), false);
  });
});

// ---------------------------------------------------------------------------
// hasInternalReminder
// ---------------------------------------------------------------------------

describe("hasInternalReminder", () => {
  it("returns true for text containing <internal-reminder> tags", () => {
    const text = `<internal-reminder>
Some internal content
</internal-reminder>`;
    assert.ok(hasInternalReminder(text));
  });

  it("returns false for text without internal-reminder tags", () => {
    assert.equal(hasInternalReminder("Just a normal user message"), false);
  });

  it("is case-insensitive for tag names", () => {
    const text = `<INTERNAL-REMINDER>content</INTERNAL-REMINDER>`;
    assert.ok(hasInternalReminder(text));
  });

  it("detects internal-reminder in mixed content", () => {
    const text = `User text here
<internal-reminder>
System content
</internal-reminder>
More user text`;
    assert.ok(hasInternalReminder(text));
  });

  it("handles empty internal-reminder tags", () => {
    const text = `<internal-reminder></internal-reminder>`;
    assert.ok(hasInternalReminder(text));
  });

  it("handles multiline internal-reminder content", () => {
    const text = `<internal-reminder>
Line 1
Line 2
Line 3
</internal-reminder>`;
    assert.ok(hasInternalReminder(text));
  });
});

// ---------------------------------------------------------------------------
// removeInternalReminders
// ---------------------------------------------------------------------------

describe("removeInternalReminders", () => {
  it("removes internal-reminder tags and content", () => {
    const text = `<internal-reminder>
Content to remove
</internal-reminder>`;
    assert.equal(removeInternalReminders(text), "");
  });

  it("preserves user text outside internal-reminder tags", () => {
    const text = `User message here
<internal-reminder>
Internal content to remove
</internal-reminder>
More user text`;
    const result = removeInternalReminders(text);
    assert.ok(result.includes("User message here"));
    assert.ok(result.includes("More user text"));
    assert.equal(result.includes("Internal content to remove"), false);
  });

  it("removes multiple internal-reminder blocks", () => {
    const text = `<internal-reminder>First block</internal-reminder>
User text
<internal-reminder>Second block</internal-reminder>`;
    const result = removeInternalReminders(text);
    assert.ok(result.includes("User text"));
    assert.equal(result.includes("First block"), false);
    assert.equal(result.includes("Second block"), false);
  });

  it("is case-insensitive for tag names", () => {
    const text = `<INTERNAL-REMINDER>Content</INTERNAL-REMINDER>`;
    assert.equal(removeInternalReminders(text), "");
  });

  it("trims whitespace from the result", () => {
    const text = `
<internal-reminder>Remove this</internal-reminder>

User text

`;
    const result = removeInternalReminders(text);
    assert.equal(result, "User text");
  });

  it("handles empty string input", () => {
    assert.equal(removeInternalReminders(""), "");
  });

  it("returns original text when no internal-reminder tags exist", () => {
    const text = "Just normal user text without any reminders";
    assert.equal(removeInternalReminders(text), text);
  });

  it("preserves code blocks in user text while removing reminders", () => {
    const text = `Here's some code:
\`\`\`javascript
const x = 1;
\`\`\`
<internal-reminder>Internal info</internal-reminder>`;
    const result = removeInternalReminders(text);
    assert.ok(result.includes("Here's some code:"));
    assert.ok(result.includes("```javascript"));
    assert.equal(result.includes("Internal info"), false);
  });
});
