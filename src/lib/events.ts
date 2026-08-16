import "server-only";

import { randomUUID } from "node:crypto";

import { asRow, asRows, getDb } from "./db";

/**
 * The unified event feed behind the Curator's Dashboard's Health tab: every
 * external API failure, every user-facing route error, every playback
 * problem the player itself reports, and every worker conversion failure
 * lands here, so there is one place to look instead of six.
 *
 * Logging must never be the reason a request fails. Every function here
 * swallows its own errors rather than throwing — a full disk or a locked
 * database should degrade to "this one log line was lost", not take down
 * whatever real feature was in the middle of logging it.
 */

export type EventCategory =
  | "internal_api"
  | "external_api"
  | "playback"
  | "client"
  | "media_job"
  | "scrape_job";

export type EventSeverity = "info" | "warning" | "error" | "critical";

export interface LogEventInput {
  category: EventCategory;
  severity: EventSeverity;
  /** e.g. "omdb", "wikipedia", "jf_proxy", "player", "worker" — a short, stable label, not a sentence. */
  source: string;
  message: string;
  detail?: unknown;
  itemId?: string | null;
  username?: string | null;
}

export interface EventRow {
  id: string;
  category: EventCategory;
  severity: EventSeverity;
  source: string;
  message: string;
  detail: string | null;
  item_id: string | null;
  username: string | null;
  created_at: number;
}

const MAX_MESSAGE_CHARS = 2000;
const MAX_DETAIL_CHARS = 4000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 5000;
/** Pruning runs on a fraction of writes rather than every one — cheap enough
 * in aggregate, and avoids paying two extra DELETEs on every single log call. */
const PRUNE_PROBABILITY = 0.05;

function pruneOldEvents(): void {
  const db = getDb();
  db.prepare("DELETE FROM event_log WHERE created_at < ?").run(Date.now() - RETENTION_MS);
  // A row-count cap too, independent of age: client-reported errors are the
  // one category anyone outside the curator can trigger (see api/client-error),
  // so a burst of noise should not be able to grow this table unbounded within
  // the 30-day window above.
  db.prepare(
    `DELETE FROM event_log WHERE id NOT IN (
       SELECT id FROM event_log ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(MAX_ROWS);
}

/** Records one event. Never throws. */
export function logEvent(input: LogEventInput): void {
  try {
    const detail =
      input.detail === undefined
        ? null
        : (() => {
            try {
              return JSON.stringify(input.detail).slice(0, MAX_DETAIL_CHARS);
            } catch {
              return String(input.detail).slice(0, MAX_DETAIL_CHARS);
            }
          })();

    getDb()
      .prepare(
        `INSERT INTO event_log (id, category, severity, source, message, detail, item_id, username, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.category,
        input.severity,
        input.source.slice(0, 100),
        input.message.slice(0, MAX_MESSAGE_CHARS),
        detail,
        input.itemId ?? null,
        input.username ?? null,
        Date.now(),
      );

    if (Math.random() < PRUNE_PROBABILITY) pruneOldEvents();
  } catch (error) {
    console.error("[events] logEvent failed (event dropped):", error);
  }
}

export interface GetEventsOptions {
  category?: EventCategory;
  severity?: EventSeverity;
  limit?: number;
}

/** Most recent events first, for the dashboard's log viewer. Never throws. */
export function getRecentEvents(opts: GetEventsOptions = {}): EventRow[] {
  try {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.category) {
      clauses.push("category = ?");
      params.push(opts.category);
    }
    if (opts.severity) {
      clauses.push("severity = ?");
      params.push(opts.severity);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return asRows<EventRow>(
      getDb()
        .prepare(`SELECT * FROM event_log ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...(params as [])),
    );
  } catch (error) {
    console.error("[events] getRecentEvents failed:", error);
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * External API call tracking
 * ------------------------------------------------------------------ */

/** Known free-tier daily caps, for showing usage as a fraction. null = no known cap. */
const KNOWN_DAILY_CAPS: Record<string, number | null> = {
  omdb: 1000,
  wikipedia: null,
  yearendlists: null,
  reverseshot: null,
  ringer: null,
  brightwalldarkroom: null,
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Increments today's success/failure counter for one external service. Never throws. */
export function recordExternalApiCall(source: string, ok: boolean): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO external_api_calls (date, source, success_count, failure_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(date, source) DO UPDATE SET
           success_count = success_count + excluded.success_count,
           failure_count = failure_count + excluded.failure_count`,
      )
      .run(todayUtc(), source, ok ? 1 : 0, ok ? 0 : 1);
  } catch (error) {
    console.error("[events] recordExternalApiCall failed:", error);
  }
}

export interface ExternalApiUsage {
  source: string;
  successCount: number;
  failureCount: number;
  dailyCap: number | null;
}

/** Today's (UTC) call counts for every external service that has made at least one call, ever recorded. */
export function getExternalApiUsageToday(): ExternalApiUsage[] {
  try {
    const rows = asRows<{ source: string; success_count: number; failure_count: number }>(
      getDb()
        .prepare("SELECT source, success_count, failure_count FROM external_api_calls WHERE date = ?")
        .all(todayUtc()),
    );
    const known = Object.keys(KNOWN_DAILY_CAPS);
    const seen = new Set(rows.map((r) => r.source));
    // Known services with zero calls today still show up, at 0/cap — silence
    // is worth seeing too (e.g. OMDb key missing, or nothing has needed it yet).
    for (const source of known) {
      if (!seen.has(source)) rows.push({ source, success_count: 0, failure_count: 0 });
    }
    return rows.map((r) => ({
      source: r.source,
      successCount: r.success_count,
      failureCount: r.failure_count,
      dailyCap: KNOWN_DAILY_CAPS[r.source] ?? null,
    }));
  } catch (error) {
    console.error("[events] getExternalApiUsageToday failed:", error);
    return [];
  }
}

/** True if a row already exists for today with this id — used by health.ts to avoid a second query type. */
export function countEventsSince(since: number, opts: { severity?: EventSeverity[] } = {}): number {
  try {
    const db = getDb();
    if (opts.severity && opts.severity.length > 0) {
      const placeholders = opts.severity.map(() => "?").join(",");
      return (
        asRow<{ n: number }>(
          db
            .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE created_at >= ? AND severity IN (${placeholders})`)
            .get(since, ...opts.severity),
        )?.n ?? 0
      );
    }
    return asRow<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE created_at >= ?").get(since))?.n ?? 0;
  } catch (error) {
    console.error("[events] countEventsSince failed:", error);
    return 0;
  }
}
