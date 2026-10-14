import assert from "node:assert/strict";
import { test } from "node:test";

import { consumeEcho, ECHO_WINDOW_MS, expectFromPlan, planFollow, viewerIsController } from "./party-sync.ts";

test("a follower more than a second off snaps to the leader", () => {
  // The 2026-10-14 test: about 3 s apart while playing.
  assert.deepEqual(planFollow({ positionSeconds: 597, paused: false }, { positionSeconds: 600, paused: null }), {
    seekTo: 600,
    setPaused: null,
  });
  assert.deepEqual(planFollow({ positionSeconds: 603, paused: false }, { positionSeconds: 600, paused: null }), {
    seekTo: 600,
    setPaused: null,
  });
});

test("within a second, a follower is left alone: a seek would cost a rebuffer", () => {
  assert.deepEqual(planFollow({ positionSeconds: 599.4, paused: false }, { positionSeconds: 600, paused: null }), {
    seekTo: null,
    setPaused: null,
  });
});

test("a pause lands the follower on the host's frame; a play starts it from there", () => {
  // About 7 s apart after a pause, in the same test.
  assert.deepEqual(planFollow({ positionSeconds: 593, paused: false }, { positionSeconds: 600, paused: true }), {
    seekTo: 600,
    setPaused: true,
  });
  assert.deepEqual(planFollow({ positionSeconds: 600, paused: true }, { positionSeconds: 600.2, paused: false }), {
    seekTo: null,
    setPaused: false,
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

test("the events a remote change causes are not sent back out; the viewer's own still are", () => {
  const now = 1_000_000;
  const expected = expectFromPlan({ seekTo: 600, setPaused: true }, now);

  assert.equal(consumeEcho(expected, { kind: "pause" }, now + 50), true);
  // An HLS seek can land seconds later — the old 300 ms window let this through as a new seek.
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 600.1 }, now + 2500), true);
  // Each expectation is used once: the viewer's next pause is theirs.
  assert.equal(consumeEcho(expected, { kind: "pause" }, now + 2600), false);
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 600 }, now + 2700), false);
});

test("a viewer's own different action is not taken for an echo", () => {
  const now = 0;
  const expected = expectFromPlan({ seekTo: 600, setPaused: null }, now);
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 900 }, 100), false, "seeked somewhere else");
  assert.equal(consumeEcho(expected, { kind: "play" }, 100), false, "play was not asked for");
  assert.equal(consumeEcho(expected, { kind: "seeked", positionSeconds: 600 }, ECHO_WINDOW_MS + 1), false, "too late");
  assert.equal(consumeEcho(null, { kind: "pause" }, 0), false);
});
