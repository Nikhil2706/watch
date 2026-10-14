import { requireAdmin } from "@/lib/admin-auth";
import { groupSeriesNow } from "@/lib/series-autogroup";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-episodes
 * Body: { key } — a series key from the browse listing's pendingEpisode.
 *
 * The console's one-click "Group as <series>": every episode of that series
 * in no group goes into its show now, joining one that already exists where
 * there is one. See series-autogroup.ts.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const key = optionalString(body, "key");
    if (!key) throw new ValidationError("key is required.");

    const result = await groupSeriesNow(key);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/group-episodes] failed:", error);
    return Response.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Could not group those episodes." },
      { status: 500, headers: NO_STORE },
    );
  }
}
