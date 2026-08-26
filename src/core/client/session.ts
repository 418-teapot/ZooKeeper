/**
 * Minimal session client contract shared by context-management units.
 *
 * Consumed by the `/dcp` command handler, the compress/decompress tool
 * adapters, and the v1 tool host.  Declares only the session APIs
 * (`session.messages`, `session.prompt`, `session.get`) used by the
 * context-command flow.  Framework-agnostic by design: hooks and tools
 * type their client parameter against this interface instead of any
 * host SDK type.
 *
 * @module
 */

/**
 * Minimal client interface required by the context-management units.
 *
 * Only the session APIs used by the command handler and tool adapters
 * are declared.  `session.prompt` carries the optional `agent` field so
 * a notification can address the session agent explicitly (without it
 * OpenCode switches the session to the default agent); `session.get` is
 * the per-call fallback used to resolve an unknown session agent.
 */
export interface SessionClient {
  session?: {
    messages?: (input: {
      path: { id: string };
    }) => Promise<{ data?: unknown } | unknown[]>;
    prompt?: (input: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
        agent?: string;
      };
    }) => Promise<unknown>;
    get?: (input: {
      path: { id: string };
    }) => Promise<{ agent?: string } | undefined>;
  };
}
