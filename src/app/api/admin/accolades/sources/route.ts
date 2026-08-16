import { requireAdmin } from "@/lib/admin-auth";
import { asRows, getDb } from "@/lib/db";
import { listRecentScrapeJobs } from "@/lib/scraping/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface ScrapeSourceRow {
  id: string;
  name: string;
  base_url: string | null;
  source_type: "web" | "pdf_upload";
  kind: "review" | "accolade";
  enabled: number;
  created_at: number;
}

/** GET /api/admin/accolades/sources — every configured source with its 3 most recent jobs. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const sources = asRows<ScrapeSourceRow>(
    getDb().prepare("SELECT * FROM scrape_sources ORDER BY source_type, name").all(),
  );

  const withJobs = sources.map((s) => ({
    ...s,
    enabled: Boolean(s.enabled),
    recentJobs: listRecentScrapeJobs(s.id, 3),
  }));

  return Response.json({ sources: withJobs }, { headers: NO_STORE });
}
