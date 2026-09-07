import { cookies } from "next/headers";

import { SCREENING_COOKIE, nameScreeningSession, resolveScreeningSession } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * What this guest would like to be called.
 *
 * A courtesy label, not a claim: nothing verifies it and nothing should pretend
 * otherwise. Every authorisation decision is made from the token and the
 * session row, never from this.
 */
export async function POST(request: Request): Promise<Response> {
  const sessionId = (await cookies()).get(SCREENING_COOKIE)?.value;
  const resolved = sessionId ? resolveScreeningSession(sessionId) : null;
  if (!resolved) return Response.json({ error: "no screening" }, { status: 401, headers: NO_STORE });

  let body: { name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }

  nameScreeningSession(resolved.sessionId, String(body.name ?? "").slice(0, 60));
  return Response.json({ ok: true }, { headers: NO_STORE });
}
