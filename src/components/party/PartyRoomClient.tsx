"use client";

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

  return (
    <div className="party-room-grid">
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

      <div className="party-room-side">
        <PartyChatPanel roomId={roomId} isCreator={isCreator} socket={socket} />
        {isCreator ? <PartyGuestLinksPanel roomId={roomId} initialLinks={guestLinks} /> : null}
      </div>
    </div>
  );
}
