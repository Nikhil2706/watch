import { requireAdmin } from "@/lib/admin-auth";
import { describePickItems } from "@/lib/pick-admin";
import { addPickItem, getPick, listPickItems, setPickItemOrder } from "@/lib/picks";
import { matchTitle } from "@/lib/scraping/match";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/picks/{id}/items
 *   { title, year?, imdb_id?, href? }
 *
 * `href` is what the console's library search hands back: "/collection/{id}"
 * marks a show, anything else a film. A title typed with no search result
 * behind it is matched here, and kept unmatched if the library does not have
 * it — it joins the pick when it arrives.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  if (!getPick(id)) {
    return Response.json({ error: "not_found", message: "No such pick." }, { status: 404, headers: NO_STORE });
  }

  try {
    const body = await readJsonBody(request);
    const title = optionalString(body, "title");
    if (!title || !title.trim()) throw new ValidationError("title is required.");
    const year = optionalInt(body, "year") ?? null;
    const explicitImdbId = optionalString(body, "imdb_id") ?? null;
    const groupId = optionalString(body, "href")?.match(/^\/collection\/([^/?#]+)/)?.[1] ?? null;

    if (groupId) {
      addPickItem(id, { kind: "show", groupId, imdbId: explicitImdbId, rawTitle: title.trim() });
    } else {
      const imdbId = explicitImdbId ?? (await matchTitle(title, year)).imdbId;
      addPickItem(id, { kind: "film", imdbId, rawTitle: title.trim(), rawYear: year });
    }
    return Response.json(
      { ok: true, items: await describePickItems(listPickItems(id)) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/picks/items] add failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not add the title." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** PUT /api/admin/picks/{id}/items — { ids } in the new order. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  if (!getPick(id)) {
    return Response.json({ error: "not_found", message: "No such pick." }, { status: 404, headers: NO_STORE });
  }

  try {
    const body = await readJsonBody(request);
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      throw new ValidationError("ids must be an array of item ids.");
    }
    setPickItemOrder(id, ids as string[]);
    return Response.json({ ok: true, items: await describePickItems(listPickItems(id)) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/picks/items] reorder failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the order." },
      { status: 500, headers: NO_STORE },
    );
  }
}
