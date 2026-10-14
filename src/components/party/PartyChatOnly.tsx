"use client";

import { PartyChatPanel } from "./PartyChatPanel";
import { usePartySocket } from "./usePartySocket";

/** Chat with no player attached — the guest branch of /party/[roomId], and the whole of /party/[roomId]/chat (the second-tab/QR/phone access path). */
export function PartyChatOnly({ roomId, isCreator, myName }: { roomId: string; isCreator: boolean; myName?: string }) {
  const socket = usePartySocket(roomId);
  return <PartyChatPanel roomId={roomId} isCreator={isCreator} socket={socket} myName={myName} />;
}
