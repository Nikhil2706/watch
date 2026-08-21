import Link from "next/link";

import type { PartyRoom } from "@/lib/party";

function scheduledLabel(ms: number): string {
  const diffMin = Math.round((ms - Date.now()) / 60000);
  if (diffMin < 60) return `in ${Math.max(1, diffMin)}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `in ${diffHr}h`;
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** Home page banner for watch parties — live now, or coming up. Nothing to show most of the time, so this renders nothing at all when both lists are empty rather than an empty section. */
export function PartyBanner({ live, upcoming }: { live: PartyRoom[]; upcoming: PartyRoom[] }) {
  if (live.length === 0 && upcoming.length === 0) return null;

  return (
    <section className="party-banner" aria-label="Watch parties">
      {live.map((room) => (
        <Link key={room.id} href={`/party/${room.id}`} className="party-banner-row party-banner-live">
          <span className="party-banner-dot" aria-hidden="true" />
          Watch party live now: <b>{room.filmTitle}</b> — join in
        </Link>
      ))}
      {upcoming.map((room) => (
        <Link key={room.id} href={`/party/${room.id}`} className="party-banner-row">
          Watch party for <b>{room.filmTitle}</b> {scheduledLabel(room.scheduledAt!)}
        </Link>
      ))}
    </section>
  );
}
