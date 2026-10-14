import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BULK_PATCH,
  buildRows,
  bulkRequest,
  collapseDuplicates,
  copySpecs,
  duplicateCopies,
  filterChips,
  memberMarks,
  otherCopies,
  patchItems,
  railSub,
  readableName,
  reasonChips,
  reasonsFor,
  rowById,
  scanReport,
  scannedAgo,
  stateDot,
  statusLine,
  toggleFilter,
  toggleReason,
  visibleRows,
  type LibraryItem,
  type Row,
  type ViewState,
} from "./library-rows.ts";

let n = 0;
function item(over: Partial<LibraryItem> = {}): LibraryItem {
  n += 1;
  return {
    id: `id${n}`,
    name: `Film ${n}`,
    year: 2000 + n,
    path: `/media/Films/Film ${n}.mp4`,
    groupId: null,
    posterUrl: null,
    height: 1080,
    sizeBytes: 1_000_000,
    subtitleCount: 1,
    imdbId: null,
    isDuplicate: false,
    isThinMetadata: false,
    isMissingSubtitles: false,
    damage: null,
    damageAllowed: false,
    isWhitelisted: false,
    isExcluded: false,
    isGrouped: false,
    groupName: null,
    version: null,
    pendingEpisode: null,
    needsDecision: false,
    ...over,
  } as LibraryItem;
}

const VIEW: ViewState = { query: "", filters: [], reason: null, sort: "needs" };
const damaged = { verdict: "damaged" as const, detail: "1,204 unreadable packets", checkedAt: 1 };

test("readableName decodes a URL-escaped filename and leaves anything else alone", () => {
  assert.equal(readableName("Kindl %28Farocki%29.mp4"), "Kindl (Farocki).mp4");
  assert.equal(readableName("100% Wolf"), "100% Wolf");
  assert.equal(readableName("bad %E0%A4%A"), "bad %E0%A4%A");
});

test("a show is one row whose flags are its episodes' union", () => {
  const eps = [
    item({ isGrouped: true, groupId: "g1", groupName: "The Curse", posterUrl: "/p1" }),
    item({ isGrouped: true, groupId: "g1", groupName: "The Curse", isMissingSubtitles: true }),
    item({ isGrouped: true, groupId: "g1", groupName: "The Curse", damage: damaged }),
  ];
  const rows = buildRows([item(), ...eps]);
  assert.equal(rows.length, 2);
  const show = rows[1]!;
  assert.equal(show.kind, "show");
  assert.equal(show.id, "group:g1");
  assert.equal(show.kind === "show" && show.members.length, 3);
  assert.equal(show.poster, "/p1");
  assert.equal(show.isMissingSubtitles, true);
  assert.equal(show.isDamaged, true);
  assert.equal(show.needsDecision, true); // one broken episode is the show's problem
});

test("a damaged episode shown anyway doesn't make its show need anything", () => {
  const rows = buildRows([item({ isGrouped: true, groupId: "g", groupName: "S", damage: damaged, damageAllowed: true })]);
  assert.equal(rows[0]!.isDamaged, false);
  assert.equal(rows[0]!.needsDecision, false);
});

test("PR #21: each episode in a show says whether it is damaged, shown anyway, or missing subtitles", () => {
  assert.deepEqual(memberMarks(item({ damage: damaged })), { damage: "damaged", noSubs: false });
  assert.deepEqual(memberMarks(item({ damage: damaged, damageAllowed: true, isMissingSubtitles: true })), { damage: "damaged, shown", noSubs: true });
  assert.deepEqual(memberMarks(item({ damage: { ...damaged, verdict: "minor" } })), { damage: null, noSubs: false });
});

test("PR #21: Open on an episode reaches that file, not 'no longer in the list'", () => {
  const ep = item({ isGrouped: true, groupId: "g", groupName: "S", damage: damaged });
  const items = [ep];
  const rows = buildRows(items);
  const opened = rowById(rows, items, ep.id);
  assert.equal(opened?.kind, "film");
  assert.equal(opened?.kind === "film" && opened.item.id, ep.id);
  assert.equal(opened?.isDamaged, true);
  assert.equal(rowById(rows, items, "gone"), null);
  assert.equal(rowById(rows, items, null), null);
});

test("special features: a suggestion and an unmapped feature need you; a mapped one doesn't", () => {
  const a = item(), b = item(), c = item();
  const rows = buildRows(
    [a, b, c],
    { [b.id]: { itemId: b.id, targets: [] }, [c.id]: { itemId: c.id, targets: [{ kind: "film", targetId: "x" }] } },
    { [a.id]: { itemId: a.id, confidence: 80, reasons: ["making-of"], targets: [] }, [c.id]: { itemId: c.id, confidence: 90, reasons: [], targets: [] } },
  );
  const [ra, rb, rc] = rows as Array<Extract<Row, { kind: "film" }>>;
  assert.deepEqual([ra!.needsDecision, rb!.needsDecision, rc!.needsDecision], [true, true, false]);
  assert.deepEqual(reasonsFor(ra!).map((r) => r.key), ["guess"]);
  assert.deepEqual(reasonsFor(rb!).map((r) => r.key), ["unmapped"]);
  assert.equal(rc!.featureGuess, null); // marked already: the guess no longer counts
  assert.equal(rc!.isSpecialFeature, true);
});

test("duplicates and loose episodes of one series collapse to one row with a count", () => {
  const pe = { key: "tt1", name: "Nirvanna the Band the Show", joins: false, files: 3 };
  const rows = buildRows([
    item({ name: "Heat", isDuplicate: true }),
    item({ name: "heat", isDuplicate: true }),
    item({ pendingEpisode: pe }),
    item({ pendingEpisode: pe }),
    item({ pendingEpisode: pe }),
    item(),
  ]);
  const out = collapseDuplicates(rows);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.dupCount, 2);
  assert.equal(out[1]!.dupCount, 3);
  assert.equal(railSub(out[0]!, VIEW), "2 copies · 2026".replace("2026", String(out[0]!.year)));
  assert.equal(railSub(out[1]!, VIEW), "3 episodes of Nirvanna the Band the Show, in no show");
  // The rows themselves are untouched.
  assert.equal(rows[0]!.dupCount, undefined);
});

test("facets AND together; Everything clears; a reason needs Needs you", () => {
  let st = toggleFilter({ filters: ["needs"], reason: "meta" }, "shows");
  assert.deepEqual(st, { filters: ["needs", "shows"], reason: "meta" });
  st = toggleFilter(st, "needs");
  assert.deepEqual(st, { filters: ["shows"], reason: null });
  assert.deepEqual(toggleFilter(st, "all"), { filters: [], reason: null });
  assert.equal(toggleReason("meta", "meta"), null);
  assert.equal(toggleReason(null, "dup"), "dup");
});

test("chip counts are against the other facets, collapsed like the rail", () => {
  const rows = buildRows([
    item({ isGrouped: true, groupId: "g", groupName: "S", isMissingSubtitles: true }),
    item({ isMissingSubtitles: true }),
    item({ name: "Heat", isDuplicate: true, needsDecision: true }),
    item({ name: "Heat", isDuplicate: true, needsDecision: true }),
  ]);
  const chips = Object.fromEntries(filterChips(rows, ["shows"]).map((c) => [c.key, c]));
  assert.equal(chips.nosubs!.count, 1); // one SHOW with no subtitles
  assert.equal(chips.shows!.on, true);
  assert.equal(chips.all!.on, false);
  const plain = Object.fromEntries(filterChips(rows, []).map((c) => [c.key, c]));
  assert.equal(plain.dup!.count, 1); // a pair counts once
  assert.equal(plain.dup!.alert, true);
  assert.equal(plain.nosubs!.alert, false);
  assert.equal(plain.all!.on, true);
  assert.equal(plain.all!.count, 3);
});

test("reason chips: only under Needs you, only non-empty, collapsed", () => {
  const rows = buildRows([
    item({ isThinMetadata: true, needsDecision: true }),
    item({ name: "Heat", isDuplicate: true, needsDecision: true }),
    item({ name: "Heat", isDuplicate: true, needsDecision: true }),
  ]);
  assert.deepEqual(reasonChips(rows, [], null), []);
  assert.deepEqual(
    reasonChips(rows, ["needs"], "dup").map((c) => [c.key, c.count, c.on]),
    [["meta", 1, false], ["dup", 1, true]],
  );
});

test("visible rows: search title, filename or year; narrow to a reason; sort", () => {
  const a = item({ name: "Wrong Match", path: "/media/Films/Amblin (1968).mp4", year: 1968 });
  const b = item({ name: "Zodiac", year: 2007, needsDecision: true, isThinMetadata: true, sizeBytes: 9e9, height: 480 });
  const c = item({ name: "Alien", year: 1979, sizeBytes: 5e9, height: 2160 });
  const s = item({ isGrouped: true, groupId: "g", groupName: "Mad Men" });
  const rows = buildRows([a, b, c, s]);
  const names = (v: Partial<ViewState>) => visibleRows(rows, { ...VIEW, ...v }).map((r) => r.name);
  assert.deepEqual(names({ query: "amblin" }), ["Wrong Match"]); // by filename
  assert.deepEqual(names({ query: "1979" }), ["Alien"]);
  assert.deepEqual(names({}), ["Zodiac", "Alien", "Mad Men", "Wrong Match"]); // needs-you first, then A–Z
  assert.deepEqual(names({ sort: "name" }), ["Alien", "Mad Men", "Wrong Match", "Zodiac"]);
  assert.deepEqual(names({ sort: "year" }), ["Zodiac", "Alien", "Wrong Match", "Mad Men"]); // shows last
  assert.deepEqual(names({ sort: "size" }), ["Zodiac", "Alien", "Wrong Match", "Mad Men"]);
  assert.deepEqual(names({ sort: "res" }), ["Zodiac", "Wrong Match", "Alien", "Mad Men"]);
  assert.deepEqual(names({ filters: ["needs"], reason: "meta" }), ["Zodiac"]);
  assert.deepEqual(names({ filters: ["needs"], reason: "dup" }), []);
});

test("rail second line says why, only in the undifferentiated Needs-you pile", () => {
  const [r] = buildRows([item({ year: 1999, isThinMetadata: true, needsDecision: true })]);
  assert.equal(railSub(r!, { filters: ["needs"], reason: null }), "1999 · No metadata");
  assert.equal(railSub(r!, { filters: ["needs"], reason: "meta" }), "1999");
  assert.equal(railSub(r!, { filters: [], reason: null }), "1999");
});

test("state dot, in the console's order", () => {
  const [hidden, nometa, dup, nosub, plain] = buildRows([
    item({ isExcluded: true, isThinMetadata: true }),
    item({ isThinMetadata: true }),
    item({ isDuplicate: true, name: "X" }),
    item({ isMissingSubtitles: true }),
    item(),
  ]);
  assert.deepEqual([hidden, nometa, dup, nosub, plain].map((r) => stateDot(r!)), ["danger", "warn", "warn", "dead", ""]);
  assert.equal(stateDot(buildRows([item({ isGrouped: true, groupId: "g", groupName: "S" })])[0]!), "accent");
});

test("status line", () => {
  assert.equal(statusLine(item()), "Nothing needs deciding");
  assert.equal(
    statusLine(item({ isThinMetadata: true, damage: damaged, isMissingSubtitles: true })),
    "No metadata fetched — hidden until fixed · Damaged file — off the site until replaced: 1,204 unreadable packets · No subtitles",
  );
  assert.equal(statusLine(item({ isThinMetadata: true, isWhitelisted: true, damage: damaged, damageAllowed: true })),
    "No metadata, shown anyway · Damaged file, shown anyway: 1,204 unreadable packets");
  assert.equal(statusLine(item({ pendingEpisode: { key: "k", name: "Mad Men", joins: true, files: 2 } })),
    "Episode of Mad Men, in no show — off the site until grouped");
  assert.equal(statusLine(item({ version: { label: "Director's cut", isPrimary: false, setSize: 2 } })), "Cut: Director's cut");
});

test("duplicate copies side by side, best by resolution; the others for keep-this", () => {
  const lo = item({ name: "Heat", isDuplicate: true, height: 480, sizeBytes: 734003200, subtitleCount: 0 });
  const hi = item({ name: "Heat", isDuplicate: true, height: 1080, sizeBytes: 4 * 1024 ** 3, subtitleCount: 3 });
  const rows = buildRows([lo, hi, item({ name: "Ronin" })]);
  const { copies, bestId } = duplicateCopies(rows, rows[0]!);
  assert.equal(copies.length, 2);
  assert.equal(bestId, hi.id);
  assert.equal(copySpecs(lo), "480p · 700.0 MB · no subtitles");
  assert.equal(copySpecs(hi), "1080p · 4.0 GB · 3 subtitle tracks");
  assert.deepEqual(otherCopies(rows, rows[1]!).map((r) => r.id), [lo.id]);
  assert.deepEqual(duplicateCopies(rows, rows[2]!).copies, []);
});

test("bulk actions: hide and show-anyway by path, subtitles by id", () => {
  const it = item({ path: "/media/x.mp4" });
  assert.deepEqual(bulkRequest("hide", it), { url: "/api/admin/library/exclude", body: { path: "/media/x.mp4" } });
  assert.deepEqual(bulkRequest("whitelist", it), { url: "/api/admin/library/whitelist", body: { path: "/media/x.mp4" } });
  assert.deepEqual(bulkRequest("subs", it), { url: "/api/admin/library/fetch-subtitles", body: { itemId: it.id } });
  assert.equal(bulkRequest("hide", { id: "a", path: null } as unknown as LibraryItem), null);
  const patched = patchItems([it], it.id, BULK_PATCH.hide!);
  assert.equal(patched[0]!.isExcluded, true);
  assert.equal(patched[0]!.needsDecision, false);
  assert.equal(it.isExcluded, false); // not mutated
});

test("scan wording", () => {
  const now = 1_000_000_000;
  assert.equal(scannedAgo(null, now), "never scanned");
  assert.equal(scannedAgo(now - 20_000, now), "scanned just now");
  assert.equal(scannedAgo(now - 5 * 60_000, now), "scanned 5 min ago");
  assert.equal(scannedAgo(now - 60 * 60_000, now), "scanned 1 hour ago");
  assert.equal(scannedAgo(now - 49 * 3600_000, now), "scanned 2 days ago");
  assert.equal(scanReport(3, 2), "3 new files picked up. 2 need a decision.");
  assert.equal(scanReport(-1, 0), "1 file no longer there. 0 need a decision.");
  assert.equal(scanReport(0, 5), "Nothing new. 5 need a decision.");
});

test("Identify starts from the title, not the release name", async () => {
  const { guessSearchName, episodeCode } = await import("./library-rows.ts");
  assert.equal(guessSearchName("The.Social.Network.2010.1080p.BluRay.x264-SPARKS"), "The Social Network 2010");
  assert.equal(guessSearchName("Amblin"), "Amblin");
  assert.equal(episodeCode({ season: 2, episode: 13 }), "S02E13");
});
