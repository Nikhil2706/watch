import "server-only";

import { cookies, headers } from "next/headers";

import { TV_MODE_COOKIE, resolveTvMode } from "./constants";

export { TV_MODE_COOKIE, isTvUserAgent, tvModeFromCookie, resolveTvMode } from "./constants";

/**
 * Server-side TV-mode detection for a server component/layout: reads the
 * request's own cookie jar and headers, then defers to the shared
 * (client-safe) resolveTvMode in constants.ts. Kept in its own
 * "server-only" module — importing next/headers from a file a client
 * component also touches breaks the Next.js build, which is exactly what
 * pulled this apart from constants.ts.
 */
export async function resolveTvModeFromRequest(): Promise<boolean> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveTvMode({
    cookieValue: cookieStore.get(TV_MODE_COOKIE)?.value,
    userAgent: headerStore.get("user-agent"),
  });
}
