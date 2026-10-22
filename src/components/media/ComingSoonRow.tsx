import Link from "next/link";

import { whenLabel, type ComingSoonEntry } from "@/lib/coming-soon-list";

/**
 * Home's Coming soon: announced titles and scheduled releases (coming-soon.ts),
 * soonest first. Drawn like a poster row, but these aren't library items yet,
 * so the cards are their own: poster, title, when, and what.
 */
export function ComingSoonRow({ entries, now }: { entries: readonly ComingSoonEntry[]; now: number }) {
  if (!entries.length) return null;
  return (
    <section className="row coming-soon-row" aria-label="Coming soon">
      <h2>
        <Link href="/coming-soon" className="row-title-link">
          Coming soon <span aria-hidden="true">›</span>
        </Link>
      </h2>
      <div className="row-scroll">
        {entries.map((e) => (
          <div key={e.key} className="poster">
            <Link href={e.href} className="poster-link">
              <div className="poster-art">
                {e.posterSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.posterSrc} alt="" loading="lazy" decoding="async" />
                ) : (
                  <div className="fallback">{e.title}</div>
                )}
                <span className="coming-when">{whenLabel(e.at, now)}</span>
              </div>
              <div className="poster-title">{e.title}</div>
              {e.detail ? <div className="poster-badge">{e.detail}</div> : null}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
