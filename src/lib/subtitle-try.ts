import "server-only";

import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { getFullItem, refreshItem } from "./jellyfin";
import { downloadSubtitle } from "./opensubtitles";
import { chosenSubtitlePath } from "./subtitle-choices";
import { formatSrt, NO_CHANGE, parseSrt, retime, type Timing } from "./srt-timing";

/**
 * Trying a subtitle before keeping it (the sync screen's "Try" mode).
 * OpenSubtitles only hands over a subtitle's text by download, which spends
 * one of the day's quota; so what is tried is held here for a day, and trying
 * it again or keeping it spends nothing more. Keeping writes it next to the
 * video (beside any already there), with whatever shift was set while trying.
 */

const HOLD_MS = 24 * 60 * 60 * 1000;

interface Held {
  content: string;
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateTriedSubtitles: Map<number, Held> | undefined;
}

function held(): Map<number, Held> {
  globalThis.__jellyfinGateTriedSubtitles ??= new Map();
  const map = globalThis.__jellyfinGateTriedSubtitles;
  const now = Date.now();
  for (const [id, h] of map) if (now - h.at > HOLD_MS) map.delete(id);
  return map;
}

export class TryError extends Error {}

/** A candidate's text: held if tried in the last day, else downloaded (one of the day's quota). */
export async function tryCandidate(fileId: number): Promise<{ text: string; spent: boolean; downloadsLeft: number | null }> {
  const cache = held();
  const hit = cache.get(fileId);
  if (hit) return { text: hit.content, spent: false, downloadsLeft: null };
  const d = await downloadSubtitle(fileId);
  if (!parseSrt(d.content).length) throw new TryError("That download isn't a subtitle this can read (not .srt text).");
  cache.set(fileId, { content: d.content, at: Date.now() });
  return { text: d.content, spent: true, downloadsLeft: d.remaining };
}

/** Writes a tried candidate next to the video, with the shift set while trying. */
export async function keepCandidate(itemId: string, fileId: number, timing: Timing = NO_CHANGE): Promise<{ fileName: string }> {
  if (!(timing.scale > 0.9 && timing.scale < 1.1) || !Number.isFinite(timing.offsetMs) || Math.abs(timing.offsetMs) > 600_000) {
    throw new TryError("That timing is out of range (at most 10 minutes either way, 10% stretch).");
  }
  const item = await getFullItem(itemId);
  const path = typeof item.Path === "string" ? item.Path : null;
  if (!path) throw new TryError("This item has no file.");
  const { text } = await tryCandidate(fileId);
  const shifted = timing.offsetMs === 0 && timing.scale === 1 ? text : formatSrt(retime(parseSrt(text), timing));
  const target = chosenSubtitlePath(path, existsSync);
  writeFileSync(target, shifted, "utf8");
  await refreshItem(itemId).catch(() => undefined);
  return { fileName: basename(target) };
}
