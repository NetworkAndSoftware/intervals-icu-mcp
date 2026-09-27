export interface Cache {
  get<T>(key: string): T | null;
  set(key: string, value: unknown, ttl: number): void;
  clear(): void;
}

// TTL constants in seconds
export const TTL = {
  NEVER: 0,
  ONE_HOUR: 3600,
  FOUR_HOURS: 14400,
  ONE_DAY: 86400,
} as const;

// Used where the SQLite cache can't run (Lambda: no native module, ephemeral disk).
// Values are stored serialized so callers can't mutate cached data, same as SQLite.
export class MemoryCache implements Cache {
  private entries = new Map<string, { value: string; fetchedAt: number; ttl: number }>();

  constructor(private maxEntries = 500) {}

  get<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    // ttl of 0 means never expires
    if (entry.ttl > 0 && Math.floor(Date.now() / 1000) - entry.fetchedAt > entry.ttl) {
      this.entries.delete(key);
      return null;
    }

    return JSON.parse(entry.value) as T;
  }

  set(key: string, value: unknown, ttl: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value: JSON.stringify(value), fetchedAt: Math.floor(Date.now() / 1000), ttl });
    // Map iterates in insertion order, so the first key is the oldest write
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
