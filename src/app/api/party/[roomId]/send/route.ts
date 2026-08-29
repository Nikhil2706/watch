import { isRoomLive, postChat, postSync, setController } from "@/lib/party-bus";
import { resolvePartyIdentity } from "@/lib/party-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/party/{roomId}/send — everything a participant sends into a room.
 *
 * The client -> server half of the SSE transport that replaced the WebSocket
 * (see src/lib/party-bus.ts). Mirrors the old socket message types one for one
 * so the protocol did not have to be redesigned along with the transport:
 *
 *   {type:"chat",   body}
 *   {type:"sync",   action:"play"|"pause"|"seek", positionSeconds}
 *   {type:"grant",  targetId}   -- creator only
 *   {type:"revoke", targetId}   -- creator only
 *
 * Ending a party is deliberately NOT here: it lives at POST /api/party/{roomId}
 * because it is a state change to the room itself rather than a message into
 * it, and it must keep working even when nobody holds a stream.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;

  const identity = await resolvePartyIdentity(roomId);
  if (!identity) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  if (!isRoomLive(roomId)) {
    return Response.json({ error: "ended", message: "This watch party has ended." }, { status: 410, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  switch (body.type) {
    case "chat": {
      const text = typeof body.body === "string" ? body.body : "";
      const message = postChat(roomId, identity, text);
      if (!message) {
        return Response.json({ error: "invalid_request", message: "Empty message." }, { status: 400, headers: NO_STORE });
      }
      return Response.json({ ok: true, message }, { headers: NO_STORE });
    }

    case "sync": {
      const action = body.action;
      if (action !== "play" && action !== "pause" && action !== "seek") {
        return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
      }
      const positionSeconds = typeof body.positionSeconds === "number" && Number.isFinite(body.positionSeconds)
        ? Math.max(0, body.positionSeconds)
        : null;
      if (positionSeconds === null) {
        return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
      }
      // Silently ignored for non-controllers rather than erroring: a viewer's
      // own player emits play/pause locally all the time, and turning each of
      // those into a visible failure would be noise, not information.
      const applied = postSync(roomId, identity, action, positionSeconds);
      return Response.json({ ok: true, applied }, { headers: NO_STORE });
    }

    case "grant":
    case "revoke": {
      const targetId = typeof body.targetId === "string" ? body.targetId : "";
      if (!targetId) {
        return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
      }
      const ok = setController(roomId, identity, targetId, body.type === "grant");
      if (!ok) {
        return Response.json(
          { error: "forbidden", message: "Only the host can change who controls playback." },
          { status: 403, headers: NO_STORE },
        );
      }
      return Response.json({ ok: true }, { headers: NO_STORE });
    }

    default:
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
}
