/**
 * Writable-region protocol — the lens write side shared by the host
 * adapters.
 *
 * The lens contract (`TextRegion`) is read-only; a host adapter binds a
 * region to its own message structure and supplies the write-back
 * closure, which is the only host-specific part of a region.  Everything
 * built on top of that protocol is host-agnostic and lives here: the
 * provenance side table recording each region's derivation, the
 * injectability predicate, the placement rule that picks a line-ref
 * target, and the prefix write itself.
 *
 * Line-ref injection is the render layer's only region write: the
 * per-round `[mN] ` prefix is prepended to exactly one injectable region
 * per visible fold unit, so the address space the model reads stays
 * dense and a host-authored summary is never rewritten.
 *
 * @module
 */

import type { HostMessage, TextRegion } from "./lens.js";
import { refPrefix } from "./view-refs.js";

/**
 * Derivation source of a lens region, recorded at construction.
 *
 * Injection targets are text-derived `content` regions and `tool-output`
 * regions.  Every other derivation — image-derived content, thinking
 * traces, tool inputs, host-authored summary text, and the
 * estimation-only text a host maps for counting — stays read-only, so a
 * line ref can never corrupt a block the host itself authored.  The
 * union covers the derivations the two host adapters record.
 */
export type RegionProvenance =
  | "text"
  | "image"
  | "thinking"
  | "summary"
  | "reasoning"
  | "tool"
  | "other";

/**
 * A lens region whose text a host adapter may rewrite in place.
 *
 * The adapter's write-back closure targets its own message structure, so
 * callers address the region through `set` without unpacking the host
 * shape.
 */
export interface WritableRegion extends TextRegion {
  /** Rewrite the region's text in place. */
  set(text: string): void;
}

/**
 * Side table recording each region's provenance.
 *
 * Kept out of the `TextRegion` interface — the lens contract stays
 * `{ kind, get }`.
 */
const regionProvenance = new WeakMap<TextRegion, RegionProvenance>();

/**
 * Record how a region was derived from its host message.
 *
 * Called by a host adapter at region construction; a region that is
 * never registered counts as read-only.
 *
 * @param region - The region to register.
 * @param provenance - The derivation source.
 */
export function recordRegionProvenance(
  region: TextRegion,
  provenance: RegionProvenance,
): void {
  regionProvenance.set(region, provenance);
}

/**
 * Report whether a lens region may receive the line-number prefix.
 *
 * Only text-derived `content` regions and `tool-output` regions are
 * injection targets.  Image-derived content, thinking traces, tool
 * inputs, host-authored summary text and regions no adapter registered
 * are never rewritten with line refs.
 *
 * @param region - The region to test.
 * @returns True when the region is a ref-injection target.
 */
export function isInjectableRegion(region: TextRegion): boolean {
  if (!region) return false;
  const provenance = regionProvenance.get(region);
  if (provenance === "text") return region.kind === "content";
  if (provenance === "tool") return region.kind === "tool-output";
  return false;
}

/**
 * Pick the region that receives the line-number prefix for a message.
 *
 * Tool-output regions win over text-derived content regions — the
 * placement keeps the prefix next to the message's bulk content rather
 * than inside a preamble — and only regions `isInjectableRegion` marks
 * qualify, so a content region derived from an estimation-only part is
 * skipped in favor of a later text-derived one.
 *
 * @param msg - The lens message receiving the prefix.
 * @returns The injection target, or undefined when no region qualifies.
 */
export function pickInjectableRegion(
  msg: HostMessage,
): WritableRegion | undefined {
  for (const region of msg.regions) {
    if (region.kind === "tool-output" && isInjectableRegion(region)) {
      return region as WritableRegion;
    }
  }
  for (const region of msg.regions) {
    if (region.kind === "content" && isInjectableRegion(region)) {
      return region as WritableRegion;
    }
  }
  return undefined;
}

/**
 * Write the current round's line-number prefix into a message's
 * injection region.
 *
 * Pure prepend: `refPrefix(line)` is placed before the region text as it
 * stands, with no marker stripping.  The input carries no prior-round
 * markers — hosts deliver a fresh per-turn message array, so the render
 * output is never seen as input again.  A message without an injectable
 * region keeps its text unchanged.
 *
 * @param msg - The lens message backing the view item.
 * @param line - The dense line number of the item.
 * @returns True when the prefix was injected, false when the message
 *   carries no injectable region.
 */
export function injectLinePrefix(msg: HostMessage, line: number): boolean {
  const region = pickInjectableRegion(msg);
  if (region === undefined) return false;
  region.set(refPrefix(line) + region.get());
  return true;
}
