/**
 * Config → capability projection.
 *
 * The parsed configuration reaches the capability catalog through one
 * projection: a config-derived capability key exists here only when the
 * parser produces it.  Both host entry points call the same projection and
 * then add their own host ports, so the two hosts can never drift in which
 * sections they honour.
 *
 * @module
 */

import type { ConfigSnapshot } from "./config-snapshot.js";
import type { Capabilities } from "./ports/index.js";

/**
 * Project the parsed config onto the capability catalog.
 *
 * Only the config-derived keys are produced; the host adds its own ports.
 * The snapshot is consumed as it is: the generated capability values are
 * the scope's own, so one configuration generation yields one projection.
 *
 * @param common - The parsed common config snapshot.
 * @returns The config-derived capability slice.
 */
export function configCapabilities(
  common: ConfigSnapshot,
): Partial<Capabilities> {
  return {
    limits: common.limits,
    contextConfig: common.contextConfig,
    continuationConfig: common.continuationConfig,
    autoDebugConfig: common.autoDebugConfig,
    agentModes: common.agentModes,
    agentPermissions: common.agentPermissions,
  };
}
