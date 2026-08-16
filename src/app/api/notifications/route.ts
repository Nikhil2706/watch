import { listNotifications } from "@/lib/notifications";
import { getSessionFromRequest } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/notifications — recent notifications + unread count, for the bell. Polled by NotificationBell. */
export async function GET(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  return Response.json(listNotifications(session.userId), { headers: NO_STORE });
}
