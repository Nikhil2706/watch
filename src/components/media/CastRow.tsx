import Link from "next/link";

import type { MediaItem } from "@/lib/media";

/**
 * Cast and crew, with portraits, linking to everything else they are in.
 *
 * "Who is that, and what else have we got with them?" is the most common
 * question asked out loud during a film, and it was previously a dead end — the
 * cast was plain text. Jellyfin already stores portraits and can filter the
 * library by person, so both halves are free.
 *
 * People without a portrait still get a card with their initials rather than
 * being hidden: a missing photo is not a reason to lose the link.
 */
export function CastRow({
  people,
  heading = "Cast",
  limit = 16,
}: {
  people: NonNullable<MediaItem["People"]>;
  heading?: string;
  limit?: number;
}) {
  if (people.length === 0) return null;

  return (
    <section className="row cast-row" aria-label={heading}>
      <h2>{heading}</h2>
      <div className="row-scroll">
        {people.slice(0, limit).map((person) => {
          const photo = person.PrimaryImageTag
            ? `/jf/Items/${person.Id}/Images/Primary?fillWidth=160&fillHeight=160&quality=90&tag=${person.PrimaryImageTag}`
            : null;
          const initials = person.Name.split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0] ?? "")
            .join("")
            .toUpperCase();

          return (
            <Link
              key={`${person.Id}-${person.Name}`}
              href={`/person/${person.Id}`}
              className="cast-card"
            >
              <div className="cast-photo">
                {photo ? (
                  <img src={photo} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="cast-initials" aria-hidden="true">
                    {initials}
                  </span>
                )}
              </div>
              <div className="cast-name">{person.Name}</div>
              {person.Role ? <div className="cast-role">{person.Role}</div> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
