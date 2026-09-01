/** Minimal typed event emitter. Keeps the package dependency-free. */
export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  /** Where a listener's exception goes, so it cannot abort the edit. */
  #onError: (error: unknown) => void = (error) => {
    // eslint-disable-next-line no-console
    console.error('[neditor] listener threw', error);
  };

  setErrorHandler(handler: (error: unknown) => void): void {
    this.#onError = handler;
  }

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.#listeners.get(event);

    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }

    set.add(listener as (payload: never) => void);

    return () => {
      this.off(event, listener);
    };
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    this.#listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);

    if (!set) {
      return;
    }

    for (const listener of [...set]) {
      // One listener throwing must not skip the others, nor unwind into the
      // edit that emitted — a throwing onChange would otherwise leave the
      // document half-updated.
      try {
        (listener as (value: Events[K]) => void)(payload);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
