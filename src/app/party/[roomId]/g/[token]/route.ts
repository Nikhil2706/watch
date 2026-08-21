import { cookieSecure } from "@/lib/env";
import { getPartyRoom, getGuestLink } from "@/lib/party";
import { guestCookie } from "@/lib/party-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /party/{roomId}/g/{token} — a guest's personal invite link. Not a
 * page: this exists purely to turn the token in the URL into a cookie (so
 * the room page and every reconnect after this one can recognise the same
 * browser without the token in the URL every time) and then redirect to
 * the actual room. See middleware.ts's own comment for why /party/* is
 * exempt from the normal login-required redirect — this route is the
 * reason.
 */
export async function GET(request: Request, { params }: { params: Promise<{ roomId: string; token: string }> }): Promise<Response> {
  const { roomId, token } = await params;

  const room = getPartyRoom(roomId);
  const link = getGuestLink(token);
  if (!room || !link || link.roomId !== roomId || room.endedAt !== null) {
    return new Response("This watch party link isn't valid anymore.", { status: 404 });
  }

  const url = new URL(`/party/${roomId}`, request.url);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": guestCookie(roomId, token, cookieSecure),
    },
  });
}
