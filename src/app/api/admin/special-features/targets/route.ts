import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { getPeopleForAllMoviesAdmin } from "@/lib/jellyfin";
import { listGroups } from "@/lib/library-curation";
import { getSpecialFeatureIdSet } from "@/lib/special-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/special-features/targets
 *
 * Everything a special feature can be mapped to, in one list: films,
 * franchises (library groups), directors and actors.
 *
 * Exists so the console can offer the same four kinds by hand that the
 * guesser proposes automatically. Without it, mapping to a director means
 * knowing a Jellyfin person id, which nobody does — and the guesser's own
 * suggestions would be the only way to reach three of the four kinds.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const [movies, peopleByItem] = await Promise.all([
    getAdminMovies({ withMediaSources: false }),
    getPeopleForAllMoviesAdmin().catch(() => new Map()),
  ]);

  const marked = getSpecialFeatureIdSet();

  // Deduplicated by id — a director appears on every film they made, and the
  // picker wants each person once.
  const directors = new Map<string, string>();
  const actors = new Map<string, string>();
  for (const credits of peopleByItem.values()) {
    for (const credit of credits) {
      if (credit.Type === "Director") directors.set(credit.Id, credit.Name);
      else if (credit.Type === "Actor") actors.set(credit.Id, credit.Name);
    }
  }

  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

  return Response.json(
    {
      // A feature is not something to map another feature onto.
      films: movies
        .filter((m) => !marked.has(m.Id))
        .map((m) => ({
          id: m.Id,
          label: m.ProductionYear ? `${m.Name} (${m.ProductionYear})` : m.Name,
        }))
        .sort(byName),
      franchises: listGroups()
        .map((g) => ({ id: g.groupId, label: g.groupName }))
        .sort(byName),
      directors: [...directors].map(([id, label]) => ({ id, label })).sort(byName),
      actors: [...actors].map(([id, label]) => ({ id, label })).sort(byName),
    },
    { headers: NO_STORE },
  );
}
