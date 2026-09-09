import Link from "next/link";

import type { CreditCard } from "@/lib/credit-cards";
import { personImageUrl } from "@/lib/image-url";

/**
 * One row of people, from either store.
 *
 * Replaces the five per-department CastRow calls the film page used to make.
 * Those produced up to five separate rows, three of them a single card wide,
 * and TMDB's crew would have made it seven — at which point the page is a
 * stack of titled rails with one face in each. The department moves into the
 * card's own subtitle instead, beside where an actor's character already sits.
 *
 * A card links to /person/{jellyfinId} where Jellyfin knows the person, since
 * that page has their portrait and biography, and to /person/tmdb/{id}
 * otherwise — which answers the same question out of tmdb_credits for the
 * cinematographers and editors Jellyfin has never held.
 */
export function CreditsRow({
  people,
  heading,
  limit = 20,
}: {
  people: CreditCard[];
  heading: string;
  limit?: number;
}) {
  if (people.length === 0) return null;

  return (
    <section className="row cast-row" aria-label={heading}>
      <h2>{heading}</h2>
      <div className="row-scroll">
        {people.slice(0, limit).map((person) => {
          const photo =
            person.photo?.kind === "jellyfin"
              ? personImageUrl(person.photo.id, person.photo.tag, 160)
              : person.photo?.kind === "tmdb"
                ? `/api/person-photo/${person.photo.tmdbId}?size=w185`
                : null;

          const inner = (
            <>
              <div className="cast-photo">
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photo} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="cast-initials" aria-hidden="true">
                    {person.initials}
                  </span>
                )}
              </div>
              <div className="cast-name">{person.name}</div>
              {person.role ? <div className="cast-role">{person.role}</div> : null}
            </>
          );

          return person.href ? (
            <Link key={person.key} href={person.href} className="cast-card">
              {inner}
            </Link>
          ) : (
            <div key={person.key} className="cast-card">
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}
