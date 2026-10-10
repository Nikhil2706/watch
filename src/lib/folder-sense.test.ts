import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimedTitle,
  folderHints,
  folderNamesPerson,
  matchAmongFilms,
  matchAmongSearch,
  type KnownFilm,
  type SearchedFilm,
} from "./folder-sense.ts";

const ROOT = "/media";

test("a folder is read as a genre, a country or a possible name", () => {
  assert.deepEqual(folderHints("/media/American/Steven Spielberg/Amblin.1968.VHSRIP.XViD-CG.avi", ROOT), [
    { kind: "name", folder: "Steven Spielberg", path: "/media/American/Steven Spielberg" },
    { kind: "country", folder: "American", path: "/media/American", languages: ["en"] },
  ]);
  const horror = folderHints("/media/Horror/Unclassified/Angst (1983) [1080p]/Angst.1983.mp4", ROOT);
  assert.deepEqual(horror.map((h) => h.kind), ["name", "genre"]);
  assert.equal(horror[1]!.kind === "genre" && horror[1]!.genreId, 27);
});

test("a folder that holds one film says nothing about the others", () => {
  assert.deepEqual(
    folderHints("/media/American/Safdie/Josh Safdie - (2006) We're Going to the Zoo/x.mp4", ROOT).map((h) => h.folder),
    ["Safdie", "American"],
  );
  assert.deepEqual(folderHints("/media/2025/Urchin (2025) [1080p]/Urchin.mp4", ROOT), []);
  assert.deepEqual(folderHints("/elsewhere/x.mp4", ROOT), []);
});

test("hand-typed folder names still name their person", () => {
  for (const [folder, person] of [
    ["Harun Farocki", "Harun Farocki"],
    ["Luca Guadanino", "Luca Guadagnino"],
    ["William Freidkin", "William Friedkin"],
    ["Roberto Rosselini", "Roberto Rossellini"],
    ["Kathour Ben Hania", "Kaouther Ben Hania"],
    ["Andrei Zulawski", "Andrzej Żuławski"],
    ["Park Chan Wook", "Park Chan-wook"],
    ["Jaume Collette Serra", "Jaume Collet-Serra"],
    ["Bresson", "Robert Bresson"],
    ["Safdie", "Benny Safdie"],
    ["Michael Angelo Covino and Kyle Marvin", "Kyle Marvin"],
  ] as const) {
    assert.ok(folderNamesPerson(folder, person), `${folder} -> ${person}`);
  }
});

test("a folder that is not a name does not become one", () => {
  assert.equal(folderNamesPerson("Horror", "Tobe Hooper"), false);
  assert.equal(folderNamesPerson("Star Wars", "George Lucas"), false);
  assert.equal(folderNamesPerson("Park", "Park Chan-wook"), false);
  assert.equal(folderNamesPerson("Paul Thomas Anderson", "Paul W.S. Anderson"), false);
  assert.equal(folderNamesPerson("Unclassified", "Robert Bresson"), false);
});

const FAROCKI = ["Harun Farocki"];

test("the director's name comes off a filename, wherever it was put", () => {
  const read = (file: string) => claimedTitle(`/media/Harun Farocki/${file}`, FAROCKI);
  assert.deepEqual(read("Harun Farocki - Between Two Wars.mkv"), { titles: ["Between Two Wars"], year: null });
  assert.equal(read("Harun Farocki - (1983) An Image.mkv").titles.includes("An Image"), true);
  assert.equal(read("Harun Farocki - (1983) An Image.mkv").year, 1983);
  assert.ok(read("Ein Bild %28Harun Farocki%2C 1983%29.mkv").titles.includes("Ein Bild"));
  assert.ok(read("Ausweg.Farocki.avi").titles.includes("Ausweg"));
  assert.ok(read("1966 Jeder ein Berliner Kindl %28Farocki%29.mkv").titles.includes("Jeder ein Berliner Kindl"));
  assert.ok(read("Harun Farocki-Parallel2.mkv").titles.includes("Parallel 2"));
  assert.ok(read("Die Schulung - Indoctrination - Harun Farocki %281987%29.avi").titles.includes("Indoctrination"));
  assert.ok(read("Aufschub.AKA.Respite.2007.DVDRip.x264-LAA.mkv").titles.includes("Respite"));
});

test("release tags and the year are not part of the title", () => {
  assert.deepEqual(claimedTitle("/media/American/Steven Spielberg/Amblin.1968.VHSRIP.XViD-CG.avi", ["Steven Spielberg"]), {
    titles: ["Amblin"],
    year: 1968,
  });
  const whip = claimedTitle(
    "/media/Italian/Mario Bava/La frusta e il corpo - The Whip And The Body (1963) 1080p h264 Ac3 Ita Eng Sub Eng-MIRCRew.mkv",
    ["Mario Bava"],
  );
  assert.equal(whip.year, 1963);
  assert.ok(whip.titles.includes("The Whip And The Body"));
  assert.ok(whip.titles.includes("La frusta e il corpo"));
});

test("a name inside a title stays in it", () => {
  assert.ok(claimedTitle("/media/French/Bresson/2014 - Hands of Bresson.mp4", ["Bresson", "Robert Bresson"]).titles.includes("Hands of Bresson"));
});

test("the folder holding one film is read as well as the file", () => {
  const read = claimedTitle("/media/French/Jacques Rivette/The Duchess of Langlois/Ne touchez pas la hache 2007 CD1.mkv", [
    "Jacques Rivette",
  ]);
  assert.equal(read.year, 2007);
  assert.ok(read.titles.includes("Ne touchez pas la hache"));
  assert.ok(read.titles.includes("The Duchess of Langlois"));
});

const SPIELBERG: KnownFilm[] = [
  { tmdbId: 1, title: "Amblin'", originalTitle: "Amblin'", year: 1968, directed: true },
  { tmdbId: 2, title: "Jaws", originalTitle: "Jaws", year: 1975, directed: true },
  { tmdbId: 3, title: "Spielberg", originalTitle: "Spielberg", year: 2017, directed: false },
];

test("Amblin in the Spielberg folder is his short, and certain", () => {
  const claim = claimedTitle("/media/American/Steven Spielberg/Amblin.1968.VHSRIP.XViD-CG.avi", ["Steven Spielberg"]);
  const match = matchAmongFilms(claim, SPIELBERG, "Steven Spielberg");
  assert.equal(match?.film.tmdbId, 1);
  assert.equal(match?.certainty, "certain");
  // Without a year in the name it is still the only Amblin he made.
  assert.equal(matchAmongFilms({ titles: ["Amblin"], year: null }, SPIELBERG, "Steven Spielberg")?.certainty, "certain");
});

test("a film he is only in, or a year that disagrees, is asked about", () => {
  assert.equal(matchAmongFilms({ titles: ["Spielberg"], year: 2017 }, SPIELBERG, "Steven Spielberg")?.certainty, "likely");
  assert.equal(matchAmongFilms({ titles: ["Jaws"], year: 1999 }, SPIELBERG, "Steven Spielberg")?.certainty, "likely");
  assert.equal(matchAmongFilms({ titles: ["Ready Player One"], year: 2018 }, SPIELBERG, "Steven Spielberg"), null);
});

const FAROCKI_FILMS: KnownFilm[] = [
  { tmdbId: 10, title: "An Image", originalTitle: "Ein Bild", year: 1983, directed: true },
  { tmdbId: 11, title: "Videograms of a Revolution", originalTitle: "Videogramme einer Revolution", year: 1992, directed: true },
  { tmdbId: 12, title: "Parallel I", originalTitle: "Parallele I", year: 2012, directed: true },
  { tmdbId: 13, title: "Parallel II", originalTitle: "Parallele II", year: 2014, directed: true },
  { tmdbId: 14, title: "Eye/Machine", originalTitle: "Auge/Maschine", year: 2001, directed: true },
  { tmdbId: 15, title: "How to Live in the German Federal Republic", originalTitle: "Leben - BRD", year: 1990, directed: true },
];

test("Farocki's files find Farocki's films", () => {
  const find = (file: string) => matchAmongFilms(claimedTitle(`/media/Harun Farocki/${file}`, FAROCKI), FAROCKI_FILMS, "Harun Farocki");
  assert.deepEqual([find("Ein Bild %28Harun Farocki%2C 1983%29.mkv")?.film.tmdbId, find("Ein Bild %28Harun Farocki%2C 1983%29.mkv")?.certainty], [10, "certain"]);
  assert.equal(find("Harun Farocki - (1983) An Image.mkv")?.film.tmdbId, 10);
  // A co-director's name in front, the original title after it.
  const video = find("Andrei_Ujica_1992_Videogramme_einer_Revolution_DVDRip_XViD_KG.avi");
  assert.deepEqual([video?.film.tmdbId, video?.certainty], [11, "certain"]);
  // A numbered series: 2 is II and never I.
  assert.equal(find("Harun Farocki-Parallel2.mkv")?.film.tmdbId, 13);
  assert.equal(find("Harun Farocki-Parallel 1.mkv")?.film.tmdbId, 12);
  // A shortened title is a suggestion, not a certainty.
  const frg = find("Harun Farocki - (1990) How to Live in the FRG.mkv");
  assert.deepEqual([frg?.film.tmdbId, frg?.certainty], [15, "likely"]);
  assert.equal(find("Computer Animation Rules Lecture.mp4"), null);
});

const CREEPS: SearchedFilm[] = [
  { tmdbId: 20, title: "Creep", originalTitle: "Creep", year: 2014, genreIds: [27, 53], language: "en" },
  { tmdbId: 21, title: "Creep", originalTitle: "Creep", year: 2004, genreIds: [27], language: "en" },
  { tmdbId: 22, title: "Creep", originalTitle: "Creep", year: 2014, genreIds: [18], language: "en" },
];

test("a Horror folder picks the horror film of that title and year", () => {
  const hints = folderHints("/media/Horror/Creep.2014.mkv", ROOT);
  const match = matchAmongSearch({ titles: ["Creep"], year: 2014 }, CREEPS, hints);
  assert.deepEqual([match?.film.tmdbId, match?.certainty], [20, "certain"]);
});

test("without a year, or without a folder that agrees, it asks", () => {
  const hints = folderHints("/media/Horror/Creep.mkv", ROOT);
  assert.equal(matchAmongSearch({ titles: ["Creep"], year: null }, CREEPS, hints)?.certainty, "likely");
  assert.equal(matchAmongSearch({ titles: ["Creep"], year: 2014 }, CREEPS, [])?.certainty, "likely");
  assert.equal(matchAmongSearch({ titles: ["Something Else"], year: 2014 }, CREEPS, hints), null);
});
