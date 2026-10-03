import "server-only";

import { episodeCode } from "./episode-key";
import { getGroup, getGroupedPathMap, getGroupSeriesPoster } from "./library-curation";
import { getItemsByImdbIds, getItemsByPaths, posterUrl, stillUrl } from "./media";
import { displayRank, orderForDisplay, showsOnHome, writeupPlainText } from "./pick-rank";
import { listPickItems, listPicksForViewer, pickHref, type PickItem, type ViewerPick } from "./picks";
import type { ResolvedSession } from "./session";
import { itemHref } from "./slugs";
import { episodeTilesForPaths } from "./tmdb-view";

/**
 * A pick as one viewer sees it: its titles resolved to posters and links.
 *
 * Only titles the viewer can actually open are kept. A converted list holds
 * every entry of its source, most of which the library does not have, and
 * parental control hides some of the rest — both drop out here, through the
 * same filtered listings every other row on the site reads.
 */

export interface PickTile {
  key: string;
  href: string;
  title: string;
  /** Beside the title, muted: a film's year, an episode's "S2 E22". */
  sub: string | null;
  posterSrc: string | null;
  /**
   * "still" for an episode: its own frame, uncropped, in a landscape tile
   * wider than the portrait ones around it. Everything else is a poster.
   */
  shape: "poster" | "still";
  /** The number under the poster; null in an unranked pick. */
  rank: number | null;
  /** The writeup as plain text, for the clamped lines under the poster. */
  excerpt: string;
  /** The writeup as stored, for the pick's own page and the title's page. */
  writeup: string | null;
  writeupSourceLabel: string | null;
  writeupSourceUrl: string | null;
}

export interface PickView {
  id: string;
  href: string;
  title: string;
  subtitle: string | null;
  ranked: boolean;
  personal: boolean;
  /** Where a converted pick came from, e.g. "Best Films of 2025 — Year End Lists". */
  sourceLabel: string | null;
  sourceUrl: string | null;
  publishedAt: number | null;
  /** Everything the source list held, for "5 of 100 in the library". */
  totalItems: number;
  tiles: PickTile[];
}

async function resolve(session: ResolvedSession, picks: ViewerPick[]): Promise<PickView[]> {
  if (picks.length === 0) return [];

  const itemsByPick = new Map<string, PickItem[]>(picks.map((p) => [p.id, listPickItems(p.id)]));
  const all = [...itemsByPick.values()].flat();

  // A show is not a Jellyfin item, so it is reached through one of its files:
  // if the viewer can see that file, they can see the show.
  const groups = new Map(
    [...new Set(all.filter((i) => i.kind === "show" && i.group_id).map((i) => i.group_id!))].map((id) => [
      id,
      getGroup(id),
    ]),
  );
  const firstPaths = [...groups.values()].map((g) => g?.paths[0]).filter((p): p is string => !!p);
  const episodePaths = all.filter((i) => i.kind === "episode" && i.item_path).map((i) => i.item_path!);
  // TMDB's season and episode numbers and the episode's real title; the file
  // itself is named after its filename.
  const episodeNames = episodeTilesForPaths(episodePaths);
  const showOfPath = episodePaths.length ? getGroupedPathMap() : new Map<string, { groupId: string; groupName: string }>();

  // One request each for every film and every show across all the picks.
  const [films, showFiles] = await Promise.all([
    getItemsByImdbIds(
      session,
      all.filter((i) => i.kind === "film" && i.imdb_id).map((i) => i.imdb_id!),
    ),
    getItemsByPaths(session, [...firstPaths, ...episodePaths]),
  ]);

  return picks.map((pick) => {
    const ranked = pick.ranked === 1;
    const items = itemsByPick.get(pick.id) ?? [];
    // Numbered before anything is dropped, so a hidden title leaves a gap
    // rather than renumbering the ones around it.
    const numbered = new Map(
      orderForDisplay(items, false).map((item, index) => [item.id, displayRank(item.rank, index)]),
    );

    const tiles: PickTile[] = [];
    for (const item of orderForDisplay(items, ranked)) {
      const base = {
        key: item.id,
        rank: ranked ? numbered.get(item.id)! : null,
        excerpt: writeupPlainText(item.writeup),
        writeup: item.writeup,
        writeupSourceLabel: item.writeup_source_label,
        writeupSourceUrl: item.writeup_source_url,
      };

      if (item.kind === "show") {
        const group = item.group_id ? groups.get(item.group_id) : null;
        const file = group?.paths[0] ? showFiles.get(group.paths[0]) : undefined;
        if (!group || !file) continue;
        tiles.push({
          ...base,
          href: `/collection/${group.groupId}`,
          title: group.groupName,
          sub: null,
          posterSrc: getGroupSeriesPoster(group.groupId) ?? posterUrl(file),
          shape: "poster",
        });
        continue;
      }

      if (item.kind === "episode") {
        const file = item.item_path ? showFiles.get(item.item_path) : undefined;
        if (!file || !item.item_path) continue;
        const show = showOfPath.get(item.item_path);
        // A film with no IMDb id is kept by its file, as an episode is
        // (episode-key.ts). It belongs to no show, and is a film on the page.
        if (!show) {
          tiles.push({
            ...base,
            href: itemHref(file.Id, file.Name, file.ProductionYear),
            title: file.Name,
            sub: file.ProductionYear ? String(file.ProductionYear) : null,
            posterSrc: posterUrl(file),
            shape: "poster",
          });
          continue;
        }
        const named = episodeNames.get(item.item_path);
        tiles.push({
          ...base,
          href: itemHref(file.Id, file.Name, file.ProductionYear),
          // "The West Wing: Two Cathedrals"; the filename's own name when
          // TMDB has not been matched for this show.
          title: named ? `${show.groupName}: ${named.name}` : file.Name,
          sub: named ? episodeCode(named.seasonNumber, named.episodeNumber) : null,
          // The episode's own frame rather than the show's poster, which
          // every episode of the show would share.
          posterSrc: stillUrl(file, 640),
          shape: "still",
        });
        continue;
      }

      const film = item.imdb_id ? films.get(item.imdb_id) : undefined;
      if (!film) continue;
      tiles.push({
        ...base,
        href: itemHref(film.Id, film.Name, film.ProductionYear),
        title: film.Name,
        sub: film.ProductionYear ? String(film.ProductionYear) : null,
        posterSrc: posterUrl(film),
        shape: "poster",
      });
    }

    return {
      id: pick.id,
      href: pickHref(pick.id),
      title: pick.title,
      subtitle: pick.subtitle,
      ranked,
      personal: pick.personal,
      sourceLabel: pick.source_kind === "article" ? pick.source_label : null,
      sourceUrl: pick.source_kind === "article" ? pick.source_url : null,
      publishedAt: pick.published_at,
      totalItems: items.length,
      tiles,
    };
  });
}

/** The Picks page: every pick this person can see that has something in it. */
export async function picksForViewer(session: ResolvedSession): Promise<PickView[]> {
  const views = await resolve(session, listPicksForViewer(session.userId));
  return views.filter((v) => v.tiles.length > 0);
}

/** Home: the same, narrowed to picks from the last week and pinned ones. */
export async function homePicksForViewer(session: ResolvedSession): Promise<PickView[]> {
  const picks = listPicksForViewer(session.userId).filter((p) =>
    showsOnHome({ pinned: p.pinned === 1, publishedAt: p.published_at }),
  );
  const views = await resolve(session, picks);
  return views.filter((v) => v.tiles.length > 0);
}

/** One pick's own page. Null when it is not live, or not for this person. */
export async function pickForViewer(session: ResolvedSession, pickId: string): Promise<PickView | null> {
  const pick = listPicksForViewer(session.userId).find((p) => p.id === pickId);
  if (!pick) return null;
  return (await resolve(session, [pick]))[0] ?? null;
}
