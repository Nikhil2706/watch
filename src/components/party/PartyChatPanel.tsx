"use client";

import { useEffect, useRef, useState } from "react";

import { REACTION_EMOJI } from "@/lib/party-room";

import { usePartySocket } from "./usePartySocket";

/** Closer than this is "in step" and says nothing (steering keeps followers within about 0.3 s). */
const DRIFT_SHOWN_SECONDS = 0.5;

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
  onMoveOut,
  onClose,
  myName,
  variant = "docked",
}: {
  roomId: string;
  isCreator: boolean;
  socket: ReturnType<typeof usePartySocket>;
  /**
   * Set only when this panel is docked beside a player. Called once the
   * conversation has somewhere else to live (another tab, or a phone), so the
   * room can give the whole width back to the film. Absent on
   * /party/[roomId]/chat, which IS the other place — offering to move the chat
   * out of the only thing on the page would be nonsense.
   */
  onMoveOut?: () => void;
  /** Set when this panel is the chat overlay on a TV or phone: a Close button in its header. */
  onClose?: () => void;
  /** This viewer's name, to show which reactions are theirs. */
  myName?: string;
  /**
   * "overlay": the TV/phone panel (PartyOverlay), which has its own tabs —
   * just the conversation and the message box here, no header, no people.
   */
  variant?: "docked" | "overlay";
}) {
  const overlay = variant === "overlay";
  const { connected, messages, participants, sendChat, react, grant, revoke } = socket;
  const [draft, setDraft] = useState("");
  /** The message whose react/reply menu is open. */
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  /** The message the next one sent will answer. */
  const [replyTo, setReplyTo] = useState<{ id: string; displayName: string; body: string } | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  // The reaction row opens with focus on its first emoji: on a TV, "down"
  // from "⋯" at the right edge would otherwise land on Reply, at the far end.
  useEffect(() => {
    if (actionsFor) actionsRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [actionsFor]);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    sendChat(body, replyTo?.id ?? null);
    setDraft("");
    setReplyTo(null);
  }

  function openInTab() {
    window.open(`/party/${roomId}/chat`, "_blank", "noopener,noreferrer");
    onMoveOut?.();
  }

  return (
    <div className={overlay ? "party-chat party-chat-overlay-variant" : "party-chat"}>
      {onMoveOut && !overlay ? (
        <div className="party-chat-head">
          <span className="party-chat-title">Chat</span>
          <div className="party-chat-head-actions">
            <button
              type="button"
              className="party-chat-move"
              onClick={() => setShowQr((v) => !v)}
              aria-expanded={showQr}
            >
              On my phone
            </button>
            <button type="button" className="party-chat-move party-chat-newtab" onClick={openInTab}>
              In a new tab
            </button>
            {onClose ? (
              <button type="button" className="party-chat-move party-chat-close" onClick={onClose}>
                Close
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showQr ? (
        <div className="party-chat-qr">
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG route, not an optimisable asset */}
          <img src={`/api/party/${roomId}/chat-qr`} alt="QR code that opens this party's chat" />
          <div className="party-chat-qr-side">
            <p>
              Scan this with a phone that&apos;s signed in here. The chat opens on its own, so the
              screen can play the film uninterrupted.
            </p>
            <button type="button" className="party-chat-move" onClick={() => onMoveOut?.()}>
              Done — hide chat here
            </button>
          </div>
        </div>
      ) : null}

      <div className="party-participants" hidden={overlay}>
        {participants.map((p) => (
          <div key={p.id} className="party-participant">
            <span className={p.kind === "guest" ? "party-name party-name-guest" : "party-name"}>{p.displayName}</span>
            {p.isController ? <span className="party-controller-badge" title="Can control playback">▶</span> : null}
            {p.driftSeconds !== null && Math.abs(p.driftSeconds) >= DRIFT_SHOWN_SECONDS ? (
              <span
                className="party-drift"
                title={`${p.displayName}'s film is ${Math.abs(p.driftSeconds).toFixed(1)} s ${p.driftSeconds < 0 ? "behind" : "ahead of"} the room`}
              >
                {Math.abs(p.driftSeconds).toFixed(1)} s {p.driftSeconds < 0 ? "behind" : "ahead"}
              </span>
            ) : null}
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
        {messages.map((m) =>
          m.kind === "system" ? (
            <div key={m.id} className="party-message party-message-system">
              <span className="party-message-body">{m.body}</span>
              <span className="party-message-time">{timeLabel(m.createdAt)}</span>
            </div>
          ) : (
          <div key={m.id} className="party-message">
            {m.replyTo ? (
              <span className="party-message-quote">
                ↪ {m.replyTo.displayName}: {m.replyTo.excerpt}
              </span>
            ) : null}
            <span className={m.kind === "guest" ? "party-name party-name-guest" : "party-name"}>{m.displayName}</span>
            <span className="party-message-body">{m.body}</span>
            <span className="party-message-time">{timeLabel(m.createdAt)}</span>
            {/* WatchParty's reactions and replies. A real button, so a TV remote reaches it. */}
            <button
              type="button"
              className="party-message-actions-btn"
              aria-label={`React or reply to ${m.displayName}`}
              aria-expanded={actionsFor === m.id}
              onClick={() => setActionsFor(actionsFor === m.id ? null : m.id)}
            >
              ⋯
            </button>
            {actionsFor === m.id ? (
              <div className="party-message-actions" role="group" aria-label="React or reply" ref={actionsRef}>
                {REACTION_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="party-reaction-pick"
                    aria-label={`React ${emoji}`}
                    onClick={() => {
                      react(m.id, emoji);
                      setActionsFor(null);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  type="button"
                  className="party-reply-btn"
                  onClick={() => {
                    setReplyTo({ id: m.id, displayName: m.displayName, body: m.body });
                    setActionsFor(null);
                    draftRef.current?.focus();
                  }}
                >
                  Reply
                </button>
              </div>
            ) : null}
            {m.reactions && m.reactions.length > 0 ? (
              <span className="party-reactions">
                {m.reactions.map((r) => {
                  const mine = !!myName && r.by.includes(myName);
                  return (
                    <button
                      key={r.emoji}
                      type="button"
                      className={mine ? "party-reaction party-reaction-mine" : "party-reaction"}
                      aria-pressed={mine}
                      title={r.by.join(", ")}
                      onClick={() => react(m.id, r.emoji)}
                    >
                      {r.emoji} {r.by.length}
                    </button>
                  );
                })}
              </span>
            ) : null}
          </div>
          ),
        )}
      </div>

      {/* The composer is disabled while the socket is down. sendChat() writes
          straight to the WebSocket, so an enabled box with no connection
          accepts a message, clears the field, and drops it on the floor with
          no error — the user believes they said something they did not. */}
      {replyTo ? (
        <div className="party-replying">
          <span>
            Replying to <strong>{replyTo.displayName}</strong>: {replyTo.body.length > 60 ? `${replyTo.body.slice(0, 59)}…` : replyTo.body}
          </span>
          <button type="button" aria-label="Cancel the reply" onClick={() => setReplyTo(null)}>
            ✕
          </button>
        </div>
      ) : null}
      <form className="party-composer" onSubmit={submit}>
        <input
          ref={draftRef}
          enterKeyHint="send"
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
