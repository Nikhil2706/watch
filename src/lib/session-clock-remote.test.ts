import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ECHO_WINDOW_MS,
  acceptReport,
  applyClockCommand,
  clockSync,
  isClockCommand,
  planExplicit,
  targetPosition,
  type ScreenClock,
} from "./session-clock.ts";

const T = 1_000_000;
const playingAt100: ScreenClock = { positionSeconds: 100, paused: false, at: T, commandAt: 0 };

test("only play, pause and seeks move a clock", () => {
  for (const type of ["play", "pause", "playPause", "seekTo", "seekBy"]) assert.equal(isClockCommand({ type }), true);
  for (const type of ["navigate", "back", "reload", "ping", "sync"]) assert.equal(isClockCommand({ type }), false);
});

test("a seek counts from where the screen is now, not where it last reported", () => {
  const c = applyClockCommand(playingAt100, { type: "seekBy", deltaSeconds: 10 }, T + 4000, null);
  assert.deepEqual(c, { positionSeconds: 114, paused: false, at: T + 4000, commandAt: T + 4000 });
});

test("two quick +10s make +20 while the first is still landing", () => {
  const first = applyClockCommand(playingAt100, { type: "seekBy", deltaSeconds: 10 }, T, null);
  const second = applyClockCommand(first, { type: "seekBy", deltaSeconds: 10 }, T + 300, null);
  assert.equal(second.positionSeconds, 120.3);
});

test("seeks stay inside the film", () => {
  assert.equal(applyClockCommand(playingAt100, { type: "seekBy", deltaSeconds: -500 }, T, 7200).positionSeconds, 0);
  assert.equal(applyClockCommand(playingAt100, { type: "seekTo", positionSeconds: 9000 }, T, 7200).positionSeconds, 7200);
});

test("play/pause toggles the clock and freezes the position on pause", () => {
  const paused = applyClockCommand(playingAt100, { type: "playPause" }, T + 2000, null);
  assert.equal(paused.paused, true);
  assert.equal(paused.positionSeconds, 102);
  assert.equal(targetPosition(paused, T + 60_000), 102);
  assert.equal(applyClockCommand(paused, { type: "playPause" }, T + 3000, null).paused, false);
});

test("the TV gets the same plan a party follower would", () => {
  // A party's explicit seek to 160 while playing, and the remote's seekTo 160,
  // reach a TV sitting at 100 as the same plan.
  const party = planExplicit({ positionSeconds: 100, paused: false }, { positionSeconds: 160, paused: false, at: T }, T, false);
  const sync = clockSync(applyClockCommand(playingAt100, { type: "seekTo", positionSeconds: 160 }, T, null));
  assert.equal(sync.type, "sync");
  assert.deepEqual(planExplicit({ positionSeconds: 100, paused: false }, sync, T, false), party);
  assert.deepEqual(party, { seekTo: 160, setPaused: null });

  // And a pause: the same plan as a party's pause.
  const pause = clockSync(applyClockCommand(playingAt100, { type: "pause" }, T, null));
  assert.deepEqual(planExplicit({ positionSeconds: 100, paused: false }, pause, T, false), { seekTo: null, setPaused: true });
});

test("a TV report from before the command does not undo it (the echo rule)", () => {
  const seeked = applyClockCommand(playingAt100, { type: "seekBy", deltaSeconds: 30 }, T, null);
  // The TV's next report was taken before the seek landed: still near 101.
  const after = acceptReport(seeked, { positionSeconds: 101, paused: false }, T + 1000);
  assert.equal(after, seeked);
  assert.equal(targetPosition(after, T + 1000), 131);
});

test("once the TV agrees, its report is the clock again", () => {
  const seeked = applyClockCommand(playingAt100, { type: "seekBy", deltaSeconds: 30 }, T, null);
  const after = acceptReport(seeked, { positionSeconds: 131.2, paused: false }, T + 1000);
  assert.deepEqual(after, { positionSeconds: 131.2, paused: false, at: T + 1000, commandAt: T });
});

test("a pause the TV hasn't shown yet is kept", () => {
  const paused = applyClockCommand(playingAt100, { type: "pause" }, T, null);
  assert.equal(acceptReport(paused, { positionSeconds: 100.5, paused: false }, T + 500), paused);
});

test("after the window the TV is the truth, even when it disagrees", () => {
  const seeked = applyClockCommand(playingAt100, { type: "seekBy", deltaSeconds: 30 }, T, null);
  const later = T + ECHO_WINDOW_MS + 1;
  assert.equal(acceptReport(seeked, { positionSeconds: 101, paused: false }, later).positionSeconds, 101);
});

test("with no clock yet, the first report starts one", () => {
  assert.deepEqual(acceptReport(null, { positionSeconds: 5, paused: true }, T), {
    positionSeconds: 5,
    paused: true,
    at: T,
    commandAt: 0,
  });
});
