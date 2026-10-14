"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { PlayerMount, type PlayerMountProps } from "@/components/media/PlayerMount";
import { useTvBack, useTvMode } from "@/components/tv/TvProvider";
import { getFocusableElements } from "@/lib/tv/spatial-nav";
import { formatClock } from "@/lib/party-room";
import { heartbeatRole, viewerIsController } from "@/lib/party-sync";

import { PartyChatPanel } from "./PartyChatPanel";
import { PartyOverlay, type PartyOverlayTab } from "./PartyOverlay";
import { PartyGuestLinksPanel, type PartyGuestLinkView } from "./PartyGuestLinksPanel";
import { usePartySocket } from "./usePartySocket";

/**
 * Below the width where chat docks beside the film (globals.css,
 * .party-room-grid's 900px breakpoint) there is no room for a side panel: the
 * chat stacked under the video, a scroll away from it.
 */
const NARROW_QUERY = "(max-width: 899px)";

/** How long "↩ 1:02:13" stays offered after a big jump. */
const UNDO_OFFER_MS = 30_000;

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
  isCreator,
  filmTitle,
  player,
  guestLinks,
}: {
  roomId: string;
  isCreator: boolean;
  filmTitle: string;
  /** null when the room's title has no playable stream right now (mirrors /watch/[id]'s own "cannot play this title" state). */
  player: PlayerMountProps | null;
  guestLinks: PartyGuestLinkView[];
}) {
  const socket = usePartySocket(roomId, { watching: player !== null });
  // Matched by the opaque id the server gave this stream: the list never
  // carries anyone's real id (a guest's is their way in).
  const isController = viewerIsController(isCreator, socket.participants, socket.selfId ?? "");
  const myName = socket.participants.find((p) => p.id === socket.selfId)?.displayName;
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

  /*
   * Undo a jump: for UNDO_OFFER_MS after the room moved more than 30 s (a
   * stray press on the remote, a slip on the seek bar), a controller gets
   * "↩ 1:02:13" beside Chat. It asks this page's player to seek there, which
   * the room then follows like any other seek.
   */
  const [seekRequest, setSeekRequest] = useState<{ to: number; id: number } | null>(null);
  /** This screen has drifted from the room for a while: "Sync me" snaps it back (taken from WatchParty and CyTube). */
  const [outOfStep, setOutOfStep] = useState(false);
  const [syncNowRequest, setSyncNowRequest] = useState<number | null>(null);
  const [dismissedJump, setDismissedJump] = useState<typeof socket.lastJump>(null);
  const [, setTick] = useState(0);
  const jump = socket.lastJump;
  const undoJump =
    isController && jump && jump !== dismissedJump && Date.now() - jump.heardAt < UNDO_OFFER_MS && player ? jump : null;
  useEffect(() => {
    if (!jump) return;
    // Re-render once the offer runs out, so the button goes.
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, UNDO_OFFER_MS - (Date.now() - jump.heardAt)) + 50);
    return () => clearTimeout(timer);
  }, [jump]);

  /* ---- The chat overlay (TV and phone) ---- */
  const [chatOpen, setChatOpen] = useState(false);
  const [overlayTab, setOverlayTab] = useState<PartyOverlayTab>("chat");
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
  /**
   * TV: the phone scanned the QR and opened the chat. From then on the chat
   * lives there: the TV's panel goes away, the QR with it, and the film gets
   * the whole screen. (Messages count as read: they are on the phone.)
   */
  const chatOnPhone = tvMode && socket.chatElsewhere;
  const showingChat = chatOnPhone || (overlayMode ? chatOpen && overlayTab === "chat" : !chatDetached);
  useEffect(() => {
    if (!socket.historyLoaded) return;
    if (seen !== null && !showingChat) return;
    if (seen !== null && socket.messages.every((m) => seen.has(m.id))) return;
    setSeen(new Set(socket.messages.map((m) => m.id)));
  }, [socket.historyLoaded, socket.messages, showingChat, seen]);
  // The room's own lines (who paused) are not something to come and read.
  const unread = seen ? socket.messages.filter((m) => m.kind !== "system" && !seen.has(m.id)).length : 0;

  useEffect(() => {
    if (!chatOnPhone || !chatOpen || overlayTab !== "chat") return;
    setChatOpen(false);
    // Back to the film, not to the Chat button: the bar hides with the controls.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".vds-player")?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOnPhone]);

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
      // On a TV, onto the open tab straight away: the remote has nowhere else
      // to start from, and down goes into it. (Not the message box: with no
      // keyboard, the QR beside it is how a TV joins the chat.) Not on a
      // phone, where focusing anything would throw the keyboard up.
      if (!tvMode) return;
      const panel = overlayRef.current;
      if (!panel) return;
      const tab = panel.querySelector<HTMLElement>(".party-overlay-tab.is-active");
      (tab ?? getFocusableElements(panel)[0])?.focus();
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
    // Desktop asks with the browser's own dialog; the TV/phone panel asks on
    // screen first (PartyOverlay) and calls endParty() directly.
    if (!confirm("End this watch party for everyone?")) return;
    await endParty();
  }

  async function endParty() {
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
        {outOfStep && player ? (
          <button
            type="button"
            className="btn ghost party-sync-me"
            title="This screen has fallen out of step with the room"
            onClick={() => {
              setSyncNowRequest(Date.now());
              setOutOfStep(false);
            }}
          >
            Sync me
          </button>
        ) : null}
        {undoJump ? (
          <button
            type="button"
            className="btn ghost party-undo-jump"
            aria-label={`Go back to ${formatClock(undoJump.from)}, where the film was before ${undoJump.by}'s jump`}
            title={`Back to where the film was before ${undoJump.by}'s jump`}
            onClick={() => {
              setSeekRequest({ to: undoJump.from, id: Date.now() });
              setDismissedJump(socket.lastJump);
            }}
          >
            ↩ {formatClock(undoJump.from)}
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
          {player && socket.waitingFor.length > 0 ? (
            <div className="party-waiting" role="status">
              Starting together · waiting for {socket.waitingFor.join(", ")}
            </div>
          ) : null}
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
                seekRequest,
                sendReport: socket.sendReport,
                onOutOfStep: setOutOfStep,
                syncNowRequest,
                prepare: socket.prepare,
                sendReady: socket.sendReady,
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
            <PartyOverlay
              roomId={roomId}
              socket={socket}
              isCreator={isCreator}
              myName={myName}
              guestLinks={guestLinks}
              tab={overlayTab}
              onTab={setOverlayTab}
              unread={unread}
              tvMode={tvMode}
              showPhoneQr={tvMode && !socket.chatElsewhere}
              onClose={closeChat}
              onEnd={() => void endParty()}
              ending={ending}
              endError={endError}
              overlayRef={overlayRef}
            />
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
                myName={myName}
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
