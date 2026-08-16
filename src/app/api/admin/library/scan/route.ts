import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { JellyfinError, refreshLibrary } from "@/lib/jellyfin";
import { promoteSubtitles } from "@/lib/subtitle-promotion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/scan
 *
 * Triggers a Jellyfin library scan. Needed because the `jellyfin` container
 * mounts the library read-only, so Jellyfin never notices a file removed or
 * added on disk until something asks it to rescan. LIBRARY_SCAN=false turns
 * off the worker's periodic auto-scan, so this is otherwise the only way to
 * make a deletion show up.
 *
 * Runs subtitle promotion first: any newly-dropped Subs folder should be
 * flattened into place before Jellyfin re-reads the folder, so the same
 * scan that notices a new file also notices its captions.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const subtitles = await promoteSubtitles();
    if (subtitles.failed.length > 0) {
      console.error("[admin/library/scan] subtitle promotion failures:", subtitles.failed);
    }

    await refreshLibrary();
    getDb()
      .prepare(
        `INSERT INTO health_last_scan (id, triggered_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET triggered_at = excluded.triggered_at`,
      )
      .run(Date.now());
    return Response.json(
      { scanning: true, subtitlesPromoted: subtitles.promoted.length },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof JellyfinError && error.status === 0) {
      console.error("[admin/library/scan] Jellyfin unreachable:", error.message);
      return Response.json(
        { error: "upstream_unavailable", message: "The media server is not responding." },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[admin/library/scan] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not start a library scan." },
      { status: 500, headers: NO_STORE },
    );
  }
}
