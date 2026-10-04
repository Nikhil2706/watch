import Link from "next/link";

import { CURATOR_NAME } from "@/lib/curator-name";
import { pickHref, type PickMention } from "@/lib/picks";

import { Writeup } from "./Writeup";

/**
 * On a film's or show's own page: every pick it is in that this viewer can
 * see, with the writeup in full and the way to the whole pick. It shows
 * however the viewer arrived — from the pick, from search, from Browse.
 */
export function PickPanels({ mentions }: { mentions: PickMention[] }) {
  if (mentions.length === 0) return null;

  return (
    <div className="pk-panels">
      {mentions.map((m) => (
        <div key={m.pickId} className="pk-panel">
          <div className="pk-panel-head">
            {m.rank !== null ? (
              <span className="pk-panel-num" aria-label={`Number ${m.rank}`}>
                {m.rank}
              </span>
            ) : null}
            <div>
              <span className="pk-panel-kind">
                {m.personal ? `Picked for you by ${CURATOR_NAME}` : "In a pick"}
                {m.label ? ` · ${m.label}` : ""}
              </span>
              <Link className="pk-panel-title" href={pickHref(m.pickId)}>
                {m.pickTitle}
              </Link>
            </div>
          </div>
          <Writeup text={m.writeup} sourceLabel={m.writeupSourceLabel} sourceUrl={m.writeupSourceUrl} />
          <Link className="pk-panel-more" href={pickHref(m.pickId)}>
            See the full pick &rarr;
          </Link>
        </div>
      ))}
    </div>
  );
}
