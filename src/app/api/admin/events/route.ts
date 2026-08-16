import { requireAdmin } from "@/lib/admin-auth";
import { getRecentEvents, type EventCategory, type EventSeverity } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const CATEGORIES = new Set<EventCategory>([
  "internal_api",
  "external_api",
  "playback",
  "client",
  "media_job",
  "scrape_job",
]);
const SEVERITIES = new Set<EventSeverity>(["info", "warning", "error", "critical"]);

/**
 * GET /api/admin/events?category=&severity=&limit=
 *
 * The Health tab's log viewer — everything logEvent() has recorded, newest
 * first, optionally filtered.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const categoryParam = url.searchParams.get("category");
  const severityParam = url.searchParams.get("severity");
  const limitParam = url.searchParams.get("limit");

  const category = categoryParam && CATEGORIES.has(categoryParam as EventCategory) ? (categoryParam as EventCategory) : undefined;
  const severity = severityParam && SEVERITIES.has(severityParam as EventSeverity) ? (severityParam as EventSeverity) : undefined;
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  const events = getRecentEvents({ category, severity, limit: Number.isFinite(limit) ? limit : undefined });

  return Response.json({ events }, { headers: NO_STORE });
}
