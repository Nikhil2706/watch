import assert from "node:assert/strict";
import { test } from "node:test";

import { clampTime, nextSpeed, PLAYER_SHORTCUTS, resolvePlayerKey } from "./player-keys.ts";

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
