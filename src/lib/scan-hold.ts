/**
 * While a library scan runs, the cached admin listing is not to be trusted.
 *
 * The scan route used to drop the listing as the scan *started*. Jellyfin's
 * scan call returns at once, and the scan route's own follow-up work (the
 * relinks in library-scan.ts, which read the listing through match.ts) read it
 * again straight away — before Jellyfin had found anything — and that answer
 * was cached as fresh for a minute. On 2026-11-02 a whole-library scan found a
 * new film in ten seconds; the console, seeing the scan end, reloaded, was
 * handed the minute-old list, and said "Nothing new". The grouping step's own
 * drop came five seconds after that.
 *
 * So a scan holds the listing open from start to end: every read in between
 * goes to Jellyfin, and nothing read then is trusted afterwards. The hold ends
 * when autoGroupAfterScan sees Jellyfin idle, plus AFTER_SCAN_MS, which covers
 * a folder re-read (Jellyfin reports no task for one, so "idle" arrives early)
 * as long as the console watches one (two minutes, curator.html). A hold that
 * is never ended — the grouping step failed to load — lapses after
 * SCAN_HOLD_MS, autoGroupAfterScan's own limit.
 *
 * Pure, so it is tested directly; admin-library-cache.ts keeps the state.
 */

export const SCAN_HOLD_MS = 30 * 60_000;
export const AFTER_SCAN_MS = 2 * 60_000;

export interface ScanHold {
  /** Scans started and not yet ended. */
  open: number;
  /** When an open hold lapses even if nobody ends it. */
  openUntil: number;
  /** The tail after the last scan ended. */
  tailUntil: number;
}

export function newScanHold(): ScanHold {
  return { open: 0, openUntil: 0, tailUntil: 0 };
}

export function scanStarted(hold: ScanHold, now: number): void {
  hold.open += 1;
  hold.openUntil = Math.max(hold.openUntil, now + SCAN_HOLD_MS);
}

export function scanEnded(hold: ScanHold, now: number): void {
  hold.open = Math.max(0, hold.open - 1);
  if (hold.open === 0) hold.openUntil = 0;
  hold.tailUntil = Math.max(hold.tailUntil, now + AFTER_SCAN_MS);
}

/** True while reads must go to Jellyfin rather than the cache. */
export function scanHolding(hold: ScanHold, now: number): boolean {
  return (hold.open > 0 && now < hold.openUntil) || now < hold.tailUntil;
}
