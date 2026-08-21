"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client side of scripts/party-server.mts's protocol — see that file's own
 * header comment for the full message shapes. Kept in sync by hand rather
 * than a shared import: the server is a standalone process outside the
 * Next.js build entirely (see DESIGN-watch-party.md), so there's no module
 * boundary that could import a shared type from here anyway.
 *
 * Connects to a same-origin path (NEXT_PUBLIC_PARTY_WS_PATH, default
 * "/ws/party") rather than a full URL — production routes that path to the
 * separate `party` container at the edge (cloudflared ingress or an
 * equivalent reverse-proxy rule), same public hostname as everything else.
 * That routing isn't wired up yet (see docker-compose.yml's `party` service
 * comment) — this will simply fail to connect until it is, same as any
 * other not-yet-deployed piece of this feature.
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

const WS_PATH = process.env.NEXT_PUBLIC_PARTY_WS_PATH ?? "/ws/party";
const RECONNECT_DELAY_MS = 2000;

export function usePartySocket(roomId: string) {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<PartyChatMessage[]>([]);
  const [participants, setParticipants] = useState<PartyParticipant[]>([]);
  const [initialState, setInitialState] = useState<{ positionSeconds: number; paused: boolean } | null>(null);
  const [lastSync, setLastSync] = useState<PartySyncEvent | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);

  useEffect(() => {
    closedByUs.current = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}?room=${encodeURIComponent(roomId)}`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);

      socket.onclose = () => {
        setConnected(false);
        if (!closedByUs.current) {
          reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      socket.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
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
        }
      };
    }

    connect();

    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      socketRef.current?.close();
    };
  }, [roomId]);

  const sendChat = useCallback((body: string) => {
    socketRef.current?.send(JSON.stringify({ type: "chat", body }));
  }, []);

  const sendSync = useCallback((action: "play" | "pause" | "seek", positionSeconds: number) => {
    socketRef.current?.send(JSON.stringify({ type: "sync", action, positionSeconds }));
  }, []);

  const grant = useCallback((targetId: string) => {
    socketRef.current?.send(JSON.stringify({ type: "grant", targetId }));
  }, []);

  const revoke = useCallback((targetId: string) => {
    socketRef.current?.send(JSON.stringify({ type: "revoke", targetId }));
  }, []);

  return { connected, messages, participants, initialState, lastSync, sendChat, sendSync, grant, revoke };
}
