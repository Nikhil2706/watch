"use client";

import { useTvMode } from "@/components/tv/TvProvider";

/** A piece of writing to offer when something ends (readingFor in articles.ts), with its QR code for a TV. */
export interface ReadingItem {
  title: string;
  url: string;
  source: string;
  /** An SVG QR code of the article's address. */
  qrSvg: string | null;
}

/**
 * "Read more" when a film or an episode ends: the critics' writing about it
 * (The Ringer, Bright Wall/Dark Room, Reverse Shot…), never Wikipedia or a
 * year-end list.
 *
 * Links on a computer or a phone, opened in a new tab so the player stays. A
 * TV has no business opening a magazine with a remote, so there each piece is
 * a QR code to scan with a phone, captioned with its title and source; none
 * of it takes focus, so the remote stays on the buttons around it.
 */
export function EndReading({ reading, heading }: { reading: ReadingItem[]; heading: string }) {
  const tvMode = useTvMode();
  if (reading.length === 0) return null;
  return (
    <section className="end-reading" aria-label={heading}>
      <h3>{heading}</h3>
      {tvMode ? (
        <ul className="end-reading-qrs">
          {reading
            .filter((r) => r.qrSvg)
            .map((r) => (
              <li key={r.url}>
                <div className="end-reading-qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: r.qrSvg! }} />
                <span className="end-reading-title">{r.title}</span>
                <span className="end-reading-source">{r.source}</span>
              </li>
            ))}
        </ul>
      ) : (
        <ul className="end-reading-links">
          {reading.map((r) => (
            <li key={r.url}>
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                {r.title}
              </a>
              <span className="end-reading-source"> · {r.source}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
