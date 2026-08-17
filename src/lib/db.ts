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

export function resolveDatabasePath(): string {
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
  // Standard tuning for this scale, left at SQLite's defaults until now: an
  // 8MB page cache (negative = KB, so -8000 = 8,000 KB) instead of the ~2MB
  // default, a 256MB mmap so reads on the hot-path tables can go through the
  // OS page cache instead of read() syscalls, and temp b-trees (used for
  // ORDER BY/DISTINCT on larger result sets) kept in memory rather than
  // spilling to a temp file on disk.
  db.exec("PRAGMA cache_size = -8000");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA temp_store = MEMORY");

  migrate(db);
  return db;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

// PRAGMA table_info on a table that doesn't exist yet returns an empty set
// rather than erroring, which would make columnExists() report "missing"
// for a table this same migrate() pass hasn't created — and then try to
// ALTER a table that doesn't exist. Always check tableExists() first.
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * One-time schema changes that CAN'T be expressed as a replay-safe
 * `IF NOT EXISTS` statement in SCHEMA_SQL — an ALTER TABLE ADD COLUMN, or
 * reshaping a table that already shipped with the wrong column. Each step
 * checks live schema state via PRAGMA table_info first, so every step here
 * is idempotent regardless of how many times migrate() calls this (which is
 * once per version bump the database is behind on, same as SCHEMA_SQL
 * itself) — unlike a bare ALTER TABLE sitting in SCHEMA_SQL, which would
 * fail the moment SCHEMA_SQL replays a second time after the column already
 * exists.
 */
function runVersionedMigrations(db: DatabaseSync): void {
  // v13: accolade_label added to article_film_links (a win/nomination's
  // display text — "Won: Best Sound Editing, 92nd Academy Awards" — isn't a
  // numeric rank, so it needed its own column rather than overloading
  // accolade_rank). Only relevant to a database that already has the table
  // from before this column existed — a fresh install's SCHEMA_SQL creates
  // it with the column already in place, and there is nothing here yet for
  // this migration pass to alter.
  if (tableExists(db, "article_film_links") && !columnExists(db, "article_film_links", "accolade_label")) {
    db.exec("ALTER TABLE article_film_links ADD COLUMN accolade_label TEXT");
  }

  // v14: film_curation_locks originally pointed locked_blurb_article_id at
  // the whole ARTICLE, which can't say which of an article's several
  // candidate passages was actually locked. Reshaped to locked_blurb_
  // candidate_id (a specific article_blurb_candidates row) instead. Safe as
  // a straight drop + recreate — by the time this fix landed, nothing had
  // exercised a real curator lock yet, so the table was always empty.
  if (tableExists(db, "film_curation_locks") && columnExists(db, "film_curation_locks", "locked_blurb_article_id")) {
    db.exec("DROP TABLE film_curation_locks");
    // Falls through to SCHEMA_SQL's CREATE TABLE IF NOT EXISTS, which runs
    // right after this function returns and recreates it in the current
    // (correct) shape — see migrate() below for the ordering.
  }

  // v19: film_imdb_id added to scrape_jobs, so the Wikipedia backfill
  // scheduler can tell which films it's already tried (see the column's
  // own comment in schema.ts). Existing rows are left NULL — they predate
  // per-film tracking and are all yearendlists/uploaded-books jobs anyway,
  // which never had a single film to attribute a row to.
  if (tableExists(db, "scrape_jobs") && !columnExists(db, "scrape_jobs", "film_imdb_id")) {
    db.exec("ALTER TABLE scrape_jobs ADD COLUMN film_imdb_id TEXT");
  }

  // v20: notifications gained a `kind` column (was implicitly always "someone
  // replied to your comment") to support two new system-generated kinds —
  // new-library-item and curator's-pick — neither of which has a comment or
  // an acting user, so actor_user_id/comment_id also had to drop their NOT
  // NULL. SQLite can't relax a column constraint in place, so this rebuilds
  // the table and copies every existing row across as kind='reply' (the only
  // kind that existed before this migration), then lets SCHEMA_SQL's own
  // CREATE TABLE IF NOT EXISTS take over for anything still missing.
  if (tableExists(db, "notifications") && !columnExists(db, "notifications", "kind")) {
    db.exec("ALTER TABLE notifications RENAME TO notifications_v19");
    db.exec(`
      CREATE TABLE notifications (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL DEFAULT 'reply',
        actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        comment_id    TEXT REFERENCES film_comments(id) ON DELETE CASCADE,
        imdb_id       TEXT NOT NULL,
        film_title    TEXT NOT NULL,
        film_href     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        read_at       INTEGER
      ) STRICT;
    `);
    db.exec(`
      INSERT INTO notifications (id, user_id, kind, actor_user_id, comment_id, imdb_id, film_title, film_href, created_at, read_at)
      SELECT id, user_id, 'reply', actor_user_id, comment_id, imdb_id, film_title, film_href, created_at, read_at
      FROM notifications_v19
    `);
    db.exec("DROP TABLE notifications_v19");
  }

  // v21: film_curation_locks gained locked_blurb_source_label/_url, so a
  // manually-entered blurb (copy-pasted from a site not worth scraping) can
  // carry the same "who said this, link to read more" attribution a scraped
  // blurb gets for free from its article row.
  if (tableExists(db, "film_curation_locks") && !columnExists(db, "film_curation_locks", "locked_blurb_source_label")) {
    db.exec("ALTER TABLE film_curation_locks ADD COLUMN locked_blurb_source_label TEXT");
    db.exec("ALTER TABLE film_curation_locks ADD COLUMN locked_blurb_source_url TEXT");
  }
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
 * being sufficient — see runVersionedMigrations() above, which handles that
 * case by checking live schema state instead of trusting the version number
 * alone. It runs BEFORE SCHEMA_SQL so a table it drops gets recreated by
 * SCHEMA_SQL's CREATE TABLE IF NOT EXISTS in the same migration pass, and it
 * still runs even for a brand-new database (current = 0) — harmless there
 * since every check is against tables that don't exist yet.
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;

  if (current >= SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    runVersionedMigrations(db);
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
