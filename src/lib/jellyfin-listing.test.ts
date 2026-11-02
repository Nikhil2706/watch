import assert from "node:assert/strict";
import { test } from "node:test";

import { filmLibraryIds, listAllItems, PAGE_SIZE, type VirtualFolder } from "./jellyfin-listing.ts";

/** A Jellyfin with these libraries, answering /Items from `byParent` (null = the ParentId-less query). */
function fakeJellyfin(folders: VirtualFolder[], byParent: Record<string, { Id: string }[]>) {
  const asked: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    asked.push(path);
    if (path === "/Library/VirtualFolders") return folders as T;
    const url = new URL(path, "http://jf");
    const items = byParent[url.searchParams.get("ParentId") ?? "null"] ?? [];
    const start = Number(url.searchParams.get("StartIndex"));
    const limit = Number(url.searchParams.get("Limit"));
    return { Items: items.slice(start, start + limit), TotalRecordCount: items.length } as T;
  };
  return { get, asked };
}

const films = (n: number, prefix = "f") => Array.from({ length: n }, (_, i) => ({ Id: `${prefix}${i}` }));

test("box sets and playlists are not film libraries", () => {
  assert.deepEqual(
    filmLibraryIds([
      { ItemId: "m", CollectionType: "movies" },
      { ItemId: "c", CollectionType: "boxsets" },
      { ItemId: "p", CollectionType: "Playlists" },
      { ItemId: "x" },
      { Name: "no id" },
      { ItemId: "m", CollectionType: "movies" },
    ]),
    ["m", "x"],
  );
});

test("asks each film library by its id, never the ParentId-less query", async () => {
  // The ParentId-less answer is the stale one: it is missing a show the library has.
  const jf = fakeJellyfin(
    [{ ItemId: "movies", CollectionType: "movies" }, { ItemId: "sets", CollectionType: "boxsets" }],
    { movies: films(5), null: films(3) },
  );
  const items = await listAllItems(jf.get, "IncludeItemTypes=Movie&Recursive=true");
  assert.equal(items.length, 5);
  const itemCalls = jf.asked.filter((p) => p.startsWith("/Items?"));
  assert.ok(itemCalls.every((p) => p.includes("ParentId=movies")));
  assert.ok(itemCalls.every((p) => p.startsWith("/Items?IncludeItemTypes=Movie&Recursive=true&")));
});

test("pages past the old 2,000 cap", async () => {
  const jf = fakeJellyfin([{ ItemId: "movies" }], { movies: films(2 * PAGE_SIZE + 7) });
  const items = await listAllItems(jf.get, "IncludeItemTypes=Movie");
  assert.equal(items.length, 2 * PAGE_SIZE + 7);
  assert.equal(jf.asked.filter((p) => p.startsWith("/Items?")).length, 3);
});

test("an exact multiple of the page size stops on the count, not an empty page", async () => {
  const jf = fakeJellyfin([{ ItemId: "movies" }], { movies: films(PAGE_SIZE) });
  assert.equal((await listAllItems(jf.get, "IncludeItemTypes=Movie")).length, PAGE_SIZE);
  assert.equal(jf.asked.filter((p) => p.startsWith("/Items?")).length, 1);
});

test("a film in two libraries is listed once", async () => {
  const jf = fakeJellyfin([{ ItemId: "a" }, { ItemId: "b" }], { a: films(3), b: [...films(2), { Id: "only-b" }] });
  assert.deepEqual(
    (await listAllItems(jf.get, "IncludeItemTypes=Movie")).map((i) => i.Id),
    ["f0", "f1", "f2", "only-b"],
  );
});

test("with no film library, falls back to the ParentId-less query", async () => {
  const jf = fakeJellyfin([{ ItemId: "sets", CollectionType: "boxsets" }], { null: films(4) });
  assert.equal((await listAllItems(jf.get, "IncludeItemTypes=Movie")).length, 4);
  assert.ok(jf.asked.filter((p) => p.startsWith("/Items?")).every((p) => !p.includes("ParentId")));
});
