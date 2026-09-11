import type { DirectorGaps } from "@/lib/director-gaps";

/**
 * A director's released films that are not in the library.
 *
 * Deliberately not links. Every other poster on this site plays something, and
 * a card that looks like one but goes nowhere would teach people that posters
 * sometimes lie. These are dimmed instead, and the heading says what they are.
 */
export function MissingFilms({ gaps }: { gaps: DirectorGaps }) {
  if (gaps.missing.length === 0) return null;

  return (
    <section className="row" aria-label="Not in the library">
      <h2>
        Not in the library
        <span className="row-count">
          {" "}
          {gaps.owned} of their {gaps.total} films are here
        </span>
      </h2>
      <div className="row-scroll">
        {gaps.missing.map((film) => (
          <div key={film.tmdbId} className="poster poster--missing">
            <div className="poster-art">
              {film.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={film.posterUrl} alt="" loading="lazy" decoding="async" />
              ) : (
                <div className="fallback">{film.title}</div>
              )}
            </div>
            <div className="poster-title">{film.title}</div>
            {film.year ? <div className="poster-sub">{film.year}</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
