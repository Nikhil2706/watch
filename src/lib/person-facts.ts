/**
 * "Born 8 May 1906 in Rome, Italy  ·  Died 3 June 1977" — one quiet line.
 *
 * From TMDB, under a person's name. Pure and importless, so the wording is
 * tested rather than eyeballed.
 */

export interface LifeFacts {
  /** ISO dates, as TMDB gives them. */
  born: string | null;
  died: string | null;
  birthplace: string | null;
}

function day(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function personFacts(person: LifeFacts | null): string | null {
  if (!person) return null;
  const born = day(person.born);
  const died = day(person.died);

  const parts: string[] = [];
  if (born || person.birthplace) {
    parts.push(
      ["Born", born, person.birthplace ? `in ${person.birthplace}` : null]
        .filter((p): p is string => Boolean(p))
        .join(" "),
    );
  }
  if (died) parts.push(`Died ${died}`);
  return parts.length > 0 ? parts.join("  ·  ") : null;
}
