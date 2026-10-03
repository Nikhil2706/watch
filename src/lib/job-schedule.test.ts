import assert from "node:assert/strict";
import { test } from "node:test";

import { describeSchedule, nextRunAt, scheduleProblem } from "./job-schedule.ts";

/** An IST wall-clock time as an instant. */
const ist = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - 5.5 * 3600_000;
const show = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 16);

test("daily: later today if the time is still ahead, tomorrow if it has passed", () => {
  const nine = { cadence: "daily" as const, hour: 9, minute: 0 };
  assert.equal(show(nextRunAt(nine, ist(2026, 10, 3, 8, 59))), "2026-10-03T09:00");
  assert.equal(show(nextRunAt(nine, ist(2026, 10, 3, 9, 0))), "2026-10-04T09:00");
});

test("the day is the IST day, not the UTC one", () => {
  // 01:30 IST on the 4th is still the 3rd in UTC.
  const early = { cadence: "daily" as const, hour: 1, minute: 30 };
  assert.equal(show(nextRunAt(early, ist(2026, 10, 3, 23, 0))), "2026-10-04T01:30");
});

test("weekly: the next such weekday, a week on if today's time has passed", () => {
  // 2026-10-01 is a Thursday.
  const thursday = { cadence: "weekly" as const, hour: 9, minute: 0, weekday: 4 };
  assert.equal(show(nextRunAt(thursday, ist(2026, 10, 1, 8, 0))), "2026-10-01T09:00");
  assert.equal(show(nextRunAt(thursday, ist(2026, 10, 1, 10, 0))), "2026-10-08T09:00");
  assert.equal(show(nextRunAt(thursday, ist(2026, 10, 3, 10, 0))), "2026-10-08T09:00");
});

test("monthly: this month if still ahead, else next, across a year end", () => {
  const the23rd = { cadence: "monthly" as const, hour: 6, minute: 0, monthDay: 23 };
  assert.equal(show(nextRunAt(the23rd, ist(2026, 10, 3))), "2026-10-23T06:00");
  assert.equal(show(nextRunAt(the23rd, ist(2026, 12, 24))), "2027-01-23T06:00");
});

test("monthly on the 31st runs on the last day of a shorter month", () => {
  const the31st = { cadence: "monthly" as const, hour: 6, minute: 0, monthDay: 31 };
  assert.equal(show(nextRunAt(the31st, ist(2027, 2, 1))), "2027-02-28T06:00");
  assert.equal(show(nextRunAt(the31st, ist(2028, 2, 1))), "2028-02-29T06:00");
  assert.equal(show(nextRunAt(the31st, ist(2026, 10, 31, 7, 0))), "2026-11-30T06:00");
});

test("schedules read the way they would be said", () => {
  assert.equal(describeSchedule({ cadence: "daily", hour: 9, minute: 0 }), "Every day at 9:00 am");
  assert.equal(describeSchedule({ cadence: "weekly", hour: 5, minute: 30, weekday: 3 }), "Every Wednesday at 5:30 am");
  assert.equal(
    describeSchedule({ cadence: "monthly", hour: 0, minute: 5, monthDay: 23 }),
    "On the 23rd of every month at 12:05 am",
  );
  assert.equal(describeSchedule({ cadence: "monthly", hour: 13, minute: 0, monthDay: 11 }), "On the 11th of every month at 1:00 pm");
});

test("a schedule missing its day is refused", () => {
  assert.equal(scheduleProblem({ cadence: "daily", hour: 9, minute: 0 }), null);
  assert.ok(scheduleProblem({ cadence: "weekly", hour: 9, minute: 0 }));
  assert.ok(scheduleProblem({ cadence: "monthly", hour: 9, minute: 0, monthDay: 32 }));
  assert.ok(scheduleProblem({ cadence: "daily", hour: 24, minute: 0 }));
});
