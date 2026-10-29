import Link from "next/link";

import type { GuideChannel } from "@/lib/live-guide";

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Home's "On now": each channel with what it is showing (live-guide.ts). A
 * card tunes in; the heading opens the full guide.
 */
export function OnNowRow({ channels }: { channels: GuideChannel[] }) {
  if (channels.length === 0) return null;
  return (
    <section className="row on-now" aria-label="On now">
      <h2>
        <Link href="/live" className="row-title-link">
          On now <span aria-hidden="true">›</span>
        </Link>
      </h2>
      <div className="row-scroll">
        {channels.map((c) => (
          <Link key={c.id} href={`/live/${encodeURIComponent(c.id)}`} className="on-now-tile">
            <span className="on-now-art">
              {c.art ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.art} alt="" loading="lazy" />
              ) : null}
              <span className="on-now-live">
                <span className="live-dot" aria-hidden="true" /> {c.name}
              </span>
            </span>
            <span className="on-now-title">{c.nowTitle}</span>
            <span className="hint">until {clock(c.now.endsAtMs)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
