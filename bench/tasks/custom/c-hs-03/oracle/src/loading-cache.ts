import { DatakitError } from './errors.ts';

export interface LoadingCacheOptions {
  /** How long a stored value stays fresh, in milliseconds. Left out: until it is invalidated. */
  ttlMs?: number;
  /** The clock, for tests. Default `Date.now`. */
  now?: () => number;
}

interface Stored<V> { value: V; at: number }
/** A load that is running. It is the key's current load only while it is the entry in the map. */
interface Load<V> { promise?: Promise<V> }

/** A cache that fills itself: `get` returns the stored value, or calls the loader and stores what it returns. */
export class LoadingCache<V> {
  readonly #loader: (key: string) => Promise<V>;
  readonly #ttlMs: number | undefined;
  readonly #now: () => number;
  readonly #values = new Map<string, Stored<V>>();
  readonly #loads = new Map<string, Load<V>>();

  constructor(loader: (key: string) => Promise<V>, options: LoadingCacheOptions = {}) {
    if (options.ttlMs !== undefined && !(options.ttlMs > 0)) throw new DatakitError('ttlMs must be positive');
    this.#loader = loader;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The stored value when it is fresh; otherwise the value of the key's current load, started here when none
   * is running. A load that `set` or `invalidate` overtook still answers the callers that were waiting for it,
   * but it is no longer the key's load: its value is not stored, and later callers do not join it.
   */
  get(key: string): Promise<V> {
    const hit = this.#fresh(key);
    if (hit) return Promise.resolve(hit.value);
    const running = this.#loads.get(key);
    if (running?.promise) return running.promise;
    const load: Load<V> = {};
    this.#loads.set(key, load);
    load.promise = this.#run(key, load);
    return load.promise;
  }

  async #run(key: string, load: Load<V>): Promise<V> {
    try {
      const value = await this.#loader(key);
      if (this.#loads.get(key) === load) this.#values.set(key, { value, at: this.#now() });
      return value;
    } finally {
      // only the key's current load clears the slot: an overtaken one must not remove its successor
      if (this.#loads.get(key) === load) this.#loads.delete(key);
    }
  }

  /** Stores a value directly. A load that is running for the key no longer counts. */
  set(key: string, value: V): void {
    this.#loads.delete(key);
    this.#values.set(key, { value, at: this.#now() });
  }

  /** Forgets the key: the next `get` loads again. A load that is running for the key no longer counts. */
  invalidate(key: string): void {
    this.#loads.delete(key);
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
