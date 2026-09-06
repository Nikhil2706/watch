import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { getPeopleForAllMoviesAdmin } from "@/lib/jellyfin";
import { listGroups } from "@/lib/library-curation";
import { guess, type KnownThings } from "@/lib/special-feature-guess";
import { getSpecialFeatureIdSet } from "@/lib/special-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/special-features/guess
 *
 * Proposes library items that look like special features, and what each might
 * be about. Proposes only — nothing here writes anything. A wrong guess costs
 * a film disappearing from Browse into some other film's extras, which is far
 * worse than the cost of confirming a right one, so every result goes through
 * the console for a human yes.
 *
 * Two Jellyfin calls, both already cached elsewhere for other panels, and one
 * local read. Expensive enough not to run on page load; cheap enough to be a
 * button.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const [movies, peopleByItem] = await Promise.all([
    getAdminMovies({ withMediaSources: false }),
    getPeopleForAllMoviesAdmin().catch(() => new Map()),
  ]);

  const alreadyMarked = getSpecialFeatureIdSet();

  // Everything the library knows about, for a candidate to be matched against.
  // People are deduplicated by id: the same director appears on every film
  // they made, and proposing them once per film would bury the console.
  const peopleById = new Map<string, { id: string; name: string; kind: "director" | "actor" }>();
  for (const credits of peopleByItem.values()) {
    for (const credit of credits) {
      if (credit.Type !== "Director" && credit.Type !== "Actor") continue;
      if (peopleById.has(credit.Id)) continue;
      peopleById.set(credit.Id, {
        id: credit.Id,
        name: credit.Name,
        kind: credit.Type === "Director" ? "director" : "actor",
      });
    }
  }

  const known: KnownThings = {
    // A film already marked as a special feature is not something another
    // feature should be mapped to.
    films: movies
      .filter((m) => !alreadyMarked.has(m.Id))
      .map((m) => ({ id: m.Id, title: m.Name })),
    groups: listGroups().map((g) => ({ id: g.groupId, name: g.groupName })),
    people: [...peopleById.values()],
  };

  const guesses = movies
    // Anything already marked has been decided on; the console lists those
    // separately, and re-proposing them would look like the guesser had no
    // memory.
    .filter((m) => !alreadyMarked.has(m.Id))
    .map((m) =>
      guess(
        { itemId: m.Id, title: m.Name, year: m.ProductionYear ?? null, overview: m.Overview ?? null },
        known,
      ),
    )
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => b.confidence - a.confidence);

  return Response.json(
    { guesses, scanned: movies.length, alreadyMarked: alreadyMarked.size },
    { headers: NO_STORE },
  );
}
