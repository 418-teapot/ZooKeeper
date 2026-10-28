/**
 * Extension entry point of the end-to-end suite: the real ZooKeeper
 * extension plus the observation probe.
 *
 * pi's extension loader gives every extension *file* its own module graph.
 * ZooKeeper's SDK bridge (`src/adapters/pi/sdk-lifecycle.ts`) is
 * process-level module state, so a probe loaded as a second file would read
 * its own copy of that map and could never observe the association the
 * subagent driver stops.  Importing both from one file keeps the probe
 * inside ZooKeeper's module graph — the suite therefore loads the
 * repository's real `src/pi.ts` without adding any test branch to product
 * code.
 *
 * ZooKeeper is invoked first: its `before_agent_start` handler must run
 * before the probe reads the bridge (handlers run in registration order).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import zookeeperPi from "../../../../../src/pi.js";
import { probe } from "./probe.js";

/**
 * Compose the real extension with the observation probe.
 *
 * @param pi - pi ExtensionAPI instance of the current runtime.
 */
export default async function zkE2E(pi: ExtensionAPI): Promise<void> {
  await zookeeperPi(pi);
  probe(pi);
}
