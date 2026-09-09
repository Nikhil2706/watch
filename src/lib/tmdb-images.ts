import "server-only";

import { asRow, getDb } from "./db";
import { isCacheableImagePath } from "./tmdb-shape";

/**
 * A byte cache for TMDB artwork, so the browser never talks to TMDB.
 *
 * Every other image on this site is served from /jf/*, precisely so a viewer's
 * browser makes no third-party request — the sign-in page goes as far as
 * drawing its own artwork rather than loading a webfont. Crew photos are the
 * first artwork with no Jellyfin object behind them, so without this they
 * would be the one exception: an <img src="https://image.tmdb.org/..."> tells
 * TMDB the viewer's IP and, through the Referer, which film they are reading
 * about. This keeps that promise intact for one more class of image.
 *
 * Filled lazily and never by a sweep. A miss fetches once and stores; a
 * failure returns null and the caller falls back to what it already does when
 * a person has no photo. There is no budget to spend and no cursor to lose.
 */

/** TMDB renditions this cache will serve. Anything else is a caller bug. */
const ALLOWED_SIZES = new Set([
  // Profiles
  "w45", "w185", "h632",
  // Stills and posters
  "w300", "w342", "w780",
  // Logos and backdrops
  "w500", "w1280",
]);

/** A w1280 backdrop runs to a few hundred KB; past this something is wrong. */
const MAX_BYTES = 3 * 1024 * 1024;

export interface CachedImage {
  bytes: Uint8Array;
  contentType: string;
}

export function getCachedImage(path: string, size: string): CachedImage | null {
  const row = asRow<{ bytes: Uint8Array; content_type: string }>(
    getDb()
      .prepare("SELECT bytes, content_type FROM tmdb_images WHERE path = ? AND size = ?")
      .get(path, size),
  );
  if (!row) return null;
  return { bytes: row.bytes, contentType: row.content_type };
}

export function putCachedImage(
  path: string,
  size: string,
  bytes: Uint8Array,
  contentType: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO tmdb_images (path, size, bytes, content_type, byte_len, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path, size) DO UPDATE SET
         bytes = excluded.bytes,
         content_type = excluded.content_type,
         byte_len = excluded.byte_len,
         fetched_at = excluded.fetched_at`,
    )
    .run(path, size, bytes, contentType, bytes.byteLength, Date.now());
}

/**
 * The cached bytes, fetching them once if they are not here yet.
 *
 * Returns null rather than throwing on every failure mode — a bad path, a size
 * nobody asked for, a dead link, an oversized body. The caller's job is then to
 * render what it renders when there is no photo at all, which is a thing every
 * cast card already knows how to do.
 */
export async function imageBytes(
  path: string | null | undefined,
  size = "w185",
): Promise<CachedImage | null> {
  if (!path || !isCacheableImagePath(path) || !ALLOWED_SIZES.has(size)) return null;

  const hit = getCachedImage(path, size);
  if (hit) return hit;

  let response: Response;
  try {
    // This host drops roughly one request in thirty, which is the real
    // constraint on anything TMDB here — but a miss is cheap and the next
    // viewer retries it for free, so there is no retry loop.
    response = await fetch(`https://image.tmdb.org/t/p/${size}${path}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null;

  putCachedImage(path, size, buffer, contentType);
  return { bytes: buffer, contentType };
}

export interface ImageCacheStats {
  count: number;
  bytes: number;
}

export function imageCacheStats(): ImageCacheStats {
  const row = asRow<{ count: number; bytes: number }>(
    getDb()
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_len), 0) AS bytes FROM tmdb_images")
      .get(),
  );
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
}
