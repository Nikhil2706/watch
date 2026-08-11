import { requireAdmin } from "@/lib/admin-auth";
import { clearRecommended, setRecommended } from "@/lib/subtitles";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/subtitles/:itemId  { stream_index, label?, language? }
 *
 * Marks one track as the recommended default. With 43 tracks on some files,
 * "the right one" is a judgement only a person can make, so it is recorded here
 * rather than guessed.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { itemId } = await context.params;

  try {
    const body = await readJsonBody(request);
    const streamIndex = optionalInt(body, "stream_index");
    if (streamIndex === undefined) {
      throw new ValidationError("stream_index is required.");
    }

    setRecommended({
      itemId,
      streamIndex,
      label: optionalString(body, "label") ?? null,
      language: optionalString(body, "language") ?? null,
      setBy: optionalString(body, "set_by") ?? "Mamnani",
    });

    return Response.json(
      { ok: true, item_id: itemId, stream_index: streamIndex },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/subtitles] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not set the recommendation." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** DELETE /api/admin/subtitles/:itemId — back to first-English. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { itemId } = await context.params;
  clearRecommended(itemId);
  return Response.json({ ok: true, item_id: itemId, cleared: true }, { headers: NO_STORE });
}
