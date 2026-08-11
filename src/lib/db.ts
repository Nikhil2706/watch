import "server-only";

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { env } from "./env";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/**
 * `node:sqlite` is used instead of better-sqlite3 deliberately: it is a Node
 * built-in, so a Windows host needs no Visual Studio C++ build tools to install
 * this app. Requires Node >= 22.13, where the API is available unflagged.
 *
 * Every call is synchronous. That is a feature here, not a limitation — it is
 * what makes the invite claim below genuinely atomic without any locking of our
 * own, and on a single-writer app on a local disk the calls are microseconds.
 */

declare global {
  // Next's dev server re-evaluates modules on every hot reload. Without pinning
  // the handle to globalThis we would leak a new file handle per reload and
  // eventually hit "database is locked".
  // eslint-disable-next-line no-var
  var __jellyfinGateDb: DatabaseSync | undefined;
}

function resolveDatabasePath(): string {
  const configured = env.databasePath;
  if (isAbsolute(configured)) return configured;
  // turbopackIgnore tells the bundler not to try to trace this path at build
  // time. It cannot: DATABASE_PATH is only known at runtime, and there is no
  // file here to bundle — SQLite opens it directly off disk.
  return resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

function openDatabase(): DatabaseSync {
  const path = resolveDatabasePath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // WAL lets the /jf/* proxy read session rows while a login writes, instead of
  // serialising behind it. `synchronous = NORMAL` is the standard WAL pairing:
  // durable across process crashes, and only at risk on hard power loss, which
  // for a session table is an acceptable trade for far fewer fsyncs.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // If a write does contend, wait rather than throwing SQLITE_BUSY immediately.
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db);
  return db;
}

/**
 * Creates or upgrades the schema on boot, so there is no separate "remember to
 * migrate" step.
 *
 * MIGRATIONS HERE MUST BE PURELY ADDITIVE. Every statement in SCHEMA_SQL uses
 * `IF NOT EXISTS`, so replaying the whole file against an older database adds
 * what is missing and leaves existing tables and their rows untouched. That is
 * what upgraded v1 (auth only) to v2 (auth + media_jobs) without a bespoke
 * migration step.
 *
 * The moment a change needs to alter or drop an existing column, this stops
 * being sufficient and needs a real per-version migration list. Bump
 * SCHEMA_VERSION and add that list rather than editing SCHEMA_SQL in place —
 * silently rewriting it would leave already-deployed databases behind.
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;

  if (current >= SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_SQL);
    // PRAGMA does not accept bound parameters; SCHEMA_VERSION is a local
    // integer constant, never user input.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getDb(): DatabaseSync {
  if (!globalThis.__jellyfinGateDb) {
    globalThis.__jellyfinGateDb = openDatabase();
  }
  return globalThis.__jellyfinGateDb;
}

/**
 * Runs `fn` inside a single write transaction.
 *
 * BEGIN IMMEDIATE (not the default deferred BEGIN) takes the write lock up
 * front, so two concurrent redemptions cannot both read a stale use_count and
 * then collide at COMMIT time.
 *
 * `fn` must be synchronous. This is enforced by the type signature on purpose:
 * an `await` inside a transaction would hold the write lock open across network
 * I/O to Jellyfin, blocking every other writer for the duration of an HTTP call
 * and leaving the database locked if the process died mid-flight.
 */
export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback means the transaction was already resolved; the
      // original error is the interesting one, so swallow this and rethrow it.
    }
    throw error;
  }
}

/**
 * Row-shape narrowing.
 *
 * `node:sqlite` types every result as `Record<string, SQLOutputValue>`, which
 * TypeScript will not narrow to a named interface directly. The schema is fixed
 * and lives in schema.ts, so the shapes are known — these two helpers keep the
 * unavoidable assertion in one place instead of scattering `as unknown as`
 * through the data layer.
 */
export function asRows<T>(result: unknown): T[] {
  return result as T[];
}

export function asRow<T>(result: unknown): T | undefined {
  return result as T | undefined;
}

/** Removes expired sessions. Cheap; called opportunistically on login. */
export function pruneExpiredSessions(): number {
  const result = getDb()
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(Date.now());
  return Number(result.changes);
}
