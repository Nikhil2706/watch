import assert from "node:assert/strict";
import { test } from "node:test";

import { inBatches, staleIds } from "./library-listing-diff.ts";

const held = new Map([
  ["a", { etag: "1" }],
  ["b", { etag: "2" }],
  ["c", { etag: undefined }],
]);

test("a title whose stamp is unchanged is not fetched again", () => {
  assert.deepEqual(staleIds([{ Id: "a", Etag: "1" }, { Id: "b", Etag: "2" }], held), []);
});

test("a changed stamp, a new title and a title with no stamp are", () => {
  assert.deepEqual(
    staleIds(
      [
        { Id: "a", Etag: "1" },
        { Id: "b", Etag: "9" },
        { Id: "new", Etag: "5" },
        { Id: "c" },
      ],
      held,
    ),
    ["b", "new", "c"],
  );
});

test("nothing held means everything is stale", () => {
  assert.deepEqual(staleIds([{ Id: "a", Etag: "1" }], new Map()), ["a"]);
});

test("batches", () => {
  assert.deepEqual(inBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(inBatches([], 50), []);
});
