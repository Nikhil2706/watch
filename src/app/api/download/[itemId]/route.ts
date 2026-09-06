import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";

import { parseRange } from "@/lib/http-range";
import { getItem } from "@/lib/media";
import { getSessionFromRequest } from "@/lib/session";
import { DownloadSourceError, getDownloadJob, queueDownload } from "@/lib/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/download/:itemId
 *
 * Session-authenticated (any logged-in user — this is the general offline-
 * download feature for the phone/desktop apps, not Langlois-gated; that's a
 * separate, raw-file-specific grant served through /jf/Items/{id}/Download
 * instead). First request for a title queues a prepare job and returns 202
 * while the worker (scripts/media-worker.mjs, processDownloadJob) produces
 * a cached, device-friendly copy; once done, every request — including this
 * same one retried — streams straight from the cache with Range support so
 * a native downloader can resume a dropped connection.
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

  // Resolve through getItem() rather than going straight to the download
  // queue: queueDownload() -> resolveSourcePath() -> getFullItem() uses the
  // admin API key, which has no concept of who is asking. getItem() is the
  // session-scoped accessor every page already goes through, so a title this
  // viewer can't see — parental-control restricted, or simply gone — is a 404
  // here exactly as it is on /item and /watch, instead of a downloadable file.
  const item = await getItem(session, itemId);
  if (!item) {
    return Response.json(
      { error: "not_found", message: "No such item." },
      { status: 404, headers: NO_STORE },
    );
  }

  let job = getDownloadJob(itemId);
  if (!job) {
    try {
      job = await queueDownload(itemId);
    } catch (error) {
      const message = error instanceof DownloadSourceError ? error.message : "Could not queue this download.";
      console.error(`[download] queue failed for ${itemId}:`, error);
      return Response.json({ error: "queue_failed", message }, { status: 502, headers: NO_STORE });
    }
  }

  if (job.status === "failed") {
    return Response.json(
      { error: "prepare_failed", message: job.error ?? "Preparing this download failed." },
      { status: 500, headers: NO_STORE },
    );
  }

  if (job.status !== "done" || !job.output_path) {
    return Response.json(
      { status: job.status, progress: job.progress, message: "Preparing this download — try again shortly." },
      { status: 202, headers: NO_STORE },
    );
  }

  let size: number;
  try {
    size = statSync(job.output_path).size;
  } catch {
    // The cached file vanished (manual cleanup, disk issue) after the job
    // recorded "done". Treat as not-yet-prepared rather than a hard error —
    // a retry re-queues it, same as a job that never ran.
    return Response.json(
      { status: "pending", progress: 0, message: "Preparing this download — try again shortly." },
      { status: 202, headers: NO_STORE },
    );
  }

  const filename = `${job.title}${extOf(job.output_path)}`;
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });

  const wanted = parseRange(request.headers.get("range"), size);

  if (wanted.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  if (wanted.kind === "full") {
    headers.set("Content-Length", String(size));
    const stream = createReadStream(job.output_path);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
  }

  headers.set("Content-Range", `bytes ${wanted.start}-${wanted.end}/${size}`);
  headers.set("Content-Length", String(wanted.end - wanted.start + 1));
  const stream = createReadStream(job.output_path, { start: wanted.start, end: wanted.end });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
}

function extOf(path: string): string {
  const dot = basename(path).lastIndexOf(".");
  return dot === -1 ? "" : basename(path).slice(dot);
}
