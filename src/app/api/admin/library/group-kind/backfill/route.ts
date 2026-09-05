import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";
import { setGroupKind } from "@/lib/library-curation";
import { fetchOmdbSeries } from "@/lib/omdb-episodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-kind/backfill
 *
 * Resolves the kind of every already-linked group that doesn't have one yet.
 *
 * Groups linked before the kind column existed carry an IMDb id but no Type —
 * OMDb returned it on every one of those fetches and the code simply didn't
 * read it. Without this, each of them would need re-linking by hand to say
 * "episodes" instead of "parts".
 *
 * One OMDb call per group, and groups are a handful rather than hundreds, so
 * this stays well inside the free tier's daily cap. Only rows where kind IS
 * NULL are visited, so a curator's own override is never overwritten. Rows
 * OMDb has no answer for are reported, not retried in a loop.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const pending = asRows<{ group_id: string; imdb_id: string }>(
      getDb().prepare("SELECT group_id, imdb_id FROM library_group_series WHERE kind IS NULL").all(),
    );

    let resolved = 0;
    let unresolved = 0;
    for (const row of pending) {
      const series = await fetchOmdbSeries(row.imdb_id);
      if (series?.kind) {
        setGroupKind(row.group_id, series.kind);
        resolved += 1;
      } else {
        unresolved += 1;
      }
    }

    return Response.json({ checked: pending.length, resolved, unresolved }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/library/group-kind/backfill] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not resolve group kinds." },
      { status: 500, headers: NO_STORE },
    );
  }
}
