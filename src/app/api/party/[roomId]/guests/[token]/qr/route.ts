import QRCode from "qrcode";

import { env } from "@/lib/env";
import { getGuestLink, getPartyRoom } from "@/lib/party";
import { getSessionFromRequest } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/party/{roomId}/guests/{token}/qr — an SVG of the guest link's
 * full URL, for the creator to display/print/screenshot for whoever that
 * link is for. Rendered server-side (the `qrcode` package, no network
 * call) rather than a third-party QR image API, same self-hosted
 * reasoning as Player.tsx bundling its own hls.js.
 *
 * Session-gated to the room's creator, same as the guest links list
 * itself (POST .../guests) — a guest link is a bearer credential, so its
 * QR code carries the same sensitivity as the raw URL.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string; token: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { roomId, token } = await params;
  const room = getPartyRoom(roomId);
  const link = getGuestLink(token);
  if (!room || !link || link.roomId !== roomId) return new Response("Not found", { status: 404 });
  if (room.creatorUserId !== session.userId) return new Response("Forbidden", { status: 403 });

  const url = `${env.publicUrl}/party/${roomId}/g/${token}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 220 });

  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
  });
}
