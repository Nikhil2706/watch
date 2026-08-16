import { requireAdmin } from "@/lib/admin-auth";
import { lockBlurbCandidate, lockCustomBlurb, unlockBlurb } from "@/lib/scraping/locks";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/accolades/film/{imdbId}/lock-blurb
 *   { candidate_id } to lock a specific scraped passage, or
 *   { text, source_label?, source_url? } for a curator-written or
 *   manually-copied blurb (sanitized on write by locks.ts). source_label/
 *   source_url are for a passage copy-pasted from a real site that isn't
 *   scraped — omit both for a purely curator-written blurb.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ imdbId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { imdbId } = await params;

  try {
    const body = await readJsonBody(request);
    const candidateId = optionalString(body, "candidate_id");
    const text = optionalString(body, "text");
    const sourceLabel = optionalString(body, "source_label");
    const sourceUrl = optionalString(body, "source_url");

    if (candidateId) {
      lockBlurbCandidate(imdbId, candidateId);
    } else if (text) {
      lockCustomBlurb(imdbId, { text, sourceLabel, sourceUrl });
    } else {
      throw new ValidationError("Provide either candidate_id or text.");
    }

    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/lock-blurb] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not lock the blurb." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE — back to auto (random). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ imdbId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { imdbId } = await params;
  unlockBlurb(imdbId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
