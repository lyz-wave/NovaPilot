/**
 * SQLite client wrapper around Node's built-in `node:sqlite` (Node >= 22.5).
 * Zero native dependencies — works on the local machine as-is.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

// Load the `node:sqlite` builtin through createRequire so bundlers (Vite/
// Next/Turbopack) don't try to statically resolve it — some toolchains strip
// the `node:` prefix and fail on a bare `sqlite` specifier.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export type NovaDb = InstanceType<typeof DatabaseSync>;

/** Apply the (idempotent) schema and stamp the schema version. */
export function migrate(db: NovaDb): void {
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(SCHEMA_VERSION);
}

/**
 * Create a fresh, migrated database at `path`.
 * Pass ":memory:" for tests. A file path has its parent directory created.
 */
export function createDb(path: string): NovaDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}

let singleton: NovaDb | null = null;

/** Lazily-opened process-wide database used by the running app. */
export function getDb(): NovaDb {
  if (singleton) return singleton;
  const path = process.env.NOVAPILOT_DB_PATH ?? resolve(process.cwd(), ".data/novapilot.db");
  singleton = createDb(path);
  return singleton;
}

/** For tests: reset the process singleton (does not delete files). */
export function __resetDbSingleton(): void {
  singleton?.close();
  singleton = null;
}

/**
 * Typed query helpers. node:sqlite returns `Record<string, SQLOutputValue>`,
 * which does not structurally overlap our row interfaces, so the cast has to go
 * through `unknown`. Centralising it here keeps call sites clean and honest
 * about the fact that column names/types are asserted by the caller's SQL.
 */
type Param = string | number | bigint | null | Uint8Array;

export function queryAll<T>(db: NovaDb, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(db: NovaDb, sql: string, ...params: Param[]): T | null {
  const row = db.prepare(sql).get(...params) as unknown as T | undefined;
  return row ?? null;
}
