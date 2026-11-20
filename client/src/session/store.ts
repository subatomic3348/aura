import { useSyncExternalStore } from 'react';

/** Observable state holder for controllers; React reads it via useSyncExternalStore. */
export class Store<S> {
  private listeners = new Set<() => void>();
  constructor(protected state: S) {}

  getState = (): S => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /**
   * Page lifetime. `release()` disposes on the next tick unless `retain()` is
   * called again first — React StrictMode (dev) unmounts and remounts every
   * component once, which must not tear down a live session or an open picker.
   */
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;

  retain(): void {
    clearTimeout(this.releaseTimer);
  }

  release(): void {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.dispose(), 0);
  }

  /** Free all resources. Overridden by controllers. */
  dispose(): void {}

  protected set(next: S): void {
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((fn) => fn());
  }
}

export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState);
}
