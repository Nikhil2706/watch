/**
 * Database schema, kept as a string constant rather than a .sql file so that it
 * survives Next's bundling and file tracing without any special config.
 *
 * All timestamps are integer Unix milliseconds (UTC). SQLite has no date type
 * and storing epoch integers keeps comparisons cheap and timezone-free — which
 * matters on a Windows host whose local time is not UTC.
 */
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invites (
  id            TEXT PRIMARY KEY,
  -- Only the SHA-256 of the invite token is stored. The plaintext exists in
  -- exactly one place for one moment: the HTTP response to the admin that
  -- created it. A stolen database yields no usable invite links.
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  max_uses      INTEGER NOT NULL,
  use_count     INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  jellyfin_user_id     TEXT NOT NULL UNIQUE,
  username             TEXT NOT NULL UNIQUE,
  -- Kept even if the invite row is later deleted, so provenance is not lost.
  invited_by_invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The live Jellyfin access token. This column is the reason the database file
  -- is as sensitive as a password store: it is a bearer credential for Jellyfin.
  jellyfin_token  TEXT NOT NULL,
  -- Jellyfin keys its own session list by DeviceId. A per-session value keeps
  -- one browser's logout from tearing down another browser's Jellyfin session.
  jellyfin_device_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  user_agent      TEXT,
  ip              TEXT
) STRICT;

-- Watch-folder conversions.
--
-- Originals dropped into the incoming folder are deliberately NOT part of the
-- Jellyfin library: Jellyfin indexes a converted file sitting next to its
-- source as a SECOND movie with the same name, not as another version of the
-- same one (verified — it produced two "Catwoman: Hunted" entries). Keeping
-- originals outside the library is what makes pre-transcoding safe.
--
-- This table is what lets the UI show a title as present-but-unavailable while
-- it is still being converted, since Jellyfin knows nothing about it yet.
CREATE TABLE IF NOT EXISTS media_jobs (
  id             TEXT PRIMARY KEY,
  -- Absolute path of the dropped file. Unique so a folder rescan cannot queue
  -- the same file twice.
  source_path    TEXT NOT NULL UNIQUE,
  -- Human-facing name, derived from the filename, shown while processing.
  title          TEXT NOT NULL,
  output_path    TEXT,
  -- pending | running | done | failed | skipped
  status         TEXT NOT NULL,
  -- 0-100, updated as ffmpeg reports progress.
  progress       INTEGER NOT NULL DEFAULT 0,
  -- Encode rate relative to realtime, for the operator to sanity-check.
  speed          REAL,
  error          TEXT,
  bytes_in       INTEGER,
  bytes_out      INTEGER,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
) STRICT;

-- The admin's recommended subtitle track for a title.
--
-- Jellyfin has no notion of "the one you should pick": it exposes every track
-- equally, and these sources carry dozens. This records the curator's choice so
-- the player can default to it instead of guessing.
--
-- Keyed on the Jellyfin item id. A rescan can mint new item ids, in which case
-- the row is simply orphaned and the player falls back to first-English — a
-- stale recommendation is never worse than no recommendation.
CREATE TABLE IF NOT EXISTS subtitle_prefs (
  jellyfin_item_id TEXT PRIMARY KEY,
  -- Index into the item's MediaStreams, which is how the player selects it.
  stream_index     INTEGER NOT NULL,
  -- Stored for display and so a mismatch after a rescan is detectable.
  label            TEXT,
  language         TEXT,
  set_by           TEXT NOT NULL,
  created_at       INTEGER NOT NULL
) STRICT;

-- Per-user lists. "kind" is 'favourite' or 'rewatch'.
--
-- Favourites also exist in Jellyfin, but rewatch does not, and splitting the
-- two across systems would mean one list surviving a Jellyfin rebuild and the
-- other not. Both live here so they behave identically.
CREATE TABLE IF NOT EXISTS user_lists (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jellyfin_item_id TEXT NOT NULL,
  kind             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, jellyfin_item_id, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_lists_lookup ON user_lists(user_id, kind, created_at DESC);

-- Curator's Picks: articles and essays the admin attaches, with his comment.
--
-- "jellyfin_item_id" is optional — a pick can hang off a specific film or stand
-- alone as general reading.
CREATE TABLE IF NOT EXISTS curations (
  id               TEXT PRIMARY KEY,
  jellyfin_item_id TEXT,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT,
  -- Shown verbatim on the card; this is the whole point of the feature.
  comment          TEXT,
  curator          TEXT NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_curations_item  ON curations(jellyfin_item_id);
CREATE INDEX IF NOT EXISTS idx_curations_order ON curations(position, created_at DESC);

-- Cached external ratings (IMDb / Rotten Tomatoes / Metacritic via OMDb).
--
-- Cached because OMDb's free tier is 1000 requests a day and a home page render
-- would otherwise spend one per visible title. Keyed on the IMDb id Jellyfin
-- already stores.
CREATE TABLE IF NOT EXISTS rating_cache (
  imdb_id      TEXT PRIMARY KEY,
  imdb_rating  TEXT,
  imdb_votes   TEXT,
  rotten       TEXT,
  metacritic   TEXT,
  fetched_at   INTEGER NOT NULL
) STRICT;

-- One-shot control signals for a running conversion.
--
-- A separate table rather than a column on media_jobs so the worker can poll a
-- tiny row without contending with its own progress writes, and so a signal is
-- consumed exactly once (the worker deletes it after acting).
CREATE TABLE IF NOT EXISTS job_controls (
  job_id     TEXT PRIMARY KEY REFERENCES media_jobs(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_media_jobs_status  ON media_jobs(status);
CREATE INDEX IF NOT EXISTS idx_media_jobs_created ON media_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_created   ON invites(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_invite      ON users(invited_by_invite_id);
`;
