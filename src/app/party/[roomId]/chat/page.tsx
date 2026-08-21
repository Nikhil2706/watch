import { redirect } from "next/navigation";

import { PartyChatOnly } from "@/components/party/PartyChatOnly";
import { getPartyRoom } from "@/lib/party";
import { resolvePartyIdentity } from "@/lib/party-identity";

export const dynamic = "force-dynamic";

/**
 * Chat-only view — what the QR code and "open on your phone" link both
 * point at, and what a second browser tab uses for a two-display setup.
 * Same auth rule as /party/[roomId] (a real session or a valid guest
 * cookie); unlike that page, this one never touches Jellyfin at all, so
 * it works identically for a user or a guest.
 */
export default async function PartyChatPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;

  const room = getPartyRoom(roomId);
  if (!room) redirect("/");

  const identity = await resolvePartyIdentity(roomId);
  if (!identity) redirect(`/login?next=${encodeURIComponent(`/party/${roomId}/chat`)}`);

  return (
    <div className="party-page party-page-chat-only">
      <div className="player-bar">
        <span className="title">{room.filmTitle}</span>
      </div>
      <PartyChatOnly roomId={roomId} isCreator={room.creatorUserId === identity.id} />
    </div>
  );
}
