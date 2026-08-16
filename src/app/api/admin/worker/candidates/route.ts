import { requireAdmin } from "@/lib/admin-auth";
import { listTransformCandidates } from "@/lib/library-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/worker/candidates
 *
 * Files that would fall back to a live transcode instead of playing
 * directly — read from Jellyfin's own probe results, since this app has no
 * ffmpeg of its own to check with (only the worker image does).
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const candidates = await listTransformCandidates();
    return Response.json({ candidates }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/worker/candidates] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not list transform candidates." },
      { status: 500, headers: NO_STORE },
    );
  }
}
