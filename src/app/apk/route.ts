import { mirroredApk } from "@/lib/app-mirror";
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
export async function GET(): Promise<Response> {
  // This server's own copy when it has one (app-mirror.ts): GitHub can crawl
  // on a home line, and at home the site is the Mac on the LAN.
  const location = (await mirroredApk()) ? "/api/app-update/apk" : APP_APK_URL;
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}
