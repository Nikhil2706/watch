import { requireAdmin } from "@/lib/admin-auth";
import { planSeriesSubtitles } from "@/lib/subtitle-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/subtitles/series/plan  { groupId, allSeasons? }
 *   What would be downloaded for each episode missing subtitles, matched to
 *   the family of the one episode that already has the right file. Spends a
 *   few downloads identifying that family; downloads nothing else.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { groupId?: unknown; allSeasons?: unknown };
  if (typeof body.groupId !== "string" || !body.groupId) {
    return Response.json({ error: "bad_request", message: "groupId is required." }, { status: 400, headers: NO_STORE });
  }
  try {
    const plan = await planSeriesSubtitles(body.groupId, { allSeasons: body.allSeasons === true });
    return Response.json({ ok: true, plan }, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      { error: "plan_failed", message: error instanceof Error ? error.message : "Could not plan subtitles." },
      { status: 400, headers: NO_STORE },
    );
  }
}
