import "server-only";

import { randomUUID } from "node:crypto";

import { asRow, asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { getGroup } from "./library-curation";

/**
 * Scheduled rollout for a TV show (library_groups) or a film series
 * (film_series) — see DESIGN-scheduled-rollout.md and schema.ts's own
 * comment on why one table pair covers both. This module is deliberately
 * Jellyfin-free (pure local SQLite): reconcileSeriesSlots() below needs to
 * know which of a film series' entries are actually owned, which requires
 * a Jellyfin lookup — callers resolve that themselves (admin routes
 * already have listAllMoviesAdmin() for exactly this) and pass in the
 * result, rather than this module reaching out to Jellyfin on its own.
 */

export type RolloutSubjectType = "group" | "series";
export type RolloutMode = "immediate" | "daily" | "weekly";

export interface RolloutPlan {
  id: string;
  subjectType: RolloutSubjectType;
  subjectId: string;
  mode: RolloutMode;
  perRelease: number;
  weekday: number | null;
  timeOfDay: string | null;
  startAt: number;
  expectedTotal: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RolloutSlot {
  id: string;
  planId: string;
  slotIndex: number;
  releaseAt: number;
  path: string | null;
  imdbId: string | null;
  revealedAt: number | null;
}

interface PlanRow {
  id: string;
  subject_type: RolloutSubjectType;
  subject_id: string;
  mode: RolloutMode;
  per_release: number;
  weekday: number | null;
  time_of_day: string | null;
  start_at: number;
  expected_total: number | null;
  created_at: number;
  updated_at: number;
}

function planFromRow(r: PlanRow): RolloutPlan {
  return {
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    mode: r.mode,
    perRelease: r.per_release,
    weekday: r.weekday,
    timeOfDay: r.time_of_day,
    startAt: r.start_at,
    expectedTotal: r.expected_total,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface SlotRow {
  id: string;
  plan_id: string;
  slot_index: number;
  release_at: number;
  path: string | null;
  imdb_id: string | null;
  revealed_at: number | null;
}

function slotFromRow(r: SlotRow): RolloutSlot {
  return {
    id: r.id,
    planId: r.plan_id,
    slotIndex: r.slot_index,
    releaseAt: r.release_at,
    path: r.path,
    imdbId: r.imdb_id,
    revealedAt: r.revealed_at,
  };
}

export function getRolloutPlan(subjectType: RolloutSubjectType, subjectId: string): RolloutPlan | null {
  const row = asRow<PlanRow>(
    getDb().prepare("SELECT * FROM library_rollout_plans WHERE subject_type = ? AND subject_id = ?").get(subjectType, subjectId),
  );
  return row ? planFromRow(row) : null;
}

export function listRolloutSlots(planId: string): RolloutSlot[] {
  return asRows<SlotRow>(
    getDb().prepare("SELECT * FROM library_rollout_slots WHERE plan_id = ? ORDER BY slot_index ASC").all(planId),
  ).map(slotFromRow);
}

/**
 * Advances a release timestamp by one cadence step from `from` — "next
 * day" for daily, "next occurrence of `weekday` at `timeOfDay`" for
 * weekly. Weekly's own first occurrence can land on `from`'s own day if
 * that day already matches and hasn't passed `timeOfDay` yet; every step
 * after the first always moves forward a full week so two slots can never
 * collide on the same day.
 */
function nextReleaseTime(mode: RolloutMode, from: number, weekday: number | null, timeOfDay: string | null, isFirst: boolean): number {
  if (mode === "immediate") return from;

  if (mode === "daily") {
    const date = new Date(isFirst ? from : from + 24 * 60 * 60 * 1000);
    return date.getTime();
  }

  // weekly
  const [hh, mm] = (timeOfDay ?? "00:00").split(":").map((n) => Number.parseInt(n, 10));
  const targetWeekday = weekday ?? 0;
  const date = new Date(from);
  date.setHours(hh ?? 0, mm ?? 0, 0, 0);
  let dayDiff = (targetWeekday - date.getDay() + 7) % 7;
  if (isFirst && dayDiff === 0 && date.getTime() >= from) {
    // today, time hasn't passed yet — first slot can land today.
  } else if (dayDiff === 0) {
    dayDiff = 7;
  }
  date.setDate(date.getDate() + dayDiff);
  return date.getTime();
}

/** Every slotCount-th release timestamp, spaced by the plan's cadence, perRelease slots sharing each timestamp. */
function computeSchedule(plan: Pick<RolloutPlan, "mode" | "perRelease" | "weekday" | "timeOfDay" | "startAt">, slotCount: number): number[] {
  const times: number[] = [];
  let cursor = plan.startAt;
  let releaseIndex = 0;
  while (times.length < slotCount) {
    const isFirstRelease = releaseIndex === 0;
    const releaseAt = plan.mode === "immediate" ? plan.startAt : nextReleaseTime(plan.mode, cursor, plan.weekday, plan.timeOfDay, isFirstRelease);
    for (let i = 0; i < plan.perRelease && times.length < slotCount; i++) times.push(releaseAt);
    cursor = releaseAt;
    releaseIndex++;
  }
  return times;
}

export interface SetRolloutPlanInput {
  mode: RolloutMode;
  perRelease: number;
  weekday?: number | null;
  timeOfDay?: string | null;
  startAt: number;
  /** Total slot count to have on hand — grows an existing plan's slot count if raised, never shrinks it (an already-scheduled or revealed slot is never deleted just because the declared total went down). */
  expectedTotal: number;
}

/**
 * Creates or updates a subject's rollout plan, and (re)computes release_at
 * for every slot that hasn't been revealed yet — an already-revealed slot
 * keeps its historical release_at untouched, so changing the schedule
 * later never pretends something someone already watched released at a
 * different time. Slot count only ever grows here (see expectedTotal's
 * own comment); shrinking it back down would mean deciding what to do
 * with a slot that already has something assigned or has already been
 * revealed, which this pass leaves to "just don't lower it" rather than
 * inventing a destructive path for a rare case.
 */
export function setRolloutPlan(subjectType: RolloutSubjectType, subjectId: string, input: SetRolloutPlanInput): RolloutPlan {
  const db = getDb();
  const now = Date.now();

  const existingPlan = getRolloutPlan(subjectType, subjectId);
  const planId = existingPlan?.id ?? randomUUID();

  db.prepare(
    `INSERT INTO library_rollout_plans (id, subject_type, subject_id, mode, per_release, weekday, time_of_day, start_at, expected_total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_type, subject_id) DO UPDATE SET
       mode = excluded.mode, per_release = excluded.per_release, weekday = excluded.weekday,
       time_of_day = excluded.time_of_day, start_at = excluded.start_at,
       expected_total = excluded.expected_total, updated_at = excluded.updated_at`,
  ).run(planId, subjectType, subjectId, input.mode, input.perRelease, input.weekday ?? null, input.timeOfDay ?? null, input.startAt, input.expectedTotal, now, now);

  const resolvedPlanId = getRolloutPlan(subjectType, subjectId)!.id;
  const existingSlots = listRolloutSlots(resolvedPlanId);
  const existingCount = existingSlots.length;

  // Grow slot count to expectedTotal if needed.
  if (input.expectedTotal > existingCount) {
    const insert = db.prepare(
      "INSERT INTO library_rollout_slots (id, plan_id, slot_index, release_at, path, imdb_id, revealed_at) VALUES (?, ?, ?, 0, NULL, NULL, NULL)",
    );
    for (let i = existingCount; i < input.expectedTotal; i++) {
      insert.run(randomUUID(), resolvedPlanId, i + 1);
    }
  }

  // Recompute release_at for every not-yet-revealed slot, in slot_index order.
  const slots = listRolloutSlots(resolvedPlanId);
  const pending = slots.filter((s) => s.revealedAt === null);
  const schedule = computeSchedule(
    { mode: input.mode, perRelease: input.perRelease, weekday: input.weekday ?? null, timeOfDay: input.timeOfDay ?? null, startAt: input.startAt },
    pending.length,
  );
  const update = db.prepare("UPDATE library_rollout_slots SET release_at = ? WHERE id = ?");
  pending.forEach((slot, i) => {
    const releaseAt = schedule[i];
    if (releaseAt !== undefined) update.run(releaseAt, slot.id);
  });

  if (subjectType === "group") reconcileGroupSlots(subjectId);

  return getRolloutPlan(subjectType, subjectId)!;
}

/**
 * Assigns every currently-grouped path that doesn't already occupy a slot
 * to the earliest open (path IS NULL) slot, in episode order — called
 * after setRolloutPlan and whenever curator.html groups a new file into an
 * already-scheduled show. A file added out of episode order still lands
 * in the right slot as long as slots outnumber files so far; if every
 * open slot is already taken (expectedTotal set too low), the extra files
 * are left unslotted and therefore immediately visible, same as an
 * ungrouped file today — this only ever adds gates, never blocks
 * something outright.
 */
export function reconcileGroupSlots(groupId: string): void {
  const plan = getRolloutPlan("group", groupId);
  if (!plan) return; // no rollout configured for this group — nothing to reconcile

  const group = getGroup(groupId);
  if (!group) return;

  const slots = listRolloutSlots(plan.id);
  const slotted = new Set(slots.filter((s) => s.path !== null).map((s) => s.path));
  const openSlots = slots.filter((s) => s.path === null).sort((a, b) => a.slotIndex - b.slotIndex);

  const unslottedPaths = group.paths
    .filter((p) => !slotted.has(p))
    .map((p) => ({ path: p, sortKey: parseEpisodeInfo(p).sortKey ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.sortKey - b.sortKey);

  const db = getDb();
  const update = db.prepare("UPDATE library_rollout_slots SET path = ? WHERE id = ?");
  unslottedPaths.forEach((entry, i) => {
    const slot = openSlots[i];
    if (slot) update.run(entry.path, slot.id);
  });
}

/**
 * Same idea as reconcileGroupSlots, for a film series: assigns every
 * OWNED-and-unassigned entry (by release position, per film_series_entries'
 * own `position` column) to the earliest open slot. `ownedImdbIds` is
 * resolved by the caller (an admin route, via listAllMoviesAdmin() —
 * see this file's own header for why that lookup doesn't live here) since
 * this module has no Jellyfin access of its own.
 */
export function reconcileSeriesSlots(
  seriesId: string,
  // Same shape as SeriesEntry (film-series.ts) — snake_case imdb_id to
  // match it exactly rather than requiring the caller to remap, since
  // this is always called with a SeriesContext's own .entries as-is.
  seriesEntries: Array<{ position: number; imdb_id: string | null }>,
  ownedImdbIds: Set<string>,
): void {
  const plan = getRolloutPlan("series", seriesId);
  if (!plan) return;

  const slots = listRolloutSlots(plan.id);
  const slotted = new Set(slots.filter((s) => s.imdbId !== null).map((s) => s.imdbId));
  const openSlots = slots.filter((s) => s.imdbId === null).sort((a, b) => a.slotIndex - b.slotIndex);

  const unslottedOwned = seriesEntries
    .filter((e): e is { position: number; imdb_id: string } => e.imdb_id !== null && ownedImdbIds.has(e.imdb_id) && !slotted.has(e.imdb_id))
    .sort((a, b) => a.position - b.position);

  const db = getDb();
  const update = db.prepare("UPDATE library_rollout_slots SET imdb_id = ? WHERE id = ?");
  unslottedOwned.forEach((entry, i) => {
    const slot = openSlots[i];
    if (slot) update.run(entry.imdb_id, slot.id);
  });
}

/** Paths currently gated by a not-yet-revealed TV rollout slot — filterVisible() in media.ts subtracts these from every public listing. Direct access (an /item/{id} link someone already has) is deliberately NOT gated — see this file's own header and the design doc for why. */
export function getHiddenRolloutPathSet(): Set<string> {
  const rows = asRows<{ path: string }>(
    getDb().prepare("SELECT path FROM library_rollout_slots WHERE revealed_at IS NULL AND path IS NOT NULL").all(),
  );
  return new Set(rows.map((r) => r.path));
}

/** Same as getHiddenRolloutPathSet, keyed by IMDb id for film-series rollout — filterVisible() checks an owned film's ProviderIds.Imdb against this, and SeriesRow's "In this series" row filters against it too. */
export function getHiddenRolloutImdbSet(): Set<string> {
  const rows = asRows<{ imdb_id: string }>(
    getDb().prepare("SELECT imdb_id FROM library_rollout_slots WHERE revealed_at IS NULL AND imdb_id IS NOT NULL").all(),
  );
  return new Set(rows.map((r) => r.imdb_id));
}

/** How many of a subject's declared slots are still pending — 0 for a subject with no rollout plan at all. */
export function pendingRolloutCount(subjectType: RolloutSubjectType, subjectId: string): number {
  const plan = getRolloutPlan(subjectType, subjectId);
  if (!plan) return 0;
  const row = asRow<{ n: number }>(
    getDb().prepare("SELECT COUNT(*) AS n FROM library_rollout_slots WHERE plan_id = ? AND revealed_at IS NULL").get(plan.id),
  );
  return row?.n ?? 0;
}

/**
 * Reveal tick — flips a slot's gate open once its release_at arrives.
 * Covers both subject types identically (a slot doesn't need to know
 * which kind it is for this part). Does NOT itself send a notification:
 * runTvNotifyTick() (library-notify.ts) already owns "an episode became
 * visible, tell people" for TV shows and now also checks
 * getHiddenRolloutPathSet() before counting an episode as visible, so it
 * naturally picks up a TV reveal on its own next pass. Film-series reveals
 * have no equivalent notification yet — new_item (the movie-add tick)
 * fires when a film is first ADDED to the library, which for a rolled-out
 * film series' pre-owned titles already happened long before its slot
 * opens, so there's no natural "just got confirmed" moment left to hang a
 * notification off the way the TV case has. Left for a follow-up.
 */
export async function runRolloutRevealTick(): Promise<{ revealed: number }> {
  const db = getDb();
  const now = Date.now();
  const due = asRows<{ id: string }>(
    db.prepare("SELECT id FROM library_rollout_slots WHERE revealed_at IS NULL AND (path IS NOT NULL OR imdb_id IS NOT NULL) AND release_at <= ?").all(now),
  );
  if (due.length === 0) return { revealed: 0 };

  const update = db.prepare("UPDATE library_rollout_slots SET revealed_at = ? WHERE id = ?");
  for (const row of due) update.run(now, row.id);
  return { revealed: due.length };
}
