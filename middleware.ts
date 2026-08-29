import { NextResponse, type NextRequest } from "next/server";

import { TV_MODE_COOKIE } from "@/lib/tv/constants";

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
 * Also excludes /party/* — a guest link ("/party/{roomId}/g/{token}", see
 * src/lib/party.ts) is specifically the no-signup path into a watch party's
 * chat, so it cannot require jfg_session the way every other page does. The
 * room page itself (/party/{roomId}) checks its OWN auth — session cookie OR
 * a valid per-room guest cookie the link page just set — rather than relying
 * on this middleware for it.
 *
 * Also excludes the PWA assets (manifest.json, sw.js, the icon PNGs) —
 * caught live while building the PWA baseline: a browser checks
 * installability (fetches the manifest + icons) from ANY page, including a
 * logged-out /login screen, and a service worker registration needs sw.js
 * served as real JavaScript, not an HTML login redirect. Without this
 * exclusion every one of those requests bounced to /login instead, which
 * would have made the site permanently uninstallable and broken SW
 * registration outright (wrong content-type, parse error).
 *
 * /login is NOT excluded from the matcher (it used to be, when this file did
 * nothing else) — it still needs to stay reachable while logged out, which
 * the middleware function itself now handles as its very first branch,
 * before the session-cookie check, rather than via the matcher. It has to
 * run for /login too so the `?tv=` override below reaches the one page a TV
 * actually loads while signed out.
 */

const SESSION_COOKIE = "jfg_session";

/**
 * `?tv=1` / `?tv=0` forces TV mode on or off, persisted as a cookie so it
 * survives every subsequent navigation without the query param — this is
 * the documented way to test TV mode from an ordinary desktop browser (see
 * scripts/windows/README.md / HANDOFF.md). Applied to whichever response
 * this function was already going to return, redirect or pass-through
 * alike, so it works whether or not the visitor is logged in yet.
 */
function applyTvModeOverride(request: NextRequest, response: NextResponse): NextResponse {
  const override = request.nextUrl.searchParams.get("tv");
  if (override === "1" || override === "0") {
    response.cookies.set(TV_MODE_COOKIE, override, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  // /login must stay reachable while logged out (see the matcher comment
  // below) but is also where a TV's very first request lands, unauthenticated
  // — so the ?tv= override has to be handled here explicitly rather than via
  // the session-cookie branch below, which /login never reaches.
  if (request.nextUrl.pathname === "/login") {
    return applyTvModeOverride(request, NextResponse.next());
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE);

  if (sessionCookie?.value) {
    return applyTvModeOverride(request, NextResponse.next());
  }

  const loginUrl = new URL("/login", request.url);
  const target = request.nextUrl.pathname + request.nextUrl.search;
  if (target !== "/") {
    // Relative path only — never an absolute URL, which would make this an
    // open redirect that could bounce a user to an attacker's login page.
    loginUrl.searchParams.set("next", target);
  }
  return applyTvModeOverride(request, NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   api/*            — handles its own auth (admin key or session)
     *   jf/*             — returns 401 JSON; an XHR must not get an HTML redirect
     *   invite/*         — must be reachable while logged out
     *   party/*          — guest links must be reachable with no account at all
     *   _next/*, favicon — framework assets
     *   manifest.json, sw.js, icon-*.png, apple-touch-icon.png, favicon-32.png
     *                    — PWA assets, must be fetchable while logged out
     *
     * login is deliberately NOT in this exclusion list (see the comment
     * above) — the function's own first branch handles it.
     */
    "/((?!api/|jf/|invite/|party/|_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|icon-maskable-512.png|apple-touch-icon.png|favicon-32.png).*)",
  ],
};
