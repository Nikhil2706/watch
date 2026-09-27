/**
 * What a cut of a film is called, guessed from its filename.
 *
 * Only a guess — the console edits it — but the filenames in this library say
 * it outright more often than not: "Hell.House.LLC.2015.DIRECTORS.CUT...",
 * "Miracolo.A.Milano.1951.ITALIAN...", "Miracle.In.Milan.1951.REMASTERED...",
 * "Stazione Termini ... English original version". Returns null when the name
 * says nothing, and the caller falls back to "Version 2" and so on.
 *
 * Pure, so it is tested against those real names.
 */

const RULES: Array<[RegExp, string]> = [
  [/director'?s?[\s._-]*cut|\bdc\b/i, "Director's cut"],
  [/\bextended\b/i, "Extended"],
  [/\bunrated\b/i, "Unrated"],
  [/\buncut\b/i, "Uncut"],
  [/\btheatrical\b/i, "Theatrical"],
  [/\bfinal[\s._-]*cut\b/i, "Final cut"],
  [/\bredux\b/i, "Redux"],
  [/\bremaster(ed)?\b/i, "Remastered"],
  [/\bcriterion\b/i, "Criterion"],
  [/english[\s._-]*(original[\s._-]*)?version|\benglish\b/i, "English version"],
  [/\bitalian\b|\bita\b/i, "Italian version"],
  [/\bfrench\b/i, "French version"],
  [/\bgerman\b/i, "German version"],
];

export function guessVersionLabel(path: string): string | null {
  const file = path.split("/").pop() ?? path;
  // Dots and underscores are word separators in release names.
  const name = file.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ");
  for (const [pattern, label] of RULES) {
    if (pattern.test(name)) return label;
  }
  return null;
}
