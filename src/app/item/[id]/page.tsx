import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { AccoladesSection } from "@/components/media/AccoladesSection";
import { CastRow } from "@/components/media/CastRow";
import { CommunitySection } from "@/components/media/CommunitySection";
import { CuratorPicks } from "@/components/media/CuratorPicks";
import { ListButtons } from "@/components/media/ListButtons";
import { RatingsRow } from "@/components/media/RatingsRow";
import { getRatingSummary } from "@/lib/community";
import { curationsForItem } from "@/lib/curations";
import { getMemberships } from "@/lib/lists";
import { getRatings } from "@/lib/ratings";
import { resolveAccolade, resolveBlurb } from "@/lib/scraping/resolve";
import { resolveTriviaForFilm } from "@/lib/scraping/trivia";
import { listSubtitles } from "@/lib/subtitles";
import { Row } from "@/components/media/Row";
import { SeriesRow } from "@/components/media/SeriesRow";
import { currentSession } from "@/lib/current-user";
import {
  backdropUrl,
  collapseEpisodeGroups,
  formatRuntime,
  getEpisodeContext,
  getItem,
  getItemByImdbId,
  getSimilar,
  qualityLabel,
  resumeSeconds,
} from "@/lib/media";
import { getSeriesContextForFilm } from "@/lib/scraping/film-series";

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

  const [similar, ratings, episodeContext] = await Promise.all([
    getSimilar(session, id).catch(() => []),
    // The IMDb id comes from Jellyfin, so no title matching is needed.
    getRatings(item.ProviderIds?.Imdb).catch(() => null),
    // Null for anything that isn't a grouped episode.
    getEpisodeContext(session, item).catch(() => null),
  ]);
  // Once every episode in a group shares the same OMDb Genres/People, they
  // become each other's best "similar" match by Jellyfin's own metric — so
  // without this, "More like this" on episode 1 fills up with episodes 2-10
  // instead of anything actually similar. Siblings get their own row below.
  const similarOthers = episodeContext
    ? similar.filter((s) => !episodeContext.siblingIds.has(s.Id))
    : similar;
  // Every episode Jellyfin's own /Similar picked from a DIFFERENT show (not
  // this one — those were already filtered above) collapses to one "N parts"
  // tile for that show, same as Search and Browse already do.
  const collapsedSimilar = collapseEpisodeGroups(similarOthers);
  const futureTitles = new Map(
    (episodeContext?.future ?? [])
      .filter((f) => f.label)
      .map((f) => [f.item.Id, f.label as string]),
  );
  // Synchronous local-DB reads, not network fetches — no Promise.all needed.
  // The public read path only ever touches resolve.ts (blurb/accolade) and
  // trivia.ts's resolveTriviaForFilm: both return short display strings,
  // never a scraped_articles.full_text.
  const imdbId = item.ProviderIds?.Imdb;
  const blurb = imdbId ? resolveBlurb(imdbId) : null;
  const accolade = imdbId ? resolveAccolade(imdbId) : null;
  const trivia = imdbId ? resolveTriviaForFilm(imdbId) : [];
  const ratingSummary = imdbId ? getRatingSummary(imdbId) : null;
  const usRating = ratingSummary && ratingSummary.count > 0 ? { average: ratingSummary.average!, count: ratingSummary.count } : null;

  // "In this series" — every film Wikipedia's own film-series lists carry
  // for this franchise (see film-series.ts), not just the ones owned. The
  // context lookup is a synchronous local read; resolving which entries are
  // actually owned needs one Jellyfin call per matched imdb id, done here in
  // parallel rather than inside SeriesRow so the component stays a plain
  // synchronous render.
  const seriesContext = imdbId ? getSeriesContextForFilm(imdbId) : null;
  const seriesItemPairs = await Promise.all(
    (seriesContext?.entries ?? [])
      .filter((e) => e.imdb_id)
      .map(async (e) => [e.imdb_id as string, await getItemByImdbId(session, e.imdb_id as string).catch(() => null)] as const),
  );
  const seriesItems = new Map(
    seriesItemPairs.filter((pair): pair is [string, NonNullable<(typeof pair)[1]>] => pair[1] !== null),
  );

  const picks = curationsForItem(id);
  const subtitles = listSubtitles(item);
  const futureIds = (episodeContext?.future ?? []).map((f) => f.item.Id);
  const seriesItemIds = Array.from(seriesItems.values(), (i) => i.Id);
  const allLists = getMemberships(session.userId, [id, ...futureIds, ...seriesItemIds]);
  const lists = allLists.get(id);
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
            {session.langloisMode ? (
              // "Langlois mode" — a per-user grant (see the langlois_mode
              // column comment in schema.ts), curator-set from the Invites
              // tab. Goes through the same /jf/* proxy as everything else;
              // it succeeds here (and 403s for anyone else) purely because
              // applyRestrictedPolicy() turned EnableContentDownloading on
              // for this user's Jellyfin account and no one else's — no
              // extra gating needed in this route.
              <a className="btn ghost" href={`/jf/Items/${item.Id}/Download`}>
                ⬇ Download film
              </a>
            ) : null}
          </div>
        </div>
      </section>

      <div className="detail-body">
        {item.Genres?.length ? (
          <div className="chip-line">
            {item.Genres.map((g) => (
              <Link key={g} className="chip" href={`/browse?dim=genre&value=${encodeURIComponent(g)}`}>
                {g}
              </Link>
            ))}
          </div>
        ) : null}

        <RatingsRow ratings={ratings} community={item.CommunityRating} accolade={accolade} usRating={usRating} />

        {/* Which languages are available matters to a room deciding what to
            put on; the codec and container do not. Those moved to the footer. */}
        {subtitles.length > 0 ? (
          <div className="subtitle-line">
            <span className="subtitle-label">Subtitles</span>
            {subtitles.map((track) =>
              session.langloisMode ? (
                <a
                  key={track.index}
                  className={`chip${track.recommended ? " chip-accent" : ""}`}
                  title={(track.recommended ? "Recommended by the curator \u2014 " : "") + "Download this subtitle file"}
                  href={track.url}
                  download={`${item.Name} - ${track.label}.vtt`}
                >
                  {track.recommended ? "\u2605 " : ""}
                  {track.label} \u2b07
                </a>
              ) : (
                <span
                  key={track.index}
                  className={`chip${track.recommended ? " chip-accent" : ""}`}
                  title={track.recommended ? "Recommended by the curator" : undefined}
                >
                  {track.recommended ? "\u2605 " : ""}
                  {track.label}
                </span>
              ),
            )}
          </div>
        ) : null}

        <AccoladesSection blurb={blurb} trivia={trivia} />
      </div>

      <CastRow people={cast} />
      {directors.length > 0 ? (
        <CastRow people={directors} heading="Directed by" limit={4} />
      ) : null}

      {episodeContext && episodeContext.future.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <Row
            title="Future episodes"
            items={episodeContext.future.map((f) => f.item)}
            lists={allLists}
            itemTitles={futureTitles}
          />
        </div>
      ) : null}

      {seriesContext && seriesContext.entries.length > 1 ? (
        <div style={{ marginTop: 28 }}>
          <SeriesRow
            title={`In the ${seriesContext.seriesName} series`}
            entries={seriesContext.entries}
            items={seriesItems}
            lists={allLists}
            currentImdbId={imdbId}
          />
        </div>
      ) : null}

      {picks.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <CuratorPicks picks={picks} heading="Curator's notes on this" />
        </div>
      ) : null}

      {imdbId ? (
        <div style={{ marginTop: 28 }}>
          <CommunitySection
            imdbId={imdbId}
            filmTitle={item.Name}
            filmHref={`/item/${item.Id}`}
            currentUserId={session.userId}
            currentUsername={session.username}
          />
        </div>
      ) : null}

      {collapsedSimilar.items.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <Row
            title="More like this"
            items={collapsedSimilar.items}
            itemHrefs={collapsedSimilar.hrefs}
            itemPosters={collapsedSimilar.posters}
            itemPartsCounts={collapsedSimilar.partsCounts}
          />
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
