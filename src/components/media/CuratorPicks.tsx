import type { Curation } from "@/lib/curations";

const KIND_LABEL: Record<string, string> = {
  article: "Article",
  essay: "Essay",
  video: "Video",
  note: "Note",
};

/**
 * Curator's Picks.
 *
 * The comment and the curator's name are shown on the face of the card, not
 * behind a click — a bare link is a bookmark, whereas the note is what makes it
 * a recommendation. That is the entire point of the section.
 *
 * A pick with no URL is still valid: sometimes the recommendation is just a
 * thought about the film.
 */
export function CuratorPicks({
  picks,
  heading = "Curator's Picks",
}: {
  picks: Curation[];
  heading?: string;
}) {
  if (picks.length === 0) return null;

  return (
    <section className="row curator" aria-label={heading}>
      <h2>{heading}</h2>
      <div className="curator-grid">
        {picks.map((pick) => {
          const label = KIND_LABEL[pick.kind] ?? pick.kind;
          const body = (
            <>
              <div className="curator-kind">{label}</div>
              <div className="curator-title">{pick.title}</div>
              {pick.comment ? (
                <blockquote className="curator-comment">{pick.comment}</blockquote>
              ) : null}
              <div className="curator-by">— {pick.curator}</div>
            </>
          );

          return pick.url ? (
            <a
              key={pick.id}
              className="curator-card"
              href={pick.url}
              target="_blank"
              // noreferrer as well as noopener: these are outbound links to
              // third-party writing, and there is no reason to leak which title
              // on this private server someone came from.
              rel="noopener noreferrer"
            >
              {body}
              <span className="curator-link">Read →</span>
            </a>
          ) : (
            <div key={pick.id} className="curator-card">
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}
