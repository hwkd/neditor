/**
 * Block identity.
 *
 * Every block carries a stable id that survives moves, edits and
 * collaborative merges. We mirror that: ids are opaque, generated once, and
 * never derived from position or content.
 */

/** Generates an opaque, collision-resistant block id. */
export function createBlockId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  // Fallback for older browsers and non-secure contexts.
  return `b-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
