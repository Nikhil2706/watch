import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreCandidate, type Rect } from "./spatial-nav.ts";

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, right: left + width, bottom: top + height, centerX: left + width / 2, centerY: top + height / 2 };
}

/** Which of `candidates` wins going `direction` from `current`. */
function winner(current: Rect, direction: "up" | "down" | "left" | "right", candidates: Record<string, Rect>): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [name, r] of Object.entries(candidates)) {
    const score = scoreCandidate(current, r, direction);
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

test("down reaches a wide box directly below, not a narrow poster further down", () => {
  // The film page on a TV: a rating star, the full-width comment box under
  // it, a poster row below that. Centre distance used to pick the poster.
  const star = rect(328, 520, 22, 44);
  assert.equal(
    winner(star, "down", {
      commentBox: rect(117, 600, 1729, 62),
      poster: rect(302, 895, 260, 452),
    }),
    "commentBox",
  );
});

test("down from a wide box picks the nearest thing under it", () => {
  const commentBox = rect(117, 600, 1729, 62);
  assert.equal(
    winner(commentBox, "down", {
      post: rect(1766, 679, 81, 38),
      poster: rect(866, 895, 260, 452),
    }),
    "post",
  );
});

test("a grid still moves by column", () => {
  const poster = rect(590, 300, 260, 452);
  assert.equal(
    winner(poster, "down", {
      sameColumn: rect(590, 800, 260, 452),
      nextColumn: rect(872, 800, 260, 452),
      previousColumn: rect(308, 800, 260, 452),
    }),
    "sameColumn",
  );
});

test("something aligned but farther beats something close but off to the side", () => {
  const button = rect(48, 694, 167, 64);
  assert.equal(
    winner(button, "down", {
      aligned: rect(48, 900, 260, 452),
      offToTheSide: rect(900, 780, 200, 60),
    }),
    "aligned",
  );
});

test("left and right stay in the row; up and down ignore what is behind", () => {
  const poster = rect(590, 300, 260, 452);
  assert.equal(scoreCandidate(poster, rect(872, 900, 260, 452), "right"), null, "a different row is not 'right'");
  assert.equal(scoreCandidate(poster, rect(590, 0, 260, 200), "down"), null, "above is not 'down'");
  assert.notEqual(scoreCandidate(poster, rect(872, 300, 260, 452), "right"), null);
});
