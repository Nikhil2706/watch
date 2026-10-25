import assert from "node:assert/strict";
import { test } from "node:test";

import { episodeLine } from "./resume-labels.ts";

test("an episode is placed in its show, then named", () => {
  assert.equal(episodeLine(1, 1, "Welcome to the Hellmouth"), "S1 E1 · Welcome to the Hellmouth");
  assert.equal(episodeLine(null, 7, "The Crisis"), "Episode 7 · The Crisis");
  assert.equal(episodeLine(null, null, "Pilot"), "Pilot");
});

test("a name that is only the number is not said twice", () => {
  assert.equal(episodeLine(2, 5, "Episode 5"), "S2 E5");
  assert.equal(episodeLine(2, 5, "S02E05"), "S2 E5");
  assert.equal(episodeLine(2, 5, null), "S2 E5");
});

test("a film kept in parts is placed by its part", () => {
  assert.equal(episodeLine(null, 7, "Out 1", { showName: "Out 1 (1971)" }), "Part 7");
  assert.equal(episodeLine(1, 2, "De Lili à Thomas", { showName: "Out 1 (1971)" }), "Part 2 · De Lili à Thomas");
});
