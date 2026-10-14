"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { bestOffset, clockSample, type ClockSample } from "@/lib/party-sync";

/**
 * Client side of the watch-party realtime protocol.
 *
 * Was a WebSocket to `/ws/party`, served by scripts/party-server.mts. That
 * path was never routed: production fronts this app with a remotely managed
 * Cloudflare tunnel whose ingress lives in the Cloudflare dashboard, so the
 * route could not be added from the codebase and every party silently did
 * nothing — chat that never sent, sync that never synced, a room that looked
 * completely normal.
 *
 * Now: an SSE stream down (`GET /api/party/{roomId}/events`) and plain POSTs
 * up (`POST /api/party/{roomId}/send`), both ordinary HTTP to the same origin
 * the tunnel already serves. The name `usePartySocket` is kept because it is
 * still exactly one live connection per room and every caller's usage is
 * unchanged.
 *
 * Server logic lives in src/lib/party-bus.ts (in the gate process now, not a
 * separate service).
 */

export interface PartyChatMessage {
  id: string;
  /** "system": the room's own lines (who paused, who jumped); not kept after a reload. */
  kind: "user" | "guest" | "system";
  displayName: string;
  body: string;
  createdAt: number;
}

export interface PartyParticipant {
  id: string;
  kind: "user" | "guest";
  displayName: string;
  isController: boolean;
}

/** Positions are stamped with the server time they were true at (`at`); see party-sync.ts. */
export interface PartySyncEvent {
  action: "play" | "pause" | "seek";
  positionSeconds: number;
  /** The room's play state after the action (a seek keeps whatever it was). */
  paused: boolean;
  at: number;
  by: string;
}

/** Round trips used for the clock estimate: a few on connecting, then one now and then. */
const CLOCK_PINGS_ON_CONNECT = 3;
const CLOCK_PING_INTERVAL_MS = 30_000;
const CLOCK_SAMPLES_KEPT = 8;

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Three failures is enough to stop pretending it is a blip and tell the user. */
const ATTEMPTS_BEFORE_UNREACHABLE = 3;

/** One per open stream, so the room can tell this tab apart from the same account's other screens. */
function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** `watching`: this page has the film open (the room page), not only the chat. */
export function usePartySocket(roomId: string, { watching = false }: { watching?: boolean } = {}) {
  const [clientId] = useState(newClientId);
  const [connected, setConnected] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [messages, setMessages] = useState<PartyChatMessage[]>([]);
  /** The room's chat history has arrived at least once (so an unread count has a baseline). */
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [participants, setParticipants] = useState<PartyParticipant[]>([]);
  const [initialState, setInitialState] = useState<{ positionSeconds: number; paused: boolean; at: number } | null>(null);
  const [lastSync, setLastSync] = useState<PartySyncEvent | null>(null);
  /** The lead controller's heartbeat while playing — a fresh object every time, so an effect on it re-runs. */
  const [lastPosition, setLastPosition] = useState<{ positionSeconds: number; at: number } | null>(null);
  /** The stream that sends heartbeats, as the server last named it. */
  const [leaderClientId, setLeaderClientId] = useState<string | null>(null);

  /**
   * Server time ≈ Date.now() + offset, from the quickest recent round trip.
   * Every sync, heartbeat and ping reply carries the server's time.
   */
  const clockSamples = useRef<ClockSample[]>([]);
  const serverNow = useCallback(() => Date.now() + bestOffset(clockSamples.current), []);
  const [ended, setEnded] = useState(false);

  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);
  const endedRef = useRef(false);
  const attempts = useRef(0);

  useEffect(() => {
    closedByUs.current = false;
    endedRef.current = false;

    function connect() {
      if (closedByUs.current || endedRef.current) return;

      const source = new EventSource(
        `/api/party/${encodeURIComponent(roomId)}/events?cid=${encodeURIComponent(clientId)}${watching ? "&player=1" : ""}`,
      );
      sourceRef.current = source;

      source.addEventListener("ready", () => {
        setConnected(true);
        setUnreachable(false);
        attempts.current = 0;
      });

      source.addEventListener("party", (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse((event as MessageEvent).data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "history":
            setMessages((msg.messages as PartyChatMessage[]) ?? []);
            setHistoryLoaded(true);
            break;
          case "chat":
            setMessages((prev) => [...prev, msg.message as PartyChatMessage]);
            break;
          case "participants":
            setParticipants((msg.list as PartyParticipant[]) ?? []);
            break;
          case "state":
            setInitialState({
              positionSeconds: Number(msg.positionSeconds),
              paused: Boolean(msg.paused),
              at: Number(msg.at),
            });
            break;
          case "sync":
            setLastSync({
              action: msg.action as PartySyncEvent["action"],
              positionSeconds: Number(msg.positionSeconds),
              paused: Boolean(msg.paused),
              at: Number(msg.at),
              by: String(msg.by),
            });
            break;
          case "position":
            setLastPosition({ positionSeconds: Number(msg.positionSeconds), at: Number(msg.at) });
            break;
          case "leader":
            setLeaderClientId(typeof msg.clientId === "string" ? msg.clientId : null);
            break;
          case "ended":
            endedRef.current = true;
            setEnded(true);
            setConnected(false);
            source.close();
            sourceRef.current = null;
            break;
        }
      });

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        setConnected(false);
        if (closedByUs.current || endedRef.current) return;

        attempts.current += 1;
        if (attempts.current >= ATTEMPTS_BEFORE_UNREACHABLE) setUnreachable(true);

        // Exponential backoff, capped. EventSource does not expose the HTTP
        // status, so a room that ended between reconnects looks the same as a
        // network blip from here — the /events route answers 410 for an ended
        // room, and the check below turns that into a proper "ended" state
        // rather than an endless retry.
        void fetch(`/api/party/${encodeURIComponent(roomId)}/events`, { method: "HEAD" })
          .then((r) => {
            if (r.status === 410) {
              endedRef.current = true;
              setEnded(true);
              return;
            }
            scheduleRetry();
          })
          .catch(scheduleRetry);
      };
    }

    function scheduleRetry() {
      if (closedByUs.current || endedRef.current) return;
      const delay = Math.min(
        RECONNECT_DELAY_MS * 2 ** Math.min(attempts.current - 1, 4),
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectTimer.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [roomId, clientId, watching]);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        const sentAt = Date.now();
        const response = await fetch(`/api/party/${encodeURIComponent(roomId)}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const receivedAt = Date.now();
        if (response.status === 410) {
          endedRef.current = true;
          setEnded(true);
        }
        if (response.ok) {
          const data = (await response.json().catch(() => null)) as { serverTime?: unknown } | null;
          if (typeof data?.serverTime === "number") {
            clockSamples.current = [
              ...clockSamples.current,
              clockSample(sentAt, data.serverTime, receivedAt),
            ].slice(-CLOCK_SAMPLES_KEPT);
          }
        }
        return response.ok;
      } catch {
        return false;
      }
    },
    [roomId],
  );

  // A few round trips as soon as the stream is up, then one every so often:
  // non-controllers send nothing else, and still need to know the server's time.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < CLOCK_PINGS_ON_CONNECT; i++) {
      timers.push(setTimeout(() => !cancelled && void post({ type: "ping" }), i * 400));
    }
    const interval = setInterval(() => void post({ type: "ping" }), CLOCK_PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, [connected, post]);

  const sendChat = useCallback((body: string) => void post({ type: "chat", body }), [post]);
  // sentAt: when the position was read, by the server's clock, so the time
  // the request spends travelling is not counted against it.
  const sendSync = useCallback(
    (action: "play" | "pause" | "seek", positionSeconds: number) =>
      void post({ type: "sync", action, positionSeconds, sentAt: serverNow(), clientId }),
    [post, clientId, serverNow],
  );
  const sendPosition = useCallback(
    (positionSeconds: number) => void post({ type: "position", positionSeconds, sentAt: serverNow(), clientId }),
    [post, clientId, serverNow],
  );
  const grant = useCallback((targetId: string) => void post({ type: "grant", targetId }), [post]);
  const revoke = useCallback((targetId: string) => void post({ type: "revoke", targetId }), [post]);

  /**
   * Ending is a room state change, not a message, and lives on its own route
   * so it keeps working with no stream open. PartyRoomClient calls that route
   * directly; this stays for callers that had it, and just marks the local
   * view as over.
   */
  const end = useCallback(() => {
    endedRef.current = true;
    setEnded(true);
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  return {
    connected,
    unreachable,
    messages,
    historyLoaded,
    participants,
    initialState,
    lastSync,
    lastPosition,
    leaderClientId,
    clientId,
    serverNow,
    ended,
    sendChat,
    sendSync,
    sendPosition,
    grant,
    revoke,
    end,
  };
}
