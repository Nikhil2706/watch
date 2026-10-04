import "server-only";

import { generateId } from "./crypto";
import { asRow, asRows, getDb, transaction } from "./db";
import { pathFromEpisodeKey } from "./episode-key";
import { getGroupedPathMap } from "./library-curation";
import { notifyUsers } from "./notifications";
import { cleanLabel, displayRank, orderForDisplay } from "./pick-rank";
import { matchTitle } from "./scraping/match";
import { sanitizeRichText } from "./scraping/rich-text";

/**
 * Picks — a titled list of films and shows the curator publishes, to everyone
 * or to chosen people, ranked or not, with a writeup per title.
 *
 * This file is storage only: it never talks to Jellyfin. Turning a pick's
 * titles into posters and links for one viewer is pick-views.ts.
 */

export type PickAudience = "everyone" | "people";
export type PickStatus = "draft" | "live";
export type PickItemKind = "film" | "show" | "episode";

export interface Pick {
  id: string;
  title: string;
  subtitle: string | null;
  ranked: number;
  /** A typed word under each poster instead of a number. Never 1 together with ranked. */
  labelled: number;
  audience: PickAudience;
  status: PickStatus;
  pinned: number;
  position: number;
  source_kind: "article" | "accolade" | null;
  source_id: string | null;
  source_label: string | null;
  source_url: string | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PickItem {
  id: string;
  pick_id: string;
  position: number;
  rank: number | null;
  /** The word shown under the poster in a labelled pick. */
  label: string | null;
  kind: PickItemKind;
  imdb_id: string | null;
  group_id: string | null;
  /** Episodes only: the file's path. */
  item_path: string | null;
  raw_title: string;
  raw_year: number | null;
  writeup: string | null;
  writeup_source_label: string | null;
  writeup_source_url: string | null;
  created_at: number;
}

/** Longer than any list entry scraped so far, short enough to stop a pasted article. */
export const WRITEUP_MAX = 12_000;

export function pickHref(id: string): string {
  return `/picks/${id}`;
}

function cleanWriteup(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = sanitizeRichText(value).replace(/\r\n?/g, "\n").trim().slice(0, WRITEUP_MAX);
  return text === "" ? null : text;
}

function touch(pickId: string): void {
  getDb().prepare("UPDATE picks SET updated_at = ? WHERE id = ?").run(Date.now(), pickId);
}

/* ------------------------------------------------------------------ *
 * Picks
 * ------------------------------------------------------------------ */

export interface PickSummary extends Pick {
  item_count: number;
  /** Titles that resolve to something in the library — what a viewer will see. */
  matched_count: number;
  recipient_count: number;
}

/** Every pick, in Picks-page order: highest position first. */
export function listPicks(): PickSummary[] {
  return asRows<PickSummary>(
    getDb()
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM pick_items i WHERE i.pick_id = p.id) AS item_count,
                (SELECT COUNT(*) FROM pick_items i WHERE i.pick_id = p.id
                    AND (i.imdb_id IS NOT NULL OR i.group_id IS NOT NULL OR i.item_path IS NOT NULL)) AS matched_count,
                (SELECT COUNT(*) FROM pick_recipients r WHERE r.pick_id = p.id) AS recipient_count
           FROM picks p
          ORDER BY p.position DESC, p.created_at DESC`,
      )
      .all(),
  );
}

export function getPick(id: string): Pick | undefined {
  return asRow<Pick>(getDb().prepare("SELECT * FROM picks WHERE id = ?").get(id));
}

export function listPickItems(pickId: string): PickItem[] {
  return asRows<PickItem>(
    getDb().prepare("SELECT * FROM pick_items WHERE pick_id = ? ORDER BY position ASC").all(pickId),
  );
}

export function listPickRecipients(pickId: string): string[] {
  return asRows<{ user_id: string }>(
    getDb().prepare("SELECT user_id FROM pick_recipients WHERE pick_id = ?").all(pickId),
  ).map((r) => r.user_id);
}

export function createPick(input: {
  title: string;
  subtitle?: string | null;
  ranked?: boolean;
  audience?: PickAudience;
  source?: { kind: "article" | "accolade"; id: string; label: string; url: string | null } | null;
}): Pick {
  const id = generateId();
  const now = Date.now();
  // Above everything already there: newest on top until the curator reorders.
  const top = asRow<{ p: number | null }>(getDb().prepare("SELECT MAX(position) AS p FROM picks").get())?.p ?? 0;

  getDb()
    .prepare(
      `INSERT INTO picks (id, title, subtitle, ranked, audience, status, pinned, position,
                          source_kind, source_id, source_label, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.subtitle?.trim() || null,
      input.ranked ? 1 : 0,
      input.audience ?? "everyone",
      top + 1,
      input.source?.kind ?? null,
      input.source?.id ?? null,
      input.source?.label ?? null,
      input.source?.url ?? null,
      now,
      now,
    );
  return getPick(id)!;
}

export interface PickPatch {
  title?: string;
  subtitle?: string | null;
  ranked?: boolean;
  /** What sits under each poster. Replaces `ranked` when given: the two are one choice. */
  under?: "number" | "word" | "nothing";
  audience?: PickAudience;
  pinned?: boolean;
}

export function updatePick(id: string, patch: PickPatch): Pick | undefined {
  const current = getPick(id);
  if (!current) return undefined;

  getDb()
    .prepare(
      `UPDATE picks SET title = ?, subtitle = ?, ranked = ?, labelled = ?, audience = ?, pinned = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      patch.title ?? current.title,
      patch.subtitle === undefined ? current.subtitle : patch.subtitle?.trim() || null,
      patch.under !== undefined
        ? patch.under === "number" ? 1 : 0
        : patch.ranked === undefined ? current.ranked : patch.ranked ? 1 : 0,
      // Choosing a number (by either route) turns the words off; they are
      // kept on the titles, so switching back brings them back.
      patch.under !== undefined
        ? patch.under === "word" ? 1 : 0
        : patch.ranked ? 0 : current.labelled,
      patch.audience ?? current.audience,
      patch.pinned === undefined ? current.pinned : patch.pinned ? 1 : 0,
      Date.now(),
      id,
    );
  // Switching a live pick to "chosen people" is a send like any other.
  notifyNewRecipients(id);
  return getPick(id);
}

/** The bell rows a pick sent. They point at the pick's page, which is how they are found again. */
function deletePickNotifications(pickId: string): void {
  getDb()
    .prepare("DELETE FROM notifications WHERE kind = 'curators_pick' AND film_href = ?")
    .run(pickHref(pickId));
}

export function deletePick(id: string): boolean {
  const result = getDb().prepare("DELETE FROM picks WHERE id = ?").run(id);
  if (Number(result.changes) === 0) return false;
  deletePickNotifications(id);
  return true;
}

/** `ids` top-first, as the console lists them. Picks left out keep their place below. */
export function setPickOrder(ids: string[]): void {
  transaction((db) => {
    const all = asRows<{ id: string }>(
      db.prepare("SELECT id FROM picks ORDER BY position DESC, created_at DESC").all(),
    ).map((r) => r.id);
    const known = new Set(all);
    const wanted = ids.filter((id) => known.has(id));
    const rest = all.filter((id) => !wanted.includes(id));
    const ordered = [...wanted, ...rest];
    ordered.forEach((id, index) => {
      db.prepare("UPDATE picks SET position = ? WHERE id = ?").run(ordered.length - index, id);
    });
  });
}

export function setPickRecipients(pickId: string, userIds: string[]): void {
  transaction((db) => {
    const wanted = new Set(userIds);
    const existing = asRows<{ user_id: string }>(
      db.prepare("SELECT user_id FROM pick_recipients WHERE pick_id = ?").all(pickId),
    ).map((r) => r.user_id);

    for (const userId of existing) {
      if (!wanted.has(userId)) {
        db.prepare("DELETE FROM pick_recipients WHERE pick_id = ? AND user_id = ?").run(pickId, userId);
      }
    }
    // Only real users: a stale id from an old console tab must not fail the
    // foreign key and lose the whole save.
    const insert = db.prepare(
      `INSERT OR IGNORE INTO pick_recipients (pick_id, user_id)
       SELECT ?, id FROM users WHERE id = ?`,
    );
    for (const userId of wanted) insert.run(pickId, userId);
  });
  touch(pickId);
  notifyNewRecipients(pickId);
}

/**
 * Tells the people a live pick is for, once each.
 *
 * Called after anything that can make someone a recipient of a live pick:
 * publishing, changing who it is for, changing the audience. notified_at is
 * what makes it once — editing a live pick's writeups does not ring anyone's
 * bell again.
 */
function notifyNewRecipients(pickId: string): number {
  const pick = getPick(pickId);
  if (!pick || pick.status !== "live" || pick.audience !== "people") return 0;

  const pending = asRows<{ user_id: string }>(
    getDb()
      .prepare("SELECT user_id FROM pick_recipients WHERE pick_id = ? AND notified_at IS NULL")
      .all(pickId),
  ).map((r) => r.user_id);
  if (pending.length === 0) return 0;

  const sent = notifyUsers(pending, {
    kind: "curators_pick",
    // The column is NOT NULL and a pick is not one film.
    imdbId: "",
    filmTitle: pick.title,
    filmHref: pickHref(pick.id),
  });
  if (sent > 0) {
    const mark = getDb().prepare(
      "UPDATE pick_recipients SET notified_at = ? WHERE pick_id = ? AND user_id = ?",
    );
    const now = Date.now();
    for (const userId of pending) mark.run(now, pickId, userId);
  }
  return sent;
}

/** Returns how many people were notified. */
export function publishPick(id: string): number {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE picks SET status = 'live', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`,
    )
    .run(now, now, id);
  return notifyNewRecipients(id);
}

/**
 * Takes a pick off every page at once. Its bell rows go too — they would link
 * to a page that no longer opens — but who was told is kept, so publishing it
 * again does not notify them twice.
 */
export function unpublishPick(id: string): void {
  getDb().prepare("UPDATE picks SET status = 'draft', updated_at = ? WHERE id = ?").run(Date.now(), id);
  deletePickNotifications(id);
}

/* ------------------------------------------------------------------ *
 * Titles in a pick
 * ------------------------------------------------------------------ */

export interface PickItemInput {
  kind?: PickItemKind;
  imdbId?: string | null;
  groupId?: string | null;
  itemPath?: string | null;
  rawTitle: string;
  rawYear?: number | null;
  rank?: number | null;
  writeup?: string | null;
  writeupSourceLabel?: string | null;
  writeupSourceUrl?: string | null;
}

function insertItem(pickId: string, position: number, input: PickItemInput): string {
  const id = generateId();
  getDb()
    .prepare(
      `INSERT INTO pick_items (id, pick_id, position, rank, kind, imdb_id, group_id, item_path, raw_title, raw_year,
                               writeup, writeup_source_label, writeup_source_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pickId,
      position,
      input.rank ?? null,
      input.kind ?? "film",
      input.imdbId ?? null,
      input.groupId ?? null,
      input.itemPath ?? null,
      input.rawTitle,
      input.rawYear ?? null,
      cleanWriteup(input.writeup),
      input.writeupSourceLabel?.trim() || null,
      input.writeupSourceUrl?.trim() || null,
      Date.now(),
    );
  return id;
}

/** Appends a title to the end of a pick. */
export function addPickItem(pickId: string, input: PickItemInput): PickItem {
  const next =
    asRow<{ n: number | null }>(
      getDb().prepare("SELECT MAX(position) AS n FROM pick_items WHERE pick_id = ?").get(pickId),
    )?.n ?? -1;
  const id = insertItem(pickId, next + 1, input);
  touch(pickId);
  return asRow<PickItem>(getDb().prepare("SELECT * FROM pick_items WHERE id = ?").get(id))!;
}

export interface PickItemPatch {
  writeup?: string | null;
  writeupSourceLabel?: string | null;
  writeupSourceUrl?: string | null;
  /** undefined leaves it; null clears a converted rank back to "number by position". */
  rank?: number | null;
  /** undefined leaves it; null or "" removes the word. */
  label?: string | null;
}

export function updatePickItem(pickId: string, itemId: string, patch: PickItemPatch): PickItem | undefined {
  const current = asRow<PickItem>(
    getDb().prepare("SELECT * FROM pick_items WHERE id = ? AND pick_id = ?").get(itemId, pickId),
  );
  if (!current) return undefined;

  getDb()
    .prepare(
      `UPDATE pick_items SET writeup = ?, writeup_source_label = ?, writeup_source_url = ?, rank = ?, label = ? WHERE id = ?`,
    )
    .run(
      patch.writeup === undefined ? current.writeup : cleanWriteup(patch.writeup),
      patch.writeupSourceLabel === undefined
        ? current.writeup_source_label
        : patch.writeupSourceLabel?.trim() || null,
      patch.writeupSourceUrl === undefined ? current.writeup_source_url : patch.writeupSourceUrl?.trim() || null,
      patch.rank === undefined ? current.rank : patch.rank,
      patch.label === undefined ? current.label : cleanLabel(patch.label),
      itemId,
    );
  touch(pickId);
  return asRow<PickItem>(getDb().prepare("SELECT * FROM pick_items WHERE id = ?").get(itemId));
}

function renumber(pickId: string, orderedIds: string[]): void {
  transaction((db) => {
    // Through a negative range first, so no two rows share a position mid-write.
    orderedIds.forEach((id, index) => {
      db.prepare("UPDATE pick_items SET position = ? WHERE id = ? AND pick_id = ?").run(-1 - index, id, pickId);
    });
    orderedIds.forEach((id, index) => {
      db.prepare("UPDATE pick_items SET position = ? WHERE id = ? AND pick_id = ?").run(index, id, pickId);
    });
  });
}

export function deletePickItem(pickId: string, itemId: string): boolean {
  const result = getDb().prepare("DELETE FROM pick_items WHERE id = ? AND pick_id = ?").run(itemId, pickId);
  if (Number(result.changes) === 0) return false;
  // Close the gap: a hand-built ranked pick numbers by position.
  renumber(pickId, listPickItems(pickId).map((i) => i.id));
  touch(pickId);
  return true;
}

/** `ids` in the new order. Items left out keep their relative order after them. */
export function setPickItemOrder(pickId: string, ids: string[]): void {
  const all = listPickItems(pickId).map((i) => i.id);
  const known = new Set(all);
  const wanted = ids.filter((id) => known.has(id));
  const rest = all.filter((id) => !wanted.includes(id));
  renumber(pickId, [...wanted, ...rest]);
  touch(pickId);
}

/* ------------------------------------------------------------------ *
 * Starting a pick from something that already exists
 * ------------------------------------------------------------------ */

interface SourceLinkRow {
  id: string;
  imdb_id: string | null;
  raw_title: string;
  raw_year: number | null;
  accolade_rank: number | null;
}

/**
 * Copies a scraped list into a new draft pick.
 *
 * Every entry comes across, matched or not: an entry for a film the library
 * does not have stays in the pick unseen and appears when the film arrives
 * (relinkUnmatchedPickItems). Ranks are the source's own, so a ranked list
 * shows 2, 7, 11 rather than pretending to be a top three.
 *
 * A writeup is filled in only where the source carries text for that entry
 * alone — a list scraped with its per-film paragraphs. The year-end lists
 * have none and convert as titles and ranks.
 */
export function createPickFromArticle(articleId: string): Pick | null {
  const article = asRow<{
    id: string;
    title: string;
    url: string;
    article_type: string;
    source_name: string;
  }>(
    getDb()
      .prepare(
        `SELECT a.id, a.title, a.url, a.article_type, s.name AS source_name
           FROM scraped_articles a JOIN scrape_sources s ON s.id = a.source_id
          WHERE a.id = ?`,
      )
      .get(articleId),
  );
  if (!article) return null;

  const links = asRows<SourceLinkRow>(
    getDb()
      .prepare(
        `SELECT id, imdb_id, raw_title, raw_year, accolade_rank FROM article_film_links
          WHERE article_id = ?
          ORDER BY (accolade_rank IS NULL), accolade_rank ASC, rowid ASC`,
      )
      .all(articleId),
  );
  if (links.length === 0) return null;

  const passages = getDb().prepare(
    "SELECT passage_text FROM article_blurb_candidates WHERE link_id = ? ORDER BY position ASC",
  );
  const url = article.url.startsWith("http") ? article.url : null;
  const ranked = links.some((l) => l.accolade_rank !== null);

  const pick = createPick({
    title: article.title,
    ranked,
    source: { kind: "article", id: article.id, label: `${article.title} — ${article.source_name}`, url },
  });

  // One row per film: an awards page lists a film once per result.
  const seen = new Set<string>();
  let position = 0;
  for (const link of links) {
    const key = link.imdb_id ?? `${link.raw_title}|${link.raw_year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text =
      article.article_type === "accolade"
        ? asRows<{ passage_text: string }>(passages.all(link.id))
            .map((p) => p.passage_text)
            .join("\n\n")
        : "";

    insertItem(pick.id, position++, {
      imdbId: link.imdb_id,
      rawTitle: link.raw_title,
      rawYear: link.raw_year,
      rank: link.accolade_rank,
      writeup: text || null,
      writeupSourceLabel: text ? article.source_name : null,
      writeupSourceUrl: text ? url : null,
    });
  }
  return getPick(pick.id)!;
}

/** Copies one of the curator's own accolade lists: its films, order and writeups. */
export function createPickFromAccolade(accoladeId: string): Pick | null {
  const accolade = asRow<{ id: string; name: string }>(
    getDb().prepare("SELECT id, name FROM curator_accolades WHERE id = ?").get(accoladeId),
  );
  if (!accolade) return null;

  const entries = asRows<{
    imdb_id: string | null;
    raw_title: string;
    raw_year: number | null;
    blurb_text: string | null;
  }>(
    getDb()
      .prepare(
        "SELECT imdb_id, raw_title, raw_year, blurb_text FROM curator_accolade_entries WHERE accolade_id = ? ORDER BY slot ASC",
      )
      .all(accoladeId),
  );

  const pick = createPick({
    title: accolade.name,
    ranked: true,
    source: { kind: "accolade", id: accolade.id, label: accolade.name, url: null },
  });
  const groups = getGroupedPathMap();
  entries.forEach((entry, position) => {
    // An episode sits in an accolade under its episode key (episode-key.ts).
    const path = pathFromEpisodeKey(entry.imdb_id);
    insertItem(
      pick.id,
      position,
      path
        ? {
            kind: "episode",
            itemPath: path,
            groupId: groups.get(path)?.groupId ?? null,
            rawTitle: entry.raw_title,
            writeup: entry.blurb_text,
          }
        : { imdbId: entry.imdb_id, rawTitle: entry.raw_title, rawYear: entry.raw_year, writeup: entry.blurb_text },
    );
  });
  return getPick(pick.id)!;
}

/**
 * Re-attempts matching for pick titles the library did not have when the pick
 * was made — called from the library scan beside the same pass for scraped
 * mentions, so a converted list gains a film the moment it is scanned in.
 */
export async function relinkUnmatchedPickItems(): Promise<number> {
  const unmatched = asRows<{ id: string; raw_title: string; raw_year: number | null }>(
    getDb()
      .prepare("SELECT id, raw_title, raw_year FROM pick_items WHERE kind = 'film' AND imdb_id IS NULL")
      .all(),
  );
  let relinked = 0;
  for (const row of unmatched) {
    const match = await matchTitle(row.raw_title, row.raw_year);
    if (match.confidence === "unmatched") continue;
    getDb().prepare("UPDATE pick_items SET imdb_id = ? WHERE id = ?").run(match.imdbId, row.id);
    relinked++;
  }
  return relinked;
}

/* ------------------------------------------------------------------ *
 * What one viewer may see
 * ------------------------------------------------------------------ */

export interface ViewerPick extends Pick {
  /** Made for this person rather than for everyone. */
  personal: boolean;
}

/**
 * Live picks this person can see, in page order: the ones made for them
 * first, then the curator's order.
 *
 * A pick for chosen people is invisible to everyone else — not on the Picks
 * page, not on Home, not on a film's page, and its own URL is a 404.
 */
export function listPicksForViewer(userId: string): ViewerPick[] {
  return asRows<Pick & { personal: number }>(
    getDb()
      .prepare(
        `SELECT p.*, (p.audience = 'people') AS personal
           FROM picks p
          WHERE p.status = 'live'
            AND (p.audience = 'everyone'
                 OR EXISTS (SELECT 1 FROM pick_recipients r WHERE r.pick_id = p.id AND r.user_id = ?))
          ORDER BY (p.audience = 'people') DESC, p.position DESC, p.created_at DESC`,
      )
      .all(userId),
  ).map((p) => ({ ...p, personal: p.personal === 1 }));
}

export function getPickForViewer(userId: string, pickId: string): ViewerPick | undefined {
  return listPicksForViewer(userId).find((p) => p.id === pickId);
}

export interface PickMention {
  pickId: string;
  pickTitle: string;
  personal: boolean;
  /** The number this title carries in a ranked pick; null in an unranked one. */
  rank: number | null;
  /** The word it carries in a labelled pick; null otherwise. */
  label: string | null;
  writeup: string | null;
  writeupSourceLabel: string | null;
  writeupSourceUrl: string | null;
}

/**
 * Every pick this viewer can see that contains this title, for the panel on
 * the title's own page. One row per pick: a title listed twice in one pick
 * shows its first entry.
 */
export function pickMentionsForTitle(
  userId: string,
  target: { imdbId?: string | null; groupId?: string | null; path?: string | null },
): PickMention[] {
  if (!target.imdbId && !target.groupId && !target.path) return [];

  const mentions: PickMention[] = [];
  for (const pick of listPicksForViewer(userId)) {
    const ordered = orderForDisplay(listPickItems(pick.id), false);
    // A show's page is asked for by group; a film's or an episode's page by
    // whichever of the two it has — an IMDb id, or just its path.
    const index = ordered.findIndex((item) =>
      target.groupId
        ? item.kind === "show" && item.group_id === target.groupId
        : (item.kind === "film" && !!target.imdbId && item.imdb_id === target.imdbId) ||
          (item.kind === "episode" && !!target.path && item.item_path === target.path),
    );
    if (index === -1) continue;
    const item = ordered[index]!;
    mentions.push({
      pickId: pick.id,
      pickTitle: pick.title,
      personal: pick.personal,
      rank: pick.ranked === 1 ? displayRank(item.rank, index) : null,
      label: pick.labelled === 1 ? item.label : null,
      writeup: item.writeup,
      writeupSourceLabel: item.writeup_source_label,
      writeupSourceUrl: item.writeup_source_url,
    });
  }
  return mentions;
}
