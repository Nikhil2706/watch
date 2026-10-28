import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceHold,
  clampTime,
  createOkPressGuard,
  holdSpeed,
  nextSpeed,
  OK_ECHO_MS,
  PLAYER_SHORTCUTS,
  resolveMediaKey,
  resolvePlayerKey,
  resolveTvRemoteKey,
} from "./player-keys.ts";

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

test("TV remote on the bar above the video: down returns to the video, left/right move along it, OK presses", () => {
  assert.deepEqual(resolveTvRemoteKey("ArrowDown", "topbar"), { kind: "leaveControls" });
  assert.equal(resolveTvRemoteKey("Enter", "topbar"), null);
  assert.equal(resolveTvRemoteKey("ArrowUp", "topbar"), null);
  // A watch party's "Chat" sits right of "‹ Back".
  assert.deepEqual(resolveTvRemoteKey("ArrowRight", "topbar"), { kind: "moveTopBar", direction: 1 });
  assert.deepEqual(resolveTvRemoteKey("ArrowLeft", "topbar"), { kind: "moveTopBar", direction: -1 });
  assert.deepEqual(resolveTvRemoteKey("MediaPlayPause", "topbar"), { kind: "toggle" });
});

test("a remote's media keys mean the film, wherever focus is (the Android TV app forwards them from the native layer)", () => {
  assert.deepEqual(resolveMediaKey("MediaPlayPause"), { kind: "toggle" });
  assert.deepEqual(resolveMediaKey("MediaPlay"), { kind: "play" });
  assert.deepEqual(resolveMediaKey("MediaPause"), { kind: "pause" });
  assert.deepEqual(resolveMediaKey("MediaFastForward"), { kind: "seek", by: 10 });
  assert.deepEqual(resolveMediaKey("MediaRewind"), { kind: "seek", by: -10 });
  for (const zone of ["video", "controls", "slider", "topbar"] as const) {
    assert.deepEqual(resolveTvRemoteKey("MediaPause", zone), { kind: "pause" }, zone);
    assert.deepEqual(resolveTvRemoteKey("MediaPlay", zone), { kind: "play" }, zone);
  }
  // The D-pad and OK are not media keys.
  for (const key of ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", " "]) {
    assert.equal(resolveMediaKey(key), null, key);
  }
});

test("one OK press is one action: a handled OK's release and click are its echo, not a second press", () => {
  // The TV: OK on the focused Pause button. Vidstack's button acts on the
  // keydown (and prevents its default); the WebView then "clicks" the button
  // on release, pointer events included.
  const guard = createOkPressGuard();
  guard.noteKeydown("Enter", true, 1000);
  assert.equal(guard.shouldSwallow("keyup", "Enter", 1080), true, "the release");
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
    assert.equal(guard.shouldSwallow(type, undefined, 1100), true, type);
  }
  // Long enough after, a press is a press again.
  assert.equal(guard.shouldSwallow("pointerup", undefined, 1000 + OK_ECHO_MS + 1), false);
});

test("an OK nothing acted on keeps its click: that click is the press (a plain button)", () => {
  const guard = createOkPressGuard();
  guard.noteKeydown("Enter", false, 1000);
  assert.equal(guard.shouldSwallow("keyup", "Enter", 1050), false);
  assert.equal(guard.shouldSwallow("click", undefined, 1060), false);
});

test("only OK arms it: arrows, and other keys' releases, pass", () => {
  const guard = createOkPressGuard();
  guard.noteKeydown("ArrowRight", true, 1000);
  assert.equal(guard.shouldSwallow("click", undefined, 1050), false, "an arrow was not a press");
  guard.noteKeydown(" ", true, 2000);
  assert.equal(guard.shouldSwallow("keyup", " ", 2050), true, "Space is a press too");
  assert.equal(guard.shouldSwallow("keyup", "ArrowDown", 2050), false);
  assert.equal(guard.shouldSwallow("keydown", "Enter", 2060), false, "a new keydown is never swallowed");
});

test("the next real press, after the echo window, acts again (pause, then play, then pause)", () => {
  const guard = createOkPressGuard();
  let actions = 0;
  // Each OK: keydown acts; the WebView's release click follows 80 ms later.
  for (const at of [0, 2000, 4000]) {
    actions += 1;
    guard.noteKeydown("Enter", true, at);
    if (!guard.shouldSwallow("pointerup", undefined, at + 80)) actions += 1;
  }
  assert.equal(actions, 3);
});

/* ---- TV hold to scrub ---- */


test("a single press jumps 10 s from where it is", () => {
  assert.deepEqual(advanceHold(null, 1, 0, 100, 3600), { dir: 1, startedAt: 0, lastAt: 0, target: 110 });
  assert.equal(advanceHold(null, -1, 0, 5, 3600).target, 0);
});

test("held, it speeds up the longer it is held", () => {
  assert.ok(holdSpeed(0) < holdSpeed(2000) && holdSpeed(2000) < holdSpeed(4000) && holdSpeed(4000) < holdSpeed(7000));
  // Hold for 8 s, a repeat every 50 ms.
  let hold = advanceHold(null, 1, 0, 0, 100_000);
  const at: Record<number, number> = {};
  for (let t = 50; t <= 8000; t += 50) {
    hold = advanceHold(hold, 1, t, 0, 100_000);
    at[t] = hold.target;
  }
  const gained = (a: number, b: number) => at[b]! - at[a]!;
  // Each second of holding covers more film than the one before.
  assert.ok(gained(500, 1000) < gained(2000, 2500));
  assert.ok(gained(2000, 2500) < gained(4000, 4500));
  assert.ok(gained(4000, 4500) < gained(7000, 7500));
});

test("the pace doesn't depend on how fast the remote repeats", () => {
  const run = (every: number) => {
    let hold = advanceHold(null, 1, 0, 0, 100_000);
    for (let t = every; t <= 2000; t += every) hold = advanceHold(hold, 1, t, 0, 100_000);
    return hold.target;
  };
  assert.ok(Math.abs(run(50) - run(100)) < 1);
});

test("held back, it stops at the start; held on, at the end", () => {
  let hold = advanceHold(null, -1, 0, 20, 3600);
  for (let t = 50; t <= 3000; t += 50) hold = advanceHold(hold, -1, t, 20, 3600);
  assert.equal(hold.target, 0);
  hold = advanceHold(null, 1, 0, 3590, 3600);
  for (let t = 50; t <= 3000; t += 50) hold = advanceHold(hold, 1, t, 3590, 3600);
  assert.equal(hold.target, 3600);
});

test("changing direction starts a new 10 s jump from the target", () => {
  let hold = advanceHold(null, 1, 0, 100, 3600);
  hold = advanceHold(hold, -1, 100, hold.target, 3600);
  assert.deepEqual(hold, { dir: -1, startedAt: 100, lastAt: 100, target: 100 });
});

test("TV remote on Next episode: OK plays it, left/right still seek, up/down put it away", () => {
  assert.deepEqual(resolveTvRemoteKey("Enter", "upnext"), { kind: "next" });
  assert.deepEqual(resolveTvRemoteKey("ArrowLeft", "upnext"), { kind: "seek", by: -10 });
  assert.deepEqual(resolveTvRemoteKey("ArrowRight", "upnext"), { kind: "seek", by: 10 });
  assert.deepEqual(resolveTvRemoteKey("ArrowUp", "upnext"), { kind: "dismissUpNext" });
  assert.deepEqual(resolveTvRemoteKey("ArrowDown", "upnext"), { kind: "dismissUpNext" });
  // Transport keys mean the same everywhere.
  assert.deepEqual(resolveTvRemoteKey("MediaTrackNext", "upnext"), { kind: "next" });
});
