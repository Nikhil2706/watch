/**
 * Range-header parsing for the offline-download route.
 *
 * Pulled out of the route so it can be tested: this is the code a phone
 * decides to trust when it resumes a 4GB film at 90% on a train, and getting
 * it wrong shows up as a download that silently restarts from zero.
 *
 * Follows RFC 7233 on the two points the inline version got wrong:
 *
 *  - An end past the last byte is CLAMPED, not rejected. `bytes=0-99999999`
 *    on a small file means "as much as you have", and answering 416 there
 *    makes a downloader think the file is gone.
 *  - A syntactically odd or multi-range header is IGNORED — the whole
 *    representation is returned — rather than answered with 416. 416 is for a
 *    range that is well-formed and genuinely unsatisfiable, and a client that
 *    asked for something we merely do not implement should still get its file.
 */
export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };

  const match = SINGLE_BYTE_RANGE.exec(header.trim());
  // Multi-range ("bytes=0-9,20-29"), another unit ("items=0-9"), or nonsense.
  // Ignoring it is what the spec asks for; we only ever serve one range.
  if (!match) return { kind: "full" };

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";

  // "bytes=-" carries neither half and means nothing.
  if (startText === "" && endText === "") return { kind: "full" };

  // An empty file cannot satisfy any byte range.
  if (size <= 0) return { kind: "unsatisfiable" };

  // Suffix form: "bytes=-500" is the LAST 500 bytes, not "up to byte 500".
  if (startText === "") {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffix)) return { kind: "full" };
    // "bytes=-0" asks for nothing, which is unsatisfiable rather than empty.
    if (suffix <= 0) return { kind: "unsatisfiable" };
    // Asking for more trailing bytes than exist yields the whole file.
    const start = Math.max(0, size - suffix);
    return { kind: "partial", start, end: size - 1 };
  }

  const start = Number.parseInt(startText, 10);
  if (!Number.isFinite(start)) return { kind: "full" };
  // A start at or past the end is the one case that genuinely deserves 416:
  // there is no byte there to send.
  if (start >= size) return { kind: "unsatisfiable" };

  // Open-ended "bytes=500-" runs to the end.
  if (endText === "") return { kind: "partial", start, end: size - 1 };

  const requestedEnd = Number.parseInt(endText, 10);
  if (!Number.isFinite(requestedEnd)) return { kind: "full" };
  if (requestedEnd < start) return { kind: "unsatisfiable" };

  return { kind: "partial", start, end: Math.min(requestedEnd, size - 1) };
}
