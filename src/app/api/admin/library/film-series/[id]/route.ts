import { requireAdmin } from "@/lib/admin-auth";
import { listAllMoviesAdmin } from "@/lib/jellyfin";
import { getRolloutPlan, listRolloutSlots, reconcileSeriesSlots } from "@/lib/rollout";
import { getSeriesById } from "@/lib/scraping/film-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/library/film-series/{id}
 *
 * A series' full entry list, each one flagged with whether it's actually
 * owned (cross-referenced against the live library by IMDb id, via the
 * same admin-scoped listAllMoviesAdmin() admin-search.ts already uses —
 * there's no per-user Jellyfin session on an admin-key-gated route),
 * plus its rollout plan and slots if one exists.
 *
 * Also reconciles the rollout on every load — if a plan exists, newly-
 * owned entries since the last time this was opened get assigned to open
 * slots automatically, same "just works" reasoning as the TV group route
 * reconciling after every grouping action.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const series = getSeriesById(id);
  if (!series) {
    return Response.json({ error: "not_found", message: "No such film series." }, { status: 404, headers: NO_STORE });
  }

  const movies = await listAllMoviesAdmin();
  const byImdb = new Map<string, (typeof movies)[number]>();
  for (const m of movies) {
    const imdb = m.ProviderIds?.Imdb;
    if (imdb) byImdb.set(imdb, m);
  }
  const ownedImdbIds = new Set(byImdb.keys());

  const plan = getRolloutPlan("series", id);
  if (plan) reconcileSeriesSlots(id, series.entries, ownedImdbIds);

  const entries = series.entries.map((e) => {
    const owned = e.imdb_id ? byImdb.get(e.imdb_id) : undefined;
    return {
      ...e,
      owned: Boolean(owned),
      ownedItemId: owned?.Id ?? null,
    };
  });

  return Response.json(
    {
      seriesId: series.seriesId,
      seriesName: series.seriesName,
      entries,
      plan: getRolloutPlan("series", id),
      slots: plan ? listRolloutSlots(plan.id) : [],
    },
    { headers: NO_STORE },
  );
}
