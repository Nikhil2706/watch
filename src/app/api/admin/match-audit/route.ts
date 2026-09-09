import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { auditFilm, type AuditCandidate } from "@/lib/match-audit";
import { filmViewByPath } from "@/lib/tmdb-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/match-audit
 *
 * Every cached film ranked by how much the library's identification disagrees
 * with TMDB's. Read-only, and entirely local — it reads the store, so it costs
 * nothing upstream and can be run as often as you like.
 *
 * This exists because `[Rec].2.2009.mkv` is identified as *The Descent: Part 2*
 * and nothing surfaced that; it was noticed by eye. With 390 cached films there
 * is no reason to assume it was the only one.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const movies = await getAdminMovies({ withMediaSources: false }).catch(() => []);

  const findings = [];
  let audited = 0;
  let uncached = 0;

  for (const m of movies) {
    const view = filmViewByPath(m.Path);
    if (!view) {
      uncached += 1;
      continue;
    }
    audited += 1;

    // Paths here are Linux-side (/media/...), but a Windows-shaped one would
    // split on the wrong separator, so both are handled.
    const filename = m.Path ? (m.Path.split(/[/\\]/).pop() ?? null) : null;
    const candidate: AuditCandidate = {
      libraryTitle: m.Name,
      filename,
      libraryYear: m.ProductionYear ?? null,
      tmdbTitle: view.title,
      tmdbOriginalTitle: view.originalTitle,
      tmdbYear: view.releaseDate ? Number(view.releaseDate.slice(0, 4)) || null : null,
      alternativeTitles: view.alternativeTitles.map((t) => t.title),
    };

    const finding = auditFilm(candidate);
    if (finding.verdict !== "agrees") {
      findings.push({
        itemId: m.Id,
        libraryTitle: m.Name,
        libraryYear: m.ProductionYear ?? null,
        tmdbTitle: view.title,
        tmdbYear: candidate.tmdbYear,
        filename,
        ...finding,
      });
    }
  }

  findings.sort((a, b) => b.score - a.score);

  return Response.json(
    {
      audited,
      uncached,
      suspect: findings.filter((f) => f.verdict === "suspect").length,
      check: findings.filter((f) => f.verdict === "check").length,
      findings: findings.slice(0, 100),
    },
    { headers: NO_STORE },
  );
}
