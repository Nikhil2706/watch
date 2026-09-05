import QRCode from "qrcode";

import { env } from "@/lib/env";
import { getPartyRoom } from "@/lib/party";
import { resolvePartyIdentity } from "@/lib/party-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/party/{roomId}/chat-qr — an SVG of this room's chat-only URL, for
 * scanning with your own phone so the television can play the film
 * uninterrupted while the conversation carries on in your hand.
 *
 * Deliberately NOT the guest-link QR next door. That one encodes
 * /party/{id}/g/{token}, a bearer credential for someone else, and is gated
 * to the room's creator. This encodes /party/{id}/chat, which carries no
 * credential at all — whoever scans it still has to be signed in on that
 * device, or they land on /login and come back afterwards. So it is gated
 * only to people already in the room (any participant, guest or user), not
 * to the creator.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  const { roomId } = await params;

  const room = getPartyRoom(roomId);
  if (!room) return new Response("Not found", { status: 404 });

  const identity = await resolvePartyIdentity(roomId);
  if (!identity) return new Response("Unauthorized", { status: 401 });

  const url = `${env.publicUrl}/party/${roomId}/chat`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 200 });

  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
  });
}
