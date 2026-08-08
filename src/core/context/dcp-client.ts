/**
 * Minimal session client contract shared by the `/dcp` command handler
 * and the compress/decompress tool adapters.
 *
 * Declares only the session APIs (`session.messages`, `session.prompt`)
 * used by the context-command flow.  Framework-agnostic by design: both
 * hooks and tools type their client parameter against this interface
 * instead of any host SDK type.
 *
 * @module
 */

/**
 * Minimal client interface required for the `/dcp` command handler.
 *
 * Only the APIs used by `handleDcpCommand` are declared.
 */
export interface DcpClient {
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
