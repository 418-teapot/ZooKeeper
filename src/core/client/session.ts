/**
 * Minimal session client contract shared by context-management units.
 *
 * Consumed by the `/dcp` command handler and the compress/decompress
 * tool adapters.  Declares only the session APIs (`session.messages`,
 * `session.prompt`) used by the context-command flow.  Framework-agnostic
 * by design: hooks and tools type their client parameter against this
 * interface instead of any host SDK type.
 *
 * @module
 */

/**
 * Minimal client interface required by the context-management units.
 *
 * Only the session APIs used by the command handler and tool adapters
 * are declared.
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
      };
    }) => Promise<unknown>;
  };
}
