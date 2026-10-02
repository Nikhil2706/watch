import { requireAdmin } from "@/lib/admin-auth";
import { listPicks, setPickOrder } from "@/lib/picks";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/picks/order — { ids } top-first, the order of the Picks page. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      throw new ValidationError("ids must be an array of pick ids.");
    }
    setPickOrder(ids as string[]);
    return Response.json({ ok: true, picks: listPicks() }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/picks/order] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the order." },
      { status: 500, headers: NO_STORE },
    );
  }
}
