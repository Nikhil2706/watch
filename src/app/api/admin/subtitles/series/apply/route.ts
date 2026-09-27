import { requireAdmin } from "@/lib/admin-auth";
import { applySeriesSubtitles } from "@/lib/subtitle-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/subtitles/series/apply  { groupId, picks: [{ path, fileId }] }
 *   Downloads the accepted picks and writes each as "<video>.eng.srt".
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { groupId?: unknown; picks?: unknown };
  const picks = Array.isArray(body.picks)
    ? body.picks.filter(
        (p): p is { path: string; fileId: number } =>
          !!p && typeof (p as { path?: unknown }).path === "string" && Number.isInteger((p as { fileId?: unknown }).fileId),
      )
    : [];
  if (typeof body.groupId !== "string" || picks.length === 0) {
    return Response.json(
      { error: "bad_request", message: "groupId and at least one pick are required." },
      { status: 400, headers: NO_STORE },
    );
  }
  const result = await applySeriesSubtitles(body.groupId, picks);
  return Response.json({ ok: true, ...result }, { headers: NO_STORE });
}
