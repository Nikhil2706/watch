/**
 * Watch-party playback sync on the client, as plain functions so it can be
 * tested without a video element. Player.tsx applies the plans.
 *
 * Why it is shaped like this (from the 2026-10-14 test, where the TV and the
 * phone skipped forward every few seconds instead of playing):
 *
 *  - A position is only true at the moment it was taken. Every one the server
 *    sends is stamped with that moment (`at`, server clock), and a follower
 *    aims at where the leader is NOW: position + (server now - at). Comparing
 *    against the position as sent left every follower behind by the message's
 *    age plus however long its own seek took, so it was always more than the
 *    old 1 s threshold off and seeked again on the next heartbeat — a loop.
 *  - Small drift is steered out with playbackRate, which costs nothing to
 *    watch. Only a big gap is worth a seek (a rebuffer), and after one the
 *    follower aims a little ahead and stops listening until it is playing
 *    again.
 *  - Exactly one stream sends heartbeats, and controllers never follow them:
 *    two controllers each following the other's heartbeat chased each other.
 */

/** Further apart than this and a follower seeks; anything less is steered out with playbackRate. */
export const SEEK_THRESHOLD_SECONDS = 3;
/** Within this, a follower counts as in step and plays at normal speed. */
export const IN_SYNC_SECONDS = 0.3;
/** A paused room is matched to the frame: a seek while paused costs nothing anyone can see. */
export const PAUSED_MATCH_SECONDS = 0.1;
/** playbackRate stays within 1 ± this while catching up: 0.95–1.05 is not noticeable. */
export const MAX_RATE_NUDGE = 0.05;
/**
 * Rate change per second of drift: anything past about 0.33 s gets the full
 * ±0.05, easing off just above the 0.3 s line. A gentler gain left a long
 * tail (1.5 s behind was still 0.6 s behind after 25 s).
 */
export const RATE_GAIN_PER_SECOND = 0.15;
/** A seek takes time to land; aim this far ahead of the leader so the follower arrives about level. */
export const SEEK_LEAD_SECONDS = 0.5;
/** After a seek, heartbeats are ignored this long (or until playback resumes). */
export const SEEK_COOLDOWN_MS = 6000;
/** How often the heartbeat source tells the room where it is while playing. */
export const HEARTBEAT_INTERVAL_MS = 5000;
/** How often a follower re-checks its drift against the last heartbeat, carried forward. */
export const DRIFT_CHECK_INTERVAL_MS = 1000;
/** A message older than this is not carried forward any further: a clock estimate that wrong is not to be trusted. */
const MAX_MESSAGE_AGE_MS = 30_000;

/** Where the room was, at server time `at`, and whether it was playing. */
export interface RoomPosition {
  positionSeconds: number;
  at: number;
  paused: boolean;
}

/** Where the room is at `serverNow`: carried forward by the message's age while playing. */
export function targetPosition(remote: RoomPosition, serverNow: number): number {
  if (remote.paused) return remote.positionSeconds;
  const ageMs = Math.min(Math.max(0, serverNow - remote.at), MAX_MESSAGE_AGE_MS);
  return remote.positionSeconds + ageMs / 1000;
}

/* ------------------------------------------------------------------ *
 * Clock offset: server time ≈ Date.now() + offset.
 * ------------------------------------------------------------------ */

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
}

/** One round trip: sent at `sentAt`, the server answered `serverTime`, back at `receivedAt` (both local). */
export function clockSample(sentAt: number, serverTime: number, receivedAt: number): ClockSample {
  const rttMs = Math.max(0, receivedAt - sentAt);
  return { offsetMs: serverTime + rttMs / 2 - receivedAt, rttMs };
}

/** The offset from the quickest recent round trip: the one least skewed by a slow leg. */
export function bestOffset(samples: readonly ClockSample[]): number {
  let best: ClockSample | null = null;
  for (const s of samples) if (!best || s.rttMs < best.rttMs) best = s;
  return best?.offsetMs ?? 0;
}

/* ------------------------------------------------------------------ *
 * Who sends heartbeats, and who follows them.
 * ------------------------------------------------------------------ */

/**
 * The server names one leader stream (the creator's, or the controller that
 * acted last). Only it sends heartbeats; with no leader named, any controller
 * may, and the first one the server hears becomes the leader. Controllers do
 * not follow heartbeats at all — only each other's explicit play/pause/seek.
 */
export function heartbeatRole(input: {
  isController: boolean;
  clientId: string;
  leaderClientId: string | null;
}): { sends: boolean; follows: boolean } {
  return {
    sends: input.isController && (input.leaderClientId === null || input.leaderClientId === input.clientId),
    follows: !input.isController,
  };
}

/* ------------------------------------------------------------------ *
 * Explicit play / pause / seek (and the room's state on joining).
 * ------------------------------------------------------------------ */

export interface SyncPlan {
  /** Where to seek, or null to stay put. */
  seekTo: number | null;
  /** The play state to switch to, or null to leave it alone. */
  setPaused: boolean | null;
}

/**
 * What to do on an explicit play, pause or seek from a controller. A paused
 * room is matched to the frame (a seek while paused is cheap). A playing room:
 *  - a follower seeks only when far off, aimed ahead, and steers the rest
 *    (including any overshoot) out with playbackRate;
 *  - a controller does not follow heartbeats, so has no steering to undo an
 *    overshoot: it seeks once it is out of step at all, to the target itself.
 */
export function planExplicit(
  local: { positionSeconds: number; paused: boolean },
  remote: RoomPosition,
  serverNow: number,
  steersWithRate: boolean,
): SyncPlan {
  const target = targetPosition(remote, serverNow);
  const drift = Math.abs(target - local.positionSeconds);
  let seekTo: number | null = null;
  if (remote.paused) {
    if (drift > PAUSED_MATCH_SECONDS) seekTo = target;
  } else if (steersWithRate ? drift > SEEK_THRESHOLD_SECONDS : drift > IN_SYNC_SECONDS) {
    seekTo = steersWithRate ? target + SEEK_LEAD_SECONDS : target;
  }
  return { seekTo, setPaused: remote.paused === local.paused ? null : remote.paused };
}

/* ------------------------------------------------------------------ *
 * Following heartbeats: steer, or (rarely) seek.
 * ------------------------------------------------------------------ */

export interface DriftControl {
  /** Heartbeats are ignored until then: the last seek is still landing. */
  cooldownUntil: number;
  /** A seek was made and "playing" has not fired since. */
  awaitingPlaying: boolean;
}

export function newDriftControl(): DriftControl {
  return { cooldownUntil: 0, awaitingPlaying: false };
}

export type DriftPlan = { kind: "none" } | { kind: "seek"; to: number } | { kind: "rate"; rate: number };

/**
 * A follower's correction toward where the leader is now. Records a seek in
 * `control` (so the cooldown starts); call `endCooldownOnPlaying` when the
 * player fires "playing".
 */
export function planDrift(
  local: { positionSeconds: number; rate: number; seeking: boolean },
  target: number,
  control: DriftControl,
  now: number,
): DriftPlan {
  if (local.seeking || now < control.cooldownUntil) return { kind: "none" };
  const drift = target - local.positionSeconds; // > 0: behind
  if (Math.abs(drift) > SEEK_THRESHOLD_SECONDS) {
    control.cooldownUntil = now + SEEK_COOLDOWN_MS;
    control.awaitingPlaying = true;
    return { kind: "seek", to: target + SEEK_LEAD_SECONDS };
  }
  const rate =
    Math.abs(drift) <= IN_SYNC_SECONDS
      ? 1
      : 1 + Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, drift * RATE_GAIN_PER_SECOND));
  const rounded = Math.round(rate * 1000) / 1000;
  return Math.abs(rounded - local.rate) < 0.001 ? { kind: "none" } : { kind: "rate", rate: rounded };
}

/** Records a seek this player made for any other reason (an explicit sync), so heartbeats wait for it too. */
export function startCooldown(control: DriftControl, now: number): void {
  control.cooldownUntil = now + SEEK_COOLDOWN_MS;
  control.awaitingPlaying = true;
}

/** "playing" after a seek: it has landed, so the next heartbeat may be listened to. */
export function endCooldownOnPlaying(control: DriftControl, now: number): void {
  if (!control.awaitingPlaying) return;
  control.awaitingPlaying = false;
  control.cooldownUntil = Math.min(control.cooldownUntil, now);
}

/**
 * Whether this viewer may drive playback. The creator always can; anyone else
 * only once the participants list (which the server rebuilds on every grant
 * and revoke) says so — which can be well after the player mounted.
 */
export function viewerIsController(
  isCreator: boolean,
  participants: ReadonlyArray<{ id: string; isController: boolean }>,
  myId: string,
): boolean {
  return isCreator || (participants.find((p) => p.id === myId)?.isController ?? false);
}

/* ------------------------------------------------------------------ *
 * Echoes: changes this player was told to make are not sent back out.
 * ------------------------------------------------------------------ */

/** How long a change this player was told to make still counts as "ours, not the viewer's". A seek on a transcoded stream can take seconds to land. */
export const ECHO_WINDOW_MS = 4000;
/** A "seeked" this close to where we were told to go is that seek landing. */
const ECHO_TOLERANCE_SECONDS = 1;

/**
 * The changes a follower has just been told to make, so the play/pause/seeked
 * events they cause are not sent back out as if the viewer had done them.
 */
export interface ExpectedRemote {
  seekTo: number | null;
  paused: boolean | null;
  until: number;
}

export function expectFromPlan(plan: SyncPlan, now: number): ExpectedRemote {
  return { seekTo: plan.seekTo, paused: plan.setPaused, until: now + ECHO_WINDOW_MS };
}

/**
 * True when a local player event is the echo of a remote change, and consumes
 * that expectation so a later, real action by the viewer is still sent.
 */
export function consumeEcho(
  expected: ExpectedRemote | null,
  event: { kind: "seeked"; positionSeconds: number } | { kind: "play" | "pause" },
  now: number,
): boolean {
  if (!expected || now > expected.until) return false;
  if (event.kind === "seeked") {
    if (expected.seekTo === null || Math.abs(event.positionSeconds - expected.seekTo) > ECHO_TOLERANCE_SECONDS) return false;
    expected.seekTo = null;
    return true;
  }
  const paused = event.kind === "pause";
  if (expected.paused !== paused) return false;
  expected.paused = null;
  return true;
}
