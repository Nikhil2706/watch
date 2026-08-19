import { createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { env } from "@/lib/env";
import { generateId } from "@/lib/crypto";
import { getSessionFromRequest } from "@/lib/session";
import { createUpload } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A multi-GB body must never be buffered — see the /jf/* proxy's own note
// on this. Same reasoning here, just for an inbound stream instead of an
// outbound one.
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024; // 20GB — generous ceiling, not a target.

/** Passes bytes through unchanged, aborting the pipeline if the running total ever exceeds the cap. */
function byteCap(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error("upload exceeded the size limit mid-stream"));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * POST /api/upload?filename=<name>
 *
 * Langlois-mode only. Streams the raw request body straight to
 * MEDIA_QUARANTINE/<uploadId>-<sanitized filename> — never buffered, same
 * discipline as every other large-file path in this app — and records an
 * `uploads` row with status 'uploaded'. That's the END of what this route
 * does: no scan, no publish. The antivirus scan happens out-of-process (see
 * scripts/windows/upload-scanner.ps1) and approval is a separate, curator-
 * only step (see /api/admin/uploads/:id/approve). See the `uploads` table
 * comment in schema.ts for the full flow.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }
  if (!session.langloisMode) {
    return Response.json(
      { error: "forbidden", message: "Uploads are only available in Langlois mode." },
      { status: 403, headers: NO_STORE },
    );
  }

  const rawFilename = new URL(request.url).searchParams.get("filename");
  if (!rawFilename || !rawFilename.trim()) {
    return Response.json({ error: "invalid_request", message: "filename query param is required." }, { status: 400, headers: NO_STORE });
  }
  // basename() strips any directory components a client could try to smuggle
  // in (e.g. "../../etc/passwd") — the write always lands directly inside
  // the quarantine directory, never above it.
  const filename = basename(rawFilename.trim());
  if (!filename) {
    return Response.json({ error: "invalid_request", message: "Not a valid filename." }, { status: 400, headers: NO_STORE });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: "too_large", message: "That file is larger than this server accepts." },
      { status: 413, headers: NO_STORE },
    );
  }
  if (!request.body) {
    return Response.json({ error: "invalid_request", message: "No file body received." }, { status: 400, headers: NO_STORE });
  }

  const id = generateId();
  mkdirSync(env.mediaQuarantinePath, { recursive: true });
  const quarantinePath = join(env.mediaQuarantinePath, `${id}-${filename}`);

  try {
    await pipeline(
      Readable.fromWeb(request.body as never),
      byteCap(MAX_UPLOAD_BYTES),
      createWriteStream(quarantinePath),
    );
  } catch (error) {
    console.error(`[upload] write failed for ${filename}:`, error);
    try {
      unlinkSync(quarantinePath);
    } catch {
      /* nothing to clean up if the write never got that far */
    }
    return Response.json(
      { error: "upload_failed", message: "The upload didn't complete — try again." },
      { status: 500, headers: NO_STORE },
    );
  }

  const sizeBytes = statSync(quarantinePath).size;
  const upload = createUpload({ id, userId: session.userId, filename, quarantinePath, sizeBytes });

  return Response.json(
    { ok: true, id: upload.id, filename: upload.filename, size_bytes: upload.size_bytes, status: upload.status },
    { status: 201, headers: NO_STORE },
  );
}
