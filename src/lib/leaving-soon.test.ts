import assert from "node:assert/strict";
import { test } from "node:test";

import { daysLeft, isRemovableFolder, leavingAt, leavingLabel } from "./leaving-soon.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a mark covers the folder and everything under it, and nothing beside it", () => {
  const marks = [{ path: "/media/Horror/Wolf Creek", deleteAt: 5000 }];
  assert.equal(leavingAt("/media/Horror/Wolf Creek/Wolf Creek (2005)/film.mp4", marks), 5000);
  assert.equal(leavingAt("/media/Horror/Wolf Creek", marks), 5000);
  assert.equal(leavingAt("/media/Horror/Wolf Creek 2/film.mp4", marks), null);
  assert.equal(leavingAt("/media/Horror/Creep (2014)/film.mp4", marks), null);
});

test("inside two marked folders, the earlier date is the one that counts", () => {
  const marks = [
    { path: "/media/Horror", deleteAt: 9000 },
    { path: "/media/Horror/Wolf Creek", deleteAt: 4000 },
  ];
  assert.equal(leavingAt("/media/Horror/Wolf Creek/x.mp4", marks), 4000);
  assert.equal(leavingAt("/media/Horror/Creep/x.mp4", marks), 9000);
});

test("days are counted up, never below nothing", () => {
  const now = 1_000_000_000_000;
  assert.equal(daysLeft(now + 30 * DAY, now), 30);
  assert.equal(daysLeft(now + 29 * DAY + 1, now), 30);
  assert.equal(daysLeft(now + 60_000, now), 1);
  assert.equal(daysLeft(now - DAY, now), 0);
  assert.equal(leavingLabel(30), "30 days left");
  assert.equal(leavingLabel(1), "1 day left");
  assert.equal(leavingLabel(0), "Leaves today");
});

test("only a folder inside the library can be marked", () => {
  assert.equal(isRemovableFolder("/media/Horror", "/media"), true);
  assert.equal(isRemovableFolder("/media/American/Steven Spielberg", "/media/"), true);
  assert.equal(isRemovableFolder("/media", "/media"), false);
  assert.equal(isRemovableFolder("/media/", "/media"), false);
  assert.equal(isRemovableFolder("/media/Horror/../..", "/media"), false);
  assert.equal(isRemovableFolder("/media/./Horror", "/media"), false);
  assert.equal(isRemovableFolder("/mediaother/Horror", "/media"), false);
  assert.equal(isRemovableFolder("/etc", "/media"), false);
  assert.equal(isRemovableFolder("/media/Horror", ""), false);
});
