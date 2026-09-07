import { cookies } from "next/headers";

import { SCREENING_COOKIE, resolveScreeningSession, screeningState } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Polled once a minute by the room, so an expiry or revoke explains itself. */
export async function GET(): Promise<Response> {
  const sessionId = (await cookies()).get(SCREENING_COOKIE)?.value;
  const resolved = sessionId ? resolveScreeningSession(sessionId) : null;
  if (!resolved) {
    return Response.json({ state: "ended", reason: "invalid" }, { headers: NO_STORE });
  }
  return Response.json(screeningState(resolved), { headers: NO_STORE });
}
