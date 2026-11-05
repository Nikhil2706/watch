/**
 * Every film in the library, asked for library by library and a page at a
 * time.
 *
 * The site used to ask Jellyfin for `/Items?IncludeItemTypes=Movie&
 * Recursive=true&Limit=2000` with no ParentId. Two things were wrong with it:
 *
 *  - With the admin key and no ParentId, Jellyfin answers from its view of the
 *    top of the tree, and that view can go stale. On 2026-11-02 Angel S1 (26
 *    files) was in Jellyfin — a search found it, the owner's own listing found
 *    it, the Movies library with ParentId found all 1,904 files — but this
 *    query returned 1,878, without Angel, until a full library scan. The site
 *    never saw the show. Asking each library by its id does not go through
 *    that view.
 *  - Limit=2000, against a library of 1,904. The 2,001st film would have gone
 *    missing just as quietly. Paging has no ceiling.
 *
 * Jellyfin is passed in, so the tests can stand in for it.
 */

export interface VirtualFolder {
  ItemId?: string;
  Name?: string;
  CollectionType?: string;
}

export interface ItemPage<T> {
  Items?: T[];
  TotalRecordCount?: number;
}

export type JellyfinGet = <T>(path: string) => Promise<T>;

/** Big enough that the real library is two requests a library, small enough that a slow page is not the whole list. */
export const PAGE_SIZE = 1000;

/**
 * Libraries that can hold films. A box-set or playlist library only holds
 * pointers to films that live in another one; a films query against it
 * would list nothing of its own.
 */
const NOT_FILMS = new Set(["boxsets", "playlists"]);

export function filmLibraryIds(folders: VirtualFolder[]): string[] {
  const ids = folders
    .filter((f) => f.ItemId && !NOT_FILMS.has((f.CollectionType ?? "").toLowerCase()))
    .map((f) => f.ItemId!);
  return [...new Set(ids)];
}

/**
 * `query` is everything after `?` except ParentId, StartIndex and Limit — the
 * item types, Fields and so on. Items are de-duplicated by Id, in case a
 * folder is in two libraries or a page boundary moves while paging.
 *
 * With no film library found (Jellyfin not set up yet, or it answered with
 * nothing), falls back to the old ParentId-less query, paged, rather than
 * report an empty library.
 */
export async function listAllItems<T extends { Id: string }>(get: JellyfinGet, query: string): Promise<T[]> {
  const parents = filmLibraryIds(await get<VirtualFolder[]>("/Library/VirtualFolders"));
  const byId = new Map<string, T>();
  for (const parent of parents.length > 0 ? parents : [null]) {
    for (const item of await listPaged<T>(get, query, parent)) {
      if (!byId.has(item.Id)) byId.set(item.Id, item);
    }
  }
  return [...byId.values()];
}

async function listPaged<T>(get: JellyfinGet, query: string, parent: string | null): Promise<T[]> {
  const scope = parent ? `&ParentId=${encodeURIComponent(parent)}` : "";
  // SortName then Id, so the order cannot change between pages.
  return everyPage<T>((start, limit) =>
    get<ItemPage<T>>(`/Items?${query}${scope}&SortBy=SortName,Id&SortOrder=Ascending&StartIndex=${start}&Limit=${limit}`),
  );
}

/** A runaway stop, far past any library this site has; reaching it is logged. */
export const MAX_ITEMS = 200_000;

/**
 * Every item of a Jellyfin query, a page at a time: the one way this site
 * asks Jellyfin for "all of" anything.
 *
 * Asking for "the first N" where everything was meant cut the library three
 * times, each quietly: Limit=200 (Browse showed 181 of 446), Limit=2000 in
 * the admin listing (fixed 2026-11-02), and Limit=2000 again in the viewers'
 * listing and the cast list, which on 2026-11-06 hid every title after "Pied
 * Piper" — Sabrina, The Stepfather, Angel S1E5–6 in Home's next-up. Each fix
 * reached only the copy that had broken. jellyfin-limits.test.ts now fails
 * on any fixed Limit of PAGE_SIZE or more outside this file.
 *
 * `fetchPage` gets the start index and page size; keep its sort fixed (end
 * it with Id) so items cannot shift between pages.
 */
export async function everyPage<T>(
  fetchPage: (startIndex: number, limit: number) => Promise<ItemPage<T> | null | undefined>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const items: T[] = [];
  for (let start = 0; start < MAX_ITEMS; start += pageSize) {
    const page = await fetchPage(start, pageSize);
    const got = page?.Items ?? [];
    items.push(...got);
    const total = page?.TotalRecordCount;
    if (got.length < pageSize || (typeof total === "number" && start + got.length >= total)) return items;
  }
  console.error(`[jellyfin-listing] stopped at ${MAX_ITEMS} items; the library is bigger than this site expects`);
  return items;
}
