import { requireAdmin } from "@/lib/admin-auth";
import { applyToParts, isFilmInParts, partsChoices, PartsError } from "@/lib/subtitle-parts-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Subtitles for a film kept in parts (subtitle-parts-apply.ts).
 *
 *   GET  ?groupId=&peek=1         -> { filmInParts } (no search)
 *   GET  ?groupId=                -> { filmInParts, parts, candidates } the whole film's, best guess first
 *   POST { groupId, fileIds }     -> one whole-film file cut across the parts, or one file per part
 */
function fail(error: unknown, what: string): Response {
  const known = error instanceof PartsError;
  if (!known) console.error(`[admin/subtitles/parts] ${what} failed:`, error);
  return Response.json(
    { error: known ? "invalid_request" : "upstream_error", message: error instanceof Error ? error.message : `Could not ${what}.` },
    { status: known ? 400 : 502, headers: NO_STORE },
  );
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const groupId = url.searchParams.get("groupId");
  if (!groupId) return Response.json({ error: "invalid_request", message: "groupId is required." }, { status: 400, headers: NO_STORE });
  const filmInParts = isFilmInParts(groupId);
  if (url.searchParams.get("peek") || !filmInParts) return Response.json({ filmInParts }, { headers: NO_STORE });
  try {
    return Response.json({ filmInParts, ...(await partsChoices(groupId)) }, { headers: NO_STORE });
  } catch (error) {
    return fail(error, "search");
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { groupId?: unknown; fileIds?: unknown };
  const fileIds = Array.isArray(b.fileIds) ? b.fileIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0) : [];
  if (typeof b.groupId !== "string" || !fileIds.length) {
    return Response.json({ error: "invalid_request", message: "groupId and fileIds are required." }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json({ ok: true, results: await applyToParts(b.groupId, fileIds) }, { headers: NO_STORE });
  } catch (error) {
    return fail(error, "write the subtitles");
  }
}
