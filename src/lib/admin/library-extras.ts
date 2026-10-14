/**
 * The rest of the Library tab's data shaping (step 2a-ii): show settings'
 * episode list and release schedule, franchises, History, special-feature
 * mappings and "match from folders". Ported from curator.html; no React.
 */

import { episodeGaps } from "../episode-gaps.ts";

/* ---- show settings ------------------------------------------------ */

export interface GroupMember {
  id: string;
  name: string;
  path: string | null;
  label: string | null;
  season: number | null;
  episode: number | null;
}

/**
 * Holes in each season's numbering, from the episode numbers in the
 * filenames. Only gaps BETWEEN what is here: a season that stops at 21 when
 * 22 exist upstream reports nothing, because nothing local can know that.
 */
export function seasonGaps(items: readonly Pick<GroupMember, "season" | "episode">[]): Array<{ season: number; episode: number }> {
  const bySeason = new Map<number, number[]>();
  for (const it of items) {
    if (typeof it.episode !== "number" || it.episode <= 0) continue;
    const season = typeof it.season === "number" ? it.season : 0;
    bySeason.set(season, [...(bySeason.get(season) ?? []), it.episode]);
  }
  const out: Array<{ season: number; episode: number }> = [];
  for (const [season, nums] of bySeason) for (const episode of episodeGaps(nums)) out.push({ season, episode });
  return out.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export function gapsLabel(gaps: ReadonlyArray<{ season: number; episode: number }>): string {
  return gaps.map((g) => (g.season ? `S${g.season}E${g.episode}` : `episode ${g.episode}`)).join(", ");
}

/** The episode's own label when the filename has one, and the (possibly wrong) title it is tagged with when that differs. */
export function memberTitle(m: Pick<GroupMember, "label" | "name">): { primary: string; taggedAs: string | null } {
  const primary = m.label || m.name;
  return { primary, taggedAs: m.label && m.name && primary !== m.name ? m.name : null };
}

export function fileName(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

export function fetchAllReport(succeeded: number, failed: number): string {
  return `Fetched ${succeeded}${failed ? `, ${failed} could not be found on OMDb — those keep their current titles` : ""}.`;
}

export function seriesLinkedReport(d: { seriesName?: string | null; posterFound?: boolean; kind?: string | null } | null): string {
  return (
    "Series linked" +
    (d?.seriesName ? ` — ${d.seriesName}` : "") +
    (d?.posterFound ? ". Poster found for Browse and the collection page." : ". Fetch OMDb is ready for each episode.") +
    (d?.kind ? ` OMDb calls this a ${d.kind === "series" ? "TV series — tiles will say episodes." : "film — tiles will say parts."}` : "")
  );
}

/* ---- release schedule (rollout.ts) --------------------------------- */

export type RolloutMode = "immediate" | "daily" | "weekly";

export interface RolloutForm {
  mode: RolloutMode;
  perRelease: string;
  weekday: string;
  timeOfDay: string;
  /** datetime-local value, in the browser's own time zone. */
  start: string;
  total: string;
}

export interface RolloutPlan {
  mode: RolloutMode;
  perRelease: number;
  weekday: number | null;
  timeOfDay: string | null;
  startAt: number;
}

export interface RolloutSlot {
  slotIndex: number;
  releaseAt: number;
  revealedAt: number | null;
  path?: string | null;
  imdbId?: string | null;
}

/** "2026-10-14T09:05" for a datetime-local input, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function rolloutFormFrom(plan: RolloutPlan | null, slots: readonly RolloutSlot[], now: number): RolloutForm {
  if (!plan) return { mode: "immediate", perRelease: "1", weekday: "0", timeOfDay: "09:00", start: toLocalInput(now), total: "" };
  return {
    mode: plan.mode,
    perRelease: String(plan.perRelease),
    weekday: plan.weekday !== null ? String(plan.weekday) : "0",
    timeOfDay: plan.timeOfDay || "09:00",
    start: toLocalInput(plan.startAt),
    total: String(slots.length),
  };
}

/** The request body, or why it can't be sent. */
export function rolloutRequest(
  subjectType: "group" | "series",
  subjectId: string,
  f: RolloutForm,
  now: number,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const expectedTotal = Number.parseInt(f.total, 10);
  if (!expectedTotal || expectedTotal < 1) return { ok: false, error: "Enter the total number expected." };
  return {
    ok: true,
    body: {
      subjectType,
      subjectId,
      mode: f.mode,
      perRelease: Number.parseInt(f.perRelease, 10) || 1,
      weekday: Number.parseInt(f.weekday, 10),
      timeOfDay: f.timeOfDay,
      startAt: f.start ? new Date(f.start).getTime() : now,
      expectedTotal,
    },
  };
}

export function slotStatus(s: Pick<RolloutSlot, "releaseAt" | "revealedAt">, now: number): "revealed" | "due" | "scheduled" {
  if (s.revealedAt) return "revealed";
  return s.releaseAt <= now ? "due" : "scheduled";
}

export function slotsSummary(slots: readonly RolloutSlot[]): string {
  const pending = slots.filter((s) => !s.revealedAt).length;
  return `${slots.length - pending} of ${slots.length} revealed, ${pending} pending`;
}

export function noScheduleMessage(subjectType: "group" | "series"): string {
  return subjectType === "group"
    ? "No schedule set — every confirmed episode is visible as soon as it's fetched."
    : "No schedule set — every owned film in this series is visible as soon as it's added.";
}

/* ---- franchises ---------------------------------------------------- */

export interface FilmSeriesSummary {
  id: string;
  name: string;
  entryCount: number;
  matchedCount: number;
  source: string;
}

export function franchiseStatus(s: FilmSeriesSummary): string {
  const complete = s.entryCount > 0 && s.matchedCount >= s.entryCount;
  return (complete ? `Complete — all ${s.entryCount} here` : `${s.matchedCount} of ${s.entryCount} here`) + (s.source === "manual" ? " · made by hand" : "");
}

export interface SyncRound {
  created: number;
  updated: number;
  removed: number;
  collections: number;
  done: boolean;
}

/** TMDB is synced a budget at a time: at most ten rounds, adding up what each did. */
export async function syncAllRounds(round: () => Promise<SyncRound>, maxRounds = 10): Promise<SyncRound & { rounds: number }> {
  const total = { created: 0, updated: 0, removed: 0, collections: 0, done: false, rounds: 0 };
  for (;;) {
    const r = await round();
    total.created += r.created;
    total.updated += r.updated;
    total.removed += r.removed;
    total.collections = r.collections;
    total.done = r.done;
    total.rounds += 1;
    if (r.done || total.rounds >= maxRounds) return total;
  }
}

export function syncReport(t: SyncRound): string {
  return (
    `${t.collections} franchises from TMDB — ${t.created} new, ${t.updated} refreshed` +
    (t.removed ? `, ${t.removed} no longer in the library` : "") +
    (t.done ? "." : ". More to fetch: run it again.")
  );
}

/* ---- special features ---------------------------------------------- */

export const SF_KINDS = [
  { kind: "film", label: "Film", list: "films" },
  { kind: "franchise", label: "Franchise", list: "franchises" },
  { kind: "director", label: "Director", list: "directors" },
  { kind: "actor", label: "Actor", list: "actors" },
] as const;

export function sfKindLabel(kind: string): string {
  return SF_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** What the picker offers for a kind: every film, franchise, director or actor there is. */
export function sfOptions(
  targets: Record<string, Array<{ id: string; label: string }>> | null,
  kind: string,
): Array<{ id: string; label: string }> {
  const list = SF_KINDS.find((k) => k.kind === kind)?.list;
  return (list && targets?.[list]) || [];
}

/** The typed text must be one of the options; returns it, or null. */
export function sfPick(options: ReadonlyArray<{ id: string; label: string }>, typed: string): { id: string; label: string } | null {
  return options.find((o) => o.label === typed) ?? null;
}

/* ---- match from folders -------------------------------------------- */

export interface FolderMatch {
  path: string;
  itemId?: string;
  title: string;
  year?: number | null;
  why: string;
  certainty?: string;
  status?: string;
  posterPath?: string | null;
}

export function folderMatchFile(path: string): string {
  return String(path || "").replace(/^\/media\//, "");
}

export function folderMatchHeading(open: number, applied: number): string {
  return open ? `${open} file${open === 1 ? "" : "s"} the folders suggest a match for` : applied ? "Matched from their folders" : "";
}

export function folderMatchRunReport(r: { looked?: number; applied?: number; suggested?: number; failed?: number }): string {
  return (
    `${r.looked ?? 0} unidentified file${r.looked === 1 ? "" : "s"}: ${r.applied ?? 0} matched from their folders, ${r.suggested ?? 0} to confirm` +
    (r.failed ? `, ${r.failed} could not be applied` : "") +
    "."
  );
}

export function kindBackfillReport(d: { checked?: number; resolved?: number; unresolved?: number }): string {
  if (!d.checked) return "Every linked show already has a kind.";
  return (
    `${d.resolved ?? 0} of ${d.checked} resolved` +
    (d.unresolved ? ` — ${d.unresolved} OMDb had no answer for; set those by hand in Show settings.` : ".")
  );
}
