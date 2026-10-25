import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDuration, orderUploadFiles, partNumberIn, splitAcrossParts, uploadFitsParts, uploadKind } from "./subtitle-parts.ts";

const cue = (startMs: number, text = `at ${startMs}`) => ({ index: 0, startMs, endMs: startMs + 2000, text });
const MIN = 60_000;

test("each part gets its own stretch of the film, starting at 0", () => {
  // Three parts: 0-60 min, 60-150 min, 150-240 min.
  const parts = splitAcrossParts([cue(5 * MIN), cue(59 * MIN), cue(61 * MIN), cue(149 * MIN), cue(151 * MIN)], [60 * MIN, 90 * MIN, 90 * MIN]);
  assert.deepEqual(
    parts.map((p) => p.map((c) => c.startMs / MIN)),
    [
      [5, 59],
      [1, 89],
      [1],
    ],
  );
  // Numbered from 1 in each part.
  assert.deepEqual(parts[1]!.map((c) => c.index), [1, 2]);
});

test("a line running across a cut goes to the part it starts in", () => {
  const parts = splitAcrossParts([{ index: 1, startMs: 59 * MIN + 59_000, endMs: 60 * MIN + 3000, text: "across" }], [60 * MIN, 60 * MIN]);
  assert.equal(parts[0]!.length, 1);
  assert.equal(parts[1]!.length, 0);
});

test("lines past the last part's end stay in the last part", () => {
  const parts = splitAcrossParts([cue(130 * MIN)], [60 * MIN, 60 * MIN]);
  assert.equal(parts[1]![0]!.startMs, 70 * MIN);
});

test("an upload split one file per part is used as it is", () => {
  assert.equal(uploadFitsParts(8, 8), true);
  assert.equal(uploadFitsParts(1, 8), false);
  assert.equal(uploadFitsParts(2, 8), false);
  assert.equal(uploadFitsParts(1, 1), false);
});

test("a part's length reads as a clock", () => {
  assert.equal(formatDuration(93 * MIN + 5000), "1:33:05");
  assert.equal(formatDuration(45 * MIN), "45:00");
});

test("the part a file name says it is", () => {
  assert.equal(partNumberIn("[1971] Jacques Rivette - Out 1_ noli me tangere EP3 - De Frederique a Sarah (EN)"), 3);
  assert.equal(partNumberIn("Out1 1971 part 6"), 6);
  assert.equal(partNumberIn("Out.1.1971.Part7.720p.BluRay"), 7);
  assert.equal(partNumberIn("Film.CD2.avi"), 2);
  assert.equal(partNumberIn("Out 1 (Noli Me Tangere)"), null);
  assert.equal(partNumberIn("Movie.1080p.x264"), null);
});

test("an upload's files go in part order, whatever order they come in", () => {
  const files = ["Out 1 1971 part3", "Out 1 1971 Part1", "Out 1 1971 Part2"].map((fileName) => ({ fileName }));
  assert.deepEqual(orderUploadFiles(files).map((f) => f.fileName), ["Out 1 1971 Part1", "Out 1 1971 Part2", "Out 1 1971 part3"]);
  // Names that don't all say a part keep the order given.
  const unnamed = [{ fileName: "b" }, { fileName: "a" }];
  assert.deepEqual(orderUploadFiles(unnamed), unnamed);
});

test("what an upload can do for a film in 8 parts", () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ fileName: `Part ${i + 1}` }));
  assert.deepEqual(uploadKind({ release: "Out 1", fileName: "Part 1", files: eight }, 8), { kind: "split" });
  assert.deepEqual(uploadKind({ release: "Out.1.1971.Part7.720p.BluRay", fileName: "Out.1.1971.Part7.720p.BluRay", files: [{ fileName: "Out.1.1971.Part7.720p.BluRay" }] }, 8), { kind: "onePart", part: 7 });
  assert.deepEqual(uploadKind({ release: "Out 1 (Noli Me Tangere) complete", fileName: "out1.complete", files: [{ fileName: "out1.complete" }] }, 8), { kind: "whole" });
  assert.deepEqual(uploadKind({ release: "x", fileName: "x", files: eight.slice(0, 2) }, 8), { kind: "mismatch" });
});
