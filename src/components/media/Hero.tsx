import Link from "next/link";

import {
  backdropUrl,
  formatRuntime,
  resumeSeconds,
  type MediaItem,
} from "@/lib/media";

/** Featured title at the top of the home page. */
export function Hero({ item }: { item: MediaItem }) {
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
          {item.CommunityRating ? (
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
            href={`/watch/${item.Id}${resume > 0 ? `?t=${resume}` : ""}`}
          >
            ▶ {resume > 0 ? "Resume" : "Play"}
          </Link>
          <Link className="btn ghost" href={`/item/${item.Id}`}>
            More info
          </Link>
        </div>
      </div>
    </section>
  );
}
