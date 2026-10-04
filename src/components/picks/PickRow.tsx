import Link from "next/link";

import { CURATOR_NAME } from "@/lib/curator-name";
import type { PickView } from "@/lib/pick-views";

import { PickRail } from "./PickRail";

/**
 * One pick as a row: its title (which opens the pick's own page), an optional
 * subtitle, and its titles. Ranked picks carry a number under each poster;
 * unranked ones space the posters wider so the writeup has room.
 *
 * The same row serves the Picks page and Home.
 */
export function PickRow({ pick }: { pick: PickView }) {
  return (
    <section
      className={pick.ranked ? "pk-row is-ranked" : pick.labelled ? "pk-row is-labelled" : "pk-row"}
      aria-label={pick.title}
      // The words are all one size: the size at which the longest fits a tile.
      style={pick.labelled ? ({ "--pk-fit": pick.labelFit } as React.CSSProperties) : undefined}
    >
      <div className="pk-head">
        {pick.personal ? <span className="pk-for-you">Picked for you by {CURATOR_NAME}</span> : null}
        <h2>
          <Link href={pick.href}>{pick.title}</Link>
        </h2>
        {pick.subtitle ? <p className="pk-sub">{pick.subtitle}</p> : null}
        {pick.sourceLabel ? (
          <p className="pk-source">
            From {pick.sourceLabel} &middot; {pick.tiles.length} of {pick.totalItems} in the library
          </p>
        ) : null}
      </div>
      <PickRail tiles={pick.tiles} ranked={pick.ranked} />
    </section>
  );
}
