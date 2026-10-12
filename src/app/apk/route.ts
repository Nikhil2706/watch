import { APP_APK_URL } from "@/lib/app-release";

export const dynamic = "force-dynamic";

/**
 * GET /apk — straight to the Android app's file, for a phone or a TV.
 *
 * /app is the page with the steps; this is the address short enough to type
 * with a TV remote into Downloader, or to send someone who only needs the
 * file. Reachable signed out, like /app (see the matcher in middleware.ts).
 * It is the same file for both: one app, laid out for whichever it is on.
 */
export function GET(): Response {
  return new Response(null, { status: 302, headers: { Location: APP_APK_URL, "Cache-Control": "no-store" } });
}
