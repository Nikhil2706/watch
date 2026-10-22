import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleWorkerRows, workerChips, workerDot, workerRows, workerSub, type Candidate, type QueueJob } from "./worker-view.ts";

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, name: id, year: null, path: `/media/${id}.avi`, quality: "720x400 · MPEG4", ...over });
const job = (id: string, path: string, status: string, progress: number | null = null): QueueJob => ({ id, source_path: path, title: id, status, progress });

test("candidates take their job's state; finished jobs stay listed", () => {
  const rows = workerRows(
    [cand("a"), cand("b", { fix: "audio", reason: "main sound track is DTS" }), cand("c")],
    [job("1", "/media/c.avi", "running", 40), job("2", "/media/gone.mkv", "done", 100)],
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.status]),
    [
      ["a", "needs"],
      ["b", "audio"],
      ["c", "running"],
      ["job:2", "done"],
    ],
  );
  assert.equal(workerSub(rows[1]!), "main sound track is DTS");
  assert.equal(workerSub(rows[2]!), "running 40%");
  assert.equal(workerDot(rows[2]!), "accent");
});

test("chips count; the browser-audio chip only appears when there are any", () => {
  const plain = workerRows([cand("a")], []);
  assert.equal(workerChips(plain, "needs").some((c) => c.key === "audio"), false);
  const mixed = workerRows([cand("a"), cand("b", { fix: "audio" })], []);
  const chips = Object.fromEntries(workerChips(mixed, "needs").map((c) => [c.key, c]));
  assert.equal(chips.needs!.count, 1);
  assert.equal(chips.audio!.count, 1);
  assert.equal(chips.needs!.alert, true);
});

test("search matches the name or the file", () => {
  const rows = workerRows([cand("Alpha"), cand("Beta", { path: "/media/x/Zeta.mkv" })], []);
  assert.deepEqual(visibleWorkerRows(rows, "needs", "zeta").map((r) => r.id), ["Beta"]);
});
