import { NextResponse, type NextRequest } from "next/server";

/**
 * Cheap gate in front of the page routes.
 *
 * DELIBERATELY DOES NOT VALIDATE THE SESSION. Next middleware runs on the Edge
 * runtime, where `node:sqlite` does not exist, so a real database lookup is not
 * possible here. Rather than reach for experimental Node-runtime middleware,
 * this checks only that a session cookie is *present* and leaves the actual
 * verification to the route handlers and server components, which run on Node
 * and hit the database directly.
 *
 * The security consequence is nil: a forged cookie gets past this redirect and
 * is then rejected by `getSession`, which is the only thing that ever grants
 * access. This exists purely so a logged-out visitor lands on /login instead of
 * a flash of empty page.
 *
 * The matcher excludes /api/* entirely, which is what keeps the admin routes
 * exempt from user session handling, as the brief requires — /api/admin/* is
 * authenticated by X-Admin-Key alone and must never be redirected to a login
 * page.
 *
 * Also excludes the PWA assets (manifest.json, sw.js, the icon PNGs) —
 * caught live while building the PWA baseline: a browser checks
 * installability (fetches the manifest + icons) from ANY page, including a
 * logged-out /login screen, and a service worker registration needs sw.js
 * served as real JavaScript, not an HTML login redirect. Without this
 * exclusion every one of those requests bounced to /login instead, which
 * would have made the site permanently uninstallable and broken SW
 * registration outright (wrong content-type, parse error).
 */

const SESSION_COOKIE = "jfg_session";

export function middleware(request: NextRequest): NextResponse {
  const sessionCookie = request.cookies.get(SESSION_COOKIE);

  if (sessionCookie?.value) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  const target = request.nextUrl.pathname + request.nextUrl.search;
  if (target !== "/") {
    // Relative path only — never an absolute URL, which would make this an
    // open redirect that could bounce a user to an attacker's login page.
    loginUrl.searchParams.set("next", target);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   api/*            — handles its own auth (admin key or session)
     *   jf/*             — returns 401 JSON; an XHR must not get an HTML redirect
     *   invite/*         — must be reachable while logged out
     *   login            — obviously
     *   _next/*, favicon — framework assets
     *   manifest.json, sw.js, icon-*.png, apple-touch-icon.png, favicon-32.png
     *                    — PWA assets, must be fetchable while logged out
     */
    "/((?!api/|jf/|invite/|login|_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|apple-touch-icon.png|favicon-32.png).*)",
  ],
};
