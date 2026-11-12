/**
 * Tests for collapsing a watched list to one entry per show.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/latest-per-show.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { latestPerShow, readUntilCards } from "./latest-per-show.ts";

type Watched = { id: string; show?: string };
const showOf = (w: Watched) => w.show;
const ids = (list: Watched[]) => list.map((w) => w.id);

test("keeps each show's newest episode, in order", () => {
  const recent: Watched[] = [
    { id: "nfy-s1e6", show: "nfy" },
    { id: "buffy-s1e5", show: "buffy" },
    { id: "buffy-s1e4", show: "buffy" },
    { id: "nfy-s1e4", show: "nfy" },
    { id: "buffy-s1e3", show: "buffy" },
  ];
  assert.deepEqual(ids(latestPerShow(recent, showOf)), ["nfy-s1e6", "buffy-s1e5"]);
});

test("films are never collapsed", () => {
  const recent: Watched[] = [{ id: "film-a" }, { id: "buffy-s1e5", show: "buffy" }, { id: "film-b" }, { id: "buffy-s1e4", show: "buffy" }];
  assert.deepEqual(ids(latestPerShow(recent, showOf)), ["film-a", "buffy-s1e5", "film-b"]);
});

test("the limit counts what is kept, not what is read", () => {
  const recent: Watched[] = [
    { id: "b5", show: "buffy" },
    { id: "b4", show: "buffy" },
    { id: "b3", show: "buffy" },
    { id: "film" },
    { id: "n6", show: "nfy" },
  ];
  assert.deepEqual(ids(latestPerShow(recent, showOf, 2)), ["b5", "film"]);
});

test("an empty list stays empty", () => {
  assert.deepEqual(latestPerShow([], showOf), []);
});

// ---- readUntilCards ------------------------------------------------------

type File = { id: string; show?: string; hidden?: boolean };
const pages = (all: File[]) => {
  const asked: number[] = [];
  const fetch = async (start: number, limit: number) => {
    asked.push(start);
    return all.slice(start, start + limit);
  };
  return { fetch, asked };
};
const opts = (cards: number, pageSize = 3, maxPages = 10) => ({
  showOf: (f: File) => f.show,
  keep: (fs: readonly File[]) => fs.filter((f) => !f.hidden),
  cards,
  pageSize,
  maxPages,
});

test("a big show counts once, so reading goes on until the row is full", async () => {
  // Looney Tunes on 2026-11-12: hundreds of new shorts ahead of everything.
  const all: File[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `lt${i}`, show: "lt" })),
    { id: "super8" },
    { id: "go" },
  ];
  const { fetch, asked } = pages(all);
  const got = await readUntilCards(fetch, opts(3));
  assert.deepEqual(got.slice(-2).map((f) => f.id), ["super8", "go"]);
  assert.deepEqual(asked, [0, 3, 6, 9]);
});

test("stops at the page that fills the row", async () => {
  const all: File[] = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}` }));
  const { fetch, asked } = pages(all);
  const got = await readUntilCards(fetch, opts(4));
  assert.equal(got.length, 6);
  assert.deepEqual(asked, [0, 3]);
});

test("hidden files neither appear nor count", async () => {
  const all: File[] = [{ id: "a", hidden: true }, { id: "b", hidden: true }, { id: "c" }, { id: "d" }];
  const { fetch } = pages(all);
  const got = await readUntilCards(fetch, opts(2, 2));
  assert.deepEqual(got.map((f) => f.id), ["c", "d"]);
});

test("ends with the listing, and never reads past maxPages", async () => {
  const short: File[] = [{ id: "a" }, { id: "b" }];
  assert.equal((await readUntilCards(pages(short).fetch, opts(20))).length, 2);

  const one: File[] = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, show: "s" }));
  const { fetch, asked } = pages(one);
  await readUntilCards(fetch, opts(5, 3, 4));
  assert.deepEqual(asked, [0, 3, 6, 9]);
});
