import { mirroredRelease } from "@/lib/app-mirror";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/app-update/latest — the Android app's update descriptor, from this
 * server's own copy of the latest release (app-mirror.ts). Same shape as
 * GitHub's latest.json; `apk` points at this site. 503 until a copy exists,
 * and the app then asks GitHub. No sign-in: the app checks at launch.
 */
export async function GET(): Promise<Response> {
  const m = await mirroredRelease();
  if (!m) {
    return Response.json({ error: "not_ready" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(
    { versionCode: m.versionCode, versionName: m.versionName, apk: `${env.publicUrl}/api/app-update/apk`, size: m.size },
    { headers: { "Cache-Control": "no-store" } },
  );
}
