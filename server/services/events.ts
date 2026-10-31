import type { RunEvent } from '../../shared/types';

type Listener = (e: RunEvent) => void;

/**
 * In-process pub/sub for run events — the "bridge" between the engine and connected browsers
 * (exposed as Server-Sent Events). Replace with Redis pub/sub when running several API instances.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, fn: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  publish(e: RunEvent) {
    for (const fn of this.listeners.get(e.runId) ?? []) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not break the engine */
      }
    }
  }
}
