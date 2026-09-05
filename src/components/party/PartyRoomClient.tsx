"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PlayerMount, type PlayerMountProps } from "@/components/media/PlayerMount";

import { PartyChatPanel } from "./PartyChatPanel";
import { PartyGuestLinksPanel, type PartyGuestLinkView } from "./PartyGuestLinksPanel";
import { usePartySocket } from "./usePartySocket";

/**
 * The combined watch+chat view (/party/[roomId]) — video main/left, chat
 * docked right, per the original spec. One usePartySocket() call shared
 * between the player (playback sync) and the chat panel, so this page
 * opens exactly one WebSocket connection rather than two independently
 * reconnecting ones.
 */
export function PartyRoomClient({
  roomId,
  myId,
  isCreator,
  player,
  guestLinks,
}: {
  roomId: string;
  myId: string;
  isCreator: boolean;
  /** null when the room's title has no playable stream right now (mirrors /watch/[id]'s own "cannot play this title" state). */
  player: PlayerMountProps | null;
  guestLinks: PartyGuestLinkView[];
}) {
  const socket = usePartySocket(roomId);
  const me = socket.participants.find((p) => p.id === myId);
  const isController = isCreator || (me?.isController ?? false);

  const [ending, setEnding] = useState(false);
  /* Chat has been sent to a phone or another tab — the film gets the width. */
  const [chatDetached, setChatDetached] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const router = useRouter();

  /**
   * Ends over HTTP, not the socket.
   *
   * This used to be `socket.end()` alone, sent over the WebSocket — which
   * meant ending a party required a working realtime connection, and that
   * transport was never routed in production, so the button silently did
   * nothing and the creator had no way to close their own room. Ending is a
   * state change to the room rather than a message into it, so it belongs on
   * its own route regardless of transport, and keeps working with no stream
   * open at all. The route broadcasts `ended` to everyone else.
   */
  async function handleEndParty() {
    if (!confirm("End this watch party for everyone?")) return;
    setEnding(true);
    setEndError(null);
    try {
      const response = await fetch(`/api/party/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ end: true }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        setEndError(data?.message ?? "Could not end the party.");
        setEnding(false);
        return;
      }
      // The route already broadcast `ended` to everyone else; this just closes
      // our own stream and flips the local view over.
      socket.end();
      router.refresh();
    } catch {
      setEndError("Could not end the party. Check your connection.");
      setEnding(false);
    }
  }

  return (
    <div className={chatDetached ? "party-room-grid chat-detached" : "party-room-grid"}>
      {socket.ended ? (
        <div className="party-ended-banner">This watch party has ended.</div>
      ) : null}

      {/* Honest failure. Before the SSE rewrite the room looked completely
          normal while chat and sync did nothing at all; if the stream ever
          drops again, say so rather than repeating that. */}
      {!socket.ended && socket.unreachable ? (
        <div className="party-degraded-banner" role="status">
          <strong>Live chat and playback sync are offline.</strong> The realtime service can’t be
          reached, so messages won’t send and playback won’t stay in step. You can still watch the
          film here, and {isCreator ? "ending the party still works." : "the host can still end the party."}
        </div>
      ) : null}

      <div className="party-room-player">
        {player ? (
          <PlayerMount
            {...player}
            party={{
              isController,
              sendSync: socket.sendSync,
              lastSync: socket.lastSync,
              initialState: socket.initialState,
            }}
          />
        ) : (
          <div className="player-stage">
            <div className="player-msg">
              <strong>Cannot play this title</strong>
              The media server offered no playable stream for this file.
            </div>
          </div>
        )}
      </div>

      {chatDetached ? (
        <div className="party-chat-away" role="status">
          <span>Chat is on your other screen.</span>
          <button type="button" onClick={() => setChatDetached(false)}>
            Bring it back
          </button>
        </div>
      ) : null}

      <div className="party-room-side" hidden={chatDetached}>
        <PartyChatPanel
          roomId={roomId}
          isCreator={isCreator}
          socket={socket}
          onMoveOut={() => setChatDetached(true)}
        />
        {isCreator ? <PartyGuestLinksPanel roomId={roomId} initialLinks={guestLinks} /> : null}
        {isCreator && !socket.ended ? (
          <>
            <button type="button" className="party-end-btn" onClick={handleEndParty} disabled={ending}>
              {ending ? "Ending…" : "End watch party"}
            </button>
            {endError ? (
              <p className="error" role="alert">
                {endError}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
