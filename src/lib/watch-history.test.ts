import assert from "node:assert/strict";
import { test } from "node:test";

import { groupByMonth, watchedOn } from "./watch-history.ts";

const at = (id: string, iso?: string) => ({ Id: id, UserData: iso ? { LastPlayedDate: iso } : {} });

test("one section per month, newest first, in the order given", () => {
  const months = groupByMonth([
    at("a", "2026-10-22T15:00:00Z"),
    at("b", "2026-10-01T10:00:00Z"),
    at("c", "2026-09-30T12:00:00Z"),
  ]);
  assert.deepEqual(
    months.map((m) => [m.label, m.items.map((i) => i.Id)]),
    [
      ["October 2026", ["a", "b"]],
      ["September 2026", ["c"]],
    ],
  );
});

test("months are India time: late on the last day of a month in UTC is the next month here", () => {
  // 30 Sep 20:00 UTC is 1 Oct 01:30 in India.
  assert.equal(groupByMonth([at("a", "2026-09-30T20:00:00Z")])[0]!.label, "October 2026");
  assert.equal(watchedOn(at("a", "2026-09-30T20:00:00Z")), "1 Oct");
});

test("anything without a date goes last, under Earlier", () => {
  const months = groupByMonth([at("x"), at("a", "2026-10-22T15:00:00Z"), at("y", "not a date")]);
  assert.deepEqual(
    months.map((m) => [m.label, m.items.map((i) => i.Id)]),
    [
      ["October 2026", ["a"]],
      ["Earlier", ["x", "y"]],
    ],
  );
  assert.equal(watchedOn(at("x")), null);
});

test("nothing watched is no sections", () => {
  assert.deepEqual(groupByMonth([]), []);
});
