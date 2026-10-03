import { requireAdmin } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { JellyfinError } from "@/lib/jellyfin";
import { toLibraryPath } from "@/lib/library-folders";
import { scanLibraryNow } from "@/lib/library-scan";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/scan
 *   { folders?: string[] }
 *
 * With `folders` — where the new files were put, as Jellyfin's path, the
 * Explorer path, or the part under the library — only those are re-read,
 * which takes seconds where the whole library takes minutes. A folder
 * Jellyfin has no item above (a file in the library root) cannot be re-read
 * on its own, and the whole library is scanned instead; the response says
 * which happened.
 *
 * Triggers a Jellyfin library scan. Needed because the `jellyfin` container
 * mounts the library read-only, so Jellyfin never notices a file removed or
 * added on disk until something asks it to rescan. LIBRARY_SCAN=false turns
 * off the worker's periodic auto-scan, so this is otherwise the only way to
 * make a deletion show up.
 *
 * The work is scanLibraryNow() (library-scan.ts), shared with the scheduled
 * "Library scan" job, which always scans the whole library.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const asked = body.folders === undefined ? [] : body.folders;
    if (!Array.isArray(asked) || asked.length > 20 || !asked.every((f) => typeof f === "string")) {
      throw new ValidationError("folders must be a list of up to 20 folder paths.");
    }
    const folders = (asked as string[]).map((typed) => {
      const path = toLibraryPath(typed, env.mediaLibraryPath, env.hostMediaPath);
      if (!path) throw new ValidationError(`“${typed}” is not a folder in the library.`);
      return path;
    });

    const { subtitlesPromoted, scanned } = await scanLibraryNow(folders);
    return Response.json(
      {
        scanning: true,
        scope: scanned.length > 0 ? "folders" : "library",
        folders: scanned,
        subtitlesPromoted,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
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
