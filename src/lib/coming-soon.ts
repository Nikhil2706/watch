import "server-only";

import { getAdminMovies } from "./admin-library-cache";
import { orderComingSoon, scheduleDetail, type ComingSoonEntry } from "./coming-soon-list";
import { generateId } from "./crypto";
import { asRow, asRows, getDb } from "./db";
import type { AdminMovieListItem } from "./jellyfin";
import { getGroup, getGroupSeriesPoster } from "./library-curation";
import { getAllMovies, posterUrl, type MediaItem } from "./media";
import { listUpcomingReleases } from "./rollout";
import { getSeriesById } from "./scraping/film-series";
import type { ResolvedSession } from "./session";
import { findTmdbTitleByImdbId, type TmdbTitle } from "./tmdb";

/**
 * Coming soon (v65): titles the curator announces by IMDb id before they are
 * in the library, plus everything scheduled to be released (rollout.ts): a
 * film's date, a show's next episodes, a franchise's next film. Home shows
 * the first few; /coming-soon shows all, with notes and summaries.
 */

export interface Announcement {
  id: string;
  imdbId: string;
  kind: "film" | "show";
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  note: string | null;
  expectedAt: number | null;
  createdAt: number;
}

interface Row {
  id: string;
  imdb_id: string;
  kind: "film" | "show";
  title: string;
  year: number | null;
  overview: string | null;
  poster_path: string | null;
  note: string | null;
  expected_at: number | null;
  created_at: number;
}

function fromRow(r: Row): Announcement {
  return {
    id: r.id,
    imdbId: r.imdb_id,
    kind: r.kind,
    title: r.title,
    year: r.year,
    overview: r.overview,
    posterPath: r.poster_path,
    note: r.note,
    expectedAt: r.expected_at,
    createdAt: r.created_at,
  };
}

export function normaliseImdbId(raw: string): string | null {
  const m = /(tt\d{5,10})/.exec(raw.trim());
  return m ? m[1]! : /^\d{5,10}$/.test(raw.trim()) ? `tt${raw.trim()}` : null;
}

/** What an IMDb id is, for the curator to check before announcing. */
export async function lookUpForAnnouncement(imdbId: string): Promise<TmdbTitle | null> {
  return findTmdbTitleByImdbId(imdbId);
}

export class ComingSoonError extends Error {}

/** Announces (or updates) a title. Its name, year, poster and summary are TMDB's, read now. */
export async function announce(input: { imdbId: string; note?: string | null; expectedAt?: number | null }): Promise<Announcement> {
  const title = await findTmdbTitleByImdbId(input.imdbId);
  if (!title) throw new ComingSoonError("TMDB doesn't know that IMDb id.");
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO coming_soon (id, imdb_id, kind, title, year, overview, poster_path, note, expected_at, created_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(imdb_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, year = excluded.year, overview = excluded.overview,
         poster_path = excluded.poster_path, note = excluded.note, expected_at = excluded.expected_at, removed_at = NULL`,
    )
    .run(
      generateId(),
      input.imdbId,
      title.kind,
      title.title,
      title.year,
      title.overview,
      title.posterPath,
      input.note?.trim() || null,
      input.expectedAt ?? null,
      now,
    );
  return getAnnouncement(input.imdbId)!;
}

export function getAnnouncement(imdbId: string): Announcement | null {
  const r = asRow<Row>(getDb().prepare("SELECT * FROM coming_soon WHERE imdb_id = ? AND removed_at IS NULL").get(imdbId));
  return r ? fromRow(r) : null;
}

export function listAnnouncements(): Announcement[] {
  return asRows<Row>(getDb().prepare("SELECT * FROM coming_soon WHERE removed_at IS NULL ORDER BY created_at DESC").all()).map(fromRow);
}

export function removeAnnouncement(id: string): boolean {
  return Number(getDb().prepare("UPDATE coming_soon SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(Date.now(), id).changes) > 0;
}

function tmdbPoster(path: string | null): string | null {
  return path ? `/api/tmdb-image?path=${encodeURIComponent(path)}&size=w342` : null;
}

function adminPoster(item: AdminMovieListItem | undefined): string | null {
  return item ? posterUrl({ Id: item.Id, Name: item.Name, ImageTags: item.ImageTags } as MediaItem) : null;
}

/**
 * Everything coming, for this viewer: announcements not yet here (or here
 * but not visible to them yet), and every schedule with something still to
 * release. A scheduled film or franchise film is named from the curator's
 * listing, since the viewer's own listing hides it until its date.
 */
export async function comingSoonFor(session: ResolvedSession): Promise<ComingSoonEntry[]> {
  const [visible, all] = await Promise.all([
    getAllMovies(session, { limit: 2000 }),
    getAdminMovies({ withMediaSources: false }),
  ]);
  const visibleImdb = new Set(visible.map((i) => i.ProviderIds?.Imdb).filter(Boolean));
  const byPath = new Map(all.filter((i) => i.Path).map((i) => [i.Path!, i]));
  const byImdb = new Map(all.filter((i) => i.ProviderIds?.Imdb).map((i) => [i.ProviderIds!.Imdb!, i]));

  const entries: ComingSoonEntry[] = [];
  const scheduledImdb = new Set<string>();

  for (const u of listUpcomingReleases()) {
    if (u.subjectType === "film") {
      const item = byPath.get(u.subjectId);
      if (!item) continue;
      if (item.ProviderIds?.Imdb) scheduledImdb.add(item.ProviderIds.Imdb);
      entries.push({
        key: `film:${item.Id}`,
        kind: "film",
        title: item.Name,
        year: item.ProductionYear ?? null,
        posterSrc: adminPoster(item),
        href: `/coming-soon#film-${item.Id}`,
        at: u.nextAt,
        detail: null,
        note: null,
        overview: item.Overview ?? null,
        createdAt: 0,
      });
    } else if (u.subjectType === "group") {
      const group = getGroup(u.subjectId);
      if (!group) continue;
      entries.push({
        key: `show:${u.subjectId}`,
        kind: "show",
        title: group.groupName,
        year: null,
        posterSrc: getGroupSeriesPoster(u.subjectId),
        href: `/collection/${u.subjectId}`,
        at: u.nextAt,
        detail: scheduleDetail("show", u.remaining),
        note: null,
        overview: null,
        createdAt: 0,
      });
    } else {
      const series = getSeriesById(u.subjectId);
      if (!series) continue;
      const next = u.nextImdbId ? byImdb.get(u.nextImdbId) : undefined;
      if (u.nextImdbId) scheduledImdb.add(u.nextImdbId);
      entries.push({
        key: `franchise:${u.subjectId}`,
        kind: "franchise",
        title: next ? `${series.seriesName}: ${next.Name}` : series.seriesName,
        year: next?.ProductionYear ?? null,
        posterSrc: adminPoster(next),
        href: `/coming-soon#franchise-${u.subjectId}`,
        at: u.nextAt,
        detail: scheduleDetail("franchise", u.remaining),
        note: null,
        overview: next?.Overview ?? null,
        createdAt: 0,
      });
    }
  }

  for (const a of listAnnouncements()) {
    // Here and visible: no longer coming. Here and scheduled: its schedule's card says when.
    if (visibleImdb.has(a.imdbId) || scheduledImdb.has(a.imdbId)) continue;
    entries.push({
      key: `announced:${a.id}`,
      kind: "announced",
      title: a.title,
      year: a.year,
      posterSrc: tmdbPoster(a.posterPath),
      href: `/coming-soon#announced-${a.id}`,
      at: a.expectedAt,
      detail: a.kind === "show" ? "TV show" : null,
      note: a.note,
      overview: a.overview,
      createdAt: a.createdAt,
    });
  }

  return orderComingSoon(entries);
}
