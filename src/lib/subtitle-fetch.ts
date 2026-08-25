import "server-only";

import { writeFileSync } from "node:fs";
import { extname } from "node:path";

import { asRow, getDb } from "./db";
import { getFullItem, refreshItem } from "./jellyfin";
import {
  downloadSubtitle,
  isOpenSubtitlesConfigured,
  pickBestMatch,
  searchSubtitlesByImdbId,
} from "./opensubtitles";

/**
 * Orchestrates "this film has no subtitles — go find one on OpenSubtitles."
 *
 * Shared by two callers: the curator's Library Review "Missing subtitles"
 * panel, and a consumer-facing action on the item page. Same reasoning as
 * subtitle-promotion.ts's naming convention — a plain
 * "<video-basename>.eng.srt" sitting next to the video is what Jellyfin's
 * own external-subtitle detection looks for, so nothing downstream (the
 * player, listSubtitles() in subtitles.ts) needs to know this file didn't
 * come from the original release.
 */

export interface SubtitleFetchAttempt {
  jellyfin_item_id: string;
  status: "found" | "not_found" | "error";
  language: string | null;
  file_name: string | null;
  message: string | null;
  requested_by: string | null;
  created_at: number;
}

export function getSubtitleFetchAttempt(itemId: string): SubtitleFetchAttempt | null {
  return (
    asRow<SubtitleFetchAttempt>(
      getDb().prepare("SELECT * FROM subtitle_fetch_attempts WHERE jellyfin_item_id = ?").get(itemId),
    ) ?? null
  );
}

function recordAttempt(input: {
  itemId: string;
  status: SubtitleFetchAttempt["status"];
  language: string | null;
  fileName: string | null;
  message: string | null;
  requestedBy: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO subtitle_fetch_attempts (jellyfin_item_id, status, language, file_name, message, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jellyfin_item_id) DO UPDATE SET
         status       = excluded.status,
         language     = excluded.language,
         file_name    = excluded.file_name,
         message      = excluded.message,
         requested_by = excluded.requested_by,
         created_at   = excluded.created_at`,
    )
    .run(
      input.itemId,
      input.status,
      input.language,
      input.fileName,
      input.message,
      input.requestedBy,
      Date.now(),
    );
}

export interface FetchResult {
  ok: boolean;
  status: SubtitleFetchAttempt["status"];
  message: string;
}

/**
 * ISO 639-2/B code Jellyfin's own filename convention expects (see
 * subtitle-promotion.ts's TWO_TO_THREE) — kept to just English for now,
 * since that is what this library's audience actually needs (same
 * reasoning as subtitles.ts's own English-first default track selection).
 * A language picker is a natural follow-up, not required for this to be
 * useful today.
 */
const REQUESTED_LANGUAGE = "en";
const FILENAME_CODE = "eng";

/**
 * `force`: the curator's Library Review action always passes true (they are
 * explicitly asking, and may be retrying after a real miss). The consumer-
 * facing route never does — a title already recorded 'not_found' or 'error'
 * won't be retried automatically on every subsequent play, which is what
 * protects the shared 100/day download quota from one popular title with
 * genuinely no match burning through it on repeat.
 */
export async function fetchSubtitleForItem(
  itemId: string,
  requestedBy: string,
  force = false,
): Promise<FetchResult> {
  if (!isOpenSubtitlesConfigured()) {
    return { ok: false, status: "error", message: "OpenSubtitles is not configured." };
  }

  const existing = getSubtitleFetchAttempt(itemId);
  if (existing && !force) {
    if (existing.status === "found") {
      return { ok: true, status: "found", message: "Already fetched." };
    }
    return { ok: false, status: existing.status, message: existing.message ?? "Already tried, no match." };
  }

  let item: Record<string, unknown>;
  try {
    item = await getFullItem(itemId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read item from Jellyfin.";
    recordAttempt({ itemId, status: "error", language: null, fileName: null, message, requestedBy });
    return { ok: false, status: "error", message };
  }

  const path = typeof item.Path === "string" ? item.Path : null;
  const providerIds = item.ProviderIds as Record<string, string> | undefined;
  const imdbId = providerIds?.Imdb;

  if (!path || !imdbId) {
    const message = !imdbId ? "This title has no IMDb id to search by." : "This title has no file path.";
    recordAttempt({ itemId, status: "error", language: null, fileName: null, message, requestedBy });
    return { ok: false, status: "error", message };
  }

  let results;
  try {
    results = await searchSubtitlesByImdbId(imdbId.replace(/^tt/, ""), REQUESTED_LANGUAGE);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenSubtitles search failed.";
    recordAttempt({ itemId, status: "error", language: null, fileName: null, message, requestedBy });
    return { ok: false, status: "error", message };
  }

  const best = pickBestMatch(results);
  if (!best || best.fileId === null) {
    const message = "No matching English subtitle found on OpenSubtitles.";
    recordAttempt({ itemId, status: "not_found", language: null, fileName: null, message, requestedBy });
    return { ok: false, status: "not_found", message };
  }

  let download;
  try {
    download = await downloadSubtitle(best.fileId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenSubtitles download failed.";
    recordAttempt({ itemId, status: "error", language: null, fileName: null, message, requestedBy });
    return { ok: false, status: "error", message };
  }

  const videoBase = path.slice(0, path.length - extname(path).length);
  const targetPath = `${videoBase}.${FILENAME_CODE}.srt`;

  try {
    writeFileSync(targetPath, download.content, "utf8");
  } catch (error) {
    const message = `Downloaded but could not write the file: ${error instanceof Error ? error.message : String(error)}`;
    recordAttempt({ itemId, status: "error", language: null, fileName: null, message, requestedBy });
    return { ok: false, status: "error", message };
  }

  // Best-effort: the file is already on disk either way, and the next
  // scheduled library scan would pick it up regardless. This just saves
  // the wait when it succeeds.
  try {
    await refreshItem(itemId);
  } catch {
    /* the file is written; a routine scan will still find it */
  }

  recordAttempt({
    itemId,
    status: "found",
    language: REQUESTED_LANGUAGE,
    fileName: targetPath.split(/[/\\]/).pop() ?? null,
    message: null,
    requestedBy,
  });

  return { ok: true, status: "found", message: `Added ${best.release ?? "a subtitle"} (${download.remaining} downloads left today).` };
}
