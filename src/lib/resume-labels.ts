/**
 * What an episode is called in Continue watching.
 *
 * An episode's own name says little by itself: "Welcome to the Hellmouth" in
 * a row of film posters is a title nobody recognises until they remember
 * which show it opens. So the card is headed with the show, and the line
 * under it places the episode: "S1 E1 · Welcome to the Hellmouth".
 *
 * Pure, so the wording is tested.
 */
export function episodeLine(season: number | null, episode: number | null, name: string | null): string {
  const code = season !== null && episode !== null ? `S${season} E${episode}` : episode !== null ? `Episode ${episode}` : "";
  const title = name?.trim() ?? "";
  // A file named only by its number has a "name" that repeats the code.
  const redundant = /^(episode\s*)?\d+$/i.test(title) || /^s\d+\s*e\d+$/i.test(title);
  return [code, redundant ? "" : title].filter(Boolean).join(" · ");
}
