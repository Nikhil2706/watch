import { sanitizeRichText } from "@/lib/scraping/rich-text";
import type { ResolvedBlurb } from "@/lib/scraping/resolve";
import type { TriviaFact } from "@/lib/scraping/trivia";

/**
 * The blurb quote + trivia list below the ratings row. The accolade badge
 * itself renders inline in RatingsRow, not here — see AccoladeCell there.
 *
 * Blurb/trivia text may carry the six-tag rich-text allowlist (bold/
 * italic/underline/strikethrough/sub/superscript); sanitizeRichText runs
 * again here even though resolve.ts's sources already passed through it on
 * write (curator text) or never contained markup to begin with (scraped
 * prose) — a second pass at the actual render boundary costs nothing and
 * is the boundary that actually matters for safety.
 */
export function AccoladesSection({
  blurb,
  trivia,
}: {
  blurb: ResolvedBlurb | null;
  trivia: TriviaFact[];
}) {
  if (!blurb && trivia.length === 0) return null;

  return (
    <>
      {blurb ? (
        <div className="blurb-card">
          {/* eslint-disable-next-line react/no-danger -- sanitizeRichText allowlists only b/i/u/s/sub/sup, no attributes */}
          <blockquote className="blurb-quote" dangerouslySetInnerHTML={{ __html: sanitizeRichText(blurb.text) }} />
          <div className="blurb-source">
            <span className="blurb-source-name">— {blurb.sourceLabel}</span>
            {blurb.sourceUrl ? (
              <a className="blurb-link" href={blurb.sourceUrl} target="_blank" rel="noopener noreferrer">
                Read the full review →
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {trivia.length > 0 ? (
        <div className="trivia-card">
          <h3>Trivia</h3>
          <ul className="trivia-list">
            {trivia.map((fact) => (
              <li key={fact.id}>
                {/* eslint-disable-next-line react/no-danger -- sanitizeRichText allowlists only b/i/u/s/sub/sup, no attributes */}
                <span dangerouslySetInnerHTML={{ __html: sanitizeRichText(fact.text) }} />
                <span className="trivia-source">{fact.sourceLabel}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
