import assert from "node:assert/strict";
import { test } from "node:test";

import { filesToHold, holdsToRelease, nearestFolder, outermostFolders, toLibraryPath } from "./library-folders.ts";

const ROOT = "/media";
const HOST = "H:/Da Moveesh";

test("a folder can be named three ways", () => {
  assert.equal(toLibraryPath("Horror/Hush", ROOT, HOST), "/media/Horror/Hush");
  assert.equal(toLibraryPath("/media/Horror/Hush/", ROOT, HOST), "/media/Horror/Hush");
  assert.equal(toLibraryPath("H:\\Da Moveesh\\Horror\\Hush", ROOT, HOST), "/media/Horror/Hush");
  assert.equal(toLibraryPath("h:/da moveesh/Horror", ROOT, HOST), "/media/Horror");
});

test("a path outside the library is refused", () => {
  assert.equal(toLibraryPath("/etc/passwd", ROOT, HOST), null);
  assert.equal(toLibraryPath("C:\\Users\\HP\\Downloads", ROOT, HOST), null);
  assert.equal(toLibraryPath("Horror/../../etc", ROOT, HOST), null);
  assert.equal(toLibraryPath("/mediaother/x", ROOT, HOST), null);
  assert.equal(toLibraryPath("   ", ROOT, HOST), null);
});

test("a Windows path is not guessed at when the host folder is not known", () => {
  assert.equal(toLibraryPath("H:\\Da Moveesh\\Horror", ROOT, ""), null);
});

const HORROR = { Id: "a", Path: "/media/Horror" };
const UNCLASSIFIED = { Id: "b", Path: "/media/Horror/Unclassified" };
const FRENCH = { Id: "c", Path: "/media/French" };
const FOLDERS = [HORROR, UNCLASSIFIED, FRENCH];

test("a new film is found by the deepest folder Jellyfin already knows", () => {
  assert.equal(nearestFolder("/media/Horror/Hush (2016)", FOLDERS)?.Id, "a");
  assert.equal(nearestFolder("/media/Horror/Unclassified/New/film.mp4", FOLDERS)?.Id, "b");
  assert.equal(nearestFolder("/media/Horror", FOLDERS)?.Id, "a");
});

test("a file in the library root, or beside a similarly named folder, has no folder", () => {
  assert.equal(nearestFolder("/media/New Film.mp4", FOLDERS), null);
  assert.equal(nearestFolder("/media/Horror Shorts/x.mp4", FOLDERS), null);
});

test("a folder inside another chosen folder is not refreshed twice", () => {
  assert.deepEqual(
    outermostFolders([UNCLASSIFIED, HORROR, FRENCH, HORROR]).map((f) => f.Id),
    ["a", "c"],
  );
});

test("a scan of one new show holds back the other new shows beside it", () => {
  const onDisk = [
    "/media/TV/Sabrina/S01E01.mkv",
    "/media/TV/Sabrina/S01E02.mkv",
    "/media/TV/Alias/S01E01.mkv",
    "/media/TV/Sabrina Shorts/x.mkv",
    "/media/TV/Buffy/S01E01.mkv",
  ];
  const known = new Set(["/media/TV/Buffy/S01E01.mkv"]);
  assert.deepEqual(filesToHold(onDisk, known, ["/media/TV/Sabrina/"]), [
    "/media/TV/Alias/S01E01.mkv",
    "/media/TV/Sabrina Shorts/x.mkv",
  ]);
});

test("a scan of a folder releases only the holds inside it", () => {
  const held = ["/media/TV/Alias/S01E01.mkv", "/media/TV/Alias Smith/x.mkv", "/media/TV/Normal People/1.mkv"];
  assert.deepEqual(holdsToRelease(held, ["/media/TV/Alias"]), ["/media/TV/Alias/S01E01.mkv"]);
});
