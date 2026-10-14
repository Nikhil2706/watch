"use client";

import { useEffect, useRef, useState } from "react";

import { PartyChatPanel } from "./PartyChatPanel";
import { PartyGuestLinksPanel, type PartyGuestLinkView } from "./PartyGuestLinksPanel";
import { PartyPeopleList } from "./PartyPeopleList";
import type { usePartySocket } from "./usePartySocket";

export type PartyOverlayTab = "chat" | "people" | "invite";

/**
 * The party's panel on a TV or a phone, opened from "Chat" beside "‹ Back"
 * and laid over the film. The docked desktop panel stacked chat, guest
 * links and End in one column; on a phone the guest links pushed the
 * conversation down to nothing, and on a TV the conversation got a third
 * of the panel. Here each gets a tab:
 *
 *  - Chat: the conversation, full height, the message box pinned at the
 *    bottom. On a TV the QR code that moves the chat to a phone sits
 *    above it, always in view: nobody types with a remote, so the phone is
 *    how a TV joins in, and a button to find first would only be in the way.
 *  - People: who is here, how far behind, who controls playback. The host
 *    gives and takes control with a plain button per person, and ends the
 *    party at the bottom (confirmed on screen: a browser confirm() is
 *    unreliable in the TV app's WebView).
 *  - Invite (host only): guest links.
 */
export function PartyOverlay({
  roomId,
  socket,
  isCreator,
  myName,
  guestLinks,
  tab,
  onTab,
  unread,
  tvMode,
  showPhoneQr,
  onClose,
  onEnd,
  ending,
  endError,
  overlayRef,
}: {
  roomId: string;
  socket: ReturnType<typeof usePartySocket>;
  isCreator: boolean;
  myName?: string;
  guestLinks: PartyGuestLinkView[];
  tab: PartyOverlayTab;
  onTab: (tab: PartyOverlayTab) => void;
  unread: number;
  tvMode: boolean;
  /** TV, until this viewer's phone has opened the chat: then the QR has done its job. */
  showPhoneQr: boolean;
  onClose: () => void;
  /** Ends the party; the confirmation has already been given on screen. */
  onEnd: () => void;
  ending: boolean;
  endError: string | null;
  overlayRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tabs: { id: PartyOverlayTab; label: string; count?: number }[] = [
    { id: "chat", label: "Chat", count: tab === "chat" ? 0 : unread },
    { id: "people", label: "People", count: socket.participants.length },
    ...(isCreator ? [{ id: "invite" as const, label: "Invite" }] : []),
  ];

  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Asking "end it?" puts focus on Cancel: OK pressed twice by accident on a
  // remote must not end everyone's film.
  useEffect(() => {
    if (confirmingEnd) cancelRef.current?.focus();
  }, [confirmingEnd]);
  useEffect(() => {
    if (tab !== "people") setConfirmingEnd(false);
  }, [tab]);

  return (
    <div className="party-chat-overlay" ref={overlayRef} role="dialog" aria-label="Watch party">
      <div className="party-sheet-handle" aria-hidden="true" />
      <div className="party-overlay-bar">
        <div className="party-overlay-tabs" role="tablist" aria-label="Watch party">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "party-overlay-tab is-active" : "party-overlay-tab"}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {t.count ? (
                <span className={t.id === "chat" ? "party-unread" : "party-overlay-count"}>{t.count > 99 ? "99+" : t.count}</span>
              ) : null}
            </button>
          ))}
        </div>
        <button type="button" className="party-overlay-close" aria-label="Close" onClick={onClose}>
          {tvMode ? "Close" : "✕"}
        </button>
      </div>

      <div className="party-overlay-body" role="tabpanel">
        {/* All three stay mounted, only one shown: switching tabs must not
            drop a half-typed message, the chat's scroll, or guest links made
            since the page loaded (the panel keeps them in its own state). */}
        <div className="party-overlay-pane party-overlay-chat" hidden={tab !== "chat"}>
            {showPhoneQr ? (
              <div className="party-tv-qr">
                {/* eslint-disable-next-line @next/next/no-img-element -- an SVG route, not an optimisable asset */}
                <img src={`/api/party/${roomId}/chat-qr`} alt="QR code that opens this chat on a phone" />
                <div>
                  <strong>Chat from your phone</strong>
                  <p>Scan this with a phone that&apos;s signed in. The film keeps playing here.</p>
                </div>
              </div>
            ) : null}
            <PartyChatPanel roomId={roomId} isCreator={isCreator} socket={socket} myName={myName} variant="overlay" />
        </div>

        <div className="party-overlay-pane party-overlay-scroll" hidden={tab !== "people"}>
            <PartyPeopleList
              participants={socket.participants}
              selfId={socket.selfId}
              isCreator={isCreator}
              grant={socket.grant}
              revoke={socket.revoke}
            />
            {isCreator && !socket.ended ? (
              <div className="party-overlay-end">
                {confirmingEnd ? (
                  <div className="party-end-confirm" role="alertdialog" aria-label="End the watch party?">
                    <p>End the watch party for everyone? The film stops on every screen.</p>
                    <div className="party-end-confirm-actions">
                      <button ref={cancelRef} type="button" className="party-end-cancel" onClick={() => setConfirmingEnd(false)}>
                        Cancel
                      </button>
                      <button type="button" className="party-end-btn" onClick={onEnd} disabled={ending}>
                        {ending ? "Ending…" : "End it"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="party-end-btn" onClick={() => setConfirmingEnd(true)}>
                    End watch party
                  </button>
                )}
                {endError ? (
                  <p className="error" role="alert">
                    {endError}
                  </p>
                ) : null}
              </div>
            ) : null}
        </div>

        {isCreator ? (
          <div className="party-overlay-pane party-overlay-scroll" hidden={tab !== "invite"}>
            <PartyGuestLinksPanel roomId={roomId} initialLinks={guestLinks} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
