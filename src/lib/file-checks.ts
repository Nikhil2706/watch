import "server-only";

import { asRow, asRows, getDb } from "./db";

/**
 * What the worker found when it read each file through (scripts/file-check.mjs
 * says how, and why). The worker writes the rows; this reads them, and holds
 * the two things the curator can say about one: "show it anyway", and "check
 * it again".
 *
 * A file judged damaged is kept off the site's listings until it is replaced
 * (a changed file is checked afresh) or allowed. Its own page still opens
 * from a link, as a hidden title's does.
 */

export interface FileCheck {
  verdict: "ok" | "minor" | "damaged";
  detail: string;
  checkedAt: number;
  /** The curator has said to show it despite the damage. */
  allowed: boolean;
}

interface Row {
  path: string;
  verdict: FileCheck["verdict"];
  detail: string | null;
  checked_at: number;
  allowed: number;
}

/** Every file with something wrong, by path. Healthy files are the rest and are not listed. */
export function fileProblems(): Map<string, FileCheck> {
  return new Map(
    asRows<Row>(getDb().prepare("SELECT path, verdict, detail, checked_at, allowed FROM file_checks WHERE verdict <> 'ok' AND path LIKE '/%'").all()).map(
      (r) => [r.path, { verdict: r.verdict, detail: r.detail ?? "", checkedAt: r.checked_at, allowed: r.allowed === 1 }],
    ),
  );
}

/** Paths kept off the site: damaged, and not allowed. */
export function getDamagedPathSet(): Set<string> {
  return new Set(
    asRows<{ path: string }>(getDb().prepare("SELECT path FROM file_checks WHERE verdict = 'damaged' AND allowed = 0").all()).map(
      (r) => r.path,
    ),
  );
}

/** "Show anyway", or take that back. False when the file has no check on record. */
export function setDamagedAllowed(path: string, allowed: boolean): boolean {
  const result = getDb().prepare("UPDATE file_checks SET allowed = ? WHERE path = ?").run(allowed ? 1 : 0, path);
  return Number(result.changes) > 0;
}

/** Forget what was found, so the worker reads the file again on its next round. */
export function requestRecheck(path: string): boolean {
  return Number(getDb().prepare("DELETE FROM file_checks WHERE path = ?").run(path).changes) > 0;
}

export function fileCheckProgress(): { checked: number; damaged: number; minor: number; lastAt: number | null } {
  const row = asRow<{ checked: number; damaged: number | null; minor: number | null; last: number | null }>(
    getDb()
      .prepare(
        `SELECT COUNT(*) AS checked, SUM(verdict = 'damaged') AS damaged, SUM(verdict = 'minor') AS minor, MAX(checked_at) AS last
           FROM file_checks WHERE path LIKE '/%'`, // not the worker's own "last walk" marker row
      )
      .get(),
  );
  return { checked: row?.checked ?? 0, damaged: row?.damaged ?? 0, minor: row?.minor ?? 0, lastAt: row?.last ?? null };
}
