import "server-only";

import { getAdminMovies, invalidateAdminMovies } from "./admin-library-cache";
import { planDecision, type CatalogueWrite, type DecisionRequest } from "./catalogue-decide";
import { listingFacts, readListingSources, type ListingSources } from "./catalogue-facts";
import { deriveCatalogueState, primaryReason, type CatalogueFacts, type CatalogueState } from "./catalogue-state";
import { invalidate } from "./cache";
import { generateId } from "./crypto";
import { getDb, transaction } from "./db";
import { fileProblems, requestRecheck, setDamagedAllowed } from "./file-checks";
import {
  addToGroup,
  excludePath,
  getGroupedPathMap,
  removeFromGroup,
  unexcludePath,
  unwhitelistPath,
  whitelistPath,
} from "./library-curation";
import { acceptFolderSuggestion } from "./folder-match";
import { createVersionSet, removeFromVersionSet, setVersionLabel } from "./film-versions";
import { groupSeriesNow, keepAsFilm } from "./series-autogroup";
import { addTarget, markSpecialFeature, unmarkSpecialFeature } from "./special-features";
import type { AdminMovieListItem } from "./jellyfin";

/**
 * The catalogue's decisions and its summary table (docs/catalogue-state.md,
 * 3.2 to 3.4). catalogue-decide.ts plans a decision as calls to the existing
 * functions; this makes them, logs who decided, and keeps catalogue_items
 * current. Nothing here decides what the site shows: that is still derived
 * live, per request, from the same tables these functions write.
 */

/** Who made a decision, as the log records it. */
export type DecidedBy = "curator" | "auto-group" | "folder-match" | (string & {});

async function runWrite(w: CatalogueWrite): Promise<void> {
  switch (w.op) {
    case "excludePath": return excludePath(w.path, w.note ?? undefined);
    case "unexcludePath": unexcludePath(w.path); return;
    case "whitelistPath": return whitelistPath(w.path);
    case "unwhitelistPath": unwhitelistPath(w.path); return;
    case "setDamagedAllowed": setDamagedAllowed(w.path, w.allowed); return;
    case "requestRecheck": requestRecheck(w.path); return;
    case "keepAsFilm": return keepAsFilm(w.path);
    case "removeFromGroup": removeFromGroup(w.path); return;
    case "addToGroup": addToGroup(w.groupId, [w.path]); return;
    case "groupSeriesNow": await groupSeriesNow(w.seriesKey); return;
    case "markSpecialFeature": return markSpecialFeature(w.itemId);
    case "unmarkSpecialFeature": unmarkSpecialFeature(w.itemId); return;
    case "addTarget": return addTarget(w.itemId, w.kind, w.targetId);
    case "removeFromVersionSet": removeFromVersionSet(w.path); return;
    case "createVersionSet": createVersionSet(w.primaryPath, [w.path]); return;
    case "setVersionLabel": setVersionLabel(w.path, w.label); return;
    case "acceptFolderSuggestion": await acceptFolderSuggestion(w.path); return;
  }
}

/**
 * Appends to the decision log. Called by decide() and by the older endpoints
 * it wraps, so the log is complete whichever the console used. Never throws:
 * a decision that was made must not report failure because its log line
 * could not be written.
 */
export function logDecision(input: {
  path: string;
  action: string;
  params?: Record<string, unknown> | null;
  reason?: string | null;
  decidedBy?: DecidedBy;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO catalogue_decisions (id, path, action, params, reason, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generateId(),
        input.path,
        input.action,
        input.params && Object.keys(input.params).length ? JSON.stringify(input.params) : null,
        input.reason ?? null,
        input.decidedBy ?? "curator",
        Date.now(),
      );
  } catch (error) {
    console.error("[catalogue] decision log write failed:", error);
  }
}

interface Projected {
  path: string;
  itemId: string;
  name: string | null;
  state: CatalogueState;
}

/** What the listing read leaves out and a decision needs: see facts(). */
interface FullSources extends ListingSources {
  groups: ReturnType<typeof getGroupedPathMap>;
  problems: ReturnType<typeof fileProblems>;
}

function readSources(): FullSources {
  return { ...readListingSources(), groups: getGroupedPathMap(), problems: fileProblems() };
}

/**
 * The listing's facts, plus two things the listing read leaves out because
 * neither changes a listing, and both matter here:
 *  - the show a file is in: being in one answers "what is this?"
 *    (catalogue-state.ts, SILENCED_BY_GROUP); without it every episode with no
 *    metadata of its own counted as needing you;
 *  - damage the curator has allowed: the listing only knows damage nobody
 *    has, so after "show anyway" the file looked undamaged and "take off"
 *    had nothing to take back.
 */
function facts(item: AdminMovieListItem, s: FullSources): CatalogueFacts {
  const f = listingFacts(item, s);
  if (!item.Path) return f;
  const check = s.problems.get(item.Path);
  return {
    ...f,
    group: s.groups.get(item.Path) ?? null,
    damaged: check?.verdict === "damaged" ? { allowed: check.allowed, detail: check.detail || null } : null,
  };
}

function project(item: AdminMovieListItem, s: FullSources): Projected | null {
  if (!item.Path) return null;
  return { path: item.Path, itemId: item.Id, name: item.Name ?? null, state: deriveCatalogueState(facts(item, s)) };
}

const UPSERT_SQL = `
  INSERT INTO catalogue_items
    (path, item_id, name, state, reason, reasons, placement, detail, needs_you, decided_by, decided_at, derived_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
    (SELECT decided_by FROM catalogue_decisions WHERE path = ? ORDER BY decided_at DESC LIMIT 1),
    (SELECT decided_at FROM catalogue_decisions WHERE path = ? ORDER BY decided_at DESC LIMIT 1),
    ?)
  ON CONFLICT(path) DO UPDATE SET
    item_id = excluded.item_id, name = excluded.name, state = excluded.state, reason = excluded.reason,
    reasons = excluded.reasons, placement = excluded.placement, detail = excluded.detail,
    needs_you = excluded.needs_you, decided_by = excluded.decided_by, decided_at = excluded.decided_at,
    derived_at = excluded.derived_at`;

function rowValues(p: Projected, now: number): Array<string | number | null> {
  const primary = primaryReason(p.state);
  const reasons = p.state.reasons.map((r) => ({ code: r.code, words: r.words, needsYou: r.needsYou }));
  return [
    p.path,
    p.itemId,
    p.name,
    p.state.state,
    primary?.code ?? null,
    JSON.stringify(reasons),
    JSON.stringify(p.state.placement),
    primary?.words ?? null,
    p.state.needsYou ? 1 : 0,
    p.path,
    p.path,
    now,
  ];
}

/**
 * Rewrites catalogue_items whole from the library listing and the tables the
 * facts come from. Run after a library scan, at boot and nightly (the
 * Library scan job); a decision updates its one row as it goes.
 */
export async function refreshCatalogue(): Promise<{ files: number; needsYou: number }> {
  const items = await getAdminMovies({ withMediaSources: false });
  const sources = readSources();
  const now = Date.now();
  const rows = items.map((item) => project(item, sources)).filter((p): p is Projected => p !== null);
  transaction((db) => {
    db.exec("DELETE FROM catalogue_items");
    const insert = db.prepare(UPSERT_SQL);
    for (const p of rows) insert.run(...rowValues(p, now));
  });
  return { files: rows.length, needsYou: rows.filter((p) => p.state.needsYou).length };
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

async function itemForPath(path: string): Promise<AdminMovieListItem | null> {
  const items = await getAdminMovies({ withMediaSources: false });
  return items.find((i) => i.Path === path) ?? null;
}

/**
 * One decision about one file: planned, made through the existing functions,
 * logged, and answered with the file's new state so a client can redraw one
 * card. Every action is idempotent.
 */
export async function decide(
  path: string,
  request: DecisionRequest,
  decidedBy: DecidedBy = "curator",
): Promise<{ path: string; state: CatalogueState }> {
  const item = await itemForPath(path);
  if (!item) throw new DecisionError("That file isn't in the library listing.", 404);

  const plan = planDecision(facts(item, readSources()), request);
  if (!plan.ok) throw new DecisionError(plan.message);

  for (const write of plan.writes) await runWrite(write);

  const { action, ...params } = request;
  logDecision({
    path,
    action,
    params: params as Record<string, unknown>,
    reason: "reason" in request ? (request.reason ?? null) : null,
    decidedBy,
  });

  // What viewers are listed changed. The curator's listing too when a file
  // moved into or out of a show, as keep-as-film's endpoint has always done.
  // (Jellyfin's metadata is untouched, so forgetAdminMovie's settling is not needed.)
  invalidate("all-movies");
  if (plan.writes.some((w) => w.op === "keepAsFilm" || w.op === "addToGroup" || w.op === "groupSeriesNow")) {
    invalidateAdminMovies();
  }

  const after = project(item, readSources())!;
  getDb().prepare(UPSERT_SQL).run(...rowValues(after, Date.now()));
  return { path, state: after.state };
}
