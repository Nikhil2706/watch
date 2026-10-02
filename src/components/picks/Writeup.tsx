import { writeupParagraphs } from "@/lib/pick-rank";
import { sanitizeRichText } from "@/lib/scraping/rich-text";

/**
 * A writeup in full, as paragraphs, with the line that credits a scraped
 * passage to where it came from.
 *
 * sanitizeRichText runs again at the render boundary even though picks.ts
 * already ran it on write — the same belt and braces AccoladesSection uses.
 */
export function Writeup({
  text,
  sourceLabel,
  sourceUrl,
}: {
  text: string | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
}) {
  const paragraphs = writeupParagraphs(text);
  if (paragraphs.length === 0) return null;

  return (
    <div className="writeup">
      {paragraphs.map((p, index) => (
        // eslint-disable-next-line react/no-danger -- sanitizeRichText allowlists only b/i/u/s/sub/sup, no attributes
        <p key={index} dangerouslySetInnerHTML={{ __html: sanitizeRichText(p) }} />
      ))}
      {sourceLabel ? (
        <p className="writeup-source">
          &mdash; {sourceLabel}
          {sourceUrl ? (
            <>
              {" "}
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                Read the article &rarr;
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
