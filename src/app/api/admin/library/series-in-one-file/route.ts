import { requireAdmin } from "@/lib/admin-auth";
import { identifyAsSeriesInOneFile, searchMiniseries, SeriesInOneFileError } from "@/lib/series-in-one-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * A TV mini-series kept as one file (series-in-one-file.ts).
 *
 *   GET  ?q=                       -> { shows: [{ tmdbId, name, year }] } TMDB's shows by name
 *   POST { itemId, path, tmdbId }  -> link the file to that show and name it after it
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return Response.json({ shows: await searchMiniseries(q) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/series-in-one-file] search failed:", error);
    return Response.json({ error: "upstream_error", message: "TMDB didn't answer; try again." }, { status: 502, headers: NO_STORE });
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { itemId?: unknown; path?: unknown; tmdbId?: unknown };
  if (typeof b.itemId !== "string" || typeof b.path !== "string" || typeof b.tmdbId !== "number") {
    return Response.json({ error: "invalid_request", message: "itemId, path and tmdbId are required." }, { status: 400, headers: NO_STORE });
  }
  try {
    const r = await identifyAsSeriesInOneFile({ itemId: b.itemId, path: b.path, tmdbId: b.tmdbId });
    return Response.json({ ok: true, ...r }, { headers: NO_STORE });
  } catch (error) {
    const known = error instanceof SeriesInOneFileError;
    if (!known) console.error("[admin/library/series-in-one-file] identify failed:", error);
    return Response.json(
      { error: known ? "invalid_request" : "upstream_error", message: error instanceof Error ? error.message : "Could not do that." },
      { status: known ? 400 : 502, headers: NO_STORE },
    );
  }
}
