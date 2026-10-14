"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { PlayerMount, type PlayerMountProps } from "@/components/media/PlayerMount";
import { useTvBack, useTvMode } from "@/components/tv/TvProvider";
import { getFocusableElements } from "@/lib/tv/spatial-nav";
import { heartbeatRole, viewerIsController } from "@/lib/party-sync";

import { PartyChatPanel } from "./PartyChatPanel";
import { PartyGuestLinksPanel, type PartyGuestLinkView } from "./PartyGuestLinksPanel";
import { usePartySocket } from "./usePartySocket";

/**
 * Below the width where chat docks beside the film (globals.css,
 * .party-room-grid's 900px breakpoint) there is no room for a side panel: the
 * chat stacked under the video, a scroll away from it.
 */
const NARROW_QUERY = "(max-width: 899px)";

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * The combined watch+chat view (/party/[roomId]). One usePartySocket() call
 * shared between the player (playback sync) and the chat, so this page opens
 * exactly one connection rather than two independently reconnecting ones.
 *
 * Two layouts:
 *  - desktop: video main/left, chat docked right, per the original spec;
 *  - TV and phone: the video alone, with a "Chat" button next to "‹ Back"
 *    that opens the chat over the film without stopping it, and counts
 *    unread messages while it is closed. On a TV that button is reached
 *    with the remote (up from the video, then right) and opened with OK;
 *    Back closes the chat and puts focus back on the button.
 */
export function PartyRoomClient({
  roomId,
  myId,
  isCreator,
  filmTitle,
  player,
  guestLinks,
}: {
  roomId: string;
  myId: string;
  isCreator: boolean;
  filmTitle: string;
  /** null when the room's title has no playable stream right now (mirrors /watch/[id]'s own "cannot play this title" state). */
  player: PlayerMountProps | null;
  guestLinks: PartyGuestLinkView[];
}) {
  const socket = usePartySocket(roomId, { watching: player !== null });
  const isController = viewerIsController(isCreator, socket.participants, myId);
  const role = heartbeatRole({ isController, clientId: socket.clientId, leaderClientId: socket.leaderClientId });

  const tvMode = useTvMode();
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
  const overlayMode = tvMode || narrow;

  const [ending, setEnding] = useState(false);
  /* Chat has been sent to a phone or another tab — the film gets the width. */
  const [chatDetached, setChatDetached] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const router = useRouter();

  /* ---- The chat overlay (TV and phone) ---- */
  const [chatOpen, setChatOpen] = useState(false);
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Set when the overlay closes, so focus goes back to the Chat button once it is focusable again. */
  const returnFocus = useRef(false);
  /**
   * Message ids already seen: the history there was on arrival, and anything
   * that came in while the chat was in view. A reconnect's fresh history
   * still counts what arrived while the stream was down.
   */
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const showingChat = overlayMode ? chatOpen : !chatDetached;
  useEffect(() => {
    if (!socket.historyLoaded) return;
    if (seen !== null && !showingChat) return;
    if (seen !== null && socket.messages.every((m) => seen.has(m.id))) return;
    setSeen(new Set(socket.messages.map((m) => m.id)));
  }, [socket.historyLoaded, socket.messages, showingChat, seen]);
  // The room's own lines (who paused) are not something to come and read.
  const unread = seen ? socket.messages.filter((m) => m.kind !== "system" && !seen.has(m.id)).length : 0;

  function closeChat() {
    returnFocus.current = true;
    setChatOpen(false);
  }

  // Back (the remote's, Escape, or the Android app's) closes the chat first.
  useTvBack(() => {
    closeChat();
    return true;
  }, overlayMode && chatOpen);

  useEffect(() => {
    if (chatOpen) {
      // On a TV, into the chat straight away: the remote has nowhere else to
      // start from. Not on a phone, where focusing the box would throw the
      // keyboard up over the film before anyone asked to type.
      if (!tvMode) return;
      const panel = overlayRef.current;
      if (!panel) return;
      const field = panel.querySelector<HTMLElement>(".party-composer input:not([disabled])");
      (field ?? getFocusableElements(panel)[0])?.focus();
      return;
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      chatButtonRef.current?.focus();
    }
  }, [chatOpen, tvMode]);

  // Leaving the narrow layout with the chat open: it is docked again instead.
  useEffect(() => {
    if (!overlayMode) setChatOpen(false);
  }, [overlayMode]);

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

  /**
   * Rendered in exactly one place at a time, but always somewhere while the
   * party is live: it used to sit only in the chat panel, so sending the chat
   * to another tab took the creator's only way to end the party with it.
   */
  const endControls =
    isCreator && !socket.ended ? (
      <div className="party-end">
        <button type="button" className="party-end-btn" onClick={handleEndParty} disabled={ending}>
          {ending ? "Ending…" : "End watch party"}
        </button>
        {endError ? (
          <p className="error" role="alert">
            {endError}
          </p>
        ) : null}
      </div>
    ) : null;

  const creatorExtras = (
    <>
      {isCreator ? <PartyGuestLinksPanel roomId={roomId} initialLinks={guestLinks} /> : null}
      {endControls}
    </>
  );

  const gridClass = [
    "party-room-grid",
    chatDetached && !overlayMode ? "chat-detached" : null,
    overlayMode ? "chat-overlay-mode" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div className="player-bar" inert={overlayMode && chatOpen && tvMode}>
        <Link className="btn ghost" href="/">
          ‹ Back
        </Link>
        {overlayMode ? (
          <button
            ref={chatButtonRef}
            type="button"
            className="btn ghost party-chat-toggle"
            aria-expanded={chatOpen}
            aria-label={unread > 0 ? `Chat, ${unread} unread` : "Chat"}
            onClick={() => (chatOpen ? closeChat() : setChatOpen(true))}
          >
            Chat
            {unread > 0 ? (
              <span className="party-unread" aria-hidden="true">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </button>
        ) : null}
        <span className="title">{filmTitle}</span>
      </div>

      <div className={gridClass}>
        {socket.ended ? <div className="party-ended-banner">This watch party has ended.</div> : null}

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

        {/* On a TV the film stays under the open chat but out of the remote's
            reach, so the D-pad cannot wander off the chat onto the video. */}
        <div className="party-room-player" inert={overlayMode && chatOpen && tvMode}>
          {player ? (
            <PlayerMount
              {...player}
              party={{
                isController,
                sendsHeartbeat: role.sends,
                followsHeartbeat: role.follows,
                serverNow: socket.serverNow,
                sendSync: socket.sendSync,
                sendPosition: socket.sendPosition,
                lastSync: socket.lastSync,
                lastPosition: socket.lastPosition,
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

        {overlayMode ? (
          chatOpen ? (
            <div className="party-chat-overlay" ref={overlayRef} role="dialog" aria-label="Chat">
              <PartyChatPanel
                roomId={roomId}
                isCreator={isCreator}
                socket={socket}
                onMoveOut={closeChat}
                onClose={closeChat}
              />
              {creatorExtras}
            </div>
          ) : null
        ) : (
          <>
            {chatDetached ? (
              <div className="party-chat-away" role="status">
                <span>Chat is on your other screen.</span>
                <button type="button" onClick={() => setChatDetached(false)}>
                  Bring it back
                </button>
                {endControls}
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
              {chatDetached ? null : endControls}
            </div>
          </>
        )}
      </div>
    </>
  );
}
