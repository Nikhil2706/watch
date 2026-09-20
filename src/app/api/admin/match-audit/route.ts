import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { getConfirmedPathSet } from "@/lib/library-curation";
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

  /*
   * A file an admin has confirmed is settled, and re-reporting it is worse than
   * saying nothing: the whole point of the three-valued verdict is that the
   * check list stays short enough to read. Five of the six items on it after
   * 2026-09-11's corrections were films that had just been identified BY HAND,
   * flagged only because their filenames are opaque — the audit was asking the
   * owner to re-check their own answer.
   *
   * Confirmation comes from apply-match with a path, which is exactly the act
   * of a person deciding what a file is, so it is the right thing to defer to.
   * They are counted rather than silently dropped: a confirmation that turns
   * out to be wrong should still be visible as a number that is growing.
   */
  const confirmedPaths = getConfirmedPathSet();

  const findings = [];
  let audited = 0;
  let uncached = 0;
  let confirmed = 0;

  for (const m of movies) {
    const view = filmViewByPath(m.Path);
    if (!view) {
      uncached += 1;
      continue;
    }
    if (m.Path && confirmedPaths.has(m.Path)) {
      confirmed += 1;
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
      confirmed,
      suspect: findings.filter((f) => f.verdict === "suspect").length,
      check: findings.filter((f) => f.verdict === "check").length,
      findings: findings.slice(0, 100),
    },
    { headers: NO_STORE },
  );
}
