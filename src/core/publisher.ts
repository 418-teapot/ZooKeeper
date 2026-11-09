/**
 * Host start publisher protocol: prepare, then publish.
 *
 * Every host start has the same two phases.  `prepare` runs the whole
 * fallible computation — activating the extension, composing the profile,
 * building the handlers and the registration descriptors — and touches no
 * host surface.  `publish` performs the host writes the prepared value
 * describes.
 *
 * The split is what makes a pre-flight failure safe: a host registers
 * through calls it cannot undo, so a failure raised after the first write
 * leaves the host half wired.  A prepared start is therefore complete (and
 * free of host calls) before `publish` runs its first write.  A `publish`
 * failure still propagates: it is not swallowed, and it stops the writes
 * that follow.
 *
 * The protocol is host-agnostic: the prepared value and the publication are
 * the host's own types, so a host keeps whatever values later phases need
 * (its event handlers, its close handle) in them.
 *
 * @module
 */

/** The start of one host instance: a prepared value, then its publication. */
export interface Publisher<Prepared, Publication> {
  /**
   * Run every fallible start step.
   *
   * @returns The prepared start.
   */
  prepare(): Promise<Prepared>;
  /**
   * Perform the host writes the prepared start describes.
   *
   * @param prepared - The value `prepare` returned.
   * @returns The publication, holding the host values later phases read.
   */
  publish(prepared: Prepared): Publication | Promise<Publication>;
}

/**
 * Run one host start: prepare, then publish.
 *
 * @param publisher - The host's start publisher.
 * @returns The publication.
 */
export async function runPublisher<Prepared, Publication>(
  publisher: Publisher<Prepared, Publication>,
): Promise<Publication> {
  const prepared = await publisher.prepare();
  return await publisher.publish(prepared);
}
