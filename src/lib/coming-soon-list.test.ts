import assert from "node:assert/strict";
import { test } from "node:test";

import { orderComingSoon, scheduleDetail, whenLabel, type ComingSoonEntry } from "./coming-soon-list.ts";

// 22 Oct 2026, 18:00 in India.
const NOW = Date.UTC(2026, 9, 22, 12, 30);
const DAY = 86_400_000;

function entry(key: string, at: number | null, createdAt = 0): ComingSoonEntry {
  return { key, kind: "announced", title: key, year: null, posterSrc: null, href: "/coming-soon", at, detail: null, note: null, overview: null, createdAt };
}

test("soonest dated first, then undated announcements, newest first", () => {
  const order = orderComingSoon([
    entry("undated-old", null, 1),
    entry("next-week", NOW + 7 * DAY),
    entry("undated-new", null, 5),
    entry("tomorrow", NOW + DAY),
  ]).map((e) => e.key);
  assert.deepEqual(order, ["tomorrow", "next-week", "undated-new", "undated-old"]);
});

test("dates read as people say them, in India time", () => {
  assert.equal(whenLabel(null, NOW), "Coming soon");
  // 20:00 India today.
  assert.equal(whenLabel(Date.UTC(2026, 9, 22, 14, 30), NOW), "Today, 8:00 pm");
  assert.equal(whenLabel(NOW + DAY, NOW), "Tomorrow");
  assert.equal(whenLabel(NOW + 2 * DAY, NOW), "Saturday");
  assert.equal(whenLabel(NOW + 10 * DAY, NOW), "1 Nov");
  assert.equal(whenLabel(Date.UTC(2027, 0, 5, 6), NOW), "5 Jan 2027");
});

test("the day turns at midnight India time, not UTC", () => {
  // 23 Oct 00:30 India is still 22 Oct in UTC: tomorrow, from 18:00 on the 22nd.
  assert.equal(whenLabel(Date.UTC(2026, 9, 22, 19, 0), NOW), "Tomorrow");
});

test("a schedule's line", () => {
  assert.equal(scheduleDetail("franchise", 3), "Next film · 3 to come");
  assert.equal(scheduleDetail("franchise", 1), "Next film");
  assert.equal(scheduleDetail("show", 1), "New episode");
  assert.equal(scheduleDetail("show", 5), "New episodes · 5 to come");
});
