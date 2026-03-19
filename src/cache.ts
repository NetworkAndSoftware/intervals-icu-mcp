import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "cache.db");

export class Cache {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        ttl INTEGER NOT NULL
      )
    `);
  }

  get<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value, fetched_at, ttl FROM cache WHERE key = ?")
      .get(key) as { value: string; fetched_at: number; ttl: number } | undefined;

    if (!row) return null;

    // ttl of 0 means never expires
    if (row.ttl > 0) {
      const age = Math.floor(Date.now() / 1000) - row.fetched_at;
      if (age > row.ttl) {
        this.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
        return null;
      }
    }

    return JSON.parse(row.value) as T;
  }

  set(key: string, value: unknown, ttl: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cache (key, value, fetched_at, ttl) VALUES (?, ?, ?, ?)"
      )
      .run(key, JSON.stringify(value), Math.floor(Date.now() / 1000), ttl);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
  }

  clear(): void {
    this.db.exec("DELETE FROM cache");
  }

  close(): void {
    this.db.close();
  }
}

// TTL constants in seconds
export const TTL = {
  NEVER: 0,
  ONE_HOUR: 3600,
  FOUR_HOURS: 14400,
  ONE_DAY: 86400,
} as const;
