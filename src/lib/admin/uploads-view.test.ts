import { test } from "node:test";
import assert from "node:assert/strict";

import { scanNote, uploadActions, uploadChips, visibleUploads, type Upload } from "./uploads-view.ts";

const up = (id: string, status: Upload["status"], scan_result: string | null = null): Upload => ({
  id,
  filename: `${id}.mkv`,
  username: "u",
  size_bytes: 1,
  status,
  scan_result,
  created_at: 0,
});

test("chips count each state and flag the ones that need you", () => {
  const list = [up("a", "clean"), up("b", "uploaded"), up("c", "scanning"), up("d", "infected"), up("e", "approved")];
  const chips = Object.fromEntries(uploadChips(list, "all").map((c) => [c.key, c]));
  assert.equal(chips.review!.count, 1);
  assert.equal(chips.review!.alert, true);
  assert.equal(chips.scanning!.count, 2);
  assert.equal(chips.infected!.alert, true);
  assert.equal(chips.all!.count, 5);
  assert.deepEqual(visibleUploads(list, "scanning").map((u) => u.id), ["b", "c"]);
});

test("approve only once the scan is clean; nothing to do once decided", () => {
  assert.deepEqual(uploadActions({ status: "clean" }), { approve: true, reject: true });
  assert.deepEqual(uploadActions({ status: "infected" }), { approve: false, reject: true });
  assert.deepEqual(uploadActions({ status: "scanning" }), { approve: false, reject: true });
  assert.deepEqual(uploadActions({ status: "approved" }), { approve: false, reject: false });
});

test("the scan detail shows until a decision", () => {
  assert.equal(scanNote({ status: "infected", scan_result: "Eicar-Signature" }), "Eicar-Signature");
  assert.equal(scanNote({ status: "rejected", scan_result: "Eicar-Signature" }), null);
});
