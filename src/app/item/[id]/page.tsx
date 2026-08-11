import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
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

  const similar = await getSimilar(session, id).catch(() => []);
  const backdrop = backdropUrl(item, 1600);
  const runtime = formatRuntime(item.RunTimeTicks);
  const quality = qualityLabel(item);
  const resume = resumeSeconds(item);

  const source = item.MediaSources?.[0];
  const audio = source?.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
  const subtitles = source?.MediaStreams?.filter((s) => s.Type === "Subtitle") ?? [];
  const directors = (item.People ?? []).filter((p) => p.Type === "Director");
  const cast = (item.People ?? []).filter((p) => p.Type === "Actor").slice(0, 12);

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
            {item.CommunityRating ? <span>★ {item.CommunityRating.toFixed(1)}</span> : null}
            {quality ? <span className="chip">{quality}</span> : null}
          </div>
          {item.Overview ? <p>{item.Overview}</p> : null}
          <div className="btn-row">
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
          <>
            <h3>Genres</h3>
            <div className="people">
              {item.Genres.map((g) => (
                <Link key={g} className="chip" href={`/browse?genre=${encodeURIComponent(g)}`}>
                  {g}
                </Link>
              ))}
            </div>
          </>
        ) : null}

        <h3>Details</h3>
        <div className="facts">
          {directors.length > 0 ? (
            <div className="fact">
              <dt>Director</dt>
              <dd>{directors.map((d) => d.Name).join(", ")}</dd>
            </div>
          ) : null}
          {source?.Container ? (
            <div className="fact">
              <dt>Container</dt>
              <dd>{source.Container.toUpperCase()}</dd>
            </div>
          ) : null}
          {source?.Size ? (
            <div className="fact">
              <dt>Size</dt>
              <dd>{(source.Size / 1e9).toFixed(2)} GB</dd>
            </div>
          ) : null}
          {audio.length > 0 ? (
            <div className="fact">
              <dt>Audio</dt>
              <dd>{audio.map((a) => a.DisplayTitle ?? a.Codec).join(", ")}</dd>
            </div>
          ) : null}
          {subtitles.length > 0 ? (
            <div className="fact">
              <dt>Subtitles</dt>
              <dd>{subtitles.map((s) => s.Language ?? s.DisplayTitle).join(", ")}</dd>
            </div>
          ) : null}
        </div>

        {cast.length > 0 ? (
          <>
            <h3>Cast</h3>
            <div className="people">
              {cast.map((person) => (
                <span key={person.Id + person.Name} className="chip">
                  {person.Name}
                  {person.Role ? ` — ${person.Role}` : ""}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {similar.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <Row title="More like this" items={similar} />
        </div>
      ) : null}
    </div>
  );
}
