import type { Ratings } from "@/lib/ratings";

/**
 * Ratings strip on the detail page.
 *
 * Each source gets its own mark and brand colour so the row is scannable —
 * previously they were four identical grey boxes and you had to read every
 * label to find the one you trusted.
 *
 * Rotten Tomatoes and Metacritic are additionally colour-coded by their own
 * published conventions (RT: fresh at 60%+, Metacritic: green at 61+, yellow
 * 40-60, red below), which carries real information rather than decoration.
 *
 * Letterboxd is absent on purpose: it publishes no API, and the only way to get
 * a number would be scraping their pages — fragile and against their terms.
 */

type Tone = "good" | "mixed" | "bad" | "neutral";

function rottenTone(value: string): Tone {
  const pct = Number.parseInt(value, 10);
  if (!Number.isFinite(pct)) return "neutral";
  return pct >= 60 ? "good" : "bad";
}

function metacriticTone(value: string): Tone {
  const score = Number.parseInt(value, 10);
  if (!Number.isFinite(score)) return "neutral";
  if (score >= 61) return "good";
  if (score >= 40) return "mixed";
  return "bad";
}

/** Small inline marks — no external assets, so nothing to load or block. */
function Mark({ source }: { source: string }) {
  switch (source) {
    case "IMDb":
      return <span className="mark mark-imdb">IMDb</span>;
    case "Rotten Tomatoes":
      return (
        <span className="mark mark-rt" aria-hidden="true">
          🍅
        </span>
      );
    case "Metacritic":
      return (
        <span className="mark mark-mc" aria-hidden="true">
          M
        </span>
      );
    default:
      return (
        <span className="mark mark-tmdb" aria-hidden="true">
          ★
        </span>
      );
  }
}

export function RatingsRow({
  ratings,
  community,
}: {
  ratings: Ratings | null;
  /** Jellyfin's own (TMDB) score, always available. */
  community?: number;
}) {
  const cells: Array<{
    source: string;
    value: string;
    note?: string;
    tone: Tone;
    /** Rendered larger and brand-marked — one score leads, the rest support. */
    primary?: boolean;
  }> = [];

  if (ratings?.imdb) {
    cells.push({
      source: "IMDb",
      value: `${ratings.imdb}`,
      note: ratings.imdbVotes ? `${ratings.imdbVotes} votes` : "out of 10",
      tone: "neutral",
      primary: true,
    });
  }
  if (ratings?.rotten) {
    cells.push({
      source: "Rotten Tomatoes",
      value: ratings.rotten,
      note: rottenTone(ratings.rotten) === "good" ? "Fresh" : "Rotten",
      tone: rottenTone(ratings.rotten),
    });
  }
  if (ratings?.metacritic) {
    cells.push({
      source: "Metacritic",
      value: ratings.metacritic,
      note: "out of 100",
      tone: metacriticTone(ratings.metacritic),
    });
  }
  if (typeof community === "number") {
    cells.push({
      source: "TMDB",
      value: community.toFixed(1),
      note: "out of 10",
      tone: "neutral",
    });
  }

  if (cells.length === 0) return null;

  return (
    <>
      <h3>Ratings</h3>
      <div className="ratings">
        {cells.map((cell) => (
          <div
            className={`rating tone-${cell.tone}${cell.primary ? " rating-primary" : ""}`}
            key={cell.source}
          >
            <div className="rating-head">
              <Mark source={cell.source} />
              <span className="rating-source">{cell.source}</span>
            </div>
            <div className="rating-value">{cell.value}</div>
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
