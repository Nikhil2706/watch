import Link from "next/link";

import {
  backdropUrl,
  formatRuntime,
  resumeSeconds,
  type MediaItem,
} from "@/lib/media";
import { itemHref, watchHref } from "@/lib/slugs";

/**
 * Featured title at the top of the home page.
 *
 * `imdb` is passed in rather than fetched here: ratings come from OMDb, which
 * is a server-side, rate-limited lookup, and the page already knows which item
 * is featured before this renders.
 */
export function Hero({ item, imdb }: { item: MediaItem; imdb?: string | null }) {
  const backdrop = backdropUrl(item, 1600);
  const runtime = formatRuntime(item.RunTimeTicks);
  const resume = resumeSeconds(item);

  return (
    <section className="hero">
      {backdrop ? (
        <div
          className="hero-bg"
          style={{ backgroundImage: `url("${backdrop}")` }}
          aria-hidden="true"
        />
      ) : null}

      <div className="hero-content">
        <h1>{item.Name}</h1>

        <div className="meta">
          {item.ProductionYear ? <span>{item.ProductionYear}</span> : null}
          {runtime ? <span>{runtime}</span> : null}
          {item.OfficialRating ? (
            <span className="chip">{item.OfficialRating}</span>
          ) : null}
          {/* IMDb leads, matching the detail page; TMDB's own score only
              stands in when the film has no IMDb id. */}
          {imdb ? (
            <span className="meta-rating">
              <span className="mark mark-imdb">IMDb</span>
              {imdb}
            </span>
          ) : item.CommunityRating ? (
            <span>★ {item.CommunityRating.toFixed(1)}</span>
          ) : null}
          {(item.Genres ?? []).slice(0, 3).map((g) => (
            <span key={g} className="chip">
              {g}
            </span>
          ))}
        </div>

        {item.Overview ? <p>{item.Overview}</p> : null}

        <div className="btn-row">
          <Link
            className="btn"
            data-tv-autofocus="true"
            href={watchHref(item.Id, item.Name, item.ProductionYear, resume)}
          >
            ▶ {resume > 0 ? "Resume" : "Play"}
          </Link>
          <Link className="btn ghost" href={itemHref(item.Id, item.Name, item.ProductionYear)}>
            More info
          </Link>
        </div>
      </div>
    </section>
  );
}
