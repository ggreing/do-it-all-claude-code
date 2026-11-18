import { DatakitError } from './errors.ts';

export interface LoadingCacheOptions {
  /** How long a stored value stays fresh, in milliseconds. Left out: until it is invalidated. */
  ttlMs?: number;
  /** The clock, for tests. Default `Date.now`. */
  now?: () => number;
}

interface Stored<V> { value: V; at: number }

/** A cache that fills itself: `get` returns the stored value, or calls the loader and stores what it returns. */
export class LoadingCache<V> {
  readonly #loader: (key: string) => Promise<V>;
  readonly #ttlMs: number | undefined;
  readonly #now: () => number;
  readonly #values = new Map<string, Stored<V>>();

  constructor(loader: (key: string) => Promise<V>, options: LoadingCacheOptions = {}) {
    if (options.ttlMs !== undefined && !(options.ttlMs > 0)) throw new DatakitError('ttlMs must be positive');
    this.#loader = loader;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  /** The stored value when it is fresh; otherwise the loader's value, which is stored. */
  async get(key: string): Promise<V> {
    const hit = this.#fresh(key);
    if (hit) return hit.value;
    const value = await this.#loader(key);
    this.#values.set(key, { value, at: this.#now() });
    return value;
  }

  /** Stores a value directly. */
  set(key: string, value: V): void {
    this.#values.set(key, { value, at: this.#now() });
  }

  /** Forgets the key: the next `get` loads again. */
  invalidate(key: string): void {
    this.#values.delete(key);
  }

  /** Whether a fresh value is stored for the key. */
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
