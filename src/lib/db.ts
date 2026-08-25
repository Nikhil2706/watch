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

  // v23: invites gained an optional email column, so createInvite() can send
  // the link itself at creation time instead of a curator always having to
  // copy/paste it somewhere else by hand.
  if (tableExists(db, "invites") && !columnExists(db, "invites", "email")) {
    db.exec("ALTER TABLE invites ADD COLUMN email TEXT");
  }

  // v24: davidbordwell added as a scrape source. This row also lives in
  // SCHEMA_SQL's own INSERT OR IGNORE seed block (so a fresh install gets it
  // for free), but SCHEMA_SQL only replays when current < SCHEMA_VERSION —
  // an already-migrated database sitting at the prior version would never
  // see a bare SCHEMA_SQL addition otherwise, hence a real version bump and
  // this explicit insert rather than relying on the seed block alone.
  if (tableExists(db, "scrape_sources")) {
    db.prepare(
      `INSERT OR IGNORE INTO scrape_sources (id, name, base_url, source_type, kind, enabled, created_at)
       VALUES ('davidbordwell', ?, ?, 'web', 'review', 0, ?)`,
    ).run("David Bordwell's Website on Cinema", "https://www.davidbordwell.net", Date.now());
  }

  // v25: same shape as v24, for kinoeye — see that block's comment for why
  // a version bump + explicit insert is needed rather than relying on the
  // SCHEMA_SQL seed block alone.
  if (tableExists(db, "scrape_sources")) {
    db.prepare(
      `INSERT OR IGNORE INTO scrape_sources (id, name, base_url, source_type, kind, enabled, created_at)
       VALUES ('kinoeye', ?, ?, 'web', 'review', 0, ?)`,
    ).run("Kinoeye", "https://www.kinoeye.org", Date.now());
  }

  // v26: film_series / film_series_entries, added to SCHEMA_SQL without a
  // version bump at first — same class of mistake as v24/v25 above, caught
  // live this time (a real "table does not exist" check against the running
  // database, not just reasoning about it) before the real ingest ran.
  // CREATE TABLE/INDEX IF NOT EXISTS is safe to just re-run directly, no
  // existence guard needed the way an ALTER TABLE would.
  db.exec(`
    CREATE TABLE IF NOT EXISTS film_series (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      wiki_page  TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS film_series_entries (
      id         TEXT PRIMARY KEY,
      series_id  TEXT NOT NULL REFERENCES film_series(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      raw_title  TEXT NOT NULL,
      raw_year   INTEGER,
      imdb_id    TEXT,
      confidence TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_film_series_entries_series ON film_series_entries(series_id);
    CREATE INDEX IF NOT EXISTS idx_film_series_entries_imdb ON film_series_entries(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_film_series_entries_unmatched ON film_series_entries(imdb_id) WHERE imdb_id IS NULL;
  `);

  // v27: same class of mistake as v24/v25 again — createScrapeJob("filmseries")
  // needs a matching row in scrape_sources (FK: scrape_jobs.source_id
  // REFERENCES scrape_sources(id)), which v26 forgot even though it added the
  // filmseries tables. Caught live: the first real ingest run threw "FOREIGN
  // KEY constraint failed" because no such row existed on the already-
  // migrated database. This row also lives in SCHEMA_SQL's own seed block for
  // a fresh install; an already-migrated database only sees it via this
  // explicit insert, same reasoning as v24/v25.
  if (tableExists(db, "scrape_sources")) {
    db.prepare(
      `INSERT OR IGNORE INTO scrape_sources (id, name, base_url, source_type, kind, enabled, created_at)
       VALUES ('filmseries', ?, ?, 'web', 'accolade', 1, ?)`,
    ).run("Wikipedia Film Series Index", "https://en.wikipedia.org", Date.now());
  }

  // v28: langlois_mode added to invites and users — this one genuinely is a
  // straightforward ALTER TABLE ADD COLUMN case (an existing table gaining a
  // column, not a new table or a seed row), the class of change this
  // function exists for in the first place. Defaults to 0 on every existing
  // row, which is correct: nobody had download access before this shipped.
  if (tableExists(db, "invites") && !columnExists(db, "invites", "langlois_mode")) {
    db.exec("ALTER TABLE invites ADD COLUMN langlois_mode INTEGER NOT NULL DEFAULT 0");
  }
  if (tableExists(db, "users") && !columnExists(db, "users", "langlois_mode")) {
    db.exec("ALTER TABLE users ADD COLUMN langlois_mode INTEGER NOT NULL DEFAULT 0");
  }

  // v29: download_jobs — new table for the offline-download backend (Phase
  // 3 of the Phone App Roadmap). Same reasoning as v26's film_series
  // tables: CREATE TABLE IF NOT EXISTS is safe to just re-run directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_jobs (
      id               TEXT PRIMARY KEY,
      jellyfin_item_id TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      source_path      TEXT NOT NULL,
      output_path      TEXT,
      status           TEXT NOT NULL,
      progress         INTEGER NOT NULL DEFAULT 0,
      error            TEXT,
      bytes_out        INTEGER,
      created_at       INTEGER NOT NULL,
      started_at       INTEGER,
      finished_at      INTEGER
    ) STRICT;
  `);

  // v30: uploads — new table for the Langlois-mode upload/quarantine/scan/
  // approve pipeline. Same reasoning as v26/v29: CREATE TABLE IF NOT
  // EXISTS is safe to just re-run directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename        TEXT NOT NULL,
      quarantine_path TEXT NOT NULL,
      size_bytes      INTEGER NOT NULL,
      status          TEXT NOT NULL,
      scan_result     TEXT,
      scanned_at      INTEGER,
      reviewed_by     TEXT,
      reviewed_at     INTEGER,
      created_at      INTEGER NOT NULL
    ) STRICT;
  `);

  // v31: notifications gained episode_count, for the "new_episodes" kind
  // (TV completion notifications — see runTvNotifyTick() in
  // library-notify.ts). NULL on every existing row, correct: nothing before
  // this migration was ever a "new_episodes" notification. known_library_
  // groups is a plain new table, added to SCHEMA_SQL alongside this version
  // bump the correct way (unlike v26/v29/v30's tables, which needed a
  // retroactive fix here) — SCHEMA_SQL's own CREATE TABLE IF NOT EXISTS,
  // which always runs right after this function returns, is sufficient for
  // it, so it needs no entry of its own here.
  if (tableExists(db, "notifications") && !columnExists(db, "notifications", "episode_count")) {
    db.exec("ALTER TABLE notifications ADD COLUMN episode_count INTEGER");
  }

  // v35: parental_control added to users — same shape as v28's langlois_mode
  // (a straightforward ALTER TABLE ADD COLUMN on an existing table). Unlike
  // Langlois mode, this never touches the account's real Jellyfin policy —
  // it's a gate-side content filter only, applied in media.ts's
  // filterVisible() and enforced again at single-item fetch in getItem(), so
  // that toggling it can never fail partway through the way a Jellyfin API
  // call could. Defaults to 0 on every existing row: nobody was filtered
  // before this shipped.
  if (tableExists(db, "users") && !columnExists(db, "users", "parental_control")) {
    db.exec("ALTER TABLE users ADD COLUMN parental_control INTEGER NOT NULL DEFAULT 0");
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
