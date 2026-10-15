/**
 * Synchronous transactional key-value storage, the shape of a SQLite-backed Durable Object's
 * `ctx.storage.kv` plus `transactionSync`. Everything the coordinator decides happens inside one
 * synchronous transaction, so no other event can interleave between a read and the write it
 * justifies.
 */
export interface TxStore {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(prefix: string, limit?: number): Array<[string, T]>;
  transaction<T>(fn: () => T): T;
}

export function durableObjectStore(storage: DurableObjectStorage): TxStore {
  return {
    get: <T>(key: string) => storage.kv.get<T>(key),
    put: <T>(key: string, value: T) => storage.kv.put<T>(key, value),
    delete: (key: string) => storage.kv.delete(key),
    list: <T>(prefix: string, limit?: number) => {
      const out: Array<[string, T]> = [];
      for (const entry of storage.kv.list<T>({ prefix, ...(limit === undefined ? {} : { limit }) })) out.push(entry);
      return out;
    },
    transaction: <T>(fn: () => T) => storage.transactionSync(fn),
  };
}

/** In-memory store with real rollback semantics, for tests. Values are cloned like DO storage. */
export class MemoryStore implements TxStore {
  private data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  put<T>(key: string, value: T): void {
    this.data.set(key, structuredClone(value));
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  list<T>(prefix: string, limit = Number.MAX_SAFE_INTEGER): Array<[string, T]> {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((k) => [k, structuredClone(this.data.get(k)) as T]);
  }

  transaction<T>(fn: () => T): T {
    const snapshot = new Map(this.data);
    try {
      return fn();
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }
}
