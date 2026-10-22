import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bestOffset,
  clockSample,
  consumeEcho,
  ECHO_WINDOW_MS,
  endCooldownOnPlaying,
  expectFromPlan,
  heartbeatRole,
  HEARTBEAT_INTERVAL_MS,
  IN_SYNC_SECONDS,
  newDriftControl,
  planDrift,
  planExplicit,
  SEEK_COOLDOWN_MS,
  SEEK_LEAD_SECONDS,
  targetPosition,
  viewerIsController,
} from "./session-clock.ts";

/* ---- Where the leader is now ---------------------------------------- */

test("a heartbeat is carried forward by its age; a paused position is not", () => {
  assert.equal(targetPosition({ positionSeconds: 600, at: 10_000, paused: false }, 12_500), 602.5);
  assert.equal(targetPosition({ positionSeconds: 600, at: 10_000, paused: true }, 12_500), 600);
  // A server time from the future (a bad clock estimate) never moves it backwards.
  assert.equal(targetPosition({ positionSeconds: 600, at: 13_000, paused: false }, 12_500), 600);
});

test("the clock offset comes from the quickest round trip", () => {
  // Local clock 5 s behind the server. A 100 ms round trip and a slow 900 ms one.
  const quick = clockSample(1000, 6050, 1100);
  const slow = clockSample(2000, 7700, 2900);
  assert.equal(quick.offsetMs, 5000);
  assert.equal(bestOffset([slow, quick]), 5000);
  assert.equal(bestOffset([]), 0);
});

/* ---- Stale heartbeats no longer cause a seek loop -------------------- */

test("a follower level with the leader is left alone however old the heartbeat is", () => {
  // The leader was at 600 s two seconds ago; the follower is at 602 s now.
  // Compared as sent (the old rule), that is 2 s off — a seek, every time.
  const plan = planDrift(
    { positionSeconds: 602, rate: 1, seeking: false },
    targetPosition({ positionSeconds: 600, at: 0, paused: false }, 2000),
    newDriftControl(),
    2000,
  );
  assert.deepEqual(plan, { kind: "none" });
});

/**
 * The 2026-10-14 case, end to end: a follower 10 s behind, heartbeats
 * arriving 400 ms after they were taken, and every seek taking 1.5 s to land
 * (the picture holds still meanwhile). It should seek once, then steer in.
 */
function simulate(opts: { startBehind: number; seekMs: number; latencyMs: number; seconds: number }) {
  const control = newDriftControl();
  const leaderAt = (t: number) => 100 + t / 1000; // leader plays at 1×
  let pos = leaderAt(0) - opts.startBehind;
  let rate = 1;
  let seekingUntil = -1;
  let seekTo = 0;
  let last: { positionSeconds: number; at: number } | null = null;
  let seeks = 0;
  const rates: number[] = [];
  for (let t = 0; t <= opts.seconds * 1000; t += 100) {
    if (seekingUntil >= 0 && t >= seekingUntil) {
      pos = seekTo;
      seekingUntil = -1;
      endCooldownOnPlaying(control, t); // "playing" fires as the seek lands
    }
    if (seekingUntil < 0) pos += (rate * 100) / 1000;
    // A heartbeat taken every 5 s, heard latencyMs later.
    const taken = t - opts.latencyMs;
    if (taken >= 0 && taken % HEARTBEAT_INTERVAL_MS === 0) last = { positionSeconds: leaderAt(taken), at: taken };
    if (last && t % 1000 === 0) {
      const plan = planDrift(
        { positionSeconds: pos, rate, seeking: seekingUntil >= 0 },
        targetPosition({ ...last, paused: false }, t),
        control,
        t,
      );
      if (plan.kind === "seek") {
        seeks += 1;
        seekTo = plan.to;
        seekingUntil = t + opts.seekMs;
      } else if (plan.kind === "rate") {
        rate = plan.rate;
        rates.push(rate);
      }
    }
  }
  return { seeks, finalDrift: leaderAt(opts.seconds * 1000) - pos, rates };
}

test("one seek, then playbackRate brings the follower in: no seek loop", () => {
  const run = simulate({ startBehind: 10, seekMs: 1500, latencyMs: 400, seconds: 90 });
  assert.equal(run.seeks, 1);
  assert.ok(Math.abs(run.finalDrift) <= IN_SYNC_SECONDS + 0.05, `final drift ${run.finalDrift.toFixed(2)} s`);
  assert.ok(run.rates.every((r) => r >= 0.95 && r <= 1.05));
  assert.equal(run.rates.at(-1), 1, "back to normal speed once in step");
});

test("a follower 2 s off never seeks at all", () => {
  const run = simulate({ startBehind: 2, seekMs: 1500, latencyMs: 400, seconds: 90 });
  assert.equal(run.seeks, 0);
  assert.ok(Math.abs(run.finalDrift) <= IN_SYNC_SECONDS + 0.05, `final drift ${run.finalDrift.toFixed(2)} s`);
});

/* ---- The playbackRate path -------------------------------------------- */

test("small drift is steered with playbackRate between 0.95 and 1.05", () => {
  const plan = (local: number, rate = 1) =>
    planDrift({ positionSeconds: local, rate, seeking: false }, 100, newDriftControl(), 0);
  assert.deepEqual(plan(98.5), { kind: "rate", rate: 1.05 }, "1.5 s behind: full speed-up");
  assert.deepEqual(plan(97.1), { kind: "rate", rate: 1.05 }, "2.9 s behind: still no seek");
  assert.deepEqual(plan(100.5), { kind: "rate", rate: 0.95 }, "0.5 s ahead: ease off");
  assert.deepEqual(plan(99.68), { kind: "rate", rate: 1.048 }, "just outside 0.3 s: nearly full");
  assert.deepEqual(plan(99.8, 1.05), { kind: "rate", rate: 1 }, "within 0.3 s: back to normal");
  assert.deepEqual(plan(99.8, 1), { kind: "none" }, "already normal: nothing to do");
  assert.deepEqual(plan(96.5), { kind: "seek", to: 100 + SEEK_LEAD_SECONDS }, "over 3 s: seek, aimed ahead");
});

/* ---- The cooldown after a seek ------------------------------------------ */

test("after a seek, heartbeats are ignored until the cooldown ends or playback resumes", () => {
  const local = { positionSeconds: 90, rate: 1, seeking: false };
  const control = newDriftControl();
  assert.equal(planDrift(local, 100, control, 0).kind, "seek");
  // Still landing: the same gap is not a reason to seek again.
  assert.deepEqual(planDrift(local, 101, control, 2000), { kind: "none" });
  assert.deepEqual(planDrift({ ...local, seeking: true }, 101, control, SEEK_COOLDOWN_MS + 1), { kind: "none" });
  // Cooldown over: listened to again.
  assert.equal(planDrift(local, 101, control, SEEK_COOLDOWN_MS + 1).kind, "seek");

  // "playing" after the seek ends the wait early.
  const early = newDriftControl();
  planDrift(local, 100, early, 0);
  endCooldownOnPlaying(early, 1200);
  assert.deepEqual(planDrift({ ...local, positionSeconds: 99.5 }, 101.2, early, 1200), { kind: "rate", rate: 1.05 });
  // A later "playing" with no seek pending changes nothing.
  const idle = newDriftControl();
  endCooldownOnPlaying(idle, 5000);
  assert.deepEqual(idle, { cooldownUntil: 0, awaitingPlaying: false });
});

/* ---- Exactly one heartbeat source; controllers don't chase ------------- */

test("two controllers: only the leader sends heartbeats, and neither follows them", () => {
  const laptop = heartbeatRole({ isController: true, clientId: "laptop", leaderClientId: "laptop" });
  const tv = heartbeatRole({ isController: true, clientId: "tv", leaderClientId: "laptop" });
  const phone = heartbeatRole({ isController: false, clientId: "phone", leaderClientId: "laptop" });
  assert.deepEqual(laptop, { sends: true, follows: false });
  assert.deepEqual(tv, { sends: false, follows: false });
  assert.deepEqual(phone, { sends: false, follows: true });
  // The TV acts and takes the lead: the laptop goes quiet, and still does not follow.
  assert.deepEqual(heartbeatRole({ isController: true, clientId: "laptop", leaderClientId: "tv" }), { sends: false, follows: false });
  // Nobody leads yet: any controller may claim it (the server keeps the first).
  assert.equal(heartbeatRole({ isController: true, clientId: "tv", leaderClientId: null }).sends, true);
});

test("an explicit play from the other controller moves a controller once, and only when it is out of step", () => {
  const remote = { positionSeconds: 600, at: 0, paused: false };
  // 1 s off, controller: no heartbeat steering to fall back on (or to undo an
  // overshoot), so it seeks once, to the target itself.
  assert.deepEqual(planExplicit({ positionSeconds: 599.5, paused: true }, remote, 500, false), {
    seekTo: 600.5,
    setPaused: false,
  });
  // A follower far off seeks aimed ahead, and steers out any overshoot.
  assert.deepEqual(planExplicit({ positionSeconds: 590, paused: false }, remote, 500, true), {
    seekTo: 600.5 + SEEK_LEAD_SECONDS,
    setPaused: null,
  });
  // Level with it (message age counted): just play.
  assert.deepEqual(planExplicit({ positionSeconds: 600.4, paused: true }, remote, 500, false), {
    seekTo: null,
    setPaused: false,
  });
  // A follower 2 s off is steered in afterwards rather than seeked.
  assert.deepEqual(planExplicit({ positionSeconds: 598.5, paused: false }, remote, 500, true), {
    seekTo: null,
    setPaused: null,
  });
});

test("a pause lands everyone on the host's frame", () => {
  // About 7 s apart after a pause, in the 2026-10-14 test.
  assert.deepEqual(planExplicit({ positionSeconds: 593, paused: false }, { positionSeconds: 600, at: 0, paused: true }, 9000, true), {
    seekTo: 600,
    setPaused: true,
  });
  // 0.27 s apart on pause (seen in the browser run): still put on the same frame.
  assert.deepEqual(planExplicit({ positionSeconds: 600.27, paused: false }, { positionSeconds: 600, at: 0, paused: true }, 0, true), {
    seekTo: 600,
    setPaused: true,
  });
  assert.deepEqual(planExplicit({ positionSeconds: 600.05, paused: false }, { positionSeconds: 600, at: 0, paused: true }, 0, true), {
    seekTo: null,
    setPaused: true,
  });
});

test("control comes from being the creator, or from the participants list once granted", () => {
  const before = [{ id: "u-mam", isController: false }];
  const after = [{ id: "u-mam", isController: true }];
  assert.equal(viewerIsController(true, [], "u-tester"), true);
  assert.equal(viewerIsController(false, [], "u-mam"), false, "nothing heard yet");
  assert.equal(viewerIsController(false, before, "u-mam"), false);
  assert.equal(viewerIsController(false, after, "u-mam"), true);
});

/* ---- Echoes ---------------------------------------------------------- */

test("the events a remote change causes are not sent back out; the viewer's own still are", () => {
  const now = 1_000_000;
  const expected = expectFromPlan({ seekTo: 600, setPaused: true }, now);

  assert.equal(consumeEcho(expected, { kind: "pause" }, now + 50), true);
  // An HLS seek can land seconds later.
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 600.1 }, now + 2500), true);
  // Each expectation is used once: the viewer's next pause is theirs.
  assert.equal(consumeEcho(expected, { kind: "pause" }, now + 2600), false);
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 600 }, now + 2700), false);
});

test("a viewer's own different action is not taken for an echo", () => {
  const expected = expectFromPlan({ seekTo: 600, setPaused: null }, 0);
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 900 }, 100), false, "seeked somewhere else");
  assert.equal(consumeEcho(expected, { kind: "play" }, 100), false, "play was not asked for");
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 600 }, ECHO_WINDOW_MS + 1), false, "too late");
  assert.equal(consumeEcho(null, { kind: "pause" }, 0), false);
});
