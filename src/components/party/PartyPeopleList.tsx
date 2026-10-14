"use client";

import type { PartyParticipant } from "./usePartySocket";

/**
 * Who is here, as large rows, for the TV and phone overlay. The docked
 * desktop panel keeps its compact chips and ⋮ menu. A small menu behind ⋮
 * is fiddly with a remote and with a thumb, so the host gets a plain button
 * per person instead.
 */
export function PartyPeopleList({
  participants,
  selfId,
  isCreator,
  grant,
  revoke,
}: {
  participants: PartyParticipant[];
  selfId: string | null;
  isCreator: boolean;
  grant: (id: string) => void;
  revoke: (id: string) => void;
}) {
  return (
    <ul className="party-people">
      {participants.map((p) => {
        const you = p.id === selfId;
        const drift =
          p.driftSeconds !== null && Math.abs(p.driftSeconds) >= 0.5
            ? `${Math.abs(p.driftSeconds).toFixed(1)} s ${p.driftSeconds < 0 ? "behind" : "ahead"}`
            : null;
        return (
          <li key={p.id} className="party-person">
            <div className="party-person-text">
              <span className={p.kind === "guest" ? "party-person-name party-name-guest" : "party-person-name"}>
                {p.displayName}
                {you ? <span className="party-person-you"> (you)</span> : null}
              </span>
              <span className="party-person-status">
                {p.isController
                  ? p.inheritedControl
                    ? "Controls playback · took over when the host left"
                    : "Controls playback"
                  : p.kind === "guest"
                    ? "Guest · chat only"
                    : "Watching"}
                {drift ? <span className="party-drift"> · {drift}</span> : null}
              </span>
            </div>
            {/* The host always has control, so there is nothing to give or take there. */}
            {isCreator && !you ? (
              p.isController ? (
                <button type="button" className="party-person-action" onClick={() => revoke(p.id)}>
                  Take back control
                </button>
              ) : (
                <button type="button" className="party-person-action" onClick={() => grant(p.id)}>
                  Give control
                </button>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
