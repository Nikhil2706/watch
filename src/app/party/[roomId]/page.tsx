import Link from "next/link";
import { redirect } from "next/navigation";

import { PartyChatOnly } from "@/components/party/PartyChatOnly";
import { PartyRoomClient } from "@/components/party/PartyRoomClient";
import { currentSession } from "@/lib/current-user";
import { getItem, getPlaybackPlan, posterUrl, resumeSeconds } from "@/lib/media";
import { getPartyRoom, listGuestLinks } from "@/lib/party";
import { resolvePartyIdentity } from "@/lib/party-identity";
import { defaultTrack, listSubtitles } from "@/lib/subtitles";

export const dynamic = "force-dynamic";

/**
 * The combined watch+chat view — video main/left, chat docked right, per
 * the original spec. Only reachable with a resolved identity (a real
 * session, or a guest cookie this room's own /g/[token] link already set —
 * see resolvePartyIdentity's own comment for why that check lives here
 * rather than in middleware).
 *
 * Guests never get a player here: getPlaybackPlan()/getItem() proxy to
 * Jellyfin using a real account's own session token, which a no-signup
 * guest identity has no equivalent of — there is no Jellyfin credential to
 * stream on their behalf. A guest's view is chat-only, identical to
 * /party/[roomId]/chat, on the assumption (matching the original spec's
 * own "watching on another device" framing) that they're watching the
 * film some other way and using this purely to talk along.
 */
export default async function PartyRoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;

  const room = getPartyRoom(roomId);
  if (!room) redirect("/");

  const identity = await resolvePartyIdentity(roomId);
  if (!identity) redirect(`/login?next=${encodeURIComponent(`/party/${roomId}`)}`);

  if (identity.kind === "guest") {
    return (
      <div className="party-page party-page-chat-only">
        <div className="player-bar">
          <span className="title">{room.filmTitle}</span>
        </div>
        <PartyChatOnly roomId={roomId} isCreator={false} />
      </div>
    );
  }

  // identity.kind === "user" from here — resolvePartyIdentity already
  // confirmed a valid session exists, so this is just re-fetching the full
  // ResolvedSession (jellyfinToken etc.) that getItem/getPlaybackPlan need
  // and that the lightweight PartyIdentity deliberately doesn't carry.
  const session = await currentSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/party/${roomId}`)}`);

  const isCreator = room.creatorUserId === identity.id;
  const guestLinks = isCreator
    ? listGuestLinks(roomId).map((l) => ({ token: l.token, label: l.label, url: `/party/${roomId}/g/${l.token}` }))
    : [];

  const item = await getItem(session, room.jellyfinId).catch(() => null);
  let player = null;
  if (item) {
    try {
      const plan = await getPlaybackPlan(session, room.jellyfinId);
      if (!plan) throw new Error("no playback plan");
      const subtitles = listSubtitles(item);
      const preferred = defaultTrack(subtitles);
      player = {
        itemId: item.Id,
        mediaSourceId: plan.mediaSourceId,
        playSessionId: plan.playSessionId,
        mode: plan.mode,
        src: plan.src,
        title: item.Name,
        poster: posterUrl(item, 640),
        startSeconds: resumeSeconds(item),
        transcodeReasons: plan.transcodeReasons,
        subtitles: subtitles.map((t) => ({
          index: t.index,
          label: t.label,
          language: t.language,
          url: t.url,
          recommended: t.recommended,
        })),
        defaultSubtitleIndex: preferred?.index ?? null,
      };
    } catch {
      player = null;
    }
  }

  return (
    <div className="party-page">
      <div className="player-bar">
        <Link className="btn ghost" href="/">
          ‹ Back
        </Link>
        <span className="title">{room.filmTitle}</span>
      </div>
      <PartyRoomClient roomId={roomId} myId={identity.id} isCreator={isCreator} player={player} guestLinks={guestLinks} />
    </div>
  );
}
