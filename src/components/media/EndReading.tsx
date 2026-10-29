"use client";

import { useTvMode } from "@/components/tv/TvProvider";

/** A piece of writing to offer when something ends (readingFor in articles.ts), with its QR code for a TV. */
export interface ReadingItem {
  title: string;
  /** Null for an uploaded book, which has no address: it shows its passage instead. */
  url: string | null;
  source: string;
  /** A book's passage about this film or episode. */
  passage: string | null;
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
 *
 * An uploaded book has no address to open or scan: it shows the passage the
 * site already picks from it about this film, under the book's title.
 */
export function EndReading({ reading, heading }: { reading: ReadingItem[]; heading: string }) {
  const tvMode = useTvMode();
  if (reading.length === 0) return null;
  const books = reading.filter((r) => !r.url && r.passage);
  const articles = reading.filter((r) => r.url);
  return (
    <section className="end-reading" aria-label={heading}>
      <h3>{heading}</h3>
      {books.length > 0 ? (
        <ul className="end-reading-books">
          {books.map((r) => (
            <li key={r.title}>
              <blockquote>{r.passage}</blockquote>
              <span className="end-reading-source">{r.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {articles.length === 0 ? null : tvMode ? (
        <ul className="end-reading-qrs">
          {articles
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
          {articles.map((r) => (
            <li key={r.url}>
              <a href={r.url!} target="_blank" rel="noopener noreferrer">
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
