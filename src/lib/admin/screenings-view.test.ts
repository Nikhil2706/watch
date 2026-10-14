import { test } from "node:test";
import assert from "node:assert/strict";

import { screeningLine, screeningRequest, searchFilms } from "./screenings-view.ts";

test("search needs two letters and caps the list", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `Alien ${i}`, year: null }));
  assert.equal(searchFilms(items, "a"), null);
  assert.equal(searchFilms(items, "al")!.length, 8);
  assert.deepEqual(searchFilms(items, "zz"), []);
});

test("the request needs a film and fills in defaults", () => {
  const f = { label: " Ana ", message: "", windowHours: "", expiryDays: "3", maxDevices: "", startsOn: "play" as const };
  assert.deepEqual(screeningRequest(null, f), { error: "Pick a film first." });
  assert.deepEqual(screeningRequest("x", f), {
    body: { itemId: "x", recipientLabel: "Ana", message: null, windowHours: 48, expiryDays: 3, maxDevices: 2, windowStartsOn: "play" },
  });
});

test("one line per screening", () => {
  assert.equal(
    screeningLine({ id: "1", titles: ["Tenet"], recipientLabel: null, revoked: false, firstOpenedAt: 1, deviceCount: 1, deviceAttempts: 2, openedBy: ["Ana"] }),
    "Tenet · for unlabelled · opened · 1/2 devices — opened by someone calling themselves Ana",
  );
});
