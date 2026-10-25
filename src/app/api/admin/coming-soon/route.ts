import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import {
  announce,
  ComingSoonError,
  listAnnouncements,
  lookUpForAnnouncement,
  normaliseImdbId,
  removeAnnouncement,
} from "@/lib/coming-soon";
import { getGroup } from "@/lib/library-curation";
import { listUpcomingReleases } from "@/lib/rollout";
import { getSeriesById } from "@/lib/scraping/film-series";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function bad(message: string, status = 400): Response {
  return Response.json({ error: "invalid_request", message }, { status, headers: NO_STORE });
}

/**
 * Coming soon, for the curator (coming-soon.ts).
 *
 *   GET                -> { announcements, scheduled }
 *   GET ?lookup=tt…    -> { title } what TMDB says that IMDb id is
 *   POST { imdbId, note?, expectedAt? } -> announce (or update) it
 *   DELETE ?id=        -> take an announcement down
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const lookup = new URL(request.url).searchParams.get("lookup");
  if (lookup !== null) {
    const imdbId = normaliseImdbId(lookup);
    if (!imdbId) return bad("That isn't an IMDb id (tt followed by digits).");
    try {
      const title = await lookUpForAnnouncement(imdbId);
      return title ? Response.json({ imdbId, title }, { headers: NO_STORE }) : bad("TMDB doesn't know that IMDb id.", 404);
    } catch (error) {
      console.error("[admin/coming-soon] lookup failed:", error);
      return Response.json({ error: "upstream_error", message: "TMDB didn't answer; try again." }, { status: 502, headers: NO_STORE });
    }
  }
  const upcoming = listUpcomingReleases();
  // A film is listed by its title and year, not its file name.
  const films = upcoming.some((u) => u.subjectType === "film")
    ? new Map((await getAdminMovies({ withMediaSources: false })).map((m) => [m.Path, m.ProductionYear ? `${m.Name} (${m.ProductionYear})` : m.Name]))
    : new Map<string | undefined, string | undefined>();
  const scheduled = upcoming.map((u) => ({
    ...u,
    name:
      u.subjectType === "group"
        ? (getGroup(u.subjectId)?.groupName ?? u.subjectId)
        : u.subjectType === "series"
          ? (getSeriesById(u.subjectId)?.seriesName ?? u.subjectId)
          : (films.get(u.subjectId) ?? u.subjectId.split("/").pop() ?? u.subjectId),
  }));
  return Response.json({ announcements: listAnnouncements(), scheduled }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(request);
  } catch {
    /* answered below */
  }
  const imdbId = typeof body.imdbId === "string" ? normaliseImdbId(body.imdbId) : null;
  if (!imdbId) return bad("imdbId is required (tt followed by digits).");
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  const expectedAt = typeof body.expectedAt === "number" && Number.isFinite(body.expectedAt) ? body.expectedAt : null;
  try {
    return Response.json({ announcement: await announce({ imdbId, note, expectedAt }) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ComingSoonError) return bad(error.message, 404);
    console.error("[admin/coming-soon] announce failed:", error);
    return Response.json({ error: "upstream_error", message: "TMDB didn't answer; try again." }, { status: 502, headers: NO_STORE });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return bad("id is required.");
  return removeAnnouncement(id) ? Response.json({ ok: true }, { headers: NO_STORE }) : bad("No such announcement.", 404);
}
