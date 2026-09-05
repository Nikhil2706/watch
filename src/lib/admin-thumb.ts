import "server-only";

import { signResource } from "./crypto";
import { env } from "./env";

/**
 * A signed thumbnail URL for the curator console — NOT the /jf/ path the
 * public site uses.
 *
 * The console is a local file:// page. Its <img> requests are cross-site, so
 * the session cookie /jf/ requires is never sent, and an <img> cannot carry
 * the X-Admin-Key header the rest of the console authenticates with. Every
 * library poster in the dashboard was therefore broken — the Accolades film
 * grid included, since the day it shipped.
 *
 * So the URL carries its own authorisation: an HMAC over "{itemId}:{tag}"
 * keyed by the admin key, minted server-side wherever these URLs are handed
 * out. The key itself never appears in a URL, in history, or in a log; the
 * signature unlocks exactly one item's poster at one image version and grants
 * nothing else.
 *
 * Lives in its own module because several surfaces mint these (the admin
 * search, the library workspace) and the signing rule must not drift between
 * them — see src/app/api/admin/thumb/[itemId]/route.ts for the other half.
 */
export function adminThumbUrl(itemId: string, tag: string | null | undefined): string | null {
  if (!tag) return null;
  const sig = signResource(`${itemId}:${tag}`, env.adminApiKey);
  const query = new URLSearchParams({ tag, sig });
  return `/api/admin/thumb/${encodeURIComponent(itemId)}?${query.toString()}`;
}
