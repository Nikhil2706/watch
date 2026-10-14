/**
 * The follower's side of watch-party playback sync, as plain functions so it
 * can be tested without a video element. Player.tsx applies the plans.
 */

/** Further apart than this and a follower jumps to the leader. Below it, a seek costs more (a rebuffer) than it fixes. */
export const DRIFT_THRESHOLD_SECONDS = 1;

/** How often a controller that is playing tells the room where it is. */
export const HEARTBEAT_INTERVAL_MS = 5000;

export interface SyncPlan {
  /** Where to seek, or null to stay put. */
  seekTo: number | null;
  /** The play state to switch to, or null to leave it alone. */
  setPaused: boolean | null;
}

/**
 * What a follower should do on hearing the room's position. `paused` is the
 * room's play state when the message carries one (play, pause, the state on
 * join) and null when it does not (a seek, a heartbeat), which leaves the
 * follower's own play state alone.
 */
export function planFollow(
  local: { positionSeconds: number; paused: boolean },
  remote: { positionSeconds: number; paused: boolean | null },
  threshold = DRIFT_THRESHOLD_SECONDS,
): SyncPlan {
  const drift = Math.abs(local.positionSeconds - remote.positionSeconds);
  return {
    seekTo: drift > threshold ? remote.positionSeconds : null,
    setPaused: remote.paused === null || remote.paused === local.paused ? null : remote.paused,
  };
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

/** How long a change this player was told to make still counts as "ours, not the viewer's". A seek on a transcoded stream can take seconds to land. */
export const ECHO_WINDOW_MS = 4000;

/**
 * The changes a follower has just been told to make, so the play/pause/seeked
 * events they cause are not sent back out as if the viewer had done them.
 * Was a flat 300 ms flag; an HLS seek routinely lands later than that, and on
 * a second controller the late "seeked" went back to the room as a new seek.
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
    if (expected.seekTo === null || Math.abs(event.positionSeconds - expected.seekTo) > DRIFT_THRESHOLD_SECONDS) return false;
    expected.seekTo = null;
    return true;
  }
  const paused = event.kind === "pause";
  if (expected.paused !== paused) return false;
  expected.paused = null;
  return true;
}
