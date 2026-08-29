import { isRoomLive, joinRoom, type PartyEvent } from "@/lib/party-bus";
import { resolvePartyIdentity } from "@/lib/party-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/party/{roomId}/events — the room's event stream (SSE).
 *
 * Replaces the WebSocket at `/ws/party`, which was never routable in
 * production. See src/lib/party-bus.ts for the full reasoning.
 *
 * Auth is the same cookie pair the rest of the party uses: a real session, or
 * a per-room guest cookie set by the guest-link route. Guests are first-class
 * here — the whole point of a guest link is that someone without an account
 * can talk along.
 */
const HEARTBEAT_MS = 20_000;

/**
 * HEAD /api/party/{roomId}/events — cheap "is this room still going?" probe.
 *
 * EventSource does not expose the HTTP status of a failed connection, so from
 * the client a room that ended between reconnects is indistinguishable from a
 * dropped network. The client probes this after a stream error and stops
 * retrying on 410. Without a HEAD export, Next answers 405 for a
 * GET-only route and that check would never fire.
 */
export async function HEAD(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;
  const identity = await resolvePartyIdentity(roomId);
  if (!identity) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!isRoomLive(roomId)) return new Response(null, { status: 410, headers: { "Cache-Control": "no-store" } });
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;

  const identity = await resolvePartyIdentity(roomId);
  if (!identity) {
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  // A finished party has no stream. Answering 410 rather than opening an inert
  // connection lets the client stop retrying and say so, instead of the old
  // behaviour: reconnecting every two seconds forever against a 404.
  if (!isRoomLive(roomId)) {
    return Response.json({ error: "ended" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }

  const encoder = new TextEncoder();
  let leave: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: PartyEvent) => {
        try {
          controller.enqueue(encoder.encode(`event: party\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client vanished mid-write; cleanup runs via cancel/abort.
        }
      };

      // Flush immediately: some proxies only commit to streaming once the
      // first bytes arrive, and the client treats this as "connected".
      try {
        controller.enqueue(encoder.encode(`event: ready\ndata: {}\n\n`));
      } catch {
        /* already closed */
      }

      leave = joinRoom(roomId, identity, send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      leave?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  request.signal.addEventListener("abort", () => {
    leave?.();
    if (heartbeat) clearInterval(heartbeat);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
