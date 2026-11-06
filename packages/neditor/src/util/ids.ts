/**
 * Numbers for DOM ids, unique across every copy of this package on the page.
 *
 * A module-level counter is per copy, so a page that loads two bundles -- a
 * widget beside the host application's own copy, two micro-frontends -- gave
 * both editors `neditor-1-…` and `neditor-link-error-1`, and each editor's
 * `aria-labelledby` / `aria-describedby` could resolve into the other one.
 * The counters live on `globalThis` under a registered symbol, which every copy
 * in the realm shares.
 */
const KEY = Symbol.for('@neditor/core/id-counters');

export function nextId(kind: string): number {
  const store = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const counters = (store[KEY] ??= new Map<string, number>());
  const next = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, next);

  return next;
}
