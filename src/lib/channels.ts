import "server-only";

import { lineupMs, onNow, seededShuffle, upcoming, type OnNow } from "./channel-schedule";
import { generateId } from "./crypto";
import { asRow, asRows, getDb, transaction } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { getDamagedPathSet } from "./file-checks";
import { listItemsForChannels } from "./jellyfin";
import { getGroup, getGroupedPathMap, listGroups } from "./library-curation";

/**
 * Channels: always-on lineups anyone can tune into, Pluto TV style.
 *
 * Nothing streams while nobody watches. A channel is a lineup worked out once
 * into programmes with running times (channel_slots) plus the moment it
 * started (epoch_ms); what is on is arithmetic on the clock
 * (channel-schedule.ts), done only when someone opens the guide or tunes in,
 * and the ordinary player is started at that point. Live only: no pause, no
 * seeking (the player's live mode).
 *
 * A lineup is the curator's list (channel_entries) of single films or
 * episodes, whole shows in air order, and genre rules (every film in a
 * genre), played in order or in a seeded shuffle. It is worked out again
 * when the channel is saved or rebuilt, never per viewer, so everyone tuned
 * in sees the same thing. A damaged file is left out.
 */

export type OrderMode = "in_order" | "shuffle";

const QUARTER_HOUR_MS = 15 * 60_000;
/**
 * When the lineup has played through: start again ("loop", every channel
 * before v69), go off air and stay to be added to ("stop"), or go ("remove":
 * the channel is deleted the next time the channels are listed).
 */
export type AtEnd = "loop" | "stop" | "remove";
export type EntryKind = "item" | "group" | "genre";

export interface ChannelEntry {
  kind: EntryKind;
  ref: string;
  label: string;
}

export interface Channel {
  id: string;
  name: string;
  orderMode: OrderMode;
  position: number;
  epochMs: number;
  builtAt: number | null;
  atEnd: AtEnd;
  /** Every programme gets exactly this long, so the channel keeps to a timetable; 0 = each its own length. */
  slotMs: number;
}

export interface ChannelSlot {
  itemId: string;
  path: string;
  name: string;
  runtimeMs: number;
}

interface ChannelRow {
  id: string;
  name: string;
  order_mode: string;
  position: number;
  epoch_ms: number;
  built_at: number | null;
  at_end: string;
  slot_ms: number;
}

const toChannel = (r: ChannelRow): Channel => ({
  id: r.id,
  name: r.name,
  orderMode: r.order_mode === "shuffle" ? "shuffle" : "in_order",
  position: r.position,
  epochMs: r.epoch_ms,
  builtAt: r.built_at,
  atEnd: r.at_end === "stop" || r.at_end === "remove" ? r.at_end : "loop",
  slotMs: Math.max(0, r.slot_ms ?? 0),
});

/**
 * How long each programme takes on the channel's clock: its slot when the
 * channel has one (a shorter programme is followed by "next in…", a longer
 * one is cut there), else its own running time.
 */
function timetable(slotMs: number, slots: ChannelSlot[]): Array<{ runtimeMs: number }> {
  return slots.map((s) => ({ runtimeMs: slotMs > 0 ? slotMs : s.runtimeMs }));
}

export function parseAtEnd(value: unknown): AtEnd {
  return value === "stop" || value === "remove" ? value : "loop";
}

/** A slot length from a request: whole minutes up to a day, else 0 (each programme its own length). */
export function parseSlotMs(value: unknown): number {
  const ms = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return ms >= 60_000 && ms <= 24 * 3_600_000 ? Math.round(ms / 60_000) * 60_000 : 0;
}

export function listChannels(nowMs = Date.now()): Channel[] {
  removeFinishedChannels(nowMs);
  return asRows<ChannelRow>(getDb().prepare("SELECT * FROM channels ORDER BY position, created_at").all()).map(toChannel);
}

/**
 * A "remove" channel whose lineup has played through is deleted, entries,
 * slots and all (they cascade). Checked whenever the channels are listed,
 * which is whenever anyone looks at the guide, so nothing has to be scheduled.
 */
function removeFinishedChannels(nowMs: number): void {
  const rows = asRows<ChannelRow>(getDb().prepare("SELECT * FROM channels WHERE at_end = 'remove'").all());
  for (const row of rows) {
    const total = lineupMs(timetable(row.slot_ms ?? 0, getSlots(row.id)));
    if (row.built_at !== null && total > 0 && nowMs >= row.epoch_ms + total) deleteChannel(row.id);
  }
}

export function getChannel(id: string): Channel | null {
  const row = asRow<ChannelRow>(getDb().prepare("SELECT * FROM channels WHERE id = ?").get(id));
  return row ? toChannel(row) : null;
}

export function getEntries(channelId: string): ChannelEntry[] {
  return asRows<{ kind: string; ref: string; label: string }>(
    getDb().prepare("SELECT kind, ref, label FROM channel_entries WHERE channel_id = ? ORDER BY position").all(channelId),
  ).map((r) => ({ kind: r.kind as EntryKind, ref: r.ref, label: r.label }));
}

export function getSlots(channelId: string): ChannelSlot[] {
  return asRows<{ item_id: string; path: string; name: string; runtime_ms: number }>(
    getDb().prepare("SELECT item_id, path, name, runtime_ms FROM channel_slots WHERE channel_id = ? ORDER BY idx").all(channelId),
  ).map((r) => ({ itemId: r.item_id, path: r.path, name: r.name, runtimeMs: r.runtime_ms }));
}

export function createChannel(name: string, orderMode: OrderMode, atEnd: AtEnd = "loop", slotMs = 0): string {
  const id = generateId();
  const now = Date.now();
  const last = asRow<{ p: number | null }>(getDb().prepare("SELECT MAX(position) AS p FROM channels").get());
  getDb()
    .prepare("INSERT INTO channels (id, name, order_mode, at_end, slot_ms, position, epoch_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, name.trim(), orderMode, atEnd, Math.max(0, Math.round(slotMs)), (last?.p ?? -1) + 1, now, now, now);
  return id;
}

/** Name, order and lineup in one go; the lineup is worked out again afterwards. */
export async function saveChannel(
  id: string,
  input: { name: string; orderMode: OrderMode; atEnd: AtEnd; slotMs: number; entries: ChannelEntry[] },
): Promise<{ slots: number; runtimeMs: number }> {
  transaction(() => {
    getDb()
      .prepare("UPDATE channels SET name = ?, order_mode = ?, at_end = ?, slot_ms = ?, updated_at = ? WHERE id = ?")
      .run(input.name.trim(), input.orderMode, input.atEnd, Math.max(0, Math.round(input.slotMs)), Date.now(), id);
    // A timetable starts on the quarter hour, so its slots land on times a
    // person would print in a guide (21:30, 22:15), not 21:37 and 22:22. The
    // channel's clock goes back to the quarter hour it started in.
    if (input.slotMs > 0) {
      getDb()
        .prepare("UPDATE channels SET epoch_ms = epoch_ms - (epoch_ms % ?) WHERE id = ?")
        .run(QUARTER_HOUR_MS, id);
    }
    getDb().prepare("DELETE FROM channel_entries WHERE channel_id = ?").run(id);
    const add = getDb().prepare("INSERT INTO channel_entries (id, channel_id, position, kind, ref, label) VALUES (?, ?, ?, ?, ?, ?)");
    input.entries.forEach((e, i) => add.run(generateId(), id, i, e.kind, e.ref, e.label));
  });
  return rebuildChannel(id);
}

export function deleteChannel(id: string): boolean {
  return Number(getDb().prepare("DELETE FROM channels WHERE id = ?").run(id).changes) > 0;
}

/** Moves a channel one place along the guide. */
export function moveChannel(id: string, direction: -1 | 1): void {
  const all = listChannels();
  const i = all.findIndex((c) => c.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= all.length) return;
  [all[i], all[j]] = [all[j]!, all[i]!];
  transaction(() => {
    const set = getDb().prepare("UPDATE channels SET position = ? WHERE id = ?");
    all.forEach((c, position) => set.run(position, c.id));
  });
}

/**
 * Works the lineup out into programmes: each entry expanded (a show into its
 * episodes in air order, a genre into its films), damaged files left out,
 * then in order or shuffled. The channel's clock (epoch) is kept, so a
 * rebuild moves what is on rather than starting the channel over.
 */
export async function rebuildChannel(id: string): Promise<{ slots: number; runtimeMs: number }> {
  const channel = getChannel(id);
  if (!channel) return { slots: 0, runtimeMs: 0 };
  const items = await listItemsForChannels();
  const byPath = new Map(items.filter((i) => i.Path).map((i) => [i.Path!, i]));
  const damaged = getDamagedPathSet();
  const grouped = getGroupedPathMap();

  const slots: ChannelSlot[] = [];
  const push = (path: string) => {
    const item = byPath.get(path);
    const runtimeMs = item?.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000) : 0;
    if (!item || runtimeMs <= 0 || damaged.has(path)) return;
    slots.push({ itemId: item.Id, path, name: item.Name, runtimeMs });
  };
  for (const entry of getEntries(id)) {
    if (entry.kind === "item") push(entry.ref);
    else if (entry.kind === "group") {
      const group = getGroup(entry.ref);
      const paths = [...(group?.paths ?? [])].sort(
        (a, b) => parseEpisodeInfo(a).sortKey - parseEpisodeInfo(b).sortKey || a.localeCompare(b),
      );
      for (const path of paths) push(path);
    } else if (entry.kind === "genre") {
      // Films only: an episode in a show's genre is not a film to schedule on its own.
      const films = items
        .filter((i) => i.Path && !grouped.has(i.Path) && (i.Genres ?? []).includes(entry.ref))
        .sort((a, b) => a.Name.localeCompare(b.Name));
      for (const film of films) push(film.Path!);
    }
  }

  const builtAt = Date.now();
  const ordered = channel.orderMode === "shuffle" ? seededShuffle(slots, `${id}:${builtAt}`) : slots;
  transaction(() => {
    getDb().prepare("DELETE FROM channel_slots WHERE channel_id = ?").run(id);
    const add = getDb().prepare(
      "INSERT INTO channel_slots (channel_id, idx, item_id, path, name, runtime_ms) VALUES (?, ?, ?, ?, ?, ?)",
    );
    ordered.forEach((s, idx) => add.run(id, idx, s.itemId, s.path, s.name, s.runtimeMs));
    getDb().prepare("UPDATE channels SET built_at = ? WHERE id = ?").run(builtAt, id);
  });
  return { slots: ordered.length, runtimeMs: lineupMs(timetable(channel.slotMs, ordered)) };
}

/** The lineup's length on the channel's clock, slots and all. */
export function channelRuntimeMs(channel: Channel): number {
  return lineupMs(timetable(channel.slotMs, getSlots(channel.id)));
}

export interface Programme extends OnNow {
  slot: ChannelSlot;
  /**
   * When the programme itself stops: its own end, or the slot's end where it
   * runs longer (cut there). Until `endsAtMs` after that, the channel shows
   * "next in…".
   */
  playsUntilMs: number;
}

function programme(on: OnNow, slots: ChannelSlot[]): Programme {
  const slot = slots[on.index]!;
  return { ...on, slot, playsUntilMs: Math.min(on.endsAtMs, on.startedAtMs + slot.runtimeMs) };
}

/** What a channel has on now and next (`count` programmes), from its clock. */
export function channelGuide(channel: Channel, nowMs: number, count = 4): Programme[] {
  const slots = getSlots(channel.id);
  return upcoming(timetable(channel.slotMs, slots), channel.epochMs, nowMs, count, channel.atEnd === "loop").map((p) =>
    programme(p, slots),
  );
}

/** Just what is on now. */
export function channelOnNow(channel: Channel, nowMs: number): Programme | null {
  const slots = getSlots(channel.id);
  const on = onNow(timetable(channel.slotMs, slots), channel.epochMs, nowMs, channel.atEnd === "loop");
  return on ? programme(on, slots) : null;
}

/** The channels either side on the guide, round the ends: a remote's up/down. */
export function neighbours(id: string): { previous: string | null; next: string | null } {
  const live = listChannels().filter((c) => getSlots(c.id).length > 0);
  const i = live.findIndex((c) => c.id === id);
  if (i < 0 || live.length < 2) return { previous: null, next: null };
  return { previous: live[(i - 1 + live.length) % live.length]!.id, next: live[(i + 1) % live.length]!.id };
}

/* ---- The console's search, for adding to a lineup ---- */

let searchCache: { at: number; items: Awaited<ReturnType<typeof listItemsForChannels>> } | null = null;

async function searchableItems() {
  if (!searchCache || Date.now() - searchCache.at > 5 * 60_000) {
    searchCache = { at: Date.now(), items: await listItemsForChannels() };
  }
  return searchCache.items;
}

/** Films, single episodes and shows matching `q`, and every genre: what a lineup can hold. */
export async function searchForChannel(q: string): Promise<{ entries: ChannelEntry[]; genres: string[] }> {
  const items = await searchableItems();
  const grouped = getGroupedPathMap();
  const needle = q.trim().toLowerCase();
  const entries: ChannelEntry[] = [];
  if (needle) {
    for (const g of listGroups()) {
      if (g.groupName.toLowerCase().includes(needle)) {
        entries.push({ kind: "group", ref: g.groupId, label: `${g.groupName} (all ${g.paths.length} episodes)` });
      }
    }
    for (const item of items) {
      if (!item.Path || !item.Name.toLowerCase().includes(needle)) continue;
      const show = grouped.get(item.Path);
      entries.push({ kind: "item", ref: item.Path, label: show ? `${show.groupName}: ${item.Name}` : item.Name });
      if (entries.length >= 40) break;
    }
  }
  const genres = [...new Set(items.flatMap((i) => i.Genres ?? []))].sort((a, b) => a.localeCompare(b));
  return { entries, genres };
}
