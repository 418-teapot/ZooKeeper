/**
 * Capability catalog.
 *
 * `Capabilities` is the union of every capability port a unit may declare
 * in its `needs` / `wants` lists.  It is an assembly-root type: unit
 * factories never receive the whole thing, only the slice they declared,
 * and `composeProfile` decides which units receive one at all.
 *
 * Convention: ports carry BEHAVIOR (functions and method objects), never
 * lazily-produced data.  A capability whose production is timing-
 * constrained (e.g. a host action method forbidden during extension
 * load) is modelled as a thunk the unit calls when it needs the value,
 * so plain property copies in the matcher can never trigger side
 * effects.  Parsed config values are the one exception — reading the
 * config file is always load-time work.
 *
 * @module
 */

import type { AgentPort } from "./agent.js";
import type { AskPort } from "./ask.js";
import type { AutoDebugPort } from "./autodebug.js";
import type { ContextPort } from "./context.js";
import type { ContinuationPort } from "./continuation.js";
import type { FetchPort } from "./fetch.js";
import type { HandoffPort } from "./handoff.js";
import type { SessionPort } from "./session.js";
import type { SubagentPort } from "./subagent.js";
import type { SwitchPort } from "./switch.js";
import type { TodoPort } from "./todo.js";
import type { ToolHostPort } from "./tool-host.js";
import type { ValidationPort } from "./validation.js";

export type { AgentPort } from "./agent.js";
export type { AskPort } from "./ask.js";
export type {
  AutoDebugDirEntry,
  AutoDebugFs,
  AutoDebugPort,
  ZdebugExec,
  ZdebugExecResult,
} from "./autodebug.js";
export type { ContextPort } from "./context.js";
export type { ContinuationPort } from "./continuation.js";
export type { FetchPort } from "./fetch.js";
export type { HandoffPort, MessageInjector } from "./handoff.js";
export type { SessionPort } from "./session.js";
export type {
  SubagentPort,
  ToolCardRenderer,
} from "./subagent.js";
export type { SwitchHost, SwitchNewSessionOps, SwitchPort } from "./switch.js";
export type { TodoPort } from "./todo.js";
export type { ToolHostPort } from "./tool-host.js";
export type { ValidationPort } from "./validation.js";

/**
 * Every capability a unit may declare.
 *
 * Fields are required on the catalog itself, with one deliberate
 * exception: `SubagentPort.subagentBaseline` is optional because its
 * production is timing-constrained (see the port file).  The assembly
 * root passes a `Partial<Capabilities>` and `composeProfile` only hands
 * a unit the keys it declared in `needs` / `wants`.  A field listed in
 * `needs` is present and non-optional inside the factory; a `wants`
 * field may be absent.
 */
export interface Capabilities
  extends ValidationPort,
    ContextPort,
    ContinuationPort,
    AutoDebugPort,
    AgentPort,
    SubagentPort,
    TodoPort,
    FetchPort,
    AskPort,
    SwitchPort,
    HandoffPort,
    SessionPort,
    ToolHostPort {}
