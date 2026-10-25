import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeResult, srtStarts } from "./subtitle-autosync.mjs";

const srt = (...starts) =>
  starts
    .map((ms, i) => {
      const t = (x) => {
        const h = Math.floor(x / 3_600_000);
        const m = Math.floor((x % 3_600_000) / 60_000);
        const s = Math.floor((x % 60_000) / 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(x % 1000).padStart(3, "0")}`;
      };
      return `${i + 1}\n${t(ms)} --> ${t(ms + 2000)}\nline ${i + 1}\n`;
    })
    .join("\n");

test("reads each line's start", () => {
  assert.deepEqual(srtStarts(srt(2202, 3_723_004)), [2202, 3_723_004]);
  assert.deepEqual(srtStarts("1\r\n00:00:01.5 --> 00:00:02,000\r\nhi"), [1500]);
});

test("one shift for every line", () => {
  assert.deepEqual(judgeResult(srt(1000, 5000, 9000), srt(2200, 6200, 10200)), { ok: true, detail: "moved 1.2 s later", moved: true });
  assert.equal(judgeResult(srt(5000, 9000), srt(4500, 8500)).detail, "moved 0.5 s earlier");
});

test("a split: two stretches moved differently", () => {
  const r = judgeResult(srt(1000, 5000, 600_000, 700_000), srt(1500, 5500, 612_000, 712_000));
  assert.equal(r.detail, "moved 0.5 s to 12 s later, in 2 stretches");
});

test("a drift: the speed changed, not one shift (The Others)", () => {
  // 1.1 s later at the start, 4.8 s earlier 99 minutes on: 0.1% faster.
  const before = Array.from({ length: 100 }, (_, i) => 33_643 + i * 60_000);
  const after = before.map((t) => Math.round(1116 + t * (1 - 0.000_99)));
  const r = judgeResult(srt(...before), srt(...after));
  assert.equal(r.detail, "moved 1.1 s later at the start to 4.8 s earlier by the end (it ran at a slightly different speed)");
});

test("nothing to do", () => {
  assert.deepEqual(judgeResult(srt(1000, 5000), srt(1040, 5040)), { ok: true, detail: "already in time: nothing moved", moved: false });
});

test("a result that lost lines isn't used", () => {
  assert.equal(judgeResult(srt(1000, 5000), srt(1000)).ok, false);
  assert.equal(judgeResult(srt(1000), "").ok, false);
});
