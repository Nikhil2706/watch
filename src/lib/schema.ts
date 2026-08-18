/**
 * Database schema, kept as a string constant rather than a .sql file so that it
 * survives Next's bundling and file tracing without any special config.
 *
 * All timestamps are integer Unix milliseconds (UTC). SQLite has no date type
 * and storing epoch integers keeps comparisons cheap and timezone-free — which
 * matters on a Windows host whose local time is not UTC.
 *
 * EVERY STATEMENT IN HERE MUST BE SAFE TO RUN AGAINST A DATABASE THAT ALREADY
 * HAS IT — because db.ts's migrate() replays this entire string in full on
 * every version bump a database is behind on, not just once ever. CREATE
 * TABLE/INDEX IF NOT EXISTS and INSERT OR IGNORE satisfy that by construction.
 * A bare ALTER TABLE ADD COLUMN does not: it is correct the first time a
 * database crosses the version that introduces it, and fails every time this
 * string replays again afterward (which a LATER version bump, unrelated to
 * that column, will trigger) because the column already exists by then. Any
 * column addition to an existing table, or any other non-replay-safe change,
 * belongs in runVersionedMigrations() in db.ts instead, which checks live
 * schema state (PRAGMA table_info) before acting and is therefore safe to run
 * on every migration regardless of how many times it fires.
 */
export const SCHEMA_VERSION = 28;

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
  created_at    INTEGER NOT NULL,
  -- Optional. When set, createInvite() sends the link here itself instead
  -- of only handing it back in the API response for a curator to copy.
  -- Stored for reference (the Invites list can show who it went to) --
  -- never used for anything but that one send at creation time.
  email         TEXT,
  -- "Langlois mode" (named for Henri Langlois, the archivist who believed
  -- prints belonged in people's hands, not just on a screen): whoever
  -- redeems this invite gets EnableContentDownloading=true on their
  -- Jellyfin account (see applyRestrictedPolicy in jellyfin.ts) instead of
  -- the usual hard denial, plus a raw-file/subtitle download affordance on
  -- the film page. Copied onto the resulting users row at redemption —
  -- see users.langlois_mode below — so later changes to this invite (or
  -- its deletion) never retroactively affect an account already created.
  langlois_mode INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  jellyfin_user_id     TEXT NOT NULL UNIQUE,
  username             TEXT NOT NULL UNIQUE,
  -- Kept even if the invite row is later deleted, so provenance is not lost.
  invited_by_invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL,
  -- Copied from invites.langlois_mode at redemption time — see that
  -- column's comment. The authoritative per-user flag; invites.langlois_mode
  -- is only ever read once, at the moment this row is created.
  langlois_mode        INTEGER NOT NULL DEFAULT 0
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

-- The OMDb backfill loop runs a WHERE fetched_at < ? ORDER BY fetched_at ASC
-- LIMIT ? query (and a matching COUNT) every 10 minutes, forever — without
-- this, that's a full table scan that gets slower as more films get rated.
CREATE INDEX IF NOT EXISTS idx_rating_cache_fetched_at ON rating_cache(fetched_at);

-- Browse's director/actor dimensions need every movie's cast/director
-- credits, and asking Jellyfin's bulk /Items endpoint for the People field
-- across the whole library is genuinely, inherently slow on Jellyfin's own
-- side — measured directly against this session's library at ~20 seconds,
-- independent of every other field on the request (confirmed by timing a
-- People-only fetch against a full-fields one: the delta was ~2 seconds,
-- so People itself is the entire cost, not something query shaping fixes).
-- A single-row cache (id is always 1) rather than one row per item: the
-- whole point is to pay that ~20s cost rarely, in SQLite so it survives a
-- container restart — an in-memory cache does not, which is exactly what
-- turned "slow once" into "slow again on every redeploy" during testing.
CREATE TABLE IF NOT EXISTS browse_people_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
) STRICT;

-- Library scanning is manual (LIBRARY_SCAN=false) — the health dashboard
-- surfaces how long it's been since the last one, since that's exactly the
-- kind of thing easy to forget. A singleton row, same pattern as the cache
-- above: there is only ever one "most recent scan".
CREATE TABLE IF NOT EXISTS health_last_scan (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  triggered_at INTEGER NOT NULL
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

-- One unified feed for anything worth a curator's attention that isn't
-- already its own table: a public/external API call that failed, a route a
-- real viewer hit that 500'd or 502'd, a playback error the PLAYER itself
-- reported (a video that wouldn't decode, a corrupt file, a stalled
-- transcode), a worker conversion failure, or a client-side crash caught by
-- a React error boundary. media_jobs and scrape_jobs stay the source of
-- truth for the conversion/scrape queues themselves (their own shape —
-- progress, status transitions — doesn't fit a flat log); this table is
-- the place everything ELSE lands so the dashboard has one feed to read
-- instead of six.
CREATE TABLE IF NOT EXISTS event_log (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL, -- internal_api | external_api | playback | client | media_job | scrape_job
  severity   TEXT NOT NULL, -- info | warning | error | critical
  source     TEXT NOT NULL, -- e.g. 'omdb', 'wikipedia', 'jf_proxy', 'player', 'worker'
  message    TEXT NOT NULL,
  detail     TEXT,          -- optional JSON blob: stack, status code, path, etc.
  item_id    TEXT,
  username   TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_log_created  ON event_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_category ON event_log(category, created_at DESC);

-- Daily call counters per external service, so the health dashboard can show
-- real usage against a real limit — OMDb's free tier is a hard 1000
-- requests/day, and silently hitting that cap would otherwise just look
-- like ratings randomly going stale with no visible cause.
CREATE TABLE IF NOT EXISTS external_api_calls (
  date          TEXT NOT NULL, -- YYYY-MM-DD, UTC
  source        TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, source)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_media_jobs_status  ON media_jobs(status);
CREATE INDEX IF NOT EXISTS idx_media_jobs_created ON media_jobs(created_at DESC);

-- Library curation decisions from the review dashboard: which files to hide
-- from the front end, and which to present as one grouped tile instead of
-- several. Path-keyed, not Jellyfin-item-id-keyed — a rescan mints a new item
-- id for a file at a new path, but never changes the path of a file nobody
-- touched, and these decisions are specifically designed to never touch the
-- actual files on disk. A stale path just orphans the row harmlessly; it
-- stops matching anything rather than hiding or grouping the wrong item.
CREATE TABLE IF NOT EXISTS library_excluded (
  path       TEXT PRIMARY KEY,
  reason     TEXT,
  created_at INTEGER NOT NULL
) STRICT;

-- A movie with no fetched metadata (no overview, no TMDB/IMDb id) is hidden
-- from the front end by default — it's an open question, not a decision, and
-- "let me pick a poster-less mystery file to play" is not a real feature.
-- Whitelisting is the explicit "yes, show this one anyway" override, kept
-- separate from library_excluded because it means the opposite thing.
CREATE TABLE IF NOT EXISTS library_whitelisted (
  path       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS library_groups (
  path       TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  group_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (path, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_library_groups_group ON library_groups(group_id);

-- A group's synopsis, separate from library_groups so a rename never risks
-- the overview text (group_name is denormalised onto every member row;
-- overview is one row per group and only needs updating in one place).
CREATE TABLE IF NOT EXISTS library_group_overview (
  group_id   TEXT PRIMARY KEY,
  overview   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- The IMDb id of the real TV series a group represents (e.g. "The Curse"),
-- set once per group so every episode's Season/Episode number (already
-- parsed from its filename) can be looked up against OMDb without the admin
-- re-pasting a link per episode.
CREATE TABLE IF NOT EXISTS library_group_series (
  group_id   TEXT PRIMARY KEY,
  imdb_id    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- The series' own poster, separate from library_group_series rather than a
-- column on it: this schema is additive-only (see migrate() in db.ts), and a
-- column can't be added to an already-created table that way. Fetched once
-- alongside the series IMDb id and used for the group's tile on Browse/
-- Search and the collection page header — never any one episode's own,
-- possibly-still-wrong, poster.
CREATE TABLE IF NOT EXISTS library_group_series_art (
  group_id   TEXT PRIMARY KEY,
  poster_url TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

-- Show-level cast/crew/genres from the series OMDb fetch, for the
-- collection page header. Comma-joined text, not normalised rows: this is
-- display-only (OMDb gives plain names, no Jellyfin Person ids to link to),
-- so there's nothing to query it by.
CREATE TABLE IF NOT EXISTS library_group_series_meta (
  group_id   TEXT PRIMARY KEY,
  genres     TEXT,
  actors     TEXT,
  director   TEXT,
  writer     TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

-- Which files an admin has explicitly confirmed the metadata for (via
-- Search/Manual/OMDb-fetch on the review dashboard). Jellyfin's own
-- LockedFields would say the same thing in principle, but its /Items LIST
-- endpoint silently drops that field even when requested (verified against
-- 10.11.11 — only a single-item fetch returns it), so this app tracks the
-- same fact itself rather than depending on a Jellyfin quirk that could
-- change again.
CREATE TABLE IF NOT EXISTS library_confirmed_metadata (
  path         TEXT PRIMARY KEY,
  confirmed_at INTEGER NOT NULL
) STRICT;

-- ------------------------------------------------------------------
-- Critics: scraped reviews, listicles, and the curator's overrides.
--
-- Every table here is either keyed on a stable identity (imdb_id) or holds
-- raw title/year text for a film not yet resolved to one — never a Jellyfin
-- item id, for the same reason every other curation table in this file
-- isn't: rescans re-mint item ids, paths and IMDb ids don't change.
-- ------------------------------------------------------------------

-- A source the scraper is allowed to pull from — a website, or the
-- "Uploaded Books" pseudo-source PDFs land under. "enabled" lets a source be
-- configured (and vetted for robots.txt/ToS) well before it's turned on —
-- see the sites checked when this was designed, only some of which shipped
-- enabled at first. source_type distinguishes an automated web fetch from a
-- curator-uploaded file; base_url is unused (NULL) for uploads.
CREATE TABLE IF NOT EXISTS scrape_sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT,
  source_type TEXT NOT NULL DEFAULT 'web', -- 'web' | 'pdf_upload'
  kind        TEXT NOT NULL, -- 'review' | 'accolade'
  enabled     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
) STRICT;

-- The full text of one fetched article, or one uploaded book's extracted
-- text. Read only by the admin-gated dashboard — the public film page is
-- only ever handed one short selected passage (article_blurb_candidates /
-- film_curation_locks below), never this column. That boundary is what
-- keeps a private reference copy from becoming a public redistribution.
CREATE TABLE IF NOT EXISTS scraped_articles (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES scrape_sources(id) ON DELETE CASCADE,
  -- A file:// or on-disk reference for an uploaded book, not necessarily a
  -- fetchable http(s) URL — still unique, still how a re-upload is detected.
  url           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  article_type  TEXT NOT NULL, -- 'review' | 'accolade'
  published_at  INTEGER,
  full_text     TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scraped_articles_source ON scraped_articles(source_id);

-- Which film(s) an article mentions. imdb_id is NULL until the matcher (or
-- the curator, by hand) resolves it — an accolade mention for a film not
-- yet in the library stays here with just raw_title/raw_year, and the
-- library scan re-attempts the match on every run so it links itself in
-- automatically the moment the film shows up.
-- accolade_rank covers a ranked-list entry ("#7"). A win/nomination isn't a
-- rank at all, so it lives in accolade_label instead ("Won: Best Sound
-- Editing, 92nd Academy Awards") with accolade_rank left null. Both null
-- means this link is a plain review, not an accolade mention.
--
-- accolade_label itself was added after v12 first shipped this table
-- without it (a real ALTER TABLE, not just a column added here — CREATE
-- TABLE IF NOT EXISTS is a no-op against an already-existing table, so a
-- column added only here would never reach a database that predates it).
-- The ALTER runs from runVersionedMigrations() in db.ts, not from this
-- string — SCHEMA_SQL replays in full every time a database is behind
-- SCHEMA_VERSION, and a bare ALTER TABLE ADD COLUMN in here would fail the
-- SECOND such replay (e.g. any later version bump) by trying to add a
-- column that already exists. db.ts's migrations check live schema state
-- via PRAGMA table_info first, so they stay safe no matter how many times
-- SCHEMA_SQL itself replays.
CREATE TABLE IF NOT EXISTS article_film_links (
  id             TEXT PRIMARY KEY,
  article_id     TEXT NOT NULL REFERENCES scraped_articles(id) ON DELETE CASCADE,
  imdb_id        TEXT,
  raw_title      TEXT NOT NULL,
  raw_year       INTEGER,
  confidence     TEXT NOT NULL, -- 'exact' | 'fuzzy' | 'unmatched'
  accolade_rank  INTEGER,
  accolade_label TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_article_film_links_imdb ON article_film_links(imdb_id);
-- article_id is a real query hot spot (unlinking an article, reading its
-- matches) despite being a foreign key — SQLite does not auto-index FKs.
CREATE INDEX IF NOT EXISTS idx_article_film_links_article ON article_film_links(article_id);
CREATE INDEX IF NOT EXISTS idx_article_film_links_unmatched ON article_film_links(imdb_id) WHERE imdb_id IS NULL;

-- Candidate pull-quotes, scoped to one film MENTION (link_id), not the whole
-- article. A single-subject review has one link and every paragraph is a
-- fair candidate; a 25-film listicle or an uploaded book has many links, and
-- only the text actually windowed around a given mention should ever be
-- offered as that film's blurb — otherwise Ford v Ferrari's picker could
-- surface a paragraph from a chapter about a different movie entirely. A
-- film's public blurb is a random pick across candidates on its own link,
-- unless locked in film_curation_locks — this table is that pool, not the
-- final answer.
CREATE TABLE IF NOT EXISTS article_blurb_candidates (
  id           TEXT PRIMARY KEY,
  link_id      TEXT NOT NULL REFERENCES article_film_links(id) ON DELETE CASCADE,
  passage_text TEXT NOT NULL,
  position     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_article_blurb_candidates_link ON article_blurb_candidates(link_id);

-- Same shape and same per-mention scoping as blurb candidates, but shorter
-- and more factual — "the production shut down for three weeks after..." —
-- split sentence-level rather than paragraph-level. A passage can
-- reasonably produce both a blurb candidate and a trivia candidate.
CREATE TABLE IF NOT EXISTS article_trivia_candidates (
  id         TEXT PRIMARY KEY,
  link_id    TEXT NOT NULL REFERENCES article_film_links(id) ON DELETE CASCADE,
  fact_text  TEXT NOT NULL,
  position   INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_article_trivia_candidates_link ON article_trivia_candidates(link_id);

-- One row per franchise, sourced from Wikipedia's "Lists of feature film
-- series" meta-index (see src/lib/scraping/film-series.ts). wiki_page
-- records which of the ~11 "List of feature film series with N entries"
-- pages this came from, purely for provenance/debugging, not looked up by.
CREATE TABLE IF NOT EXISTS film_series (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  wiki_page  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- One row per film-in-a-series slot, in release order (position). imdb_id
-- is null until matchTitle() resolves it — same confidence vocabulary as
-- article_film_links, and the same "re-attempt on every library scan" relink
-- pattern (relinkUnmatchedFilmSeriesEntries), so a film added to the library
-- after its series was already scraped still links up automatically.
CREATE TABLE IF NOT EXISTS film_series_entries (
  id         TEXT PRIMARY KEY,
  series_id  TEXT NOT NULL REFERENCES film_series(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  raw_title  TEXT NOT NULL,
  raw_year   INTEGER,
  imdb_id    TEXT,
  confidence TEXT NOT NULL, -- 'exact' | 'fuzzy' | 'unmatched'
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_film_series_entries_series ON film_series_entries(series_id);
CREATE INDEX IF NOT EXISTS idx_film_series_entries_imdb ON film_series_entries(imdb_id);
CREATE INDEX IF NOT EXISTS idx_film_series_entries_unmatched ON film_series_entries(imdb_id) WHERE imdb_id IS NULL;

-- The curator's override, one row per film. Absence of a row means "auto":
-- a random blurb candidate and the highest-ranked accolade mention. A
-- locked blurb points at a specific scraped PASSAGE (locked_blurb_
-- candidate_id, a specific article_blurb_candidates row — an early version
-- of this table pointed at the whole article instead, which can't say
-- which of an article's several candidate passages was actually picked;
-- fixed via runVersionedMigrations() in db.ts before any real lock existed)
-- or is entirely curator-written (locked_blurb_text, candidate id null) —
-- same either/or for the accolade side.
-- locked_blurb_source_label/_url are set only alongside locked_blurb_text —
-- a manually-entered blurb (copy-pasted from a site not worth building a
-- scraper for) still deserves the same "who said this, and a link to read
-- more" treatment a scraped blurb gets for free from its article row.
CREATE TABLE IF NOT EXISTS film_curation_locks (
  imdb_id                    TEXT PRIMARY KEY,
  locked_blurb_candidate_id  TEXT REFERENCES article_blurb_candidates(id) ON DELETE SET NULL,
  locked_blurb_text          TEXT,
  locked_blurb_source_label  TEXT,
  locked_blurb_source_url    TEXT,
  locked_accolade_link_id    TEXT REFERENCES article_film_links(id) ON DELETE SET NULL,
  locked_accolade_entry_id   TEXT,
  updated_at                 INTEGER NOT NULL
) STRICT;

-- Trivia is a LIST, not a single pick, unlike the blurb above — a film
-- reasonably carries several facts at once. Any row here for an imdb_id
-- means "curated": show exactly these, in position order. No rows means
-- "auto": show up to 5 random article_trivia_candidates reachable through
-- that film's article_film_links. trivia_candidate_id NULL means the
-- curator typed this fact directly (custom_text holds it) rather than
-- picking a scraped one.
CREATE TABLE IF NOT EXISTS film_trivia_selections (
  id                   TEXT PRIMARY KEY,
  imdb_id              TEXT NOT NULL,
  trivia_candidate_id  TEXT REFERENCES article_trivia_candidates(id) ON DELETE SET NULL,
  custom_text          TEXT,
  position             INTEGER NOT NULL,
  created_at           INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_film_trivia_selections_imdb ON film_trivia_selections(imdb_id, position);

-- A curator-built accolade list (independent of anything scraped) — e.g.
-- "Mamnani's Favourite Car Movies".
CREATE TABLE IF NOT EXISTS curator_accolades (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- One slot in a curator-built list. Same not-yet-in-library support as
-- article_film_links: imdb_id is NULL until the film is matched, and the
-- library scan re-resolves it the same way.
CREATE TABLE IF NOT EXISTS curator_accolade_entries (
  id           TEXT PRIMARY KEY,
  accolade_id  TEXT NOT NULL REFERENCES curator_accolades(id) ON DELETE CASCADE,
  slot         INTEGER NOT NULL,
  imdb_id      TEXT,
  raw_title    TEXT NOT NULL,
  raw_year     INTEGER,
  blurb_text   TEXT,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_curator_accolade_entries_accolade ON curator_accolade_entries(accolade_id);
CREATE INDEX IF NOT EXISTS idx_curator_accolade_entries_unmatched ON curator_accolade_entries(imdb_id) WHERE imdb_id IS NULL;

-- One scrape/extract run against one source (a web fetch, or processing one
-- uploaded PDF). Mirrors media_jobs' shape on purpose — the dashboard's
-- job-progress UI pattern (poll status/progress) is reused as-is rather
-- than invented twice.
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES scrape_sources(id) ON DELETE CASCADE,
  status         TEXT NOT NULL, -- pending | running | done | failed
  progress       INTEGER NOT NULL DEFAULT 0,
  found_count    INTEGER NOT NULL DEFAULT 0,
  matched_count  INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  -- Set only for a per-film source (Wikipedia) — a per-site crawl
  -- (yearendlists, a review site) covers many films in one job and leaves
  -- this null. Lets the Wikipedia backfill scheduler know which films it's
  -- already tried, successful or not, so a film with no Wikipedia page
  -- doesn't get re-attempted forever.
  film_imdb_id   TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_film ON scrape_jobs(source_id, film_imdb_id);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_source ON scrape_jobs(source_id, created_at DESC);

-- Seeded once, idempotently: the sites vetted for robots.txt/ToS when this
-- feature was designed, plus the always-enabled "Uploaded Books" pseudo-
-- source PDFs land under. yearendlists.com and Wikipedia (via its official
-- API, not HTML scraping — Wikipedia's own robots.txt/ToS explicitly
-- prefer this) ship enabled; the review sites are configured and ready but
-- untested against real content until turned on from the dashboard.
INSERT OR IGNORE INTO scrape_sources (id, name, base_url, source_type, kind, enabled, created_at) VALUES
  ('uploaded-books', 'Uploaded Books', NULL, 'pdf_upload', 'review', 1, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('yearendlists', 'Year End Lists', 'https://www.yearendlists.com', 'web', 'accolade', 1, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('wikipedia', 'Wikipedia', 'https://en.wikipedia.org', 'web', 'accolade', 1, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('the-ringer', 'The Ringer', 'https://www.theringer.com', 'web', 'review', 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('brightwalldarkroom', 'Bright Wall/Dark Room', 'https://www.brightwalldarkroom.com', 'web', 'review', 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('reverseshot', 'Reverse Shot', 'https://reverseshot.org', 'web', 'review', 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('davidbordwell', 'David Bordwell''s Website on Cinema', 'https://www.davidbordwell.net', 'web', 'review', 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('kinoeye', 'Kinoeye', 'https://www.kinoeye.org', 'web', 'review', 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('filmseries', 'Wikipedia Film Series Index', 'https://en.wikipedia.org', 'web', 'accolade', 1, CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_created   ON invites(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_invite      ON users(invited_by_invite_id);

-- Viewer ratings and comments — "Community": what the actual people
-- watching this library think, alongside the external IMDb/RT/Metacritic
-- scores and the curator's own accolades. Keyed by IMDb id, same as
-- rating_cache and every Accolades table — a movie's own id, or a grouped
-- TV show's SERIES id (library_group_series.imdb_id), never a Jellyfin
-- item id or one episode's id, so a show's conversation stays in one place
-- regardless of which episode someone's watching.

CREATE TABLE IF NOT EXISTS user_ratings (
  id         TEXT PRIMARY KEY,
  imdb_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The UI shows half-star increments (0.5-5.0), but that's just this same
  -- 1-10 integer scale relabeled — 1 = half a star, 10 = five stars. See
  -- src/lib/stars.ts for the (display-only) conversion. No schema change
  -- needed when the rating scale's presentation changed after this table
  -- first shipped.
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(imdb_id, user_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_ratings_imdb ON user_ratings(imdb_id);

-- One level of replies only (parent_id points at a top-level comment,
-- enforced in the write path, not here). Plain text, not the Accolades
-- rich-text allowlist — this is chat between people who know each other,
-- not curated prose.
--
-- deleted_at is a soft delete: a reply thread must survive its parent
-- comment being removed, so a deleted comment becomes a "[deleted]"
-- placeholder rather than a hard DELETE, which would cascade and take
-- other people's replies out with it.
CREATE TABLE IF NOT EXISTS film_comments (
  id         TEXT PRIMARY KEY,
  imdb_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES film_comments(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_film_comments_imdb   ON film_comments(imdb_id, created_at);
CREATE INDEX IF NOT EXISTS idx_film_comments_parent ON film_comments(parent_id);

-- In-app only (no push/email). Three kinds: 'reply' (someone replied to your
-- comment — has actor_user_id + comment_id), 'new_item' (a title was just
-- added to the library — system-generated, no actor), 'curators_pick' (the
-- curator flagged a title for you — system-generated from the console, no
-- app-level user account to attribute it to since curator actions are
-- admin-key gated, not session-based).
--
-- film_title/film_href are a snapshot, not a live lookup: this app has no
-- local index from imdb_id back to a Jellyfin item or group id (Jellyfin
-- holds that association, not this database), and resolving one per row
-- every time the bell dropdown opens would mean a Jellyfin round trip per
-- notification. Whatever wrote the row already had both on hand at the
-- moment that made the notification true, so they're captured once, here.
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'reply',
  actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  comment_id    TEXT REFERENCES film_comments(id) ON DELETE CASCADE,
  imdb_id       TEXT NOT NULL,
  film_title    TEXT NOT NULL,
  -- e.g. "/item/{id}" for a movie or "/collection/{groupId}" for a show.
  film_href     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

-- Snapshot of every movie the library-notify tick loop has already seen, so
-- it can tell "genuinely new since last tick" apart from "already known" —
-- see src/lib/library-notify.ts. The first-ever tick on a fresh database
-- populates this without notifying anyone (nothing counts as "new" against
-- an empty snapshot), so turning this feature on never floods every user
-- with the whole existing library at once.
CREATE TABLE IF NOT EXISTS known_library_items (
  imdb_id      TEXT PRIMARY KEY,
  jellyfin_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
) STRICT;
`;
