import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";
import { ingestAllFromCache } from "@/lib/tmdb-people";
import { runTmdbRefreshTick } from "@/lib/tmdb-backfill";
import { fetchMovie, fetchPerson, fetchSeason, fetchShow } from "@/lib/tmdb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const KINDS = new Set(["movie", "tv", "season", "person"]);
const DAY_MS = 86_400_000;

/**
 * GET /api/admin/tmdb/entries?kind=movie&limit=50 — the store, oldest first.
 *
 * A cached payload is a snapshot and nothing invalidates it, which is fine for
 * a week and wrong for a year. The weekly job asks for a refresh, but until
 * 2026-09-10 the route it asks ignored the request (see api/admin/tmdb), so
 * nothing has been re-fetched since the first fill. This is the view that says
 * how old "oldest" has become, and the POST below refreshes one entry when it
 * is known to have changed, or the stalest slice on demand.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "movie";
  if (!KINDS.has(kind)) {
    return Response.json(
      { error: "invalid_request", message: "kind must be movie, tv, season or person." },
      { status: 400, headers: NO_STORE },
    );
  }
  const asked = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(asked) ? Math.min(500, Math.max(1, Math.floor(asked))) : 50;

  const db = getDb();
  const rows = asRows<{ tmdb_id: number; season: number; title: string | null; fetched_at: number }>(
    db
      .prepare(
        // A season payload is named "Season 1", which says nothing in a list of
        // forty of them, so it borrows its show's name where the show is cached.
        "SELECT c.tmdb_id, c.season, " +
          "CASE WHEN c.kind = 'season' THEN " +
          "  COALESCE((SELECT json_extract(s.payload, '$.name') FROM tmdb_cache s " +
          "    WHERE s.kind = 'tv' AND s.tmdb_id = c.tmdb_id AND s.season = -1) || ' — ', '') || " +
          "  COALESCE(json_extract(c.payload, '$.name'), 'Season ' || c.season) " +
          "ELSE COALESCE(json_extract(c.payload, '$.title'), json_extract(c.payload, '$.name')) END AS title, " +
          "c.fetched_at FROM tmdb_cache c WHERE c.kind = ? ORDER BY c.fetched_at ASC LIMIT ?",
      )
      .all(kind, limit),
  );
  const total =
    asRows<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM tmdb_cache WHERE kind = ?").all(kind))[0]?.n ?? 0;

  const now = Date.now();
  return Response.json(
    {
      kind,
      total,
      entries: rows.map((r) => ({
        tmdbId: r.tmdb_id,
        season: r.season >= 0 ? r.season : null,
        title: r.title ?? "",
        fetchedAt: r.fetched_at,
        ageDays: Math.floor((now - r.fetched_at) / DAY_MS),
      })),
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/admin/tmdb/entries
 *   { kind, tmdbId, season? }        refresh one entry now
 *   { oldest: true, maxAgeDays? }    refresh a bounded slice of the stalest
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: { kind?: string; tmdbId?: number; season?: number; oldest?: boolean; maxAgeDays?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }

  if (body.oldest === true) {
    const asked = Number(body.maxAgeDays);
    const maxAgeDays = Number.isFinite(asked) && asked >= 0 ? asked : 30;
    try {
      // Bounded by the tick's own budget, and it keeps the previous payload
      // when a fetch fails, so a bad minute on this link costs nothing.
      const result = await runTmdbRefreshTick(maxAgeDays);
      const ingest = ingestAllFromCache();
      return Response.json({ ok: true, ...result, credits: ingest.credits }, { headers: NO_STORE });
    } catch (error) {
      console.error("[tmdb] stale refresh failed:", error);
      return Response.json(
        { error: "internal_error", message: "The refresh pass failed." },
        { status: 500, headers: NO_STORE },
      );
    }
  }

  const kind = body.kind ?? "";
  const tmdbId = Number(body.tmdbId);
  const season = Number(body.season);
  if (!KINDS.has(kind) || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
    return Response.json(
      { error: "invalid_request", message: "kind and a positive tmdbId are required." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (kind === "season" && (!Number.isSafeInteger(season) || season < 0)) {
    return Response.json(
      { error: "invalid_request", message: "A season refresh needs a season number." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    if (kind === "movie") await fetchMovie(tmdbId, true);
    else if (kind === "tv") await fetchShow(tmdbId, true);
    else if (kind === "season") await fetchSeason(tmdbId, season, true);
    else await fetchPerson(tmdbId, true);

    // A refreshed film or show may carry changed credits. The rebuild reads only
    // the cache and replaces rather than merges, so running it every time is
    // cheap and cannot double anything up.
    const ingest = kind === "movie" || kind === "tv" ? ingestAllFromCache() : null;
    return Response.json({ ok: true, credits: ingest?.credits ?? null }, { headers: NO_STORE });
  } catch (error) {
    console.error("[tmdb] single refresh failed:", error);
    return Response.json(
      {
        error: "upstream_error",
        message: "TMDB did not answer. This host's link to it drops about one request in thirty — try again.",
      },
      { status: 502, headers: NO_STORE },
    );
  }
}
