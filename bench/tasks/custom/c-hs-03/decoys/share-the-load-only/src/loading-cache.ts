// A plausible fix that is wrong: callers at the same time share one load, and nothing else changes. A load
// that set or invalidate overtook still stores its value when it finishes, a caller after invalidate joins the
// load that was started before it, and a failed load is fine only because the slot is cleared in finally.
import { DatakitError } from './errors.ts';

export interface LoadingCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

interface Stored<V> { value: V; at: number }

export class LoadingCache<V> {
  readonly #loader: (key: string) => Promise<V>;
  readonly #ttlMs: number | undefined;
  readonly #now: () => number;
  readonly #values = new Map<string, Stored<V>>();
  readonly #loads = new Map<string, Promise<V>>();

  constructor(loader: (key: string) => Promise<V>, options: LoadingCacheOptions = {}) {
    if (options.ttlMs !== undefined && !(options.ttlMs > 0)) throw new DatakitError('ttlMs must be positive');
    this.#loader = loader;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): Promise<V> {
    const hit = this.#fresh(key);
    if (hit) return Promise.resolve(hit.value);
    const running = this.#loads.get(key);
    if (running) return running;
    const promise = (async () => {
      try {
        const value = await this.#loader(key);
        this.#values.set(key, { value, at: this.#now() });
        return value;
      } finally {
        this.#loads.delete(key);
      }
    })();
    this.#loads.set(key, promise);
    return promise;
  }

  set(key: string, value: V): void {
    this.#values.set(key, { value, at: this.#now() });
  }

  invalidate(key: string): void {
    this.#values.delete(key);
  }

  has(key: string): boolean {
    return this.#fresh(key) !== undefined;
  }

  #fresh(key: string): Stored<V> | undefined {
    const hit = this.#values.get(key);
    if (!hit) return undefined;
    if (this.#ttlMs !== undefined && this.#now() - hit.at >= this.#ttlMs) {
      this.#values.delete(key);
      return undefined;
    }
    return hit;
  }
}
