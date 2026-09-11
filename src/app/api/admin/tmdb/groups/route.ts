import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/tmdb/groups — every library group, and what it is linked to.
 *
 * The backfill links a group to a TMDB show only on an exact name plus a
 * plausible episode count, and leaves everything else alone on purpose: a wrong
 * link stamps another show's stills across every episode. Until now nothing
 * said which groups had been left alone. This is that list, unlinked first.
 * Linking one by hand uses the existing PUT /api/admin/tmdb.
 *
 * Carries the group's kind as well, because a group that is a franchise of
 * films ("movie") is correctly unlinked from TV and should not look like a gap.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const rows = asRows<{
    group_id: string;
    name: string;
    files: number;
    kind: string | null;
    tmdb_id: number | null;
    resolved_by: string | null;
    tmdb_name: string | null;
  }>(
    getDb()
      .prepare(
        "SELECT g.group_id, MIN(g.group_name) AS name, COUNT(*) AS files, s.kind AS kind, " +
          "l.tmdb_id AS tmdb_id, l.resolved_by AS resolved_by, " +
          "(SELECT json_extract(c.payload, '$.name') FROM tmdb_cache c " +
          "  WHERE c.kind = 'tv' AND c.tmdb_id = l.tmdb_id AND c.season = -1) AS tmdb_name " +
          "FROM library_groups g " +
          "LEFT JOIN library_group_series s ON s.group_id = g.group_id " +
          "LEFT JOIN tmdb_links l ON l.subject_type = 'group' AND l.subject_id = g.group_id " +
          "GROUP BY g.group_id " +
          "ORDER BY (l.tmdb_id IS NULL OR l.tmdb_id <= 0) DESC, name COLLATE NOCASE",
      )
      .all(),
  );

  return Response.json(
    {
      groups: rows.map((r) => ({
        groupId: r.group_id,
        name: r.name,
        files: r.files,
        kind: r.kind ?? null,
        link:
          r.tmdb_id && r.tmdb_id > 0
            ? { tmdbId: r.tmdb_id, name: r.tmdb_name ?? "", resolvedBy: r.resolved_by ?? "" }
            : null,
      })),
    },
    { headers: NO_STORE },
  );
}
