import "server-only";

import {
  accoladeMentionsForFilm,
  blurbCandidatesForFilm,
  getAccoladeMention,
  getBlurbCandidate,
  type AccoladeMention,
} from "./articles";
import { curatorAccoladeMentionsForFilm, getCuratorAccoladeEntry } from "./curator-accolades";
import { getLock } from "./locks";

/**
 * The ONLY read path the public film page is allowed to use for Accolades
 * data. Every function here returns a short display string, never
 * full_text — that boundary is what keeps a private reference copy
 * (scraped_articles.full_text, admin-dashboard-only) from becoming a
 * public redistribution. Re-exports resolveTriviaForFilm from trivia.ts
 * unchanged; it already honours the same rule.
 */
export { resolveTriviaForFilm } from "./trivia";

export interface ResolvedBlurb {
  text: string;
  sourceLabel: string;
  sourceUrl: string | null;
  locked: boolean;
}

export function resolveBlurb(imdbId: string): ResolvedBlurb | null {
  const lock = getLock(imdbId);

  if (lock?.locked_blurb_text) {
    return {
      text: lock.locked_blurb_text,
      sourceLabel: lock.locked_blurb_source_label || "Curator",
      sourceUrl: lock.locked_blurb_source_url,
      locked: true,
    };
  }
  if (lock?.locked_blurb_candidate_id) {
    const candidate = getBlurbCandidate(lock.locked_blurb_candidate_id);
    if (candidate) {
      return {
        text: candidate.passage_text,
        sourceLabel: candidate.source_name,
        sourceUrl: candidate.article_url.startsWith("http") ? candidate.article_url : null,
        locked: true,
      };
    }
  }

  const candidates = blurbCandidatesForFilm(imdbId);
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
  return {
    text: pick.passage_text,
    sourceLabel: pick.source_name,
    sourceUrl: pick.article_url.startsWith("http") ? pick.article_url : null,
    locked: false,
  };
}

export interface ResolvedAccolade {
  /** Short label for the ratings-row cell, e.g. "#7" or "Won". */
  badge: string;
  /** e.g. "The Ringer's 25 Best Sports Movies" or "92nd Academy Awards". */
  detail: string;
  locked: boolean;
  /** The original article, when it came from an actual URL (never set for a curator-built list, which has nowhere to link to) — repaying a scraped site with a real click, same reasoning as the blurb's "Read the full review" link. */
  sourceUrl: string | null;
}

/**
 * Win vs. nomination is carried as a prefix on the free-text label — "Won:
 * Best Sound Editing, 92nd Academy Awards" against "Nominated: ..." — as
 * written by wikipedia.ts and wikipedia-lists.ts. Kept in one place so the
 * badge and the ranking below can't drift apart on what counts as a win.
 */
function isWinLabel(label: string): boolean {
  return label.startsWith("Won");
}

function fromMention(m: AccoladeMention, locked: boolean): ResolvedAccolade {
  const sourceUrl = m.article_url.startsWith("http") ? m.article_url : null;
  if (m.accolade_label) {
    const badge = isWinLabel(m.accolade_label) ? "Won" : "Nom.";
    return { badge, detail: `${m.accolade_label} — ${m.source_name}`, locked, sourceUrl };
  }
  return { badge: `#${m.accolade_rank}`, detail: `${m.article_title} — ${m.source_name}`, locked, sourceUrl };
}

/**
 * "Most prominent" = a win beats any numeric rank; among ranks (scraped or
 * from the curator's own lists), lowest number wins; a nomination ranks
 * below both, but still shows when it's all a film has. Curator-built lists
 * participate in "auto" without needing a separate lock — building the
 * list is already the curation act.
 */
export function resolveAccolade(imdbId: string): ResolvedAccolade | null {
  const lock = getLock(imdbId);

  if (lock?.locked_accolade_entry_id) {
    const entry = getCuratorAccoladeEntry(lock.locked_accolade_entry_id);
    if (entry) return { badge: `#${entry.slot + 1}`, detail: entry.accolade_name, locked: true, sourceUrl: null };
  }
  if (lock?.locked_accolade_link_id) {
    const mention = getAccoladeMention(lock.locked_accolade_link_id);
    if (mention) return fromMention(mention, true);
  }

  const scraped = accoladeMentionsForFilm(imdbId);
  // Only a genuine win short-circuits the ranked list below. articles.ts
  // orders every labelled row ahead of the ranked ones without distinguishing
  // "Won:" from "Nominated:", so matching on the label alone here would let a
  // nomination suppress a real #1 placement purely by row order.
  const win = scraped.find((m) => m.accolade_label && isWinLabel(m.accolade_label));
  if (win) return fromMention(win, false);

  const curator = curatorAccoladeMentionsForFilm(imdbId);
  const ranked = [
    ...scraped
      .filter((m) => m.accolade_rank != null)
      .map((m) => ({
        rank: m.accolade_rank!,
        label: `${m.article_title} — ${m.source_name}`,
        sourceUrl: m.article_url.startsWith("http") ? m.article_url : null,
      })),
    ...curator.map((e) => ({ rank: e.slot + 1, label: e.accolade_name, sourceUrl: null })),
  ].sort((a, b) => a.rank - b.rank);

  const best = ranked[0];
  if (best) {
    return { badge: `#${best.rank}`, detail: best.label, locked: false, sourceUrl: best.sourceUrl };
  }

  // No win and nothing ranked — a nomination is still worth showing.
  const nomination = scraped.find((m) => m.accolade_label);
  return nomination ? fromMention(nomination, false) : null;
}
