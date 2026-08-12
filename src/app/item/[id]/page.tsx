import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { CastRow } from "@/components/media/CastRow";
import { CuratorPicks } from "@/components/media/CuratorPicks";
import { ListButtons } from "@/components/media/ListButtons";
import { RatingsRow } from "@/components/media/RatingsRow";
import { curationsForItem } from "@/lib/curations";
import { getMemberships } from "@/lib/lists";
import { getRatings } from "@/lib/ratings";
import { listSubtitles } from "@/lib/subtitles";
import { Row } from "@/components/media/Row";
import { currentSession } from "@/lib/current-user";
import {
  backdropUrl,
  formatRuntime,
  getItem,
  getSimilar,
  qualityLabel,
  resumeSeconds,
} from "@/lib/media";

export const dynamic = "force-dynamic";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const item = await getItem(session, id);
  if (!item) notFound();

  const [similar, ratings] = await Promise.all([
    getSimilar(session, id).catch(() => []),
    // The IMDb id comes from Jellyfin, so no title matching is needed.
    getRatings(item.ProviderIds?.Imdb).catch(() => null),
  ]);
  const picks = curationsForItem(id);
  const subtitles = listSubtitles(item);
  const lists = getMemberships(session.userId, [id]).get(id);
  const backdrop = backdropUrl(item, 1600);
  const runtime = formatRuntime(item.RunTimeTicks);
  const quality = qualityLabel(item);
  const resume = resumeSeconds(item);

  const source = item.MediaSources?.[0];
  const audio = source?.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
  const directors = (item.People ?? []).filter((p) => p.Type === "Director");
  const cast = (item.People ?? []).filter((p) => p.Type === "Actor").slice(0, 20);

  return (
    <div className="detail">
      <AppBar username={session.username} />

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
            {item.OfficialRating ? <span className="chip">{item.OfficialRating}</span> : null}
            {/* IMDb is the number a film club actually argues about, so it is
                the one in the headline. TMDB's own score only stands in when
                the film has no IMDb id. Resolution and codec used to sit here
                too — they are file detail and now live in the footer line. */}
            {ratings?.imdb ? (
              <span className="meta-rating">
                <span className="mark mark-imdb">IMDb</span>
                {ratings.imdb}
              </span>
            ) : item.CommunityRating ? (
              <span>★ {item.CommunityRating.toFixed(1)}</span>
            ) : null}
          </div>
          {item.Overview ? <p>{item.Overview}</p> : null}
          <div className="btn-row">
            <ListButtons
              itemId={item.Id}
              initialFavourite={lists?.has("favourite") ?? false}
              initialRewatch={lists?.has("rewatch") ?? false}
              variant="inline"
            />
            <Link
              className="btn"
              href={`/watch/${item.Id}${resume > 0 ? `?t=${resume}` : ""}`}
            >
              ▶ {resume > 0 ? `Resume at ${Math.floor(resume / 60)}m` : "Play"}
            </Link>
            {resume > 0 ? (
              <Link className="btn ghost" href={`/watch/${item.Id}`}>
                Start over
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <div className="detail-body">
        {item.Genres?.length ? (
          <div className="chip-line">
            {item.Genres.map((g) => (
              <Link key={g} className="chip" href={`/browse?genre=${encodeURIComponent(g)}`}>
                {g}
              </Link>
            ))}
          </div>
        ) : null}

        <RatingsRow ratings={ratings} community={item.CommunityRating} />

        {/* Which languages are available matters to a room deciding what to
            put on; the codec and container do not. Those moved to the footer. */}
        {subtitles.length > 0 ? (
          <div className="subtitle-line">
            <span className="subtitle-label">Subtitles</span>
            {subtitles.map((track) => (
              <span
                key={track.index}
                className={`chip${track.recommended ? " chip-accent" : ""}`}
                title={track.recommended ? "Recommended by the curator" : undefined}
              >
                {track.recommended ? "\u2605 " : ""}
                {track.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <CastRow people={cast} />
      {directors.length > 0 ? (
        <CastRow people={directors} heading="Directed by" limit={4} />
      ) : null}

      {picks.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <CuratorPicks picks={picks} heading="Curator's notes on this" />
        </div>
      ) : null}

      {similar.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <Row title="More like this" items={similar} />
        </div>
      ) : null}

      {/* Last, small, and not in cards. A film club cares what the film is,
          not what container it happens to be in — but the information is still
          worth having when a playback problem needs explaining. */}
      <p className="file-line">
        {[
          source?.Container ? source.Container.toUpperCase() : null,
          source?.Size ? `${(source.Size / 1e9).toFixed(2)} GB` : null,
          quality,
          audio.length > 0
            ? audio.map((a) => a.DisplayTitle ?? a.Codec).join(" / ")
            : null,
        ]
          .filter(Boolean)
          .join("  ·  ")}
      </p>
    </div>
  );
}
