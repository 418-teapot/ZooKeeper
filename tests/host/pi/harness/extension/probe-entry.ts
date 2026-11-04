/**
 * Probe extension entry of the end-to-end suite.
 *
 * pi loads this file beside the real ZooKeeper entry (`src/pi.ts`), so the
 * probe observes a sub-session runtime that loads ZooKeeper from its inline
 * factory instead of this file.  ZooKeeper is registered first: its
 * `before_agent_start` handler must run before the probe reads the runtime
 * state (handlers run in registration order).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probe } from "./probe.js";

/**
 * Register the observation probe.
 *
 * @param pi - pi ExtensionAPI instance of the current runtime.
 */
export default function probeExtension(pi: ExtensionAPI): void {
  probe(pi);
}
