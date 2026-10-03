import assert from "node:assert/strict";
import { test } from "node:test";

import { nearestFolder, outermostFolders, toLibraryPath } from "./library-folders.ts";

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
