/**
 * Which files are copies of the same film, for the review dashboard's
 * "Duplicate title — pick one".
 *
 * A shared title alone was the whole test, so The Climb the 2018 short and
 * The Climb the 2019 feature it grew into were offered as copies to choose
 * between — even after the short was marked a special feature of the feature,
 * and although IMDb gives them different ids. Same for any remake.
 *
 * Now two files are copies only when their normalised titles match AND their
 * IMDb ids agree (or one has none yet — an unidentified file might well be a
 * copy). Files already decided another way — a special feature, or another
 * cut of a film kept as versions — take no part.
 *
 * Pure, so the rule is tested rather than argued about.
 */

export interface TitledFile {
  id: string;
  /** Already normalised by the caller (library-review.ts's normaliseTitle). */
  titleKey: string;
  imdbId: string | null;
}

export function duplicateIds(files: readonly TitledFile[]): Set<string> {
  const byTitle = new Map<string, TitledFile[]>();
  for (const f of files) {
    if (!f.titleKey) continue;
    const list = byTitle.get(f.titleKey) ?? [];
    list.push(f);
    byTitle.set(f.titleKey, list);
  }
  const out = new Set<string>();
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue;
        if (a.imdbId && b.imdbId && a.imdbId !== b.imdbId) continue;
        out.add(a.id);
        break;
      }
    }
  }
  return out;
}
