// A plausible fix that is wrong: a per-key version stops an overtaken load from storing its value, and set and
// invalidate clear the slot of the running load, so a later caller starts a new one. But every load clears the
// slot when it finishes, whoever holds it: the overtaken load removes the slot of the load that came after it,
// and the next callers start a third load beside the one still running.
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
  readonly #versions = new Map<string, number>();

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
    const version = this.#versions.get(key) ?? 0;
    const promise = (async () => {
      try {
        const value = await this.#loader(key);
        if ((this.#versions.get(key) ?? 0) === version) this.#values.set(key, { value, at: this.#now() });
        return value;
      } finally {
        this.#loads.delete(key);
      }
    })();
    this.#loads.set(key, promise);
    return promise;
  }

  set(key: string, value: V): void {
    this.#versions.set(key, (this.#versions.get(key) ?? 0) + 1);
    this.#loads.delete(key);
    this.#values.set(key, { value, at: this.#now() });
  }

  invalidate(key: string): void {
    this.#versions.set(key, (this.#versions.get(key) ?? 0) + 1);
    this.#loads.delete(key);
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
