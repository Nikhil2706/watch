import { requireAdmin } from "@/lib/admin-auth";
import { applyEpisodeStills, planEpisodeStills } from "@/lib/episode-stills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/episode-stills — what WOULD change, touching nothing.
 *
 * A dry run first, because the interesting failure is silent: an off-by-one in
 * episode numbering puts the wrong still on every episode of a season and looks
 * perfectly fine until someone watches one.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const groupId = new URL(request.url).searchParams.get("groupId") ?? undefined;
  const plan = planEpisodeStills({ groupId });
  return Response.json(
    {
      planned: plan.entries.length,
      alreadyDone: plan.alreadyDone,
      skipped: plan.skipped,
      sample: plan.entries.slice(0, 12).map((e) => ({
        group: e.group,
        se: `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`,
        title: e.title,
        still: e.stillUrl,
      })),
    },
    { headers: NO_STORE },
  );
}

/** POST /api/admin/episode-stills — apply it. { groupId?, budget? } */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: { groupId?: string; budget?: number; force?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // No body means "everything, default budget".
  }

  try {
    const result = await applyEpisodeStills({
      groupId: body.groupId,
      force: body.force === true,
      budget: Number.isFinite(Number(body.budget)) && Number(body.budget) > 0 ? Number(body.budget) : undefined,
    });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    console.error("[episode-stills] apply failed:", error);
    return Response.json({ error: "internal_error", message: "Could not apply stills." }, { status: 500, headers: NO_STORE });
  }
}
