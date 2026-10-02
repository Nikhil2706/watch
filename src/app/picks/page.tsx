import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PickRow } from "@/components/picks/PickRow";
import { CURATOR_NAME } from "@/lib/curator-name";
import { currentSession } from "@/lib/current-user";
import { picksForViewer } from "@/lib/pick-views";

export const dynamic = "force-dynamic";

/**
 * Picks: lists of films and shows the curator has put together, each a row.
 *
 * The ones made for the person signed in come first; the rest follow the
 * order set in the console. Each row's title opens that pick's own page,
 * where every writeup is in full.
 */
export default async function PicksPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const picks = await picksForViewer(session);

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <div className="page-head">
        <h1>Picks</h1>
      </div>

      {picks.length === 0 ? (
        <div className="empty">
          <p>No picks yet.</p>
          <p className="hint" style={{ margin: 0 }}>
            When {CURATOR_NAME} puts a list together, it shows up here.
          </p>
        </div>
      ) : (
        <div className="pk-rows">
          {picks.map((pick) => (
            <PickRow key={pick.id} pick={pick} />
          ))}
        </div>
      )}
    </>
  );
}
