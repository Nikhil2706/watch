import { requireAdmin } from "@/lib/admin-auth";
import { keepCandidate, TryError, tryCandidate } from "@/lib/subtitle-try";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Trying a subtitle before keeping it (subtitle-try.ts).
 *
 *   GET  ?fileId=                              -> { text, spent, downloadsLeft } (one download, the first time in a day)
 *   POST { itemId, fileId, scale?, offsetMs? } -> keep it next to the video, with that shift
 */
function fail(error: unknown, what: string): Response {
  const known = error instanceof TryError;
  if (!known) console.error(`[admin/subtitles/try] ${what} failed:`, error);
  return Response.json(
    { error: known ? "invalid_request" : "upstream_error", message: error instanceof Error ? error.message : `Could not ${what}.` },
    { status: known ? 400 : 502, headers: NO_STORE },
  );
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const fileId = Number(new URL(request.url).searchParams.get("fileId"));
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return Response.json({ error: "invalid_request", message: "fileId is required." }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json(await tryCandidate(fileId), { headers: NO_STORE });
  } catch (error) {
    return fail(error, "fetch that subtitle");
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { itemId?: unknown; fileId?: unknown; scale?: unknown; offsetMs?: unknown };
  if (typeof b.itemId !== "string" || typeof b.fileId !== "number") {
    return Response.json({ error: "invalid_request", message: "itemId and fileId are required." }, { status: 400, headers: NO_STORE });
  }
  try {
    const timing = {
      scale: typeof b.scale === "number" ? b.scale : 1,
      offsetMs: typeof b.offsetMs === "number" ? b.offsetMs : 0,
    };
    return Response.json({ ok: true, ...(await keepCandidate(b.itemId, b.fileId, timing)) }, { headers: NO_STORE });
  } catch (error) {
    return fail(error, "keep that subtitle");
  }
}
