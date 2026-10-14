import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSeriesPlan,
  chooseReference,
  headline,
  needsSubtitle,
  pickForEpisode,
  pickWithoutReference,
  summarise,
  type EpisodeSearch,
  type PlanDeps,
  type SeriesEpisode,
} from "./subtitle-series-plan.ts";
import type { SubtitleCandidate } from "./subtitle-match.ts";

const ep = (season: number, episode: number, over: Partial<SeriesEpisode> = {}): SeriesEpisode => ({
  path: `/media/Buffy/Season ${season}/Buffy.S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}.mp4`,
  season,
  episode,
  externalFile: null,
  embedded: [],
  jellyfinHasSubtitle: false,
  ...over,
});

const builtIn = (over: Partial<SeriesEpisode> = {}): Partial<SeriesEpisode> => ({
  embedded: [{ index: 2, codec: "mov_text", language: "eng" }],
  jellyfinHasSubtitle: true,
  ...over,
});

const cand = (over: Partial<SubtitleCandidate>): SubtitleCandidate => ({
  fileId: 1,
  fileName: null,
  release: null,
  uploader: null,
  hearingImpaired: false,
  fps: null,
  downloadCount: 0,
  hashMatch: false,
  ...over,
});

const SRT = (lines: string[]) =>
  lines.map((l, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\n${l}\n`).join("\n");
const REFERENCE_LINES = [
  "Into every generation a slayer is born",
  "One girl in all the world",
  "She alone will wield the strength and skill",
  "To fight the vampires, demons and the forces of darkness",
];

/** An OpenSubtitles stand-in: results per "season x episode", downloads counted. */
function mockDeps(opts: {
  results: Record<string, SubtitleCandidate[]>;
  files?: Record<number, string>;
  embeddedText?: string;
  externalText?: string;
}) {
  const searches: EpisodeSearch[] = [];
  const downloads: number[] = [];
  const reads: string[] = [];
  let remaining = 100;
  const deps: PlanDeps = {
    search: async (input) => {
      searches.push(input);
      return opts.results[`${input.season}x${input.episode}`] ?? [];
    },
    download: async (fileId) => {
      downloads.push(fileId);
      remaining -= 1;
      return { content: opts.files?.[fileId] ?? "", remaining };
    },
    readExternal: async (file) => {
      reads.push(`external:${file}`);
      return opts.externalText ?? "";
    },
    readEmbedded: async (e, track) => {
      reads.push(`embedded:${e.season}x${e.episode}#${track.index}`);
      if (opts.embeddedText === undefined) throw new Error("no ffmpeg");
      return opts.embeddedText;
    },
    moviehash: (path) => `hash:${path.slice(-10)}`,
    basename: (p) => p.split("/").pop()!,
  };
  return { deps, searches, downloads, reads };
}

const SHOW = { imdbId: "tt0118276", tmdbId: 95 };

/* ------------------------------------------------------------------ *
 * Reference selection: external, then embedded, then none
 * ------------------------------------------------------------------ */

test("reference: an external .srt wins over built-in tracks", () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 2, { externalFile: "/m/Buffy.S01E02.srt" }), ep(1, 3)];
  const ref = chooseReference(eps);
  assert.equal(ref.kind, "external");
  assert.equal(ref.kind === "external" && ref.episode.episode, 2);
});

test("reference: a built-in text track when no episode has an external file", () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 2, builtIn()), ep(1, 7)];
  const ref = chooseReference(eps);
  assert.equal(ref.kind, "embedded");
  assert.equal(ref.kind === "embedded" && ref.track.codec, "mov_text");
});

test("reference: image-only and foreign tracks are not a reference; nothing usable means none", () => {
  const eps = [
    ep(1, 1, builtIn({ embedded: [{ index: 2, codec: "hdmv_pgs_subtitle", language: "eng" }] })),
    ep(1, 2, builtIn({ embedded: [{ index: 3, codec: "subrip", language: "fre" }] })),
    ep(1, 3),
  ];
  assert.equal(chooseReference(eps).kind, "none");
  assert.equal(chooseReference([ep(1, 1), ep(1, 2)]).kind, "none");
});

test("reference: English before unlabelled, and from the season with the most to fill", () => {
  const eps = [
    ep(1, 1, builtIn({ embedded: [{ index: 2, codec: "mov_text", language: "und" }] })),
    ep(2, 1, builtIn()),
    ep(3, 1, builtIn()),
    ep(3, 5),
    ep(3, 6),
    ep(2, 13),
  ];
  const ref = chooseReference(eps);
  assert.equal(ref.kind === "embedded" && `${ref.episode.season}x${ref.episode.episode}`, "3x1");
});

/* ------------------------------------------------------------------ *
 * Only episodes with no subtitle at all
 * ------------------------------------------------------------------ */

test("needsSubtitle: built-in or external means it has one", () => {
  assert.equal(needsSubtitle(ep(1, 1)), true);
  assert.equal(needsSubtitle(ep(1, 1, builtIn())), false);
  assert.equal(needsSubtitle(ep(1, 1, { externalFile: "/x.srt" })), false);
  // Jellyfin knows of a subtitle the stream list here doesn't break out.
  assert.equal(needsSubtitle(ep(1, 1, { jellyfinHasSubtitle: true })), false);
});

test("plan: episodes with built-in subtitles are skipped and counted in the header", async () => {
  // Buffy as found on 2026-10-14: 141 with a built-in track, 3 with none.
  const missing = new Set(["1x7", "2x13", "3x7"]);
  const eps: SeriesEpisode[] = [];
  for (let s = 1; s <= 7; s++)
    for (let e = 1; e <= (s === 1 ? 12 : 22); e++) eps.push(missing.has(`${s}x${e}`) ? ep(s, e) : ep(s, e, builtIn()));
  assert.equal(eps.length, 144);
  const { deps, searches } = mockDeps({ results: {}, embeddedText: SRT(REFERENCE_LINES) });
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);

  assert.deepEqual(plan.summary, { episodes: 144, needSubtitles: 3, builtIn: 141, external: 0, unparsed: 0 });
  assert.equal(plan.headline, "3 episodes need subtitles; 141 already have built-in ones.");
  assert.deepEqual(
    plan.episodes.map((e) => `${e.season}x${e.episode}`),
    ["1x7", "2x13", "3x7"],
  );
  // Searched: the reference once, and the three missing; never a built-in one.
  const searched = searches.map((s) => `${s.season}x${s.episode}`);
  assert.equal(searched.length, 4);
  for (const s of ["1x7", "2x13", "3x7"]) assert.ok(searched.includes(s));
});

test("headline: singular, external files, and unparsed files", () => {
  assert.equal(
    headline(summarise([ep(1, 1), ep(1, 2, builtIn()), ep(1, 3, { externalFile: "/a.srt" }), ep(1, 4, { externalFile: "/b.srt" })], 1)),
    "1 episode needs subtitles; 1 already has a built-in one; 2 have subtitle files. 1 file without an episode number in the name was left out.",
  );
});

/* ------------------------------------------------------------------ *
 * Ordering: family, then moviehash, then best-rated
 * ------------------------------------------------------------------ */

test("without a reference, a moviehash match beats a more popular release", () => {
  const pick = pickWithoutReference([
    cand({ fileId: 1, downloadCount: 90_000, fromTrusted: true, rating: 9, votes: 40 }),
    cand({ fileId: 2, downloadCount: 12, hashMatch: true }),
  ]);
  assert.equal(pick?.candidate.fileId, 2);
  assert.equal(pick?.method, "moviehash");
});

test("best-rated: not hearing-impaired, trusted, rated with votes, then downloads", () => {
  const pick = pickWithoutReference([
    cand({ fileId: 1, downloadCount: 50_000, hearingImpaired: true }),
    cand({ fileId: 2, downloadCount: 40_000 }),
    cand({ fileId: 3, downloadCount: 5_000, rating: 8.5, votes: 12 }),
    cand({ fileId: 4, downloadCount: 1_000, rating: 10, votes: 1 }), // one vote doesn't count
  ]);
  assert.equal(pick?.candidate.fileId, 3);
  assert.equal(pick?.method, "best-rated");
  assert.equal(pickWithoutReference([cand({ fileId: 5, downloadCount: 3, fromTrusted: true }), cand({ fileId: 6, downloadCount: 9 })])?.candidate.fileId, 5);
  assert.equal(pickWithoutReference([]), null);
});

test("with a family, the family's file beats a moviehash match from another uploader", () => {
  const family = { uploader: "kitsune", release: "Buffy.S01E01.DVDRip.XviD-SAiNTS", fileName: null, hearingImpaired: false, fps: null };
  const pick = pickForEpisode(
    [
      cand({ fileId: 1, uploader: "someone", hashMatch: true, downloadCount: 10 }),
      cand({ fileId: 2, uploader: "kitsune", release: "Buffy.S01E07.DVDRip.XviD-SAiNTS", downloadCount: 5 }),
    ],
    family,
    "Buffy.S01E07.mp4",
  );
  assert.equal(pick?.candidate.fileId, 2);
  assert.equal(pick?.method, "family");
});

test("with a family that has no file for the episode, moviehash then best-rated", () => {
  const family = { uploader: "kitsune", release: "Buffy.S01E01.DVDRip.XviD-SAiNTS", fileName: null, hearingImpaired: false, fps: null };
  const synced = pickForEpisode(
    [cand({ fileId: 1, uploader: "a", downloadCount: 900 }), cand({ fileId: 2, uploader: "b", hashMatch: true })],
    family,
    "Buffy.S02E13.mp4",
  );
  // A hash match alone clears the family score bar; it is picked as what it is.
  assert.equal(synced?.candidate.fileId, 2);
  assert.equal(synced?.method, "moviehash");
  const rated = pickForEpisode([cand({ fileId: 1, uploader: "a", downloadCount: 900 }), cand({ fileId: 3, uploader: "c", downloadCount: 50 })], family, "Buffy.S02E13.mp4");
  assert.equal(rated?.candidate.fileId, 1);
  assert.equal(rated?.method, "best-rated");
});

/* ------------------------------------------------------------------ *
 * End to end through the planner, OpenSubtitles mocked
 * ------------------------------------------------------------------ */

test("plan: an embedded reference is read, identified by its words, and its family picked", async () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 2, builtIn()), ep(1, 7)];
  const { deps, downloads, reads, searches } = mockDeps({
    embeddedText: SRT(REFERENCE_LINES),
    results: {
      "1x1": [
        cand({ fileId: 11, uploader: "other", release: "Buffy.S01E01.WEB", downloadCount: 900 }),
        cand({ fileId: 12, uploader: "kitsune", release: "Buffy.S01E01.DVDRip.XviD-SAiNTS", downloadCount: 500 }),
      ],
      "1x7": [
        cand({ fileId: 71, uploader: "other", release: "Buffy.S01E07.WEB", downloadCount: 900 }),
        cand({ fileId: 72, uploader: "kitsune", release: "Buffy.S01E07.DVDRip.XviD-SAiNTS", downloadCount: 100 }),
      ],
    },
    files: { 11: SRT(["Something else entirely", "Nothing alike here"]), 12: SRT(REFERENCE_LINES) },
  });
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);

  assert.equal(plan.reference.kind, "embedded");
  assert.equal(plan.reference.source, "built-in track 2 (mov_text, eng)");
  assert.deepEqual(reads, ["embedded:1x1#2"]);
  assert.equal(plan.reference.family?.uploader, "kitsune");
  assert.deepEqual(downloads, [11, 12]); // most-downloaded first, stopped at the match
  assert.equal(plan.downloadsUsed, 2);
  assert.equal(plan.downloadsLeft, 98);
  assert.equal(plan.episodes[0]?.pick?.fileId, 72);
  assert.equal(plan.episodes[0]?.pick?.method, "family");
  // The reference is searched with its own video's hash; the show id is the parent.
  assert.equal(searches[0]?.moviehash, `hash:${eps[0]!.path.slice(-10)}`);
  assert.equal(searches[0]?.parentImdbId, "tt0118276");
});

test("plan: external reference is preferred and read from disk, not extracted", async () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 2, { externalFile: "/m/Buffy.S01E02.eng.srt" }), ep(1, 3)];
  const { deps, reads } = mockDeps({ results: {}, externalText: SRT(REFERENCE_LINES), embeddedText: "" });
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);
  assert.equal(plan.reference.kind, "external");
  assert.equal(plan.reference.source, "Buffy.S01E02.eng.srt");
  assert.deepEqual(reads, ["external:/m/Buffy.S01E02.eng.srt"]);
});

test("plan: no reference at all — no downloads spent, each episode matched on its own", async () => {
  const eps = [ep(1, 1), ep(1, 2)];
  const { deps, downloads } = mockDeps({
    results: {
      "1x1": [cand({ fileId: 1, downloadCount: 900 }), cand({ fileId: 2, hashMatch: true })],
      "1x2": [cand({ fileId: 3, downloadCount: 900 }), cand({ fileId: 4, downloadCount: 10 })],
    },
  });
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);
  assert.equal(plan.reference.kind, "none");
  assert.match(plan.reference.note, /matched on its own/);
  assert.deepEqual(downloads, []);
  assert.deepEqual(
    plan.episodes.map((e) => [e.pick?.fileId, e.pick?.method]),
    [
      [2, "moviehash"],
      [3, "best-rated"],
    ],
  );
});

test("plan: an unreadable built-in track falls back to matching each episode on its own", async () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 7)];
  const { deps, downloads } = mockDeps({ results: { "1x7": [cand({ fileId: 9, downloadCount: 5 })] } }); // readEmbedded throws
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);
  assert.equal(plan.reference.kind, "embedded");
  assert.match(plan.reference.note, /Couldn't read built-in track 2.*on its own/);
  assert.equal(plan.reference.family, null);
  assert.deepEqual(downloads, []);
  assert.equal(plan.episodes[0]?.pick?.method, "best-rated");
});

test("plan: a reference no search result matches doesn't block the others", async () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 7)];
  const { deps, downloads } = mockDeps({
    embeddedText: SRT(REFERENCE_LINES),
    results: {
      "1x1": [cand({ fileId: 11, downloadCount: 9 })],
      "1x7": [cand({ fileId: 71, hashMatch: true })],
    },
    files: { 11: SRT(["Not it at all", "Different words"]) },
  });
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);
  assert.equal(plan.reference.family, null);
  assert.match(plan.reference.note, /None of its 1 OpenSubtitles results/);
  assert.deepEqual(downloads, [11]);
  assert.equal(plan.episodes[0]?.pick?.method, "moviehash");
});

test("plan: identifying spends at most five downloads", async () => {
  const eps = [ep(1, 1, builtIn()), ep(1, 7)];
  const many = Array.from({ length: 9 }, (_, i) => cand({ fileId: 100 + i, downloadCount: 100 - i }));
  const { deps, downloads } = mockDeps({ embeddedText: SRT(REFERENCE_LINES), results: { "1x1": many } });
  await buildSeriesPlan({ episodes: eps, unparsed: 0, show: SHOW }, deps);
  assert.equal(downloads.length, 5);
});

test("plan: nothing missing means no searches and no downloads", async () => {
  const { deps, searches, downloads } = mockDeps({ results: {}, embeddedText: SRT(REFERENCE_LINES) });
  const plan = await buildSeriesPlan({ episodes: [ep(1, 1, builtIn()), ep(1, 2, builtIn())], unparsed: 0, show: SHOW }, deps);
  assert.equal(plan.headline, "0 episodes need subtitles; 2 already have built-in ones.");
  assert.deepEqual(plan.episodes, []);
  assert.deepEqual(searches, []);
  assert.deepEqual(downloads, []);
});

test("plan: an episode's own id is searched by when known", async () => {
  const eps = [ep(1, 7, { episodeImdbId: "tt0533443", episodeTmdbId: 991 })];
  const { deps, searches } = mockDeps({ results: {} });
  const plan = await buildSeriesPlan({ episodes: eps, unparsed: 0, show: { imdbId: null, tmdbId: null } }, deps);
  assert.equal(searches[0]?.episodeImdbId, "tt0533443");
  assert.equal(plan.episodes[0]?.status, "no-match");
});
