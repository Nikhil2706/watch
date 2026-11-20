import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { mirroredApk } from "@/lib/app-mirror";
import { byteRange } from "@/lib/app-mirror-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/app-update/apk — this server's copy of the latest Android app
 * (app-mirror.ts), for the app's self-update. Honours one byte range, so
 * Android's DownloadManager can resume. No sign-in, like /apk.
 */
export async function GET(request: Request): Promise<Response> {
  const apk = await mirroredApk();
  if (!apk) return new Response("No copy of the app on this server yet.\n", { status: 404 });
  const base = {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": 'attachment; filename="watch-release.apk"',
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const range = byteRange(request.headers.get("range"), apk.size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${apk.size}` } });
  }
  if (range) {
    const stream = Readable.toWeb(createReadStream(apk.path, { start: range.start, end: range.end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...base, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${apk.size}` },
    });
  }
  const stream = Readable.toWeb(createReadStream(apk.path)) as ReadableStream;
  return new Response(stream, { headers: { ...base, "Content-Length": String(apk.size) } });
}
