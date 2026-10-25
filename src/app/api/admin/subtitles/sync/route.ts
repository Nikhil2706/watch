import { requireAdmin } from "@/lib/admin-auth";
import { readSubtitle, restoreOriginal, saveTiming, SyncError } from "@/lib/subtitle-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The sync screen's file access (subtitle-sync.ts).
 *
 *   GET  ?itemId=&name=                        -> { text, hasOriginal }
 *   POST { itemId, name, scale, offsetMs }     -> rewrite with that timing (first version kept as .orig)
 *   POST { itemId, name, restore: true }       -> put the first version back
 */
function fail(error: unknown, what: string): Response {
  const known = error instanceof SyncError;
  if (!known) console.error(`[admin/subtitles/sync] ${what} failed:`, error);
  return Response.json(
    { error: known ? "invalid_request" : "internal_error", message: error instanceof Error ? error.message : `Could not ${what}.` },
    { status: known ? 400 : 500, headers: NO_STORE },
  );
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const itemId = url.searchParams.get("itemId");
  const name = url.searchParams.get("name");
  if (!itemId || !name) return Response.json({ error: "invalid_request", message: "itemId and name are required." }, { status: 400, headers: NO_STORE });
  try {
    return Response.json(await readSubtitle(itemId, name), { headers: NO_STORE });
  } catch (error) {
    return fail(error, "read the subtitle");
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { itemId?: unknown; name?: unknown; scale?: unknown; offsetMs?: unknown; restore?: unknown };
  if (typeof b.itemId !== "string" || typeof b.name !== "string") {
    return Response.json({ error: "invalid_request", message: "itemId and name are required." }, { status: 400, headers: NO_STORE });
  }
  try {
    if (b.restore === true) {
      await restoreOriginal(b.itemId, b.name);
      return Response.json({ ok: true, restored: true }, { headers: NO_STORE });
    }
    if (typeof b.scale !== "number" || typeof b.offsetMs !== "number") {
      return Response.json({ error: "invalid_request", message: "scale and offsetMs are required." }, { status: 400, headers: NO_STORE });
    }
    return Response.json({ ok: true, ...(await saveTiming(b.itemId, b.name, { scale: b.scale, offsetMs: b.offsetMs })) }, { headers: NO_STORE });
  } catch (error) {
    return fail(error, "save the timing");
  }
}
