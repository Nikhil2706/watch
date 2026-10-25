/**
 * Subtitle timing, for the sync screen in /admin (subtitles/sync): read an
 * .srt, move it, write it back. Pure, so it is tested directly; used in the
 * browser (the live preview) and on the server (saving).
 *
 * A timing change is t' = t * scale + offsetMs. Most subtitles that are off
 * are off by a constant (offset only). One that drifts, right at the start
 * and seconds off by the end, was timed for another frame rate (25 vs
 * 23.976): fitting two lines heard at two moments gives both numbers.
 */

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Timing {
  /** 1 means no stretch. */
  scale: number;
  offsetMs: number;
}

export const NO_CHANGE: Timing = { scale: 1, offsetMs: 0 };

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toMs(stamp: string): number | null {
  const m = TIME.exec(stamp);
  if (!m) return null;
  const [, h, min, s, frac] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(frac!.padEnd(3, "0"));
}

export function formatMs(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

/** Reads an .srt. Tolerates a BOM, Windows line endings, blank padding and missing numbers. */
export function parseSrt(text: string): Cue[] {
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l, i, all) => l.trim() !== "" || (i > 0 && i < all.length - 1));
    const timeLine = lines.findIndex((l) => l.includes("-->"));
    if (timeLine === -1) continue;
    const [a, b] = lines[timeLine]!.split("-->");
    const startMs = toMs(a ?? "");
    const endMs = toMs(b ?? "");
    if (startMs === null || endMs === null) continue;
    const text = lines.slice(timeLine + 1).join("\n").trim();
    if (!text) continue;
    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }
  return cues;
}

export function formatSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatMs(c.startMs)} --> ${formatMs(c.endMs)}\n${c.text}\n`).join("\n");
}

export function applyTiming(t: number, timing: Timing): number {
  return t * timing.scale + timing.offsetMs;
}

/** Every cue moved; any that would start before 0 are dropped (they can't be shown). */
export function retime(cues: readonly Cue[], timing: Timing): Cue[] {
  return cues
    .map((c) => ({ ...c, startMs: Math.round(applyTiming(c.startMs, timing)), endMs: Math.round(applyTiming(c.endMs, timing)) }))
    .filter((c) => c.endMs > 0)
    .map((c, i) => ({ ...c, index: i + 1, startMs: Math.max(0, c.startMs) }));
}

/** The cue showing at video time `ms`, with a timing applied, if any. */
export function cueAt(cues: readonly Cue[], ms: number, timing: Timing): Cue | null {
  for (const c of cues) {
    if (applyTiming(c.startMs, timing) <= ms && ms < applyTiming(c.endMs, timing)) return c;
  }
  return null;
}

/** "This line is being said now": the offset that puts its start at `videoMs` (keeping any stretch). */
export function offsetFromLine(cue: Cue, videoMs: number, scale = 1): Timing {
  return { scale, offsetMs: Math.round(videoMs - cue.startMs * scale) };
}

/**
 * Two lines heard at two moments: the stretch and offset that put both where
 * they were heard. Refused when the lines are too close together to tell a
 * stretch from a slip (under a minute apart), or the stretch is implausible
 * (more than 10% either way: no frame-rate mismatch is that big).
 */
export function fitTwoPoints(
  a: { cueMs: number; videoMs: number },
  b: { cueMs: number; videoMs: number },
): Timing | { error: string } {
  if (Math.abs(b.cueMs - a.cueMs) < 60_000) return { error: "Pick two lines at least a minute apart." };
  const scale = (b.videoMs - a.videoMs) / (b.cueMs - a.cueMs);
  if (!(scale > 0.9 && scale < 1.1)) return { error: "Those two don't fit a steady drift; check you picked the right lines." };
  return { scale: Math.round(scale * 1e6) / 1e6, offsetMs: Math.round(a.videoMs - a.cueMs * scale) };
}

/** "+1.2 s", "−0.4 s", "+2.0 s and 4.1% slower" for the screen. */
export function describeTiming(t: Timing): string {
  const s = t.offsetMs / 1000;
  const shift = `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(1)} s`;
  if (Math.abs(t.scale - 1) < 1e-6) return shift;
  const pct = Math.abs(t.scale - 1) * 100;
  return `${shift}, ${pct.toFixed(2)}% ${t.scale > 1 ? "slower" : "faster"}`;
}
