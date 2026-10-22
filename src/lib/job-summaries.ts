/**
 * The one-line result a scheduled job leaves on the Health tab. Plain words:
 * it is read on a phone as often as at a desk, and a JSON dump neither reads
 * nor wraps (one ran the Health page to twice the phone's width).
 */

export interface TmdbNewTitles {
  moviesFetched: number;
  showsLinked: number;
  seasonsFetched: number;
  failures: number;
  noMatch: number;
  unmatched: ReadonlyArray<unknown>;
}

export interface EpisodeStills {
  applied: number;
  failed: number;
  unresolved: number;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function tmdbRefreshSummary(refreshed: number, added: TmdbNewTitles, stills: EpisodeStills): string {
  const parts = [`${refreshed} refreshed`];

  const found: string[] = [];
  if (added.moviesFetched) found.push(count(added.moviesFetched, "film"));
  if (added.showsLinked) found.push(count(added.showsLinked, "show"));
  if (added.seasonsFetched) found.push(count(added.seasonsFetched, "season"));
  parts.push(found.length ? `new: ${found.join(", ")}` : "no new titles");
  if (added.noMatch) parts.push(`${added.noMatch} not on TMDB`);
  if (added.unmatched.length) parts.push(`${added.unmatched.length} left unmatched`);
  if (added.failures) parts.push(count(added.failures, "failed request"));

  if (stills.applied) parts.push(count(stills.applied, "episode still"));
  if (stills.failed) parts.push(count(stills.failed, "still", "stills") + " failed");

  return parts.join(" · ");
}
