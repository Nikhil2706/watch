import "server-only";

import { cookies } from "next/headers";

import { getSession, SESSION_COOKIE, type ResolvedSession } from "./session";

/**
 * Session lookup for server components.
 *
 * This — not the middleware — is the authoritative check. Middleware only sees
 * whether a cookie exists; this resolves it against the database and returns
 * null for anything forged, revoked or expired.
 */
export async function currentSession(): Promise<ResolvedSession | null> {
  const store = await cookies();
  return getSession(store.get(SESSION_COOKIE)?.value ?? null);
}
