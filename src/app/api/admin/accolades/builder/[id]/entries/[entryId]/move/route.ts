import { requireAdmin } from "@/lib/admin-auth";
import { moveCuratorAccoladeEntry } from "@/lib/scraping/curator-accolades";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/accolades/builder/{id}/entries/{entryId}/move  { direction: "up" | "down" } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, entryId } = await params;

  try {
    const body = await readJsonBody(request);
    const direction = body.direction;
    if (direction !== "up" && direction !== "down") {
      throw new ValidationError('direction must be "up" or "down".');
    }

    const moved = moveCuratorAccoladeEntry(id, entryId, direction);
    if (!moved) {
      return Response.json(
        { error: "not_found", message: "Already at that end of the list, or no such slot." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/builder/entries/move] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not reorder." }, { status: 500, headers: NO_STORE });
  }
}
