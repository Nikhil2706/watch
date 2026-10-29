import "server-only";

import { channelGuide, listChannels, type Programme } from "./channels";
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
  for (const channel of listChannels()) {
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
