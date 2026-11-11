import { requireAdmin } from "@/lib/admin-auth";
import { invalidate } from "@/lib/cache";
import { clearEpisodeNumbers, setEpisodeNumbers, type EpisodeNumberEntry } from "@/lib/episode-numbers";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX = 5000;

/**
 * POST /api/admin/library/episode-numbers
 *   { set: [{ path, season, episode }] }  numbers files whose names carry none
 *   { clear: [path] }                     back to the filename
 *
 * For a collection of shorts (episode-numbers.ts): season the year, episode
 * the release order, season 0 the extras. A channel showing the show picks
 * the order up when it is next rebuilt.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const set = body.set ?? [];
    const clear = body.clear ?? [];
    if (!Array.isArray(set) || !Array.isArray(clear) || set.length + clear.length > MAX) {
      throw new ValidationError(`set and clear must be lists, ${MAX} entries at most.`);
    }
    const entries: EpisodeNumberEntry[] = set.map((e) => {
      const entry = e as Partial<EpisodeNumberEntry>;
      const ok =
        typeof entry.path === "string" &&
        entry.path.startsWith("/") &&
        entry.path.length <= 4096 &&
        Number.isInteger(entry.season) &&
        Number.isInteger(entry.episode) &&
        entry.season! >= 0 &&
        entry.season! < 10000 &&
        entry.episode! >= 0 &&
        entry.episode! < 1000;
      if (!ok) throw new ValidationError("Each entry needs a path, a season (0-9999) and an episode (0-999).");
      return { path: entry.path!, season: entry.season!, episode: entry.episode! };
    });
    if (!clear.every((p) => typeof p === "string")) throw new ValidationError("clear must be a list of paths.");
    const numbered = setEpisodeNumbers(entries);
    const cleared = clearEpisodeNumbers(clear as string[]);
    invalidate("all-movies");
    return Response.json({ numbered, cleared }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/episode-numbers] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the numbers." }, { status: 500, headers: NO_STORE });
  }
}
