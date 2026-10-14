/**
 * The Picks tab's data shaping (step 2e of moving the console). Ported from
 * curator.html (pkChips, pkRenderEditor, pkRenderItems, pkSaveItem and the
 * reorder helpers); no React, so it can be tested.
 */

const DAY = 864e5;
const HOME_DAYS = 7;

export interface Pick {
  id: string;
  title: string;
  subtitle: string | null;
  status: "live" | "draft";
  audience: "everyone" | "people";
  ranked: boolean | number;
  labelled?: boolean | number;
  pinned: boolean | number;
  published_at: number | null;
  recipient_count: number;
  item_count: number;
  matched_count: number;
  source_label?: string | null;
}

export interface PickItem {
  id: string;
  displayTitle: string;
  displayYear: number | null;
  kind: "film" | "show" | "episode";
  inLibrary: boolean;
  posterUrl: string | null;
  imdb_id: string | null;
  rank: number | null;
  label: string | null;
  writeup: string | null;
  writeup_source_label: string | null;
  writeup_source_url: string | null;
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function pickChips(p: Pick, now: number): Array<{ text: string; tone: "" | "live" | "people" | "warm" }> {
  const chips: Array<{ text: string; tone: "" | "live" | "people" | "warm" }> = [];
  chips.push({ text: p.status === "live" ? "Live" : "Draft", tone: p.status === "live" ? "live" : "" });
  chips.push(
    p.audience === "people"
      ? { text: `${p.recipient_count} ${p.recipient_count === 1 ? "person" : "people"}`, tone: "people" }
      : { text: "Everyone", tone: "" },
  );
  if (p.status === "live") {
    if (p.pinned) chips.push({ text: "Pinned to Home", tone: "warm" });
    else if (p.published_at && now - p.published_at < HOME_DAYS * DAY) chips.push({ text: `On Home until ${shortDate(p.published_at + HOME_DAYS * DAY)}`, tone: "" });
  }
  chips.push({ text: `${p.matched_count}${p.item_count !== p.matched_count ? ` of ${p.item_count}` : ""} titles`, tone: "" });
  return chips;
}

export type Under = "number" | "word" | "nothing";

export function underOf(p: Pick): Under {
  return p.ranked ? "number" : p.labelled ? "word" : "nothing";
}

export function statusLine(p: Pick): string {
  return p.status === "live"
    ? `Live since ${p.published_at ? shortDate(p.published_at) : "—"}. Changes show on the site as you make them.`
    : "Draft. Not on the site until you publish it.";
}

export function homeNote(p: Pick, now: number): string {
  if (p.pinned) return "Stays on Home until you untick this.";
  if (p.status === "live" && p.published_at) {
    const until = p.published_at + HOME_DAYS * DAY;
    return now - p.published_at < HOME_DAYS * DAY ? `On Home until ${shortDate(until)}.` : `No longer on Home. Its week ended ${shortDate(until)}.`;
  }
  return "On Home for 7 days from publishing.";
}

export function publishQuestion(p: Pick, recipients: number): string {
  const who =
    p.audience === "people" ? `${recipients}${recipients === 1 ? " person, who will be notified" : " people, who will be notified"}` : "everyone";
  return `Publish “${p.title}” to ${who}?`;
}

export function splitItems(items: readonly PickItem[]): { present: Array<{ it: PickItem; index: number }>; missing: Array<{ it: PickItem; index: number }> } {
  const present: Array<{ it: PickItem; index: number }> = [];
  const missing: Array<{ it: PickItem; index: number }> = [];
  items.forEach((it, index) => (it.inLibrary ? present : missing).push({ it, index }));
  return { present, missing };
}

export function countsLine(present: number, missing: number): string {
  return `${present} ${present === 1 ? "title" : "titles"} on the site${missing ? ` · ${missing} not in the library` : ""}`;
}

/** Moves one id up or down; null when it can't move that way. */
export function moved(ids: readonly string[], id: string, dir: "up" | "down"): string[] | null {
  const i = ids.indexOf(id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  next.splice(j, 0, next.splice(i, 1)[0]!);
  return next;
}

/** Drops `dragged` in front of `target`, as the old drag-and-drop did. */
export function droppedBefore(ids: readonly string[], dragged: string, target: string): string[] {
  if (dragged === target) return [...ids];
  const rest = ids.filter((x) => x !== dragged);
  const at = rest.indexOf(target);
  rest.splice(at < 0 ? rest.length : at, 0, dragged);
  return rest;
}

/** Titles the library lacks keep their place after the ones shown. */
export function fullOrder(shownIds: readonly string[], items: readonly PickItem[]): string[] {
  const shown = new Set(shownIds);
  return [...shownIds, ...items.filter((it) => !shown.has(it.id)).map((it) => it.id)];
}

export interface ItemDraft {
  writeup: string;
  credit: string;
  creditUrl: string | null;
  rank?: string;
  word?: string;
}

/** The PATCH body; a link belongs to its credit, so clearing one clears the other. */
export function itemBody(d: ItemDraft): Record<string, unknown> {
  const label = d.credit.trim();
  const body: Record<string, unknown> = {
    writeup: d.writeup,
    writeup_source_label: label || null,
    writeup_source_url: label ? d.creditUrl || null : null,
  };
  if (d.rank !== undefined) body.rank = d.rank.trim() === "" ? null : Number(d.rank);
  if (d.word !== undefined) body.label = d.word.trim() || null;
  return body;
}

/** "Use this" replaces the writeup; "Add below" appends a paragraph. */
export function usePassage(current: string, passage: string, how: "replace" | "append"): string {
  return how === "append" && current.trim() ? `${current.replace(/\s+$/, "")}\n\n${passage}` : passage;
}

export function sourceBits(src: { inLibrary: number; entries: number; ranked: boolean; withWriteups?: number }): string {
  const bits = [`${src.inLibrary} of ${src.entries} in the library`, src.ranked ? "ranked" : "unranked"];
  if (src.withWriteups) bits.push(`${src.withWriteups} with a writeup`);
  return bits.join(" · ");
}

export function keptLine(k: { restored?: boolean; leftBecause?: string; leftAt: number; rank?: number | null; label?: string | null }): string {
  const how = k.restored ? "back in the pick" : k.leftBecause === "deleted" ? `deleted ${shortDate(k.leftAt)}` : `kept in the library, ${shortDate(k.leftAt)}`;
  return how + (k.rank ? ` · was number ${k.rank}` : "") + (k.label ? ` · “${k.label}”` : "");
}

export function stripTags(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();
}
