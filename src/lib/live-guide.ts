import "server-only";

import { channelGuide, getChannel, listChannels, skipGoneProgramme, type Programme } from "./channels";
import { episodeCards } from "./episode-cards";
import { getItem, posterUrl, stillUrl, type MediaItem } from "./media";
import type { ResolvedSession } from "./session";

/** A channel as the guide and Home's "On now" row show it. */
export interface GuideChannel {
  id: string;
  name: string;
  now: Programme;
  next: Programme | null;
  /** Show and episode for an episode ("Buffy The Vampire Slayer · S2 E3 · …"), the title for a film. */
  nowTitle: string;
  art: string | null;
}

/**
 * Every channel with something on, from its clock (channels.ts), with the
 * programme's own artwork through this viewer's listing. Cheap: a few local
 * reads and one item lookup per channel.
 */
export async function liveGuide(session: ResolvedSession, nowMs = Date.now()): Promise<GuideChannel[]> {
  const out: GuideChannel[] = [];
  for (const listed of listChannels()) {
    // A programme deleted since the lineup was built is skipped (channels.ts).
    const channel = (await skipGoneProgramme(listed, nowMs)) ? (getChannel(listed.id) ?? listed) : listed;
    const [now, next] = channelGuide(channel, nowMs, 2);
    if (!now) continue;
    const item: MediaItem | null = await getItem(session, now.slot.itemId).catch(() => null);
    const cards = item ? episodeCards([item]) : null;
    const show = item ? cards!.titles.get(item.Id) : undefined;
    const line = item ? cards!.lines.get(item.Id) : undefined;
    out.push({
      id: channel.id,
      name: channel.name,
      now,
      next: next ?? null,
      nowTitle: show ? `${show} · ${line ?? now.slot.name}` : now.slot.name,
      art: item ? (show ? stillUrl(item, 480) : posterUrl(item, 320)) : null,
    });
  }
  return out;
}

/** One programme on the grid, with what the guide's details panel shows. */
export interface GridProgramme {
  itemId: string;
  /** The show's name for an episode, else the film's. */
  title: string;
  /** "S1 E3 · Witch" for an episode, the year for a film. */
  line: string | null;
  startMs: number;
  /** The end of its slot on the channel's clock (a "next in…" gap included). */
  endMs: number;
  art: string | null;
  overview: string | null;
}

export interface GridChannel {
  id: string;
  /** Its number on the guide, from 1, in the guide's order. */
  number: number;
  name: string;
  programmes: GridProgramme[];
}

/**
 * The Pluto-style guide: every channel, and every programme from now to
 * `hours` ahead (the one on now included from its start). Programmes come
 * from each channel's clock, as on the channel page; a deleted one is
 * skipped first (channels.ts).
 */
export async function liveGuideGrid(session: ResolvedSession, nowMs = Date.now(), hours = 3): Promise<GridChannel[]> {
  const until = nowMs + hours * 3_600_000;
  const items = new Map<string, Promise<MediaItem | null>>();
  const item = (id: string) => {
    if (!items.has(id)) items.set(id, getItem(session, id).catch(() => null));
    return items.get(id)!;
  };

  const out: GridChannel[] = [];
  let number = 0;
  for (const listed of listChannels(nowMs)) {
    const channel = (await skipGoneProgramme(listed, nowMs)) ? (getChannel(listed.id) ?? listed) : listed;
    // Enough of the lineup to fill the window, without walking a whole loop.
    let guide = channelGuide(channel, nowMs, 12);
    for (let count = 24; guide.length > 0 && guide[guide.length - 1]!.endsAtMs < until && count <= 96; count *= 2) {
      const longer = channelGuide(channel, nowMs, count);
      if (longer.length === guide.length) break;
      guide = longer;
    }
    const inWindow = guide.filter((p) => p.startedAtMs < until);
    if (inWindow.length === 0) continue;
    number += 1;
    const programmes = await Promise.all(
      inWindow.map(async (p) => {
        const found = await item(p.slot.itemId);
        const cards = found ? episodeCards([found]) : null;
        const show = found ? cards!.titles.get(found.Id) : undefined;
        const episodeLine = found ? cards!.lines.get(found.Id) : undefined;
        return {
          itemId: p.slot.itemId,
          title: show ?? found?.Name ?? p.slot.name,
          line: show ? (episodeLine ?? p.slot.name) : found?.ProductionYear ? String(found.ProductionYear) : null,
          startMs: p.startedAtMs,
          endMs: p.endsAtMs,
          art: found ? (show ? stillUrl(found, 640) : posterUrl(found, 400)) : null,
          overview: found?.Overview ?? null,
        };
      }),
    );
    out.push({ id: channel.id, number, name: channel.name, programmes });
  }
  return out;
}
