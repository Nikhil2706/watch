import { requireAdmin } from "@/lib/admin-auth";
import { planSeriesSubtitles } from "@/lib/subtitle-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/subtitles/series/plan  { groupId }
 *   What would be downloaded for each episode with no subtitle at all (an
 *   episode with a built-in track is left alone): matched to the family of a
 *   reference episode's .srt or built-in track when there is one, else on its
 *   own (moviehash, then best-rated). Spends at most five downloads
 *   identifying the reference; downloads nothing else.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { groupId?: unknown };
  if (typeof body.groupId !== "string" || !body.groupId) {
    return Response.json({ error: "bad_request", message: "groupId is required." }, { status: 400, headers: NO_STORE });
  }
  try {
    const plan = await planSeriesSubtitles(body.groupId);
    return Response.json({ ok: true, plan }, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      { error: "plan_failed", message: error instanceof Error ? error.message : "Could not plan subtitles." },
      { status: 400, headers: NO_STORE },
    );
  }
}
