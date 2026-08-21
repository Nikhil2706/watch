import { getPartyRoom, createGuestLink } from "@/lib/party";
import { getSessionFromRequest } from "@/lib/session";
import { optionalString, readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/party/{roomId}/guests  { label? }
 *
 * Mints one new per-person guest link — creator-only. label is what shows
 * next to that person's chat messages ("Alice"); left blank, it becomes
 * "Guest N". The returned token is the whole credential: paste it into
 * "/party/{roomId}/g/{token}" (done client-side — see the guest-links
 * panel) and hand that URL or its QR code to the one specific person it's
 * for.
 */
export async function POST(request: Request, { params }: { params: Promise<{ roomId: string }> }): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const { roomId } = await params;
  const room = getPartyRoom(roomId);
  if (!room) {
    return Response.json({ error: "not_found", message: "No such watch party." }, { status: 404, headers: NO_STORE });
  }
  if (room.creatorUserId !== session.userId) {
    return Response.json(
      { error: "forbidden", message: "Only the party's creator can invite guests." },
      { status: 403, headers: NO_STORE },
    );
  }

  const raw = await readJsonBody(request).catch(() => ({}));
  const label = optionalString(raw, "label");

  const link = createGuestLink(roomId, label ?? undefined);
  return Response.json({ link }, { status: 201, headers: NO_STORE });
}
