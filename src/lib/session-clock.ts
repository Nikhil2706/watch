/**
 * Playback sync, as plain functions so it can be tested without a video
 * element: the watch party (Player.tsx applies the plans) and, since step 2
 * of docs/playback-sessions.md, the phone remote driving a TV (the last
 * section below; remote-bus.ts keeps the clock, ScreenAgent.tsx applies it).
 * Was party-sync.ts, which still re-exports it.
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

/* ------------------------------------------------------------------ *
 * The phone remote: one clock per screen, kept on the server.
 *
 * Before, the phone's commands fired and forgot ("seekBy 10" was worked out
 * on the TV from wherever its video happened to be), the TV's next report
 * could undo what the phone had just shown, and the phone's bar only moved
 * when a report arrived (every 4 s). Now the server holds the screen's
 * position the way it holds a party's: stamped with the server time it was
 * true at. A command moves that clock and is sent to the TV as one stamped
 * position, which the TV applies with planExplicit like a party follower.
 * ------------------------------------------------------------------ */

/** A screen's clock: where it was at server time `at`, and when a command last moved it. */
export interface ScreenClock extends RoomPosition {
  /** Server time of the last command that set this clock; 0 when it only ever came from reports. */
  commandAt: number;
}

/** The remote's commands that move a clock (navigate, back, reload and ping move a page, not a clock). */
export type ClockCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "playPause" }
  | { type: "seekTo"; positionSeconds: number }
  | { type: "seekBy"; deltaSeconds: number };

/** What the TV is sent for a ClockCommand: the clock it should be on, as a party follower is. */
export interface ClockSync extends RoomPosition {
  type: "sync";
}

export function isClockCommand(command: { type: string }): command is ClockCommand {
  return ["play", "pause", "playPause", "seekTo", "seekBy"].includes(command.type);
}

/**
 * The clock after a command. A seek counts from where the clock says the
 * screen is now, so two quick "+10"s make +20 even while the first is still
 * landing on the TV (which used to add the second 10 to the old position).
 */
export function applyClockCommand(
  clock: ScreenClock,
  command: ClockCommand,
  now: number,
  durationSeconds: number | null,
): ScreenClock {
  let position = targetPosition(clock, now);
  let paused = clock.paused;
  switch (command.type) {
    case "play":
      paused = false;
      break;
    case "pause":
      paused = true;
      break;
    case "playPause":
      paused = !paused;
      break;
    case "seekTo":
      position = command.positionSeconds;
      break;
    case "seekBy":
      position += command.deltaSeconds;
      break;
  }
  const end = durationSeconds != null && Number.isFinite(durationSeconds) ? durationSeconds : Infinity;
  position = Math.max(0, Math.min(end, position));
  return { positionSeconds: Math.round(position * 1000) / 1000, paused, at: now, commandAt: now };
}

export function clockSync(clock: ScreenClock): ClockSync {
  return { type: "sync", positionSeconds: clock.positionSeconds, paused: clock.paused, at: clock.at };
}

/** A report this close to the clock (position taken just before it was sent) agrees with it. */
export const REPORT_AGREES_SECONDS = 1.5;

/**
 * A screen's report becomes the clock, except while a command is still
 * landing: for ECHO_WINDOW_MS after one, a report that disagrees with it is
 * the TV's state from before the command (or mid-seek) and is ignored. Once
 * the TV agrees, or the window has passed, the TV is the truth again.
 */
export function acceptReport(
  clock: ScreenClock | null,
  report: { positionSeconds: number; paused: boolean },
  now: number,
): ScreenClock {
  const fromReport: ScreenClock = {
    positionSeconds: report.positionSeconds,
    paused: report.paused,
    at: now,
    commandAt: clock?.commandAt ?? 0,
  };
  if (!clock || now - clock.commandAt > ECHO_WINDOW_MS) return fromReport;
  const agrees =
    report.paused === clock.paused &&
    Math.abs(report.positionSeconds - targetPosition(clock, now)) <= REPORT_AGREES_SECONDS;
  return agrees ? fromReport : clock;
}
