/**
 * Tests for the channel clock.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/channel-schedule.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { lineupMs, onNow, seededShuffle, slotLength, timetableMarkMs, upcoming } from "./channel-schedule.ts";

const MIN = 60_000;
// Three programmes: 45, 30 and 15 minutes; the lineup runs 90 minutes.
const slots = [{ runtimeMs: 45 * MIN }, { runtimeMs: 30 * MIN }, { runtimeMs: 15 * MIN }];
const epoch = Date.UTC(2026, 9, 30, 20, 0);

test("at the epoch, the first programme is starting", () => {
  assert.deepEqual(onNow(slots, epoch, epoch), { index: 0, offsetMs: 0, startedAtMs: epoch, endsAtMs: epoch + 45 * MIN });
});

test("partway through the lineup, the right programme and how far in", () => {
  const now = epoch + 50 * MIN;
  const on = onNow(slots, epoch, now)!;
  assert.equal(on.index, 1);
  assert.equal(on.offsetMs, 5 * MIN);
  assert.equal(on.startedAtMs, epoch + 45 * MIN);
  assert.equal(on.endsAtMs, epoch + 75 * MIN);
});

test("the lineup loops: a full cycle later it is the same", () => {
  assert.deepEqual(onNow(slots, epoch, epoch + 90 * MIN + 10 * MIN)!.index, 0);
  assert.equal(onNow(slots, epoch, epoch + 3 * 90 * MIN + 80 * MIN)!.index, 2);
});

test("a clock before the epoch still lands somewhere sensible", () => {
  const on = onNow(slots, epoch, epoch - 5 * MIN)!;
  assert.equal(on.index, 2);
  assert.equal(on.offsetMs, 10 * MIN);
});

test("an empty or zero-length lineup has nothing on", () => {
  assert.equal(onNow([], epoch, epoch), null);
  assert.equal(onNow([{ runtimeMs: 0 }], epoch, epoch), null);
});

test("a zero-length programme is skipped, not shown", () => {
  const withGap = [{ runtimeMs: 10 * MIN }, { runtimeMs: 0 }, { runtimeMs: 10 * MIN }];
  assert.equal(onNow(withGap, epoch, epoch + 12 * MIN)!.index, 2);
});

test("the guide: now, then what follows, round the loop", () => {
  const guide = upcoming(slots, epoch, epoch + 80 * MIN, 4);
  assert.deepEqual(
    guide.map((g) => g.index),
    [2, 0, 1, 2],
  );
  assert.equal(guide[1]!.startedAtMs, epoch + 90 * MIN);
  assert.equal(guide[2]!.startedAtMs, epoch + 135 * MIN);
});

test("a seeded shuffle is the same for the same seed, and a real reorder", () => {
  const list = Array.from({ length: 20 }, (_, i) => i);
  const a = seededShuffle(list, "channel-1:1");
  assert.deepEqual(a, seededShuffle(list, "channel-1:1"));
  assert.notDeepEqual(a, list);
  assert.notDeepEqual(a, seededShuffle(list, "channel-1:2"));
  assert.deepEqual([...a].sort((x, y) => x - y), list);
});

test("a lineup that does not loop plays once, then is off air", () => {
  assert.equal(lineupMs(slots), 90 * MIN);
  assert.equal(onNow(slots, epoch, epoch + 80 * MIN, false)?.index, 2);
  assert.equal(onNow(slots, epoch, epoch + 90 * MIN, false), null);
  assert.equal(onNow(slots, epoch, epoch - MIN, false), null);
  // Looping, the same moment is the top of the lineup again.
  assert.equal(onNow(slots, epoch, epoch + 90 * MIN)?.index, 0);
});

test("the guide of a lineup that does not loop stops at its last programme", () => {
  const guide = upcoming(slots, epoch, epoch + 50 * MIN, 4, false);
  assert.deepEqual(guide.map((p) => p.index), [1, 2]);
  assert.deepEqual(upcoming(slots, epoch, epoch + 50 * MIN, 4).map((p) => p.index), [1, 2, 0, 1]);
});

test("fixed slots: each programme takes the slot, so starts land on the marks", () => {
  // Timetabled as 45-minute slots whatever each runs for.
  const fixed = slots.map(() => ({ runtimeMs: 45 * MIN }));
  const second = onNow(fixed, epoch, epoch + 50 * MIN)!;
  assert.equal(second.index, 1);
  assert.equal(second.startedAtMs, epoch + 45 * MIN);
  assert.equal(second.endsAtMs, epoch + 90 * MIN);
});

test("round slots: a film is rounded up to the next mark and never cut", () => {
  const five = 5 * MIN;
  assert.equal(slotLength(107 * MIN + 20_000, five, "round"), 110 * MIN);
  assert.equal(slotLength(90 * MIN, five, "round"), 90 * MIN);
  assert.equal(slotLength(45 * MIN + 36_000, 45 * MIN, "fixed"), 45 * MIN);
  assert.equal(slotLength(41 * MIN, 45 * MIN, "fixed"), 45 * MIN);
  assert.equal(slotLength(41 * MIN, 0, "round"), 41 * MIN);
});

test("a timetable starts on its slot's mark, or the quarter hour", () => {
  assert.equal(timetableMarkMs(5 * MIN), 5 * MIN);
  assert.equal(timetableMarkMs(15 * MIN), 15 * MIN);
  assert.equal(timetableMarkMs(45 * MIN), 15 * MIN);
  assert.equal(timetableMarkMs(60 * MIN), 15 * MIN);
});
