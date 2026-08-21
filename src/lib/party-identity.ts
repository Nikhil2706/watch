import "server-only";

import { cookies } from "next/headers";

import { getGuestLink } from "./party";
import { getSession, SESSION_COOKIE } from "./session";

/** A watch party's chat has two kinds of participant: this site's own users, and no-signup guests holding a per-person link (see schema.ts's party_guest_links comment). Both need a stable displayName and a stable id for the duration of the party. */
export interface PartyIdentity {
  kind: "user" | "guest";
  /** userId for kind "user", the guest link's token for kind "guest" — either way, the thing party_messages.user_id/guest_token actually stores. */
  id: string;
  displayName: string;
}

function guestCookieName(roomId: string): string {
  return `jfg_pg_${roomId}`;
}

/**
 * Resolves whichever identity this browser has for this specific room — a
 * real session takes priority (a logged-in user who also happens to be
 * holding a guest link for the same room, e.g. their own party, is still
 * just themselves). Returns null when neither is present; callers send the
 * visitor to /login rather than rendering anything, same as every other
 * page would via middleware — except middleware deliberately excludes
 * /party/* (see its own comment), so this check has to happen here
 * instead.
 */
export async function resolvePartyIdentity(roomId: string): Promise<PartyIdentity | null> {
  const store = await cookies();

  const session = getSession(store.get(SESSION_COOKIE)?.value ?? null);
  if (session) return { kind: "user", id: session.userId, displayName: session.username };

  const guestToken = store.get(guestCookieName(roomId))?.value;
  if (guestToken) {
    const link = getGuestLink(guestToken);
    if (link && link.roomId === roomId) return { kind: "guest", id: link.token, displayName: link.label };
  }

  return null;
}

/** Set by the guest-link entry route (/party/[roomId]/g/[token]/route.ts) — see that file for why this can't just be a plain page. */
export function guestCookie(roomId: string, token: string, secure: boolean): string {
  const parts = [
    `${guestCookieName(roomId)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    // A guest link is meant to outlive one sitting — someone might close the
    // tab and come back for a second episode of the same party later the
    // same evening — but not linger forever the way a real account's
    // session does. 30 days, same order of magnitude as this app's own
    // session lifetime elsewhere.
    `Max-Age=${30 * 24 * 60 * 60}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
