import { requireAdmin } from "@/lib/admin-auth";
import { isScrapeRunInProgress, runManualScrapePass } from "@/lib/scrape-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/scrape/run-now
 *
 * Manually starts a full OMDb + Wikipedia catch-up pass — the same one the
 * Wednesday 5:30am schedule runs automatically (src/lib/scrape-schedule.ts).
 * A pass can take several minutes on a large backlog, so this fires it and
 * returns immediately rather than holding the request open; progress shows
 * up on the Health tab's existing "OMDb catch-up" / "Wikipedia catch-up"
 * rows as it goes, same as the automatic pass.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  if (isScrapeRunInProgress()) {
    return Response.json(
      { started: false, reason: "A scrape pass is already running." },
      { headers: NO_STORE },
    );
  }

  void runManualScrapePass()
    .then((result) => console.log("[admin/scrape/run-now] pass finished:", result))
    .catch((error) => console.error("[admin/scrape/run-now] pass failed:", error));

  return Response.json({ started: true }, { headers: NO_STORE });
}
