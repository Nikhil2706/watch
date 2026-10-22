import { requireAdmin } from "@/lib/admin-auth";
import { invalidate } from "@/lib/cache";
import { clearFilmRelease, getFilmRelease, setFilmRelease } from "@/lib/rollout";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * One film's release date (rollout.ts, subject "film"): hidden everywhere
 * until then, and listed in Coming soon with its date.
 *
 *   GET  ?path=                         -> { release: { releaseAt, released } | null }
 *   POST { path, releaseAt: ms | null } -> schedule or move it; null releases it now
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const path = new URL(request.url).searchParams.get("path");
  if (!path) return Response.json({ error: "invalid_request", message: "path is required." }, { status: 400, headers: NO_STORE });
  return Response.json({ release: getFilmRelease(path) }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(request);
  } catch {
    /* answered below */
  }
  const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path : null;
  const releaseAt = body.releaseAt;
  if (!path || !(releaseAt === null || (typeof releaseAt === "number" && Number.isFinite(releaseAt)))) {
    return Response.json(
      { error: "invalid_request", message: "path, and releaseAt as a time in ms (or null to release now), are required." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (releaseAt !== null && releaseAt <= Date.now()) {
    return Response.json({ error: "invalid_request", message: "Pick a time in the future." }, { status: 400, headers: NO_STORE });
  }
  if (releaseAt === null) clearFilmRelease(path);
  else setFilmRelease(path, releaseAt);
  // What viewers are listed changed.
  invalidate("all-movies");
  return Response.json({ ok: true, release: getFilmRelease(path) }, { headers: NO_STORE });
}
