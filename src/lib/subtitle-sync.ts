import "server-only";

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getAdminMovies } from "./admin-library-cache";
import { asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { getFullItem, refreshItem } from "./jellyfin";
import { getGroupedPathMap, getGroupKind, partsUnitFor } from "./library-curation";
import { formatSrt, parseSrt, retime, type Timing } from "./srt-timing";
import type { EpisodeFiles } from "./subtitle-show-shift";

/**
 * The sync screen (/admin/subtitles/sync): read one of a video's subtitle
 * files for the live preview, and save it with new timing. Only .srt files
 * sitting next to that item's video, named after it, are touched; a name is
 * never taken as a path.
 *
 * Saving keeps the very first version as "<name>.orig" (an extension
 * Jellyfin doesn't read as a subtitle), so a sync can always be undone.
 */

export class SyncError extends Error {}

export interface SyncTarget {
  itemId: string;
  title: string;
  videoPath: string;
  /** The .srt files next to the video, by name. */
  files: string[];
  /** For an episode: its show's other episodes and their .srt files ("shift every episode"). */
  show: { groupId: string; name: string; unit: "episodes" | "parts"; episodes: EpisodeFiles[] } | null;
}

export async function videoOf(itemId: string): Promise<{ title: string; path: string }> {
  const item = await getFullItem(itemId);
  const path = typeof item.Path === "string" ? item.Path : null;
  if (!path) throw new SyncError("This item has no file.");
  return { title: typeof item.Name === "string" ? item.Name : basename(path), path };
}

function srtFilesNextTo(videoPath: string): string[] {
  const stem = basename(videoPath, extname(videoPath));
  try {
    return readdirSync(dirname(videoPath))
      .filter((f) => extname(f).toLowerCase() === ".srt" && (f.startsWith(stem + ".") || f === `${stem}.srt`))
      .sort();
  } catch {
    return [];
  }
}

export async function syncTarget(itemId: string): Promise<SyncTarget> {
  const v = await videoOf(itemId);
  return { itemId, title: v.title, videoPath: v.path, files: srtFilesNextTo(v.path), show: await showOf(v.path) };
}

/** The other episodes of the show a video is in, in order, with their .srt files. */
async function showOf(videoPath: string): Promise<SyncTarget["show"]> {
  const group = getGroupedPathMap().get(videoPath);
  if (!group) return null;
  const paths = asRows<{ path: string }>(
    getDb().prepare("SELECT path FROM library_groups WHERE group_id = ?").all(group.groupId),
  ).map((r) => r.path);
  const idOf = new Map((await getAdminMovies({ withMediaSources: false })).map((m) => [m.Path, m.Id]));
  const episodes = paths
    .filter((p) => p !== videoPath && idOf.has(p))
    .map((p) => ({ p, info: parseEpisodeInfo(p) }))
    .sort((a, b) => a.info.sortKey - b.info.sortKey || a.p.localeCompare(b.p))
    .map(({ p, info }) => ({
      itemId: idOf.get(p)!,
      path: p,
      label: info.episode !== null ? `S${info.season ?? 1} E${info.episode}` : basename(p),
      files: srtFilesNextTo(p),
    }));
  return { groupId: group.groupId, name: group.groupName, unit: partsUnitFor(getGroupKind(group.groupId)), episodes };
}

/**
 * The same timing for other episodes' files ("shift every episode by this
 * much"): each file moves by it from where it is now, its first version kept
 * as .orig like any save. Files not of this show are refused.
 */
export async function shiftShowFiles(
  fromItemId: string,
  timing: Timing,
  files: ReadonlyArray<{ itemId: string; name: string }>,
): Promise<Array<{ itemId: string; name: string; ok: boolean; message: string }>> {
  const v = await videoOf(fromItemId);
  const show = await showOf(v.path);
  if (!show) throw new SyncError("This video isn't an episode of a show.");
  const allowed = new Set(show.episodes.flatMap((e) => e.files.map((f) => `${e.itemId}\n${f}`)));
  const out = [];
  for (const f of files) {
    if (!allowed.has(`${f.itemId}\n${f.name}`)) {
      out.push({ ...f, ok: false, message: "Not a subtitle of this show's episodes." });
      continue;
    }
    try {
      const r = await saveTiming(f.itemId, f.name, timing);
      out.push({ ...f, ok: true, message: `${r.cues} lines` });
    } catch (error) {
      out.push({ ...f, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** A subtitle file of this item, by name: only one listed next to its video. */
export async function fileOf(itemId: string, name: string): Promise<string> {
  const v = await videoOf(itemId);
  if (name !== basename(name) || !srtFilesNextTo(v.path).includes(name)) {
    throw new SyncError("That isn't one of this video's subtitle files.");
  }
  return join(dirname(v.path), name);
}

export async function readSubtitle(itemId: string, name: string): Promise<{ text: string; hasOriginal: boolean }> {
  const file = await fileOf(itemId, name);
  return { text: readFileSync(file, "utf8"), hasOriginal: existsSync(`${file}.orig`) };
}

/** Rewrites the file with the new timing; the first version stays as "<name>.orig". */
export async function saveTiming(itemId: string, name: string, timing: Timing): Promise<{ cues: number }> {
  if (!(timing.scale > 0.9 && timing.scale < 1.1) || !Number.isFinite(timing.offsetMs) || Math.abs(timing.offsetMs) > 600_000) {
    throw new SyncError("That timing is out of range (at most 10 minutes either way, 10% stretch).");
  }
  const file = await fileOf(itemId, name);
  const cues = parseSrt(readFileSync(file, "utf8"));
  if (!cues.length) throw new SyncError("That file has no subtitle lines this can read.");
  if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
  const moved = retime(cues, timing);
  writeFileSync(file, formatSrt(moved), "utf8");
  await refreshItem(itemId).catch(() => undefined);
  return { cues: moved.length };
}

/** Puts the first version back ("<name>.orig" over the file); the .orig stays. */
export async function restoreOriginal(itemId: string, name: string): Promise<void> {
  const file = await fileOf(itemId, name);
  if (!existsSync(`${file}.orig`)) throw new SyncError("There's no earlier version of this file to go back to.");
  copyFileSync(`${file}.orig`, file);
  await refreshItem(itemId).catch(() => undefined);
}
