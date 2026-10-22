import Link from "next/link";
import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { comingSoonFor } from "@/lib/coming-soon";
import { whenLabel } from "@/lib/coming-soon-list";
import { currentSession } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * Everything coming (coming-soon.ts): what the curator has announced, with
 * their note and the title's summary, and what is scheduled to release —
 * soonest first. Home's Coming soon row is the top of this list.
 */
export default async function ComingSoonPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const entries = await comingSoonFor(session).catch(() => []);
  const now = Date.now();

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <div className="page-head">
        <h1>Coming soon</h1>
      </div>

      {!entries.length ? (
        <div className="empty">
          <p>Nothing announced right now.</p>
        </div>
      ) : (
        <ol className="coming-list">
          {entries.map((e) => (
            <li key={e.key} id={e.key.replace(":", "-")} className="coming-item">
              {e.posterSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={e.posterSrc} alt="" loading="lazy" />
              ) : (
                <div className="coming-noart" aria-hidden="true" />
              )}
              <div>
                <p className="coming-when-line">{whenLabel(e.at, now)}</p>
                <h2>
                  {e.kind === "show" ? <Link href={e.href}>{e.title}</Link> : e.title}
                  {e.year ? <span className="coming-year"> {e.year}</span> : null}
                </h2>
                {e.detail ? <p className="hint">{e.detail}</p> : null}
                {e.note ? <p className="coming-note">{e.note}</p> : null}
                {e.overview ? <p className="coming-overview">{e.overview}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
