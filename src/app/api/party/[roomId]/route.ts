import { endPartyRoom, getPartyRoom, listGuestLinks } from "@/lib/party";
import { getSessionFromRequest } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/party/{roomId}
 *
 * Room info for anyone signed in (the chat page needs this regardless of
 * who's asking, to render the header/status). Guest links are only
 * included when the requester is the room's creator — a guest link is a
 * bearer credential (see its own comment in schema.ts), so handing the
 * whole list to every participant would let anyone in the room mint
 * themselves someone else's identity.
 */
export async function GET(request: Request, { params }: { params: Promise<{ roomId: string }> }): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const { roomId } = await params;
  const room = getPartyRoom(roomId);
  if (!room) {
    return Response.json({ error: "not_found", message: "No such watch party." }, { status: 404, headers: NO_STORE });
  }

  const isCreator = room.creatorUserId === session.userId;
  return Response.json(
    { room, guestLinks: isCreator ? listGuestLinks(roomId) : [], isCreator },
    { headers: NO_STORE },
  );
}

/** POST /api/party/{roomId}  { end: true } — the creator ending their own party early. */
export async function POST(request: Request, { params }: { params: Promise<{ roomId: string }> }): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const { roomId } = await params;
  const ended = endPartyRoom(roomId, session.userId);
  if (!ended) {
    return Response.json(
      { error: "invalid_request", message: "Not your party, or it's already over." },
      { status: 400, headers: NO_STORE },
    );
  }
  return Response.json({ ended: true }, { headers: NO_STORE });
}
