/**
 * When two titles that are not the same may still be taken for the same film.
 *
 * The first rule was word overlap: seven words in ten shared, and the year
 * not contradicting. Run against the real lists it attached "Dancer in the
 * Dark" (Palme d'Or, 2000) to the library's "In the Dark", "The Silence of
 * the Lambs" to "The Look of Silence", "Shaun of the Dead" to "Land of the
 * Dead" — 66 different pairs, of which three or four were right. A title
 * with one word taken out is, as a rule, a different film.
 *
 * So the rule here is narrow, and names what it lets through:
 *   - a list that writes "Ready Player One Film" or "One Battle After
 *     Another Movie" means the film of that title (looseKey), as long as
 *     two words of title are left: "Scary Movie" is a title;
 *   - one word that differs only by a plural or by a letter in a very short
 *     word — "The Nice Guy" / "The Nice Guys", "Ford vs Ferrari" / "Ford v
 *     Ferrari" (nearTitle) — and then only when both sides give a year and
 *     the years agree, which the caller checks.
 *
 * Titles arrive already normalised (lowercase words, single spaces). Pure,
 * so the pairs above are tests.
 */

/** A title as a list wrote it, without a trailing "film" or "movie". */
export function looseKey(key: string): string {
  const words = key.split(" ").filter(Boolean);
  if (words.length > 2 && /^(film|movie)$/.test(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

function sameWordNearly(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // A plural: guy / guys, witch / witches.
  if (short.length >= 3 && (long === short + "s" || long === short + "es")) return true;
  // "vs" / "v", "&" spelt out differently: only in words too short to be a
  // different word by one letter being a different title ("cat" / "car" is,
  // which is why three letters is the limit and the lengths must differ).
  return long.length <= 3 && short.length >= 1 && long.length - short.length === 1 && long.startsWith(short);
}

/** The same words in the same order, but for one that differs as sameWordNearly allows. */
export function nearTitle(a: string, b: string): boolean {
  const x = a.split(" ").filter(Boolean);
  const y = b.split(" ").filter(Boolean);
  if (x.length !== y.length || x.length < 2) return false;
  let differing = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (!sameWordNearly(x[i]!, y[i]!)) return false;
    differing += 1;
  }
  return differing === 1;
}
