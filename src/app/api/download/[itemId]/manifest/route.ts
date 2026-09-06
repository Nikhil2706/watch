import { statSync } from "node:fs";

import { getDownloadJob } from "@/lib/downloads";
import { getItem, posterUrl } from "@/lib/media";
import { getSessionFromRequest } from "@/lib/session";
import { listSubtitles } from "@/lib/subtitles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/download/:itemId/manifest
 *
 * Describes everything an app has to fetch to make one title watchable with
 * no network: the prepared file, its subtitle tracks, and a poster.
 *
 * A download is a BUNDLE, not a file, and this is what says so. Subtitles are
 * the reason. They are not sitting next to the video — Jellyfin renders each
 * one to WebVTT on demand at /jf/Videos/.../Stream.vtt — so a client that only
 * pulls the media ends up with a film it cannot read. They are also tiny, tens
 * of kilobytes against several gigabytes, so there is no case for making the
 * user choose: take every text track there is.
 *
 * The poster is here for the same reason. The Downloads screen is looked at
 * precisely when there is no network, which is exactly when a remote poster
 * URL renders as a blank tile.
 *
 * Session-scoped like the media route: resolved through getItem(), so a title
 * this viewer cannot see is a 404 here too rather than a manifest describing
 * something they are not allowed to have.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  const { itemId } = await context.params;
  const item = await getItem(session, itemId);
  if (!item) {
    return Response.json(
      { error: "not_found", message: "No such item." },
      { status: 404, headers: NO_STORE },
    );
  }

  // Deliberately does NOT queue a prepare job — asking what a download would
  // contain should not start producing one. The media route does that when
  // the user actually commits.
  const job = getDownloadJob(itemId);

  let sizeBytes: number | null = null;
  if (job?.status === "done" && job.output_path) {
    try {
      sizeBytes = statSync(job.output_path).size;
    } catch {
      // Cache file vanished after the job recorded done; the media route
      // treats that as not-yet-prepared, so report the same here.
      sizeBytes = null;
    }
  }

  const ready = job?.status === "done" && sizeBytes !== null;

  // Image-based tracks (PGS, VobSub) are already filtered out by
  // listSubtitles, because only text converts to WebVTT. A film subtitled
  // only in PGS therefore has none offline — the same as it has none in the
  // browser, so this is not a new limitation, but it is why a bundle can
  // legitimately come back with an empty subtitles array.
  const subtitles = listSubtitles(item).map((track) => ({
    index: track.index,
    label: track.label,
    language: track.language,
    recommended: track.recommended,
    isForced: track.isForced,
    url: track.url,
    // What the client should save it as. Kept server-side so every platform
    // names them the same way.
    filename: `${track.index}-${(track.language ?? "und").toLowerCase()}.vtt`,
  }));

  return Response.json(
    {
      itemId: item.Id,
      title: item.Name,
      year: item.ProductionYear ?? null,
      // Ticks are 100-nanosecond units — Jellyfin's unit, nobody else's.
      durationSeconds: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000_000) : null,
      status: job?.status ?? "absent",
      progress: job?.progress ?? 0,
      ready,
      sizeBytes,
      media: {
        url: `/api/download/${encodeURIComponent(item.Id)}`,
        contentType: "video/mp4",
        filename: "media.mp4",
      },
      poster: posterUrl(item, 480),
      subtitles,
    },
    { headers: NO_STORE },
  );
}
