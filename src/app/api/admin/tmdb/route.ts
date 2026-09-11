import { requireAdmin } from "@/lib/admin-auth";
import { runTmdbBackfillTick, runTmdbRefreshTick } from "@/lib/tmdb-backfill";
import { ingestAllFromCache } from "@/lib/tmdb-people";
import { fetchShow, putLink, searchShows, tmdbStoreStats } from "@/lib/tmdb-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/tmdb — what is in the store. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json(tmdbStoreStats(), { headers: NO_STORE });
}

/**
 * POST /api/admin/tmdb — run one bounded batch.
 *   { budget? }                               fetch what is missing
 *   { mode: "refresh", maxAgeDays?, budget? } re-fetch what has gone stale
 *
 * Bounded and repeatable rather than one long run: TMDB has no daily quota to
 * respect, but this host's link to it drops connections often enough that a
 * synchronous pass over the whole library would spend minutes failing. Press it
 * again to continue — the store itself is the cursor.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let budget = 40;
  let mode: string | undefined;
  let maxAgeDays = 7;
  try {
    const body = (await request.json()) as { budget?: number; mode?: string; maxAgeDays?: number };
    const n = Number(body?.budget);
    if (Number.isFinite(n) && n > 0) budget = Math.min(300, Math.floor(n));
    mode = body?.mode;
    const age = Number(body?.maxAgeDays);
    if (Number.isFinite(age) && age >= 0) maxAgeDays = age;
  } catch {
    // No body is fine — the default budget is the point.
  }

  // "refresh" is what the weekly job sends. Until 2026-09-10 this route never
  // read the mode, so the job's refresh passes would have run the ordinary
  // backfill instead, which finds nothing new. Caught before its first run.
  if (mode === "refresh") {
    try {
      const result = await runTmdbRefreshTick(maxAgeDays, budget);
      // A re-fetched film can carry changed credits. The rebuild reads only the
      // cache and replaces rather than merges, so it is cheap and cannot double up.
      const credits = result.refreshed > 0 ? ingestAllFromCache().credits : 0;
      return Response.json(
        { ok: true, ...result, creditsIngested: credits, stats: tmdbStoreStats() },
        { headers: NO_STORE },
      );
    } catch (error) {
      console.error("[tmdb] refresh tick failed:", error);
      return Response.json({ error: "internal_error", message: "The TMDB refresh failed." }, { status: 500, headers: NO_STORE });
    }
  }

  try {
    const result = await runTmdbBackfillTick(budget);
    return Response.json({ ok: true, ...result, stats: tmdbStoreStats() }, { headers: NO_STORE });
  } catch (error) {
    console.error("[tmdb] backfill tick failed:", error);
    return Response.json({ error: "internal_error", message: "The TMDB pass failed." }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PUT /api/admin/tmdb — link a group to a TMDB show by hand.
 *   { groupId, tmdbId }        link it
 *   { groupId, search: true }  just list the candidates, so you can choose
 *
 * The matcher refuses anything short of an exact normalised name, which
 * correctly leaves translated titles unlinked — "Atti Degli Apostoli" is
 * *Acts of the Apostles* and no amount of string comparison will say so. This
 * is how those get resolved, and how a bad auto-link gets corrected.
 */
export async function PUT(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: { groupId?: string; tmdbId?: number; search?: boolean; name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }
  if (!body.groupId) {
    return Response.json({ error: "invalid_request", message: "groupId is required." }, { status: 400, headers: NO_STORE });
  }

  try {
    if (body.search) {
      const results = await searchShows(body.name ?? body.groupId);
      // Episode counts come only from the detail call, and they are the thing
      // that makes a choice possible, so the top few are enriched.
      const enriched = [];
      for (const r of results.slice(0, 5)) {
        try {
          const show = await fetchShow(r.id);
          const p = show.payload as { number_of_episodes?: number; overview?: string };
          enriched.push({ ...r, episodes: p.number_of_episodes ?? null, overview: (p.overview ?? "").slice(0, 140) });
        } catch {
          enriched.push({ ...r, episodes: null, overview: "" });
        }
      }
      return Response.json({ ok: true, candidates: enriched }, { headers: NO_STORE });
    }

    const tmdbId = Number(body.tmdbId);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      return Response.json({ error: "invalid_request", message: "tmdbId is required." }, { status: 400, headers: NO_STORE });
    }
    await fetchShow(tmdbId);
    putLink({
      subjectType: "group",
      subjectId: body.groupId,
      tmdbKind: "tv",
      tmdbId,
      season: null,
      episode: null,
      resolvedBy: "manual",
    });
    return Response.json({ ok: true, stats: tmdbStoreStats() }, { headers: NO_STORE });
  } catch (error) {
    console.error("[tmdb] manual link failed:", error);
    return Response.json({ error: "internal_error", message: "Could not reach TMDB." }, { status: 500, headers: NO_STORE });
  }
}
