/**
 * Sentences out of prose, for trivia facts.
 *
 * The old split was ". " followed by a capital, which also breaks after an
 * initial or a title: "Sympathy for Mr. | Vengeance did not fare well",
 * "David S. | Goyer signed on", "Michael B. | Jordan said". The stub before
 * the break was usually too short to keep, so the stored "fact" began
 * mid-sentence; 2,546 of 189,545 did on 2026-09-30. Here a break that
 * follows one of these is joined back up.
 */
const NO_BREAK_AFTER = new RegExp(
  "(?:^|[\\s(\"“'‘])(?:" +
    [
      // A single capital: a middle initial, "J. R. R. Tolkien", "U.S." too.
      "[A-Z]",
      "Mr", "Mrs", "Ms", "Mx", "Dr", "St", "Jr", "Sr", "Mt", "Ft", "Prof", "Rev", "Hon",
      "Gen", "Col", "Lt", "Maj", "Sgt", "Capt", "Cmdr", "Adm", "Gov", "Sen", "Rep", "Pres",
      "Messrs", "Mme", "Mlle",
      "vs", "etc", "approx", "ca", "cf", "al", "Inc", "Ltd", "Co", "Corp", "Bros",
      "No", "Nos", "Vol", "Vols", "pp", "Pt", "Ch", "Ep",
      "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
    ].join("|") +
    ")\\.$",
);

export function splitSentences(text: string): string[] {
  const pieces = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z"“])/);
  const sentences: string[] = [];
  for (const piece of pieces) {
    const last = sentences[sentences.length - 1];
    if (last !== undefined && NO_BREAK_AFTER.test(last)) sentences[sentences.length - 1] = `${last} ${piece}`;
    else sentences.push(piece);
  }
  return sentences.map((s) => s.trim()).filter(Boolean);
}
