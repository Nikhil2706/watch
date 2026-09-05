import "server-only";

import { randomBytes } from "node:crypto";

import { getDb, asRows } from "./db";

/**
 * The library review dashboard's decisions — what to hide, what to group —
 * live here, not on disk. Da Moveesh is the admin's actual catalogue and
 * nothing in this app should rewrite it just to change what's *displayed*;
 * a duplicate file move turned out to be slow (multi-GB copies across a
 * Docker mount boundary) and, more importantly, the wrong instinct entirely.
 * These are opinions about presentation, and opinions belong in this app's
 * own database, not stamped onto the admin's files.
 *
 * Everything here is keyed on the Jellyfin container path (e.g.
 * "/media/Horror/x.mp4"), not the Jellyfin item id — ids can be re-minted by
 * a rescan, paths only change if the admin actually moves the file, which is
 * exactly what this table exists to avoid needing.
 */

export interface ExcludedEntry {
  path: string;
  reason: string | null;
  createdAt: number;
}

export interface GroupEntry {
  groupId: string;
  groupName: string;
  paths: string[];
  createdAt: number;
}

export function listExcluded(): ExcludedEntry[] {
  const rows = asRows<{ path: string; reason: string | null; created_at: number }>(
    getDb().prepare("SELECT * FROM library_excluded ORDER BY created_at DESC").all(),
  );
  return rows.map((r) => ({ path: r.path, reason: r.reason, createdAt: r.created_at }));
}

export function getExcludedPathSet(): Set<string> {
  const rows = asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_excluded").all());
  return new Set(rows.map((r) => r.path));
}

export function excludePath(path: string, reason?: string): void {
  getDb()
    .prepare(
      `INSERT INTO library_excluded (path, reason, created_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET reason = excluded.reason`,
    )
    .run(path, reason ?? null, Date.now());
}

export function unexcludePath(path: string): boolean {
  const result = getDb().prepare("DELETE FROM library_excluded WHERE path = ?").run(path);
  return Number(result.changes) > 0;
}

export function listGroups(): GroupEntry[] {
  const rows = asRows<{ path: string; group_id: string; group_name: string; created_at: number }>(
    getDb().prepare("SELECT * FROM library_groups ORDER BY created_at ASC").all(),
  );
  const byId = new Map<string, GroupEntry>();
  for (const r of rows) {
    let g = byId.get(r.group_id);
    if (!g) {
      g = { groupId: r.group_id, groupName: r.group_name, paths: [], createdAt: r.created_at };
      byId.set(r.group_id, g);
    }
    g.paths.push(r.path);
  }
  return [...byId.values()];
}

/** Every grouped path mapped to which group it belongs to — the browse page's collapse set. */
export function getGroupedPathMap(): Map<string, { groupId: string; groupName: string }> {
  const rows = asRows<{ path: string; group_id: string; group_name: string }>(
    getDb().prepare("SELECT path, group_id, group_name FROM library_groups").all(),
  );
  return new Map(rows.map((r) => [r.path, { groupId: r.group_id, groupName: r.group_name }]));
}

export function getGroup(groupId: string): GroupEntry | null {
  const rows = asRows<{ path: string; group_id: string; group_name: string; created_at: number }>(
    getDb().prepare("SELECT * FROM library_groups WHERE group_id = ? ORDER BY created_at ASC").all(groupId),
  );
  const first = rows[0];
  if (!first) return null;
  return {
    groupId,
    groupName: first.group_name,
    paths: rows.map((r) => r.path),
    createdAt: first.created_at,
  };
}

/** Groups the given paths under one name, generating a fresh group id. */
export function createGroup(name: string, paths: string[]): string {
  const groupId = randomBytes(8).toString("base64url");
  const now = Date.now();
  const stmt = getDb().prepare(
    "INSERT INTO library_groups (path, group_id, group_name, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const path of paths) stmt.run(path, groupId, name, now);
  return groupId;
}

/**
 * Adds more paths to an ALREADY-EXISTING group — for a show a curator
 * scheduled a rollout for (rollout.ts) before every episode had arrived,
 * where the original "Group checked as one" action only ever creates a
 * brand-new group. group_name is read off the group's own first existing
 * row rather than passed in, so a caller never has to already know it.
 * Silently a no-op for a path that's already in ANY group (this table's
 * own PRIMARY KEY (path, group_id) would otherwise throw on a re-add of a
 * path already in THIS group, and adding the same file to two different
 * groups is never correct regardless).
 */
export function addToGroup(groupId: string, paths: string[]): number {
  const db = getDb();
  const existing = getGroup(groupId);
  if (!existing) return 0;

  const alreadyGrouped = getGroupedPathMap();
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT INTO library_groups (path, group_id, group_name, created_at) VALUES (?, ?, ?, ?)",
  );
  let added = 0;
  for (const path of paths) {
    if (alreadyGrouped.has(path)) continue;
    stmt.run(path, groupId, existing.groupName, now);
    added++;
  }
  return added;
}

export function ungroup(groupId: string): boolean {
  const result = getDb().prepare("DELETE FROM library_groups WHERE group_id = ?").run(groupId);
  getDb().prepare("DELETE FROM library_group_overview WHERE group_id = ?").run(groupId);
  getDb().prepare("DELETE FROM library_group_series WHERE group_id = ?").run(groupId);
  getDb().prepare("DELETE FROM library_group_series_art WHERE group_id = ?").run(groupId);
  getDb().prepare("DELETE FROM library_group_series_meta WHERE group_id = ?").run(groupId);
  return Number(result.changes) > 0;
}

export function removeFromGroup(path: string): boolean {
  const result = getDb().prepare("DELETE FROM library_groups WHERE path = ?").run(path);
  return Number(result.changes) > 0;
}

/** Renames a group. group_name is denormalised onto every member row, so every row updates together. */
export function renameGroup(groupId: string, name: string): boolean {
  const result = getDb()
    .prepare("UPDATE library_groups SET group_name = ? WHERE group_id = ?")
    .run(name, groupId);
  return Number(result.changes) > 0;
}

export function getGroupOverview(groupId: string): string | null {
  const row = getDb()
    .prepare("SELECT overview FROM library_group_overview WHERE group_id = ?")
    .get(groupId) as { overview: string } | undefined;
  return row?.overview ?? null;
}

export function setGroupOverview(groupId: string, overview: string): void {
  getDb()
    .prepare(
      `INSERT INTO library_group_overview (group_id, overview, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET overview = excluded.overview, updated_at = excluded.updated_at`,
    )
    .run(groupId, overview, Date.now());
}

export function getGroupSeriesId(groupId: string): string | null {
  const row = getDb()
    .prepare("SELECT imdb_id FROM library_group_series WHERE group_id = ?")
    .get(groupId) as { imdb_id: string } | undefined;
  return row?.imdb_id ?? null;
}

/**
 * Whether a grouped title is a television series or a film released in parts.
 *
 * The distinction is only ever about wording — "154 episodes" versus "8 parts"
 * — but getting it wrong is conspicuous on a tile. "unknown" is a real state,
 * not a failure: groups created before this existed have no kind until their
 * series is re-fetched, and they read as "parts" meanwhile, exactly as they
 * did before.
 */
export type GroupKind = "series" | "movie";

function toGroupKind(value: string | null | undefined): GroupKind | null {
  return value === "series" || value === "movie" ? value : null;
}

export function getGroupKind(groupId: string): GroupKind | null {
  const row = getDb()
    .prepare("SELECT kind FROM library_group_series WHERE group_id = ?")
    .get(groupId) as { kind: string | null } | undefined;
  return toGroupKind(row?.kind);
}

/**
 * Written both by the OMDb series fetch (which knows Type) and by the
 * dashboard's own control, which must win: OMDb catalogues plenty of long
 * films as mini-series, and no amount of re-fetching will change its mind.
 * Requires the group to already have a series row — kind describes a linked
 * title, and there is nothing to describe without one.
 */
export function setGroupKind(groupId: string, kind: GroupKind | null): boolean {
  const result = getDb()
    .prepare("UPDATE library_group_series SET kind = ?, updated_at = ? WHERE group_id = ?")
    .run(kind, Date.now(), groupId);
  return Number(result.changes) > 0;
}

/** Every group that has a resolved kind — one read for a whole browse/search page. */
export function getAllGroupKinds(): Map<string, GroupKind> {
  const rows = asRows<{ group_id: string; kind: string | null }>(
    getDb().prepare("SELECT group_id, kind FROM library_group_series").all(),
  );
  const map = new Map<string, GroupKind>();
  for (const r of rows) {
    const kind = toGroupKind(r.kind);
    if (kind) map.set(r.group_id, kind);
  }
  return map;
}

/** "episodes" for a series, "parts" for anything else — including not-yet-known. */
export function partsUnitFor(kind: GroupKind | null | undefined): "episodes" | "parts" {
  return kind === "series" ? "episodes" : "parts";
}

export function setGroupSeriesId(groupId: string, imdbId: string): void {
  getDb()
    .prepare(
      `INSERT INTO library_group_series (group_id, imdb_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET imdb_id = excluded.imdb_id, updated_at = excluded.updated_at`,
    )
    .run(groupId, imdbId, Date.now());
}

/** Records that an admin has explicitly confirmed this file's metadata — see schema.ts for why this exists instead of trusting Jellyfin's LockedFields. */
export function markMetadataConfirmed(path: string): void {
  getDb()
    .prepare(
      `INSERT INTO library_confirmed_metadata (path, confirmed_at) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET confirmed_at = excluded.confirmed_at`,
    )
    .run(path, Date.now());
}

export function getConfirmedPathSet(): Set<string> {
  const rows = asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_confirmed_metadata").all());
  return new Set(rows.map((r) => r.path));
}

export function getGroupSeriesPoster(groupId: string): string | null {
  const row = getDb()
    .prepare("SELECT poster_url FROM library_group_series_art WHERE group_id = ?")
    .get(groupId) as { poster_url: string | null } | undefined;
  return row?.poster_url ?? null;
}

export function setGroupSeriesPoster(groupId: string, posterUrl: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO library_group_series_art (group_id, poster_url, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET poster_url = excluded.poster_url, updated_at = excluded.updated_at`,
    )
    .run(groupId, posterUrl, Date.now());
}

/** Every group id that has a stored series poster, mapped to that poster URL — one read for a whole browse/search page. */
export function getAllGroupSeriesPosters(): Map<string, string> {
  const rows = asRows<{ group_id: string; poster_url: string | null }>(
    getDb().prepare("SELECT group_id, poster_url FROM library_group_series_art").all(),
  );
  const map = new Map<string, string>();
  for (const r of rows) if (r.poster_url) map.set(r.group_id, r.poster_url);
  return map;
}

export interface GroupSeriesMeta {
  genres: string[];
  actors: string[];
  director: string[];
  writer: string[];
}

export function setGroupSeriesMeta(groupId: string, meta: GroupSeriesMeta): void {
  getDb()
    .prepare(
      `INSERT INTO library_group_series_meta (group_id, genres, actors, director, writer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         genres = excluded.genres, actors = excluded.actors,
         director = excluded.director, writer = excluded.writer, updated_at = excluded.updated_at`,
    )
    .run(groupId, meta.genres.join(", "), meta.actors.join(", "), meta.director.join(", "), meta.writer.join(", "), Date.now());
}

export function getGroupSeriesMeta(groupId: string): GroupSeriesMeta | null {
  const row = getDb()
    .prepare("SELECT genres, actors, director, writer FROM library_group_series_meta WHERE group_id = ?")
    .get(groupId) as { genres: string | null; actors: string | null; director: string | null; writer: string | null } | undefined;
  if (!row) return null;
  const split = (s: string | null) => (s ? s.split(", ").filter(Boolean) : []);
  return { genres: split(row.genres), actors: split(row.actors), director: split(row.director), writer: split(row.writer) };
}

export interface WhitelistedEntry {
  path: string;
  createdAt: number;
}

export function listWhitelisted(): WhitelistedEntry[] {
  const rows = asRows<{ path: string; created_at: number }>(
    getDb().prepare("SELECT * FROM library_whitelisted ORDER BY created_at DESC").all(),
  );
  return rows.map((r) => ({ path: r.path, createdAt: r.created_at }));
}

export function getWhitelistedPathSet(): Set<string> {
  const rows = asRows<{ path: string }>(getDb().prepare("SELECT path FROM library_whitelisted").all());
  return new Set(rows.map((r) => r.path));
}

/** "Show this one anyway, even though it has no fetched metadata." */
export function whitelistPath(path: string): void {
  getDb()
    .prepare("INSERT INTO library_whitelisted (path, created_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING")
    .run(path, Date.now());
}

export function unwhitelistPath(path: string): boolean {
  const result = getDb().prepare("DELETE FROM library_whitelisted WHERE path = ?").run(path);
  return Number(result.changes) > 0;
}
