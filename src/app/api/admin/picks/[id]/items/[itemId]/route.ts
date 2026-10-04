import { requireAdmin } from "@/lib/admin-auth";
import { cleanLabel, LABEL_MAX } from "@/lib/pick-rank";
import { deletePickItem, updatePickItem, WRITEUP_MAX } from "@/lib/picks";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * PATCH /api/admin/picks/{id}/items/{itemId}
 *   { writeup?, writeup_source_label?, writeup_source_url?, rank?, label? }
 *
 * The writeup is the curator's own text or a scraped passage they chose; a
 * passage carries its source's name and link so the page can credit it.
 * `rank: null` drops a converted list's number back to "by position".
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, itemId } = await params;

  try {
    const body = await readJsonBody(request);

    const writeup = body.writeup;
    if (writeup !== undefined && writeup !== null && typeof writeup !== "string") {
      throw new ValidationError("writeup must be text.");
    }
    if (typeof writeup === "string" && writeup.length > WRITEUP_MAX) {
      throw new ValidationError(`A writeup can be at most ${WRITEUP_MAX} characters.`);
    }
    const sourceUrl = body.writeup_source_url === null ? null : optionalString(body, "writeup_source_url");
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
      throw new ValidationError("The source link must start with http:// or https://");
    }

    const label = body.label;
    if (label !== undefined && label !== null && typeof label !== "string") {
      throw new ValidationError("label must be text.");
    }
    if (typeof label === "string" && (cleanLabel(label)?.length ?? 0) > LABEL_MAX) {
      throw new ValidationError(`The word under a poster can be at most ${LABEL_MAX} characters.`);
    }

    const item = updatePickItem(id, itemId, {
      label: label as string | null | undefined,
      writeup: writeup as string | null | undefined,
      writeupSourceLabel:
        body.writeup_source_label === null ? null : optionalString(body, "writeup_source_label"),
      writeupSourceUrl: sourceUrl,
      rank: body.rank === null ? null : optionalInt(body, "rank"),
    });
    if (!item) {
      return Response.json({ error: "not_found", message: "No such title in this pick." }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ ok: true, item }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/picks/items] update failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the writeup." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** DELETE /api/admin/picks/{id}/items/{itemId} */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, itemId } = await params;
  if (!deletePickItem(id, itemId)) {
    return Response.json({ error: "not_found", message: "No such title in this pick." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
