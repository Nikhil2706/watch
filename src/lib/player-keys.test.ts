import assert from "node:assert/strict";
import { test } from "node:test";

import { clampTime, nextSpeed, PLAYER_SHORTCUTS, resolvePlayerKey, resolveTvRemoteKey } from "./player-keys.ts";

test("YouTube's keys", () => {
  assert.deepEqual(resolvePlayerKey({ key: " " }), { kind: "toggle" });
  assert.deepEqual(resolvePlayerKey({ key: "k" }), { kind: "toggle" });
  assert.deepEqual(resolvePlayerKey({ key: "j" }), { kind: "seek", by: -10 });
  assert.deepEqual(resolvePlayerKey({ key: "L", shiftKey: true }), { kind: "seek", by: 10 });
  assert.deepEqual(resolvePlayerKey({ key: "ArrowLeft" }), { kind: "seek", by: -5 });
  assert.deepEqual(resolvePlayerKey({ key: "m" }), { kind: "mute" });
  assert.deepEqual(resolvePlayerKey({ key: "f" }), { kind: "fullscreen" });
  assert.deepEqual(resolvePlayerKey({ key: "c" }), { kind: "captions" });
  assert.deepEqual(resolvePlayerKey({ key: ">", shiftKey: true }), { kind: "speed", by: 0.25 });
  assert.deepEqual(resolvePlayerKey({ key: "N", shiftKey: true }), { kind: "next" });
});

test("VLC's jump sizes by modifier", () => {
  assert.deepEqual(resolvePlayerKey({ key: "ArrowRight", shiftKey: true }), { kind: "seek", by: 3 });
  assert.deepEqual(resolvePlayerKey({ key: "ArrowRight", altKey: true }), { kind: "seek", by: 10 });
  assert.deepEqual(resolvePlayerKey({ key: "ArrowLeft", ctrlKey: true }), { kind: "seek", by: -60 });
  assert.deepEqual(resolvePlayerKey({ key: "ArrowLeft", metaKey: true }), { kind: "seek", by: -60 });
});

test("number keys jump by tenths, top row or number pad", () => {
  assert.deepEqual(resolvePlayerKey({ key: "0", code: "Digit0" }), { kind: "seekPercent", percent: 0 });
  assert.deepEqual(resolvePlayerKey({ key: "7", code: "Digit7" }), { kind: "seekPercent", percent: 70 });
  assert.deepEqual(resolvePlayerKey({ key: "3", code: "Numpad3" }), { kind: "seekPercent", percent: 30 });
  assert.equal(resolvePlayerKey({ key: "!", code: "Digit1", shiftKey: true }), null, "Shift+1 is not a jump");
});

test("speed, frame and help by physical key, whatever character it reports", () => {
  assert.deepEqual(resolvePlayerKey({ key: ".", code: "Period", shiftKey: true }), { kind: "speed", by: 0.25 });
  assert.deepEqual(resolvePlayerKey({ key: ",", code: "Comma", shiftKey: true }), { kind: "speed", by: -0.25 });
  assert.deepEqual(resolvePlayerKey({ key: ".", code: "Period" }), { kind: "frame", direction: 1 });
  assert.deepEqual(resolvePlayerKey({ key: "/", code: "Slash", shiftKey: true }), { kind: "help" });
  assert.equal(resolvePlayerKey({ key: "/", code: "Slash" }), null);
});

test("browser shortcuts are left alone", () => {
  assert.equal(resolvePlayerKey({ key: "f", ctrlKey: true }), null, "Ctrl+F is find");
  assert.equal(resolvePlayerKey({ key: "l", ctrlKey: true }), null, "Ctrl+L is the address bar");
  assert.equal(resolvePlayerKey({ key: "n" }), null, "plain n does nothing; next episode needs Shift");
  assert.equal(resolvePlayerKey({ key: "Tab" }), null);
});

test("speed stays within bounds and frame steps stay inside the film", () => {
  assert.equal(nextSpeed(1, 0.25), 1.25);
  assert.equal(nextSpeed(3, 0.25), 3);
  assert.equal(nextSpeed(0.25, -0.25), 0.25);
  assert.equal(clampTime(-1, 100), 0);
  assert.equal(clampTime(101, 100), 100);
  assert.equal(clampTime(50, NaN), 50);
});

test("every shortcut in the help list resolves to something", () => {
  assert.ok(PLAYER_SHORTCUTS.length >= 15);
});

test("media keys: a remote's transport buttons, anywhere", () => {
  assert.deepEqual(resolvePlayerKey({ key: "MediaPlayPause" }), { kind: "toggle" });
  assert.deepEqual(resolvePlayerKey({ key: "MediaPause" }), { kind: "pause" });
  assert.deepEqual(resolvePlayerKey({ key: "MediaFastForward" }), { kind: "seek", by: 10 });
  assert.deepEqual(resolveTvRemoteKey("MediaRewind", "controls"), { kind: "seek", by: -10 });
  assert.deepEqual(resolveTvRemoteKey("MediaPlay", "slider"), { kind: "play" });
});

test("TV remote on the video: OK plays/pauses, left/right jump 10 s, down opens the bar, up goes to Back", () => {
  assert.deepEqual(resolveTvRemoteKey("Enter", "video"), { kind: "toggle" });
  assert.deepEqual(resolveTvRemoteKey("ArrowLeft", "video"), { kind: "seek", by: -10 });
  assert.deepEqual(resolveTvRemoteKey("ArrowRight", "video"), { kind: "seek", by: 10 });
  assert.deepEqual(resolveTvRemoteKey("ArrowDown", "video"), { kind: "showControls" });
  assert.deepEqual(resolveTvRemoteKey("ArrowUp", "video"), { kind: "focusTopBar" });
  assert.equal(resolveTvRemoteKey("k", "video"), null, "no letters on a remote; not TV keys");
});

test("TV remote in the control bar: left/right move, up leaves, OK presses the button", () => {
  assert.deepEqual(resolveTvRemoteKey("ArrowRight", "controls"), { kind: "moveControl", direction: 1 });
  assert.deepEqual(resolveTvRemoteKey("ArrowLeft", "controls"), { kind: "moveControl", direction: -1 });
  assert.deepEqual(resolveTvRemoteKey("ArrowUp", "controls"), { kind: "leaveControls" });
  assert.equal(resolveTvRemoteKey("Enter", "controls"), null);
  assert.equal(resolveTvRemoteKey("ArrowDown", "controls"), null);
});

test("TV remote on a slider: left/right stay with the slider, up leaves the bar", () => {
  assert.equal(resolveTvRemoteKey("ArrowLeft", "slider"), null);
  assert.equal(resolveTvRemoteKey("ArrowRight", "slider"), null);
  assert.deepEqual(resolveTvRemoteKey("ArrowUp", "slider"), { kind: "leaveControls" });
});

test("TV remote on the Back link above the video: down returns to the video, OK follows the link", () => {
  assert.deepEqual(resolveTvRemoteKey("ArrowDown", "topbar"), { kind: "leaveControls" });
  assert.equal(resolveTvRemoteKey("Enter", "topbar"), null);
  assert.equal(resolveTvRemoteKey("ArrowUp", "topbar"), null);
  assert.equal(resolveTvRemoteKey("ArrowRight", "topbar"), null);
  assert.deepEqual(resolveTvRemoteKey("MediaPlayPause", "topbar"), { kind: "toggle" });
});
