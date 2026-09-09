import { requireAdmin } from "@/lib/admin-auth";
import { imageCacheStats } from "@/lib/tmdb-images";
import { ingestAllFromCache, peopleStats } from "@/lib/tmdb-people";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/people — how many people, credits and cached photos there are. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const images = imageCacheStats();
  return Response.json(
    {
      ...peopleStats(),
      photoCache: { count: images.count, megabytes: Number((images.bytes / 1e6).toFixed(2)) },
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/admin/people — build the people tables from the TMDB store.
 *
 * Unlike the TMDB backfill this takes no budget and makes no request: every
 * payload it reads was fetched last week and is already on this disk. That is
 * the dividend from having stored the raw payload verbatim rather than the
 * handful of fields wanted at the time — a new use of the data costs a SQL
 * pass, not another 400 calls over a link that drops one in thirty.
 *
 * Safe to press twice. Each subject's credits are replaced rather than merged,
 * so a second run changes nothing, and a run after a re-identification is
 * exactly how a film ends up with the right crew instead of the old one's.
 *
 * Photos are NOT fetched here. They fill in one at a time as pages are viewed
 * (see tmdb-images.ts), which is deliberate: a sweep would be another budgeted
 * loop, and the two written for TMDB so far both had the same bug.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const result = ingestAllFromCache();
    return Response.json(
      { ok: true, ...result, stats: peopleStats() },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[people] ingest failed:", error);
    return Response.json(
      { error: "internal_error", message: "Building the people tables failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
