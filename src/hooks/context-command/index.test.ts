/**
 * Tests for the `/dcp context` command hook adapter.
 *
 * Covers: fetching messages, injecting ignored prompt, throwing sentinel,
 * unknown subcommand help, empty messages, unavailable client APIs.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../../core/metrics.js";
import { _resetForTesting } from "../../utils/logger.js";
import {
  DCP_COMMAND_HANDLED,
  type DcpClient,
  handleDcpCommand,
} from "./index.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock client that returns given messages and tracks prompt calls.
 */
function mockClient(messages: ContextMessageEntry[]): {
  client: DcpClient;
  promptCalls: Array<{
    sessionID: string;
    text: string;
    noReply?: boolean;
    ignored?: boolean;
  }>;
} {
  const promptCalls: Array<{
    sessionID: string;
    text: string;
    noReply?: boolean;
    ignored?: boolean;
  }> = [];

  const client: DcpClient = {
    session: {
      messages: async () => ({ data: messages }),
      prompt: async (input: {
        path: { id: string };
        body: {
          noReply?: boolean;
          parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
        };
      }) => {
        promptCalls.push({
          sessionID: input.path.id,
          text: input.body.parts[0]?.text ?? "",
          noReply: input.body.noReply,
          ignored: input.body.parts[0]?.ignored,
        });
      },
    },
  };

  return { client, promptCalls };
}

/**
 * Assert that the prompt call includes expected keywords.
 */
function assertPromptContains(
  promptCalls: Array<{ text: string }>,
  keyword: string,
  message?: string,
): void {
  assert.ok(promptCalls.length > 0, "expected at least one prompt call");
  assert.ok(
    promptCalls[0].text.includes(keyword),
    message ?? `expected prompt to contain "${keyword}"`,
  );
}

/**
 * Format assertion helper: check that "user" label appears in prompt.
 */
function assertPromptHasCategory(
  promptCalls: Array<{ text: string }>,
  label: string,
): void {
  assertPromptContains(promptCalls, label);
}

// ---------------------------------------------------------------------------
// Normal flow: context subcommand
// ---------------------------------------------------------------------------

describe("/dcp context subcommand", () => {
  it("fetches messages and injects ignored prompt", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
      {
        info: {
          role: "assistant",
          id: "m2",
          tokens: { input: 100, output: 50 },
        },
        parts: [{ type: "text", text: "Hello" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-1", "context");

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].sessionID, "sess-1");
    assert.equal(promptCalls[0].noReply, true);
    assert.equal(promptCalls[0].ignored, true);
    assertPromptContains(promptCalls, "上下文报告");
    assertPromptContains(promptCalls, "tokens");
  });

  it("handles empty args (default to context)", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-2", "");

    assert.equal(promptCalls.length, 1);
    assertPromptContains(promptCalls, "上下文报告");
  });

  it("includes cache hit rate when available", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
      {
        info: {
          role: "assistant",
          id: "m2",
          tokens: {
            input: 500,
            output: 100,
            cache: { read: 200, write: 50 },
          },
        },
        parts: [{ type: "text", text: "Response" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-3", "context");

    assertPromptContains(promptCalls, "26.7%");
  });

  it("includes category breakdown", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        info: {
          role: "assistant",
          id: "m2",
          tokens: { input: 500, output: 100 },
        },
        parts: [{ type: "text", text: "World" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-4", "context");

    assertPromptHasCategory(promptCalls, "user");
    assertPromptHasCategory(promptCalls, "asst");
    assertPromptHasCategory(promptCalls, "sys");
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe("unknown subcommand", () => {
  it("injects help text instead of context report", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-5", "foobar");

    assert.equal(promptCalls.length, 1);
    assertPromptContains(promptCalls, "用法");
    assertPromptContains(promptCalls, "/dcp context");
    // Should NOT contain context report keywords
    assert.equal(
      promptCalls[0].text.includes("上下文报告"),
      false,
      "help text should not include context report",
    );
  });
});

// ---------------------------------------------------------------------------
// Empty messages
// ---------------------------------------------------------------------------

describe("empty messages", () => {
  it("handles empty array gracefully", async () => {
    const { client, promptCalls } = mockClient([]);

    await handleDcpCommand(client, "sess-6", "context");

    assert.equal(promptCalls.length, 1);
    assertPromptContains(promptCalls, "0 tokens");
    assertPromptContains(promptCalls, "0 条");
  });
});

// ---------------------------------------------------------------------------
// Client with missing APIs
// ---------------------------------------------------------------------------

describe("missing client APIs", () => {
  it("throws when client is null", async () => {
    await assert.rejects(
      () => handleDcpCommand(null, "sess-7", "context"),
      /无法获取/,
    );
  });

  it("throws when client is undefined", async () => {
    await assert.rejects(
      () => handleDcpCommand(undefined, "sess-8", "context"),
      /无法获取/,
    );
  });

  it("throws when session.messages is unavailable", async () => {
    const client: DcpClient = {}; // no session at all
    await assert.rejects(
      () => handleDcpCommand(client, "sess-9", "context"),
      /无法获取/,
    );
  });

  it("throws when response contains error object (HTTP error)", async () => {
    const client: DcpClient = {
      session: {
        messages: async () => ({
          data: undefined,
          error: { message: "rate limit exceeded" },
        }),
      },
    };
    await assert.rejects(
      () => handleDcpCommand(client, "sess-10", "context"),
      /rate limit exceeded/,
    );
  });
});

// ---------------------------------------------------------------------------
// Sentinel export
// ---------------------------------------------------------------------------

describe("DCP_COMMAND_HANDLED sentinel", () => {
  it("is an Error instance", () => {
    assert.ok(DCP_COMMAND_HANDLED instanceof Error);
  });

  it("has descriptive message", () => {
    assert.ok(DCP_COMMAND_HANDLED.message.includes("/dcp command handled"));
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports handleDcpCommand as a function", () => {
    assert.equal(typeof handleDcpCommand, "function");
  });

  it("exports DCP_COMMAND_HANDLED as an Error", () => {
    assert.ok(DCP_COMMAND_HANDLED instanceof Error);
  });
});
