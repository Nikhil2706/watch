/**
 * Who may call /api/admin/*: the decision, with nothing to look up, so it is
 * tested directly (admin-auth.ts does the lookups).
 *
 * Two ways in:
 *   - the X-Admin-Key header — scripts, the Mac's helpers and the old
 *     console (curator.html) still use it;
 *   - the session cookie of an account with users.is_admin set — the /admin
 *     pages in the app.
 *
 * The cookie is the new risk. A header is never attached by a browser on its
 * own, so the key needed no CSRF defence; a cookie is (SameSite=Lax still
 * sends it on a top-level navigation from another site). So a cookie only
 * counts for a request the browser says came from this site itself
 * (Sec-Fetch-Site: same-origin) or from the person typing the address
 * ("none"). Browsers too old to send Sec-Fetch-Site are judged by Origin on
 * anything that isn't a plain read.
 */

export interface AdminRequestFacts {
  method: string;
  /** Whether X-Admin-Key was sent, and whether it matched (compared in constant time by the caller). */
  keyHeader: "absent" | "valid" | "invalid";
  /** The signed-in account, if the request carries a live session. */
  session: { username: string; isAdmin: boolean; suspended: boolean } | null;
  secFetchSite: string | null;
  origin: string | null;
  /** This server's own origin(s), e.g. PUBLIC_URL and the Host the request arrived on. */
  ownOrigins: readonly string[];
}

export type AdminDecision =
  | { ok: true; via: "key" }
  | { ok: true; via: "session"; username: string }
  | { ok: false; reason: "no-credentials" | "bad-key" | "not-admin" | "cross-site" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function decideAdmin(f: AdminRequestFacts): AdminDecision {
  // A key that was sent decides on its own: a wrong one is refused even if a
  // session would have passed, so a script with a stale key fails loudly.
  if (f.keyHeader === "valid") return { ok: true, via: "key" };
  if (f.keyHeader === "invalid") return { ok: false, reason: "bad-key" };

  const s = f.session;
  if (!s) return { ok: false, reason: "no-credentials" };
  if (!s.isAdmin || s.suspended) return { ok: false, reason: "not-admin" };
  if (!sameSite(f)) return { ok: false, reason: "cross-site" };
  return { ok: true, via: "session", username: s.username };
}

function sameSite(f: AdminRequestFacts): boolean {
  const site = f.secFetchSite?.toLowerCase() ?? null;
  if (site !== null) return site === "same-origin" || site === "none";
  // No Fetch Metadata (an old browser): a read is let through, a write needs
  // an Origin that is ours.
  if (SAFE_METHODS.has(f.method.toUpperCase())) return true;
  return f.origin !== null && f.ownOrigins.some((o) => sameOrigin(o, f.origin!));
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
