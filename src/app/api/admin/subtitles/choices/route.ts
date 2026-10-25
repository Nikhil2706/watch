import { requireAdmin } from "@/lib/admin-auth";
import { ChooserError, downloadChosenSubtitle, subtitleChoices } from "@/lib/subtitle-chooser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * A film's or episode's subtitles to choose from (subtitle-chooser.ts).
 *
 *   GET  ?itemId=          -> every English candidate, best guess first, with why;
 *                             what it already has. A search: spends no downloads.
 *   POST { itemId, fileId } -> download that one next to the video (beside any
 *                             already there; nothing is overwritten).
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) return Response.json({ error: "invalid_request", message: "itemId is required." }, { status: 400, headers: NO_STORE });
  try {
    return Response.json(await subtitleChoices(itemId), { headers: NO_STORE });
  } catch (error) {
    const known = error instanceof ChooserError;
    if (!known) console.error("[admin/subtitles/choices] search failed:", error);
    return Response.json(
      { error: known ? "invalid_request" : "upstream_error", message: error instanceof Error ? error.message : "Search failed." },
      { status: known ? 400 : 502, headers: NO_STORE },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { itemId?: unknown; fileId?: unknown };
  if (typeof body.itemId !== "string" || typeof body.fileId !== "number" || !Number.isFinite(body.fileId)) {
    return Response.json({ error: "invalid_request", message: "itemId and fileId are required." }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json({ ok: true, ...(await downloadChosenSubtitle(body.itemId, body.fileId)) }, { headers: NO_STORE });
  } catch (error) {
    const known = error instanceof ChooserError;
    if (!known) console.error("[admin/subtitles/choices] download failed:", error);
    return Response.json(
      { error: known ? "invalid_request" : "upstream_error", message: error instanceof Error ? error.message : "Download failed." },
      { status: known ? 400 : 502, headers: NO_STORE },
    );
  }
}
