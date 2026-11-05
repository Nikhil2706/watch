/**
 * What a channel is showing, worked out from a clock.
 *
 * A channel is not a stream. It is a lineup of programmes with their running
 * times (channel_slots) and the moment it started (epoch). Where it is now is
 * arithmetic: how long since the epoch, wrapped round the length of the whole
 * lineup, then which programme that lands in and how far into it. Nothing is
 * played, read or sent while nobody is watching; someone tuning in gets the
 * ordinary player started at that point, and two people on one channel are in
 * step because they share the clock, not a stream.
 *
 * ZERO imports, like episode-gaps.ts, so its tests can load it.
 */

export interface Slot {
  /** How long the programme runs, in milliseconds. */
  runtimeMs: number;
}

export interface OnNow {
  /** Index of the programme on now. */
  index: number;
  /** How far into it, in milliseconds. */
  offsetMs: number;
  /** When it started, on the wall clock (ms since 1970). */
  startedAtMs: number;
  /** When it ends, on the wall clock. */
  endsAtMs: number;
}

/** The whole lineup's running time, once through. */
export function lineupMs(slots: readonly Slot[]): number {
  return slots.reduce((sum, s) => sum + Math.max(0, s.runtimeMs), 0);
}

/**
 * The programme on at `nowMs`, or null for a lineup with nothing to show.
 * With `loop` false the lineup plays once: nothing is on before the epoch or
 * after the last programme ends (the channel is off air).
 */
export function onNow(slots: readonly Slot[], epochMs: number, nowMs: number, loop = true): OnNow | null {
  const cycle = lineupMs(slots);
  if (cycle <= 0) return null;
  const elapsed = nowMs - epochMs;
  if (!loop && (elapsed < 0 || elapsed >= cycle)) return null;
  // Wrapped into [0, cycle): before the epoch counts back from the end.
  const intoCycle = ((elapsed % cycle) + cycle) % cycle;
  let at = 0;
  for (let index = 0; index < slots.length; index++) {
    const runtime = Math.max(0, slots[index]!.runtimeMs);
    if (runtime > 0 && intoCycle < at + runtime) {
      const offsetMs = intoCycle - at;
      const startedAtMs = nowMs - offsetMs;
      return { index, offsetMs, startedAtMs, endsAtMs: startedAtMs + runtime };
    }
    at += runtime;
  }
  return null;
}

/**
 * What is on now and the `count - 1` programmes after it, with their
 * wall-clock times: the guide. A lineup that does not loop runs out at its
 * last programme, so its guide can be shorter than `count`.
 */
export function upcoming(slots: readonly Slot[], epochMs: number, nowMs: number, count: number, loop = true): OnNow[] {
  const first = onNow(slots, epochMs, nowMs, loop);
  if (!first) return [];
  const out: OnNow[] = [first];
  let index = first.index;
  let startedAtMs = first.endsAtMs;
  while (out.length < count) {
    if (!loop && index + 1 >= slots.length) break;
    index = (index + 1) % slots.length;
    const runtime = Math.max(0, slots[index]!.runtimeMs);
    if (runtime === 0) continue;
    out.push({ index, offsetMs: 0, startedAtMs, endsAtMs: startedAtMs + runtime });
    startedAtMs += runtime;
  }
  return out;
}

/**
 * The same shuffle every time for the same seed, so everyone tuned to a
 * shuffled channel sees the same order, and it only changes when the lineup
 * is rebuilt (Fisher-Yates over a small seeded generator, mulberry32).
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (Math.imul(31, state) + seed.charCodeAt(i)) | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type SlotRule = "fixed" | "round" | "pack";

/**
 * How long one programme takes on a timetabled channel's clock. `fixed`: the
 * slot exactly (a longer programme is cut at its end). `round`: the
 * programme's own length rounded up to the next whole slot, so nothing is cut
 * and the next one still starts on a mark. No slot: its own length.
 */
export function slotLength(runtimeMs: number, slotMs: number, rule: SlotRule): number {
  if (slotMs <= 0) return runtimeMs;
  if (rule === "fixed") return slotMs;
  return Math.max(1, Math.ceil(runtimeMs / slotMs)) * slotMs;
}

/**
 * The mark a timetable's clock starts on, so its slots land on times a guide
 * would print: the slot itself when it divides a quarter hour (every 5
 * minutes: 12:05, 12:35), else the quarter hour (45-minute slots: 21:30, 22:15).
 */
export function timetableMarkMs(slotMs: number): number {
  const quarter = 15 * 60_000;
  return slotMs > 0 && quarter % slotMs === 0 ? slotMs : quarter;
}

/** One programme for shuffleInBlocks: the block it belongs to (null on its own) and its place in it. */
export interface Blocked<T> {
  item: T;
  block: string | null;
  order: number;
}

/**
 * A shuffle that keeps what belongs together together: films in parts, a
 * series, a franchise. Each block is one unit, in its own order (part one
 * first, a franchise by release), and the units are shuffled with the single
 * films around them, the same way every time for the same seed.
 */
export function shuffleInBlocks<T>(items: readonly Blocked<T>[], seed: string): T[] {
  const byBlock = new Map<string, Blocked<T>[]>();
  const units: Blocked<T>[][] = [];
  for (const entry of items) {
    if (entry.block === null) {
      units.push([entry]);
      continue;
    }
    let unit = byBlock.get(entry.block);
    if (!unit) {
      unit = [];
      byBlock.set(entry.block, unit);
      units.push(unit);
    }
    unit.push(entry);
  }
  for (const unit of units) unit.sort((a, b) => a.order - b.order);
  return seededShuffle(units, seed).flatMap((unit) => unit.map((entry) => entry.item));
}

/** How far a packed slot may run over before the last programme is cut at its end (end credits, not story). */
export const PACK_OVERRUN_MS = 90_000;

/**
 * "pack" slots: programmes back to back, as many as fit in one slot (two
 * 22-minute episodes in 45 minutes), then "next in…" to the slot's end. A
 * slot that runs over by up to PACK_OVERRUN_MS keeps its length and the last
 * programme is cut there; a programme longer than a slot gets its own,
 * rounded up to whole slots (an 84-minute special: 90). Returns each
 * programme's length on the clock, so the slots land on the marks.
 */
export function packedLengths(runtimes: readonly number[], slotMs: number): number[] {
  const out: number[] = [];
  let block: number[] = [];
  const close = () => {
    if (block.length === 0) return;
    const total = block.reduce((sum, r) => sum + r, 0);
    const length = total <= slotMs + PACK_OVERRUN_MS ? slotMs : Math.ceil(total / slotMs) * slotMs;
    // Every programme plays in full but the last, which takes the rest.
    const before = block.slice(0, -1);
    out.push(...before, length - before.reduce((sum, r) => sum + r, 0));
    block = [];
  };
  for (const runtime of runtimes) {
    const total = block.reduce((sum, r) => sum + r, 0);
    if (block.length > 0 && total + runtime > slotMs + PACK_OVERRUN_MS) close();
    block.push(runtime);
  }
  close();
  return out;
}
