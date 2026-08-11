import type { Ratings } from "@/lib/ratings";

/**
 * Ratings strip on the detail page.
 *
 * Letterboxd is absent on purpose: it publishes no API, and the only way to get
 * a number would be scraping their pages — fragile and against their terms. A
 * missing source is more honest than one that quietly goes wrong.
 */
export function RatingsRow({
  ratings,
  community,
}: {
  ratings: Ratings | null;
  /** Jellyfin's own (TMDB) score, always available. */
  community?: number;
}) {
  const cells: Array<{ source: string; value: string; note?: string }> = [];

  if (ratings?.imdb) {
    cells.push({
      source: "IMDb",
      value: `${ratings.imdb}/10`,
      note: ratings.imdbVotes ? `${ratings.imdbVotes} votes` : undefined,
    });
  }
  if (ratings?.rotten) {
    cells.push({ source: "Rotten Tomatoes", value: ratings.rotten });
  }
  if (ratings?.metacritic) {
    cells.push({ source: "Metacritic", value: `${ratings.metacritic}/100` });
  }
  if (typeof community === "number") {
    cells.push({ source: "TMDB", value: `${community.toFixed(1)}/10` });
  }

  if (cells.length === 0) return null;

  return (
    <>
      <h3>Ratings</h3>
      <div className="ratings">
        {cells.map((cell) => (
          <div className="rating" key={cell.source}>
            <div className="rating-value">{cell.value}</div>
            <div className="rating-source">{cell.source}</div>
            {cell.note ? <div className="rating-note">{cell.note}</div> : null}
          </div>
        ))}
      </div>
      {!ratings ? (
        <p className="hint" style={{ marginTop: 8 }}>
          IMDb, Rotten Tomatoes and Metacritic appear once OMDB_API_KEY is set.
        </p>
      ) : null}
    </>
  );
}
