import { NextResponse } from "next/server";

import { claimScreeningDevice, SCREENING_COOKIE } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /screening/{token}
 *
 * A route handler rather than a page, so the token leaves the address bar
 * immediately: it is not left sitting in a screenshot, a Referer header, or
 * shoulder-surfing range. Same pattern as the watch-party guest link.
 *
 * Claims a device slot and 302s to /s/{id}, which is the only URL the recipient
 * ever sees or can bookmark.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  const result = claimScreeningDevice(token, {
    userAgent: request.headers.get("user-agent"),
    // Behind Cloudflare, so the first hop is the one that means anything.
    ip: (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || null,
  });

  const url = new URL(request.url);

  if (!result.ok) {
    // Never a 404 and never a login form. A login form shown to someone with no
    // account is the most confusing possible ending.
    const to = new URL("/s/unavailable", url.origin);
    to.searchParams.set("why", result.reason ?? "invalid");
    return NextResponse.redirect(to, 302);
  }

  const response = NextResponse.redirect(new URL(`/s/${result.screeningId}`, url.origin), 302);
  response.cookies.set({
    name: SCREENING_COOKIE,
    value: result.sessionId!,
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
