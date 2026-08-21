import "server-only";

import { statfs, stat, readdir } from "node:fs/promises";
import path from "node:path";

import { asRow, asRows, getDb, resolveDatabasePath } from "./db";
import { env } from "./env";
import { countEventsSince, getExternalApiUsageToday, type ExternalApiUsage } from "./events";
import { checkJellyfinHealth, getActiveSessions, type JellyfinHealth, type JellyfinSessionSummary } from "./jellyfin";
import { getLibraryNotifyStatus, getTvNotifyStatus, type LibraryNotifyStatus, type TvNotifyStatus } from "./library-notify";
import { getOmdbBackfillStatus, type OmdbBackfillStatus } from "./omdb-backfill";
import { getWikipediaBackfillStatus, type WikipediaBackfillStatus } from "./wikipedia-backfill";

/**
 * Everything the Curator's Dashboard's Health tab shows, gathered fresh on
 * every request. Nothing here is expensive enough to need caching — the one
 * genuinely slow Jellyfin call (Browse's People fetch) deliberately isn't
 * part of this at all.
 */

export interface HealthSnapshot {
  checkedAt: number;
  overall: "ok" | "warning" | "critical";
  publicSite: {
    reachable: boolean;
    statusCode: number | null;
    responseMs: number | null;
    url: string;
    error?: string;
  };
  jellyfin: JellyfinHealth;
  sessions: JellyfinSessionSummary | null;
  storage: {
    path: string;
    freeBytes: number | null;
    totalBytes: number | null;
    freeFraction: number | null;
    error?: string;
  };
  conversionQueue: {
    pending: number;
    running: number;
    failedRecent: number;
    stuck: Array<{ id: string; title: string; startedAt: number; hoursRunning: number }>;
  };
  scraping: {
    recentFailures: Array<{ id: string; sourceId: string; error: string | null; finishedAt: number | null }>;
  };
  database: {
    sizeBytes: number | null;
    error?: string;
  };
  storageBreakdown: {
    /** scraped_articles.full_text — the actual reviews/books/lists content. */
    scrapedDataBytes: number;
    /** browse_people_cache + rating_cache + library_group_series_meta — data fetched from an external API and kept so we don't re-fetch it. */
    cachedApiDataBytes: number;
    /** Everything else in the database (users, comments, notifications, jobs, locks, ...) — small by construction. */
    otherDataBytes: number;
    /** The running app itself (.next build + node_modules) — static per deploy, not part of "your data". */
    codebaseBytes: number | null;
  };
  lastLibraryScan: {
    triggeredAt: number | null;
    hoursAgo: number | null;
  };
  externalApis: ExternalApiUsage[];
  recentIssueCount: number;
  omdbBackfill: OmdbBackfillStatus | null;
  wikipediaBackfill: WikipediaBackfillStatus | null;
  libraryNotify: LibraryNotifyStatus | null;
  tvNotify: TvNotifyStatus | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Software transcodes on this hardware can genuinely run for hours; only flag a
 * conversion as "stuck" once it's well past even a generous real-world ceiling. */
const STUCK_JOB_HOURS = 6;
const LOW_STORAGE_FRACTION = 0.1;
/** A cap this close to exhausted is worth a warning before it actually runs out. */
const API_CAP_WARN_FRACTION = 0.9;

async function checkPublicSite(): Promise<HealthSnapshot["publicSite"]> {
  const start = Date.now();
  try {
    const response = await fetch(env.publicUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    return {
      reachable: response.status < 500,
      statusCode: response.status,
      responseMs: Date.now() - start,
      url: env.publicUrl,
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      responseMs: null,
      url: env.publicUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkStorage(): Promise<HealthSnapshot["storage"]> {
  try {
    const stats = await statfs(env.mediaLibraryPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      path: env.mediaLibraryPath,
      freeBytes,
      totalBytes,
      freeFraction: totalBytes > 0 ? freeBytes / totalBytes : null,
    };
  } catch (error) {
    return {
      path: env.mediaLibraryPath,
      freeBytes: null,
      totalBytes: null,
      freeFraction: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkConversionQueue(): HealthSnapshot["conversionQueue"] {
  const db = getDb();
  const pending = asRow<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE status = 'pending'").get(),
  )?.n ?? 0;
  const running = asRow<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE status = 'running'").get(),
  )?.n ?? 0;
  const failedRecent = asRow<{ n: number }>(
    db
      .prepare("SELECT COUNT(*) AS n FROM media_jobs WHERE status = 'failed' AND finished_at >= ?")
      .get(Date.now() - WEEK_MS),
  )?.n ?? 0;

  const stuckCutoff = Date.now() - STUCK_JOB_HOURS * 60 * 60 * 1000;
  const stuckRows = asRows<{ id: string; title: string; started_at: number }>(
    db
      .prepare("SELECT id, title, started_at FROM media_jobs WHERE status = 'running' AND started_at <= ?")
      .all(stuckCutoff),
  );
  const stuck = stuckRows.map((row) => ({
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    hoursRunning: Math.round(((Date.now() - row.started_at) / (60 * 60 * 1000)) * 10) / 10,
  }));

  return { pending, running, failedRecent, stuck };
}

function checkScraping(): HealthSnapshot["scraping"] {
  const db = getDb();
  const rows = asRows<{ id: string; source_id: string; error: string | null; finished_at: number | null }>(
    db
      .prepare(
        `SELECT id, source_id, error, finished_at FROM scrape_jobs
         WHERE status = 'failed' AND finished_at >= ?
         ORDER BY finished_at DESC LIMIT 10`,
      )
      .all(Date.now() - WEEK_MS),
  );
  return {
    recentFailures: rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      error: row.error,
      finishedAt: row.finished_at,
    })),
  };
}

async function checkDatabase(): Promise<HealthSnapshot["database"]> {
  try {
    const stats = await stat(resolveDatabasePath());
    return { sizeBytes: stats.size };
  } catch (error) {
    return { sizeBytes: null, error: error instanceof Error ? error.message : String(error) };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateCodebaseBytes: number | null | undefined;
}

/** Recursive directory size, skipping anything unreadable rather than failing the whole walk. */
async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        /* file vanished mid-walk — skip it */
      }
    }
  }
  return total;
}

/**
 * Size of the running app itself (everything under /app except /app/data,
 * which is the database — counted separately). Static for the life of the
 * process, so this only ever walks the filesystem once and caches the
 * result — same globalThis-pinning reasoning as the backfill loops, so a
 * dev-mode hot reload doesn't repeat the walk either.
 */
async function getCodebaseBytes(): Promise<number | null> {
  if (globalThis.__jellyfinGateCodebaseBytes !== undefined) return globalThis.__jellyfinGateCodebaseBytes;
  try {
    const appRoot = process.cwd();
    const dataDir = path.dirname(resolveDatabasePath());
    let total = 0;
    const entries = await readdir(appRoot, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(appRoot, entry.name);
      if (full === dataDir) continue;
      total += entry.isDirectory() ? await dirSizeBytes(full) : (await stat(full).catch(() => null))?.size ?? 0;
    }
    globalThis.__jellyfinGateCodebaseBytes = total;
    return total;
  } catch {
    globalThis.__jellyfinGateCodebaseBytes = null;
    return null;
  }
}

function checkStorageBreakdown(): { scrapedDataBytes: number; cachedApiDataBytes: number } {
  const db = getDb();
  const scrapedDataBytes =
    asRow<{ n: number }>(db.prepare("SELECT COALESCE(SUM(LENGTH(full_text)), 0) AS n FROM scraped_articles").get())
      ?.n ?? 0;

  const browsePeopleBytes =
    asRow<{ n: number }>(db.prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM browse_people_cache").get())
      ?.n ?? 0;
  const ratingCacheBytes =
    asRow<{ n: number }>(
      db
        .prepare(
          "SELECT COALESCE(SUM(LENGTH(imdb_id) + LENGTH(imdb_rating) + LENGTH(imdb_votes) + LENGTH(rotten) + LENGTH(metacritic)), 0) AS n FROM rating_cache",
        )
        .get(),
    )?.n ?? 0;
  const seriesMetaBytes =
    asRow<{ n: number }>(
      db
        .prepare(
          "SELECT COALESCE(SUM(LENGTH(genres) + LENGTH(actors) + LENGTH(director) + LENGTH(writer)), 0) AS n FROM library_group_series_meta",
        )
        .get(),
    )?.n ?? 0;

  return { scrapedDataBytes, cachedApiDataBytes: browsePeopleBytes + ratingCacheBytes + seriesMetaBytes };
}

function checkLastLibraryScan(): HealthSnapshot["lastLibraryScan"] {
  const row = asRow<{ triggered_at: number }>(
    getDb().prepare("SELECT triggered_at FROM health_last_scan WHERE id = 1").get(),
  );
  if (!row) return { triggeredAt: null, hoursAgo: null };
  return {
    triggeredAt: row.triggered_at,
    hoursAgo: Math.round(((Date.now() - row.triggered_at) / (60 * 60 * 1000)) * 10) / 10,
  };
}

function apiNearCap(usage: ExternalApiUsage): boolean {
  if (usage.dailyCap === null) return false;
  return usage.successCount + usage.failureCount >= usage.dailyCap * API_CAP_WARN_FRACTION;
}

function computeOverall(snapshot: Omit<HealthSnapshot, "overall" | "checkedAt">): HealthSnapshot["overall"] {
  const critical =
    !snapshot.publicSite.reachable ||
    !snapshot.jellyfin.reachable ||
    snapshot.conversionQueue.stuck.length > 0 ||
    snapshot.externalApis.some(apiNearCap);
  if (critical) return "critical";

  const warning =
    snapshot.conversionQueue.failedRecent > 0 ||
    snapshot.scraping.recentFailures.length > 0 ||
    (snapshot.storage.freeFraction !== null && snapshot.storage.freeFraction < LOW_STORAGE_FRACTION) ||
    snapshot.lastLibraryScan.hoursAgo === null ||
    snapshot.externalApis.some((a) => a.failureCount > 0) ||
    snapshot.recentIssueCount > 0;
  if (warning) return "warning";

  return "ok";
}

export async function getHealthSnapshot(): Promise<HealthSnapshot> {
  const [publicSite, jellyfin, storage, database, codebaseBytes] = await Promise.all([
    checkPublicSite(),
    checkJellyfinHealth(),
    checkStorage(),
    checkDatabase(),
    getCodebaseBytes(),
  ]);

  const sessions = jellyfin.reachable ? await getActiveSessions().catch(() => null) : null;
  const conversionQueue = checkConversionQueue();
  const scraping = checkScraping();
  const lastLibraryScan = checkLastLibraryScan();
  const externalApis = getExternalApiUsageToday();
  const recentIssueCount = countEventsSince(Date.now() - DAY_MS, { severity: ["error", "critical"] });
  const omdbBackfill = getOmdbBackfillStatus();
  const wikipediaBackfill = getWikipediaBackfillStatus();
  const libraryNotify = getLibraryNotifyStatus();
  const tvNotify = getTvNotifyStatus();

  const { scrapedDataBytes, cachedApiDataBytes } = checkStorageBreakdown();
  const otherDataBytes = Math.max(0, (database.sizeBytes ?? 0) - scrapedDataBytes - cachedApiDataBytes);
  const storageBreakdown = { scrapedDataBytes, cachedApiDataBytes, otherDataBytes, codebaseBytes };

  const partial = {
    publicSite,
    jellyfin,
    sessions,
    storage,
    conversionQueue,
    scraping,
    database,
    storageBreakdown,
    lastLibraryScan,
    externalApis,
    recentIssueCount,
    omdbBackfill,
    wikipediaBackfill,
    libraryNotify,
    tvNotify,
  };

  return {
    checkedAt: Date.now(),
    overall: computeOverall(partial),
    ...partial,
  };
}
