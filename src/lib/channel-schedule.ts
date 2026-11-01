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

/** The programme on at `nowMs`, or null for a lineup with nothing to show. */
export function onNow(slots: readonly Slot[], epochMs: number, nowMs: number): OnNow | null {
  const cycle = slots.reduce((sum, s) => sum + Math.max(0, s.runtimeMs), 0);
  if (cycle <= 0) return null;
  const elapsed = nowMs - epochMs;
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

/** What is on now and the `count - 1` programmes after it, with their wall-clock times: the guide. */
export function upcoming(slots: readonly Slot[], epochMs: number, nowMs: number, count: number): OnNow[] {
  const first = onNow(slots, epochMs, nowMs);
  if (!first) return [];
  const out: OnNow[] = [first];
  let index = first.index;
  let startedAtMs = first.endsAtMs;
  while (out.length < count) {
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
