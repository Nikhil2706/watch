import { requireAdmin } from "@/lib/admin-auth";
import {
  createPick,
  createPickFromAccolade,
  createPickFromArticle,
  listPicks,
  relinkUnmatchedPickItems,
} from "@/lib/picks";
import { optionalBoolean, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/picks — every pick, in Picks-page order, drafts included. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  // Films also arrive without a console scan (the worker, Jellyfin's own
  // scan), so opening the tab is a second moment to let a converted list
  // pick up what has come in. Not awaited: the list does not depend on it.
  void relinkUnmatchedPickItems().catch((error) => console.error("[admin/picks] relink failed:", error));
  return Response.json({ picks: listPicks() }, { headers: NO_STORE });
}

/**
 * POST /api/admin/picks
 *   { title, subtitle?, ranked? }      a new empty pick
 *   { from_article: id }               a copy of a scraped list
 *   { from_accolade: id }              a copy of one of the curator's accolades
 *
 * Always a draft: nothing reaches a viewer until it is published.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const fromArticle = optionalString(body, "from_article");
    const fromAccolade = optionalString(body, "from_accolade");

    if (fromArticle || fromAccolade) {
      const pick = fromArticle ? createPickFromArticle(fromArticle) : createPickFromAccolade(fromAccolade!);
      if (!pick) {
        return Response.json(
          { error: "not_found", message: "That list no longer exists, or has nothing in it." },
          { status: 404, headers: NO_STORE },
        );
      }
      return Response.json({ ok: true, pick }, { status: 201, headers: NO_STORE });
    }

    const title = optionalString(body, "title");
    if (!title || !title.trim()) throw new ValidationError("title is required.");
    const pick = createPick({
      title: title.trim(),
      subtitle: optionalString(body, "subtitle") ?? null,
      ranked: optionalBoolean(body, "ranked") ?? false,
    });
    return Response.json({ ok: true, pick }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/picks] create failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not create the pick." },
      { status: 500, headers: NO_STORE },
    );
  }
}
