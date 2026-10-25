/**
 * What an episode is called in Continue watching.
 *
 * An episode's own name says little by itself: "Welcome to the Hellmouth" in
 * a row of film posters is a title nobody recognises until they remember
 * which show it opens. So the card is headed with the show, and the line
 * under it places the episode: "S1 E1 · Welcome to the Hellmouth".
 *
 * A film kept in parts (Out 1) is placed by its part, "Part 7", and a name
 * that only repeats the film's own ("Out 1") is left off.
 *
 * Pure, so the wording is tested.
 */
export function episodeLine(
  season: number | null,
  episode: number | null,
  name: string | null,
  parts?: { showName: string },
): string {
  const code = parts
    ? episode !== null
      ? `Part ${episode}`
      : ""
    : season !== null && episode !== null
      ? `S${season} E${episode}`
      : episode !== null
        ? `Episode ${episode}`
        : "";
  const title = name?.trim() ?? "";
  // A file named only by its number has a "name" that repeats the code.
  const redundant =
    /^((episode|part)\s*)?\d+$/i.test(title) ||
    /^s\d+\s*e\d+$/i.test(title) ||
    (parts !== undefined && title !== "" && parts.showName.toLowerCase().startsWith(title.toLowerCase()));
  return [code, redundant ? "" : title].filter(Boolean).join(" · ");
}
