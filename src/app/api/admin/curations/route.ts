import { requireAdmin } from "@/lib/admin-auth";
import { createCuration, isCurationKind, listCurations } from "@/lib/curations";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/curations
 *   { title, kind?, url?, comment?, curator?, item_id?, position? }
 *
 * Kept to curl like the rest of the admin surface — there is no admin UI in
 * this app by design.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);

    const title = optionalString(body, "title");
    if (!title || title.trim() === "") {
      throw new ValidationError("title is required.");
    }

    const kind = body.kind === undefined ? "article" : body.kind;
    if (!isCurationKind(kind)) {
      throw new ValidationError("kind must be article, essay, video or note.");
    }

    const url = optionalString(body, "url") ?? null;
    if (url && !/^https?:\/\//i.test(url)) {
      throw new ValidationError("url must start with http:// or https://");
    }

    const curation = createCuration({
      itemId: optionalString(body, "item_id") ?? null,
      kind,
      title: title.trim(),
      url,
      // Shown verbatim on the card, so no length trimming beyond the sane cap
      // in optionalString would make sense here.
      comment: typeof body.comment === "string" ? body.comment.slice(0, 2000) : null,
      curator: optionalString(body, "curator") ?? "Mamnani",
      position: optionalInt(body, "position") ?? 0,
    });

    return Response.json({ ok: true, curation }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/curations] create failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not create the pick." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** GET /api/admin/curations -> everything, newest first. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const curations = listCurations(200).map((c) => ({
    ...c,
    created_at: new Date(c.created_at).toISOString(),
  }));
  return Response.json({ curations, count: curations.length }, { headers: NO_STORE });
}
