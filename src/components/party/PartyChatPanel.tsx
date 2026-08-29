"use client";

import { useEffect, useRef, useState } from "react";

import { usePartySocket } from "./usePartySocket";

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The chat side of a watch party — usable standalone (the QR/second-tab
 * access path, /party/[roomId]/chat) or embedded next to the player
 * (/party/[roomId]). Playback sync is NOT handled here even when a
 * <Player> is on the same page — that wiring lives in PartyPlayerSync
 * (src/components/party/PartyPlayerSync.tsx), which shares this same
 * socket's sendSync/lastSync via the caller composing both around one
 * usePartySocket call, so a page using both doesn't open two connections.
 */
export function PartyChatPanel({
  roomId,
  isCreator,
  socket,
}: {
  roomId: string;
  isCreator: boolean;
  socket: ReturnType<typeof usePartySocket>;
}) {
  const { connected, messages, participants, sendChat, grant, revoke } = socket;
  const [draft, setDraft] = useState("");
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    sendChat(body);
    setDraft("");
  }

  return (
    <div className="party-chat">
      <div className="party-participants">
        {participants.map((p) => (
          <div key={p.id} className="party-participant">
            <span className={p.kind === "guest" ? "party-name party-name-guest" : "party-name"}>{p.displayName}</span>
            {p.isController ? <span className="party-controller-badge" title="Can control playback">▶</span> : null}
            {isCreator ? (
              <div className="party-participant-menu">
                <button
                  type="button"
                  className="party-menu-btn"
                  aria-label={`Options for ${p.displayName}`}
                  onClick={() => setOpenMenuFor(openMenuFor === p.id ? null : p.id)}
                >
                  ⋮
                </button>
                {openMenuFor === p.id ? (
                  <div className="party-menu-dropdown">
                    {p.isController ? (
                      <button type="button" onClick={() => { revoke(p.id); setOpenMenuFor(null); }}>
                        Remove playback control
                      </button>
                    ) : (
                      <button type="button" onClick={() => { grant(p.id); setOpenMenuFor(null); }}>
                        Grant playback control
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {!connected ? <span className="party-status">Reconnecting…</span> : null}
      </div>

      <div className="party-messages" ref={scrollRef}>
        {messages.length === 0 ? <p className="party-empty">No messages yet — say hello.</p> : null}
        {messages.map((m) => (
          <div key={m.id} className="party-message">
            <span className={m.kind === "guest" ? "party-name party-name-guest" : "party-name"}>{m.displayName}</span>
            <span className="party-message-body">{m.body}</span>
            <span className="party-message-time">{timeLabel(m.createdAt)}</span>
          </div>
        ))}
      </div>

      {/* The composer is disabled while the socket is down. sendChat() writes
          straight to the WebSocket, so an enabled box with no connection
          accepts a message, clears the field, and drops it on the floor with
          no error — the user believes they said something they did not. */}
      <form className="party-composer" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={connected ? "Say something…" : "Chat is offline"}
          maxLength={1000}
          disabled={!connected}
        />
        <button type="submit" disabled={!connected || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
