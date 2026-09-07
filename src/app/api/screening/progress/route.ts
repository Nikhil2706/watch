import { cookies } from "next/headers";

import {
  SCREENING_COOKIE,
  markScreeningPlayStarted,
  resolveScreeningSession,
  screeningState,
  setScreeningProgress,
} from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Where this guest got to, in their own row.
 *
 * Screenings share one Jellyfin account, so Jellyfin's UserData would leak one
 * stranger's stopping point to the next. Deliberately a position and nothing
 * else: no timeline of plays, pauses and seeks. That distinction is what keeps
 * this from being the parked viewing-metrics feature by the back door.
 */
export async function POST(request: Request): Promise<Response> {
  const sessionId = (await cookies()).get(SCREENING_COOKIE)?.value;
  const resolved = sessionId ? resolveScreeningSession(sessionId) : null;
  if (!resolved) return Response.json({ error: "no screening" }, { status: 401, headers: NO_STORE });

  const state = screeningState(resolved);
  if (state.state === "ended") {
    return Response.json({ error: "ended" }, { status: 403, headers: NO_STORE });
  }

  let body: { itemId?: string; positionTicks?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }

  const itemId = body.itemId;
  const ticks = Number(body.positionTicks);
  if (!itemId || !Number.isFinite(ticks)) {
    return Response.json({ error: "bad request" }, { status: 400, headers: NO_STORE });
  }

  // Only for an item that is actually part of this screening.
  if (!resolved.items.some((i) => i.jellyfinItemId === itemId)) {
    return Response.json({ error: "not this screening" }, { status: 403, headers: NO_STORE });
  }

  // A 'play' window starts on the first real playback, not on opening the link.
  if (resolved.windowStartsOn === "play" && ticks > 0) {
    markScreeningPlayStarted(resolved.screeningId);
  }

  setScreeningProgress(resolved.sessionId, itemId, ticks);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
