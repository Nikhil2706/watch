import assert from "node:assert/strict";
import { test } from "node:test";

import { checkLibraryDrive, expectedTopFolders, type DriveFs } from "./library-drive.ts";

/** A pretend disk: folder path -> its entries. A folder listed as "EIO" cannot be read. */
function disk(tree: Record<string, string[] | "EIO">): DriveFs {
  return {
    readdir(path) {
      const entry = tree[path];
      if (entry === undefined) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
      if (entry === "EIO") throw new Error(`EIO: i/o error, scandir '${path}'`);
      return entry;
    },
    isDirectory: (path) => path in tree,
  };
}

const LIBRARY = {
  "/media": ["Horror", "Drama", "Comedy", "Shows", ".DS_Store"],
  "/media/Horror": ["Hush (2016)"],
  "/media/Drama": ["Aftersun (2022)"],
  "/media/Comedy": [],
  "/media/Shows": ["Severance"],
};
const KNOWN = ["Comedy", "Drama", "Horror", "Shows"];

test("the top-level folders come from the paths Jellyfin knows", () => {
  assert.deepEqual(
    expectedTopFolders(["/media/Horror/Hush (2016)", "/media/Horror", "/media/Drama/Aftersun (2022)", "/media", "/elsewhere/X", "/media/.trash/a"], "/media"),
    ["Drama", "Horror"],
  );
  assert.deepEqual(expectedTopFolders(["/media/Horror"], "/media/"), ["Horror"]);
});

test("present: the library and its known folders can all be read", () => {
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk(LIBRARY));
  assert.equal(r.present, true);
  if (r.present) assert.deepEqual(r.folders, ["Comedy", "Drama", "Horror", "Shows"]);
});

test("absent: the mount point is there but empty (drive unplugged)", () => {
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk({ "/media": [] }));
  assert.equal(r.present, false);
  if (!r.present) assert.match(r.reason, /is empty/);
});

test("absent: only macOS's litter is left in the folder", () => {
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk({ "/media": [".DS_Store", ".Spotlight-V100"] }));
  assert.equal(r.present, false);
});

test("absent: the library folder cannot be read (a stale mount after the drive went)", () => {
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk({ "/media": "EIO" }));
  assert.equal(r.present, false);
  if (!r.present) assert.match(r.reason, /cannot be read.*EIO/);
});

test("absent: the library folder does not exist", () => {
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk({}));
  assert.equal(r.present, false);
});

test("absent: something is there, but not the library's folders", () => {
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk({ "/media": ["incoming"], "/media/incoming": [] }));
  assert.equal(r.present, false);
  if (!r.present) assert.match(r.reason, /4 of the library's 4 top-level folders are missing/);
});

test("absent: the folders are listed but cannot be read", () => {
  const tree: Record<string, string[] | "EIO"> = { "/media": KNOWN, "/media/Horror": "EIO", "/media/Drama": "EIO", "/media/Comedy": "EIO", "/media/Shows": [] };
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk(tree));
  assert.equal(r.present, false);
});

test("present: one top-level folder deliberately removed does not stop every scan", () => {
  const { "/media/Comedy": _gone, ...rest } = LIBRARY;
  const r = checkLibraryDrive("/media", { folders: KNOWN, allRequired: false }, disk({ ...rest, "/media": ["Horror", "Drama", "Shows"] }));
  assert.equal(r.present, true);
});

test("MEDIA_EXPECTED_FOLDERS: every named folder must be there", () => {
  const { "/media/Comedy": _gone, ...rest } = LIBRARY;
  const fs = disk({ ...rest, "/media": ["Horror", "Drama", "Shows"] });
  const r = checkLibraryDrive("/media", { folders: ["Horror", "Comedy"], allRequired: true }, fs);
  assert.equal(r.present, false);
  if (!r.present) assert.match(r.reason, /Comedy/);
  assert.equal(checkLibraryDrive("/media", { folders: ["Horror", "Drama"], allRequired: true }, fs).present, true);
});

test("a new library Jellyfin knows nothing about yet: readable and not empty is enough", () => {
  assert.equal(checkLibraryDrive("/media", { folders: [], allRequired: false }, disk(LIBRARY)).present, true);
  assert.equal(checkLibraryDrive("/media", { folders: [], allRequired: false }, disk({ "/media": [] })).present, false);
});
