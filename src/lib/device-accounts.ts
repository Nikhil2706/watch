/**
 * The accounts signed in on one device, so a family TV can switch between
 * them without anyone typing a password or pairing again.
 *
 * Each entry is an ordinary session id, exactly what jfg_session holds: every
 * account on the list signed in on this device in the usual way, and switching
 * only changes which of those sessions is the active one. Nothing here can
 * reach an account that did not sign in on this device, and signing an
 * account out (or an admin revoking it) ends its session, which drops it from
 * the list the next time the list is read.
 *
 * The list lives in its own httpOnly cookie (ACCOUNTS_COOKIE in session.ts),
 * so page script can no more read these ids than it can read jfg_session.
 * Pure functions only, so the rules are testable without a database.
 */

/** A family, not an office: enough tiles to fit one row on a TV. */
export const MAX_DEVICE_ACCOUNTS = 8;

/** Session ids are url-safe base64 (crypto.ts); anything else is not ours. */
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function parseDeviceAccounts(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids: string[] = [];
  for (const raw of decodeURIComponent(value).split(".")) {
    const id = raw.trim();
    if (SESSION_ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_DEVICE_ACCOUNTS);
}

export function serializeDeviceAccounts(ids: string[]): string {
  return ids.slice(0, MAX_DEVICE_ACCOUNTS).join(".");
}

/**
 * The list after a sign-in on this device: the new session first, and any
 * earlier session of the same account dropped (signing in again replaces it).
 * When the list is full the longest-unused account falls off the end.
 */
export function addDeviceAccount(
  ids: string[],
  sessionId: string,
  sameAccount: (otherId: string) => boolean = () => false,
): string[] {
  const rest = ids.filter((id) => id !== sessionId && !sameAccount(id));
  return [sessionId, ...rest].slice(0, MAX_DEVICE_ACCOUNTS);
}

/** The list after one account signs out here. */
export function removeDeviceAccount(ids: string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId);
}

/**
 * Whether opening Home on a TV should ask "Who's watching?" first: more than
 * one account saved here, and the TV has been left alone long enough that
 * whoever picks up the remote may not be who was watching last.
 */
export function shouldAskWhoIsWatching(input: {
  tvMode: boolean;
  savedAccounts: number;
  recentlyUsed: boolean;
  pathname: string;
}): boolean {
  return input.tvMode && input.savedAccounts > 1 && !input.recentlyUsed && input.pathname === "/";
}
