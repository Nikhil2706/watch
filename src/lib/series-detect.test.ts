/**
 * Tests for series detection and what the auto-grouper does with it.
 *
 * Run:
 *   node --test --experimental-strip-types \
 *        --disable-warning=ExperimentalWarning src/lib/series-detect.test.ts
 *
 * The case that started this: "Nirvanna the Band the Show", 16 files, season
 * two named "NtBtS.S02E01.The.Burger.1080p.mkv", shown as sixteen films until
 * it was grouped by hand on 2026-10-14.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectSeries,
  filenameEpisodeMarker,
  isRecognisedEpisode,
  planGrouping,
  showFolderOf,
  type EpisodeFile,
  type GroupingState,
} from "./series-detect.ts";

const ROOT = "/media";

function file(path: string, extra: Partial<EpisodeFile> = {}): EpisodeFile {
  return { path, omdb: null, tmdbTvId: null, ...extra };
}

function omdbEpisode(seriesImdbId: string): Pick<EpisodeFile, "omdb"> {
  return { omdb: { type: "episode", seriesImdbId } };
}

function emptyState(overrides: Partial<GroupingState> = {}): GroupingState {
  return {
    groupOf: new Map(),
    groups: [],
    declinedKeys: new Set(),
    declinedPaths: new Set(),
    names: new Map(),
    ...overrides,
  };
}

/* ---- the filename ---- */

test("reads SxxEyy wherever it sits in the name", () => {
  assert.deepEqual(
    { ...filenameEpisodeMarker("/media/TV/NtBtS.S02E01.The.Burger.1080p.mkv") },
    { season: 2, episode: 1, index: 6 },
  );
  assert.equal(filenameEpisodeMarker("/media/x/s01e03.mkv")?.episode, 3);
  assert.equal(filenameEpisodeMarker("/media/x/Show - S1E12 - Title.mp4")?.season, 1);
  assert.equal(filenameEpisodeMarker("/media/ER/er.03x02.Dr.Carter.avi")?.episode, 2);
});

test("does not take a film's name for an episode", () => {
  for (const name of [
    "/media/Horror/Se7en.1995.1080p.mkv",
    "/media/Action/300.2006.BluRay.mkv",
    "/media/Drama/Movie.1920x1080.mkv",
    "/media/Sci-Fi/2001.A.Space.Odyssey.mkv",
    "/media/Italian/Atti degli apostoli 2⁄5.mkv",
    "/media/Docs/Part 1 of 3.mkv",
    "/media/Crime/Ocean's.Eleven.2001.x264.mkv",
  ]) {
    assert.equal(filenameEpisodeMarker(name), null, name);
    assert.equal(isRecognisedEpisode(file(name)), false, name);
  }
});

test("metadata alone is enough to recognise an episode", () => {
  assert.equal(isRecognisedEpisode(file("/media/Comedy/The Burger.mkv", omdbEpisode("tt1"))), true);
  assert.equal(isRecognisedEpisode(file("/media/Comedy/The Burger.mkv", { tmdbTvId: 4 })), true);
  // OMDb calling it a movie is not.
  assert.equal(
    isRecognisedEpisode(file("/media/Comedy/The Burger.mkv", { omdb: { type: "movie", seriesImdbId: null } })),
    false,
  );
});

test("a season folder belongs to the show folder above it", () => {
  assert.equal(showFolderOf("/media/TV/Nirvanna/Season 2/x.mkv", ROOT), "/media/TV/Nirvanna");
  assert.equal(showFolderOf("/media/TV/Nirvanna/S02/x.mkv", ROOT), "/media/TV/Nirvanna");
  assert.equal(showFolderOf("/media/TV/Nirvanna/x.mkv", ROOT), "/media/TV/Nirvanna");
  assert.equal(showFolderOf("/media/x.mkv", ROOT), null);
});

/* ---- which files are one series ---- */

test("Nirvanna: OMDb-identified season one and a filename-only season two are one show", () => {
  const show = "/media/TV/Nirvanna the Band the Show";
  const files = [
    ...Array.from({ length: 8 }, (_, i) =>
      file(`${show}/Season 1/Nirvanna.the.Band.the.Show.S01E0${i + 1}.mkv`, omdbEpisode("tt7015472")),
    ),
    ...Array.from({ length: 8 }, (_, i) => file(`${show}/Season 2/NtBtS.S02E0${i + 1}.The.Burger.1080p.mkv`)),
    file("/media/Comedy/Superbad.2007.mkv"),
  ];
  const clusters = detectSeries(files, ROOT);
  assert.equal(clusters.length, 1);
  const [c] = clusters;
  assert.equal(c!.key, "imdb:tt7015472");
  assert.equal(c!.evidence, "omdb");
  assert.equal(c!.paths.length, 16);
  assert.equal(c!.folderName, "Nirvanna the Band the Show");
});

test("filename-only seasons with different names join when laid out in season folders", () => {
  const show = "/media/TV/Nirvanna the Band the Show";
  const clusters = detectSeries(
    [
      file(`${show}/Season 1/Nirvanna.the.Band.the.Show.S01E01.mkv`),
      file(`${show}/Season 1/Nirvanna.the.Band.the.Show.S01E02.mkv`),
      file(`${show}/Season 2/NtBtS.S02E01.The.Burger.1080p.mkv`),
      file(`${show}/Season 2/NtBtS.S02E02.mkv`),
    ],
    ROOT,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.evidence, "filename");
  assert.equal(clusters[0]!.paths.length, 4);
  assert.equal(clusters[0]!.folderName, "Nirvanna the Band the Show");
});

test("metadata beats the filename: one folder, two OMDb series, stays two", () => {
  const files = [
    file("/media/TV/Misc/Show.S01E01.mkv", omdbEpisode("ttA")),
    file("/media/TV/Misc/Show.S01E02.mkv", omdbEpisode("ttA")),
    file("/media/TV/Misc/Show.S01E03.mkv", omdbEpisode("ttB")),
  ];
  const clusters = detectSeries(files, ROOT);
  assert.deepEqual(
    clusters.map((c) => [c.key, c.paths.length]),
    [
      ["imdb:ttA", 2],
      ["imdb:ttB", 1],
    ],
  );
});

test("a filename-only file joins the one metadata series in its folder", () => {
  const clusters = detectSeries(
    [
      file("/media/TV/Fargo/Fargo.S01E01.mkv", { tmdbTvId: 60622 }),
      file("/media/TV/Fargo/Fargo.S01E02.mkv", { tmdbTvId: 60622 }),
      file("/media/TV/Fargo/Fargo.S01E03.mkv"),
    ],
    ROOT,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.key, "tmdb:60622");
  assert.equal(clusters[0]!.paths.length, 3);
});

test("with two metadata series in a folder, the filename's name decides, or nothing does", () => {
  const clusters = detectSeries(
    [
      file("/media/TV/Dump/Lost.S01E01.mkv", omdbEpisode("ttLost")),
      file("/media/TV/Dump/Fargo.S01E01.mkv", omdbEpisode("ttFargo")),
      file("/media/TV/Dump/Lost.S01E02.mkv"),
      file("/media/TV/Dump/Twin.Peaks.S01E01.mkv"),
    ],
    ROOT,
  );
  const byKey = new Map(clusters.map((c) => [c.key, c.paths]));
  assert.deepEqual(byKey.get("imdb:ttLost"), ["/media/TV/Dump/Lost.S01E01.mkv", "/media/TV/Dump/Lost.S01E02.mkv"]);
  assert.deepEqual(byKey.get("imdb:ttFargo"), ["/media/TV/Dump/Fargo.S01E01.mkv"]);
  // Twin Peaks is nobody's: its own series, by filename.
  assert.ok([...byKey.values()].some((p) => p.length === 1 && p[0] === "/media/TV/Dump/Twin.Peaks.S01E01.mkv"));
});

test("a plain folder of mixed shows, filenames only, stays split by name", () => {
  const clusters = detectSeries(
    [
      file("/media/TV/Lost.S01E01.mkv"),
      file("/media/TV/Lost.S01E02.mkv"),
      file("/media/TV/Fargo.S01E01.mkv"),
      file("/media/TV/Fargo.S01E02.mkv"),
    ],
    ROOT,
  );
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((c) => c.filenameName).sort(), ["Fargo", "Lost"]);
  // The folder holds two shows, so it names neither.
  assert.ok(clusters.every((c) => c.folderName === null));
});

test("OMDb and TMDB ids for the same show are tied together by a file that has both", () => {
  const clusters = detectSeries(
    [
      file("/media/A/one.mkv", omdbEpisode("ttX")),
      file("/media/B/two.mkv", { ...omdbEpisode("ttX"), tmdbTvId: 9 }),
      file("/media/C/three.mkv", { tmdbTvId: 9 }),
    ],
    ROOT,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.key, "imdb:ttX");
  assert.equal(clusters[0]!.tmdbTvId, 9);
});

test("the key does not depend on the order the library lists files in", () => {
  const files = [
    file("/media/TV/S/a.S01E01.mkv", omdbEpisode("ttX")),
    file("/media/TV/S/a.S01E02.mkv", { ...omdbEpisode("ttY"), tmdbTvId: 1 }),
    file("/media/TV/S/a.S01E03.mkv", { ...omdbEpisode("ttX"), tmdbTvId: 1 }),
  ];
  const forward = detectSeries(files, ROOT).map((c) => c.key);
  const backward = detectSeries([...files].reverse(), ROOT).map((c) => c.key);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ["imdb:ttX"]);
});

/* ---- what the auto-grouper does ---- */

const NIRVANNA = [
  file("/media/TV/N/N.S01E01.mkv", omdbEpisode("ttN")),
  file("/media/TV/N/N.S01E02.mkv", omdbEpisode("ttN")),
  file("/media/TV/N/N.S01E03.mkv", omdbEpisode("ttN")),
];

test("two or more loose episodes become a new group, named after the series", () => {
  const steps = planGrouping(detectSeries(NIRVANNA, ROOT), emptyState({ names: new Map([["imdb:ttN", "Nirvanna the Band the Show"]]) }));
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action, "create");
  assert.equal(steps[0]!.action === "create" && steps[0]!.name, "Nirvanna the Band the Show");
  assert.equal(steps[0]!.paths.length, 3);
});

test("dissolved stays dissolved: the files the curator ungrouped are not grouped again", () => {
  const clusters = detectSeries(NIRVANNA, ROOT);
  const steps = planGrouping(
    clusters,
    emptyState({
      declinedKeys: new Set(["imdb:ttN"]),
      declinedPaths: new Set(NIRVANNA.map((f) => f.path)),
    }),
  );
  assert.deepEqual(steps, []);
});

test("dissolved stays dissolved: a new episode of that series waits for the curator instead", () => {
  const newEpisode = file("/media/TV/N/N.S01E04.mkv", omdbEpisode("ttN"));
  const newer = file("/media/TV/N/N.S01E05.mkv", omdbEpisode("ttN"));
  const steps = planGrouping(
    detectSeries([...NIRVANNA, newEpisode, newer], ROOT),
    emptyState({
      declinedKeys: new Set(["imdb:ttN"]),
      declinedPaths: new Set(NIRVANNA.map((f) => f.path)),
    }),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action, "wait");
  assert.equal(steps[0]!.action === "wait" && steps[0]!.why, "dissolved");
  assert.deepEqual(steps[0]!.paths, [newEpisode.path, newer.path]);
});

test("a file taken out of a group by hand is not put back", () => {
  const groupOf = new Map([
    [NIRVANNA[0]!.path, "g1"],
    [NIRVANNA[1]!.path, "g1"],
  ]);
  const steps = planGrouping(
    detectSeries(NIRVANNA, ROOT),
    emptyState({
      groupOf,
      groups: [{ groupId: "g1", name: "Nirvanna", seriesImdbId: null, tmdbTvId: null }],
      declinedPaths: new Set([NIRVANNA[2]!.path]),
    }),
  );
  assert.deepEqual(steps, []);
});

test("a new episode joins the group its siblings are in, and nothing grouped moves", () => {
  const groupOf = new Map([
    [NIRVANNA[0]!.path, "curators"],
    [NIRVANNA[1]!.path, "curators"],
  ]);
  const steps = planGrouping(
    detectSeries(NIRVANNA, ROOT),
    emptyState({ groupOf, groups: [{ groupId: "curators", name: "My Nirvanna", seriesImdbId: null, tmdbTvId: null }] }),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action, "add");
  assert.equal(steps[0]!.action === "add" && steps[0]!.groupId, "curators");
  assert.deepEqual(steps[0]!.paths, [NIRVANNA[2]!.path]);
});

test("episodes whose siblings sit in two different groups are left for the curator", () => {
  const groupOf = new Map([
    [NIRVANNA[0]!.path, "g1"],
    [NIRVANNA[1]!.path, "g2"],
  ]);
  const steps = planGrouping(
    detectSeries(NIRVANNA, ROOT),
    emptyState({
      groupOf,
      groups: [
        { groupId: "g1", name: "A", seriesImdbId: null, tmdbTvId: null },
        { groupId: "g2", name: "B", seriesImdbId: null, tmdbTvId: null },
      ],
    }),
  );
  assert.equal(steps[0]!.action, "wait");
  assert.equal(steps[0]!.action === "wait" && steps[0]!.why, "ambiguous");
});

test("a group linked to the same series is found even with nothing of it grouped yet", () => {
  const steps = planGrouping(
    detectSeries(NIRVANNA, ROOT),
    emptyState({ groups: [{ groupId: "g", name: "Something else", seriesImdbId: "ttN", tmdbTvId: null }] }),
  );
  assert.equal(steps[0]!.action, "add");
});

test("one loose episode of a series nobody has grouped waits rather than becoming a show of one", () => {
  const steps = planGrouping(detectSeries([NIRVANNA[0]!], ROOT), emptyState());
  assert.equal(steps[0]!.action, "wait");
  assert.equal(steps[0]!.action === "wait" && steps[0]!.why, "one-file");
});

test("a name falls back from metadata to the folder to the filename", () => {
  const steps = planGrouping(
    detectSeries(
      [file("/media/TV/Lost.S01E01.mkv"), file("/media/TV/Lost.S01E02.mkv"), file("/media/TV/Other film.mkv")],
      ROOT,
    ),
    emptyState(),
  );
  assert.equal(steps[0]!.action === "create" && steps[0]!.name, "Lost");
});
