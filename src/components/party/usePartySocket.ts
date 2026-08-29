"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  kind: "user" | "guest";
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

export interface PartySyncEvent {
  action: "play" | "pause" | "seek";
  positionSeconds: number;
  by: string;
}

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Three failures is enough to stop pretending it is a blip and tell the user. */
const ATTEMPTS_BEFORE_UNREACHABLE = 3;

export function usePartySocket(roomId: string) {
  const [connected, setConnected] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [messages, setMessages] = useState<PartyChatMessage[]>([]);
  const [participants, setParticipants] = useState<PartyParticipant[]>([]);
  const [initialState, setInitialState] = useState<{ positionSeconds: number; paused: boolean } | null>(null);
  const [lastSync, setLastSync] = useState<PartySyncEvent | null>(null);
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

      const source = new EventSource(`/api/party/${encodeURIComponent(roomId)}/events`);
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
            break;
          case "chat":
            setMessages((prev) => [...prev, msg.message as PartyChatMessage]);
            break;
          case "participants":
            setParticipants((msg.list as PartyParticipant[]) ?? []);
            break;
          case "state":
            setInitialState({ positionSeconds: Number(msg.positionSeconds), paused: Boolean(msg.paused) });
            break;
          case "sync":
            setLastSync({
              action: msg.action as PartySyncEvent["action"],
              positionSeconds: Number(msg.positionSeconds),
              by: String(msg.by),
            });
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
  }, [roomId]);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        const response = await fetch(`/api/party/${encodeURIComponent(roomId)}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (response.status === 410) {
          endedRef.current = true;
          setEnded(true);
        }
        return response.ok;
      } catch {
        return false;
      }
    },
    [roomId],
  );

  const sendChat = useCallback((body: string) => void post({ type: "chat", body }), [post]);
  const sendSync = useCallback(
    (action: "play" | "pause" | "seek", positionSeconds: number) =>
      void post({ type: "sync", action, positionSeconds }),
    [post],
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
    participants,
    initialState,
    lastSync,
    ended,
    sendChat,
    sendSync,
    grant,
    revoke,
    end,
  };
}
