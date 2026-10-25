/**
 * "Sync automatically": a subtitle file lined up with its video by alass
 * (https://github.com/kaegi/alass). alass finds where people speak in the
 * film's sound and moves the subtitle's lines to match, including a file
 * that drifts part way (made for a cut with a scene more or less).
 *
 * This file is the command and the judgement of its result, kept apart from
 * the worker that runs them (media-worker.mjs) so they can be tested. The
 * worker keeps the file's first version as "<name>.orig", as a save on the
 * sync screen does, so "Put back the first version" undoes it.
 */

/** The alass command line: reference (the video), the subtitle, where to write. */
export function alassArgs(video, subtitle, out) {
  return [video, subtitle, out];
}

/** The start time of every line in an .srt, in order (ms). */
export function srtStarts(text) {
  const starts = [];
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    starts.push(Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, "0")));
  }
  return starts;
}

function seconds(ms) {
  const s = Math.abs(ms) / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

function direction(ms) {
  return ms >= 0 ? "later" : "earlier";
}

/**
 * How far alass moved the lines, in words, or a reason the result can't be
 * used. alass keeps every line and their order, so line k before and after
 * are the same line. A "stretch" is a run of lines each moved about as much
 * as the line before: one stretch is a plain shift, or a steady drift when
 * alass also changed the speed; more mean alass split the file.
 */
export function judgeResult(beforeText, afterText) {
  const before = srtStarts(beforeText);
  const after = srtStarts(afterText);
  if (!after.length) return { ok: false, detail: "alass wrote no subtitle lines" };
  if (after.length !== before.length) {
    return { ok: false, detail: `alass returned ${after.length} lines for ${before.length}` };
  }
  const moves = after.map((t, i) => t - before[i]);
  let stretches = 1;
  for (let i = 1; i < moves.length; i++) if (Math.abs(moves[i] - moves[i - 1]) > 250) stretches++;
  const sorted = [...moves].sort((a, b) => a - b);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  if (Math.abs(low) < 100 && Math.abs(high) < 100) return { ok: true, detail: "already in time: nothing moved", moved: false };
  if (high - low < 250) {
    return { ok: true, detail: `moved ${seconds(sorted[sorted.length >> 1])} ${direction(sorted[sorted.length >> 1])}`, moved: true };
  }
  if (stretches === 1) {
    // One stretch whose move grows steadily: the subtitle ran at a slightly
    // different speed (a 25 or 29.97 fps release against a 23.976 film).
    const first = moves[0];
    const last = moves[moves.length - 1];
    return {
      ok: true,
      detail: `moved ${seconds(first)} ${direction(first)} at the start to ${seconds(last)} ${direction(last)} by the end (it ran at a slightly different speed)`,
      moved: true,
    };
  }
  const span = low < 0 && high > 0 ? `${seconds(low)} earlier to ${seconds(high)} later` : `${seconds(low)} to ${seconds(high)} ${direction(high)}`;
  return { ok: true, detail: `moved ${span}, in ${stretches} stretches`, moved: true };
}
