# Catalogue state: one answer to "why isn't this on the site?"

Status: design, for review. Implementation lands in the steps at the end, one
PR each, each one leaving the site working.

## 1. The problem

Whether a library file is listed on the site is decided today by a stack of
independent checks in `filterVisible` (`src/lib/media.ts`), each with its own
table, its own console filter chip, badge and button, and its own endpoint:

| Rule today | Fact lives in | Keyed on | Hides in | Console today | Endpoint(s) today |
|---|---|---|---|---|---|
| Hidden by the curator | `library_excluded` | path | every list | "Hidden" chip, Hide/Unhide | `exclude`, `unexclude` |
| Damaged file | `file_checks` (verdict `damaged`, `allowed = 0`) | path | every list | "Damaged" chip, show anyway / recheck | `file-check` |
| No metadata | Jellyfin item (no overview, no IMDb/TMDB id) + `library_whitelisted` | path | every list except a show's own episode list | "No metadata" chip, Show anyway | `whitelist`, `unwhitelist` |
| Recognised episode in no show (PR #24) | `omdb_title_kind`, `tmdb_links`, filename, `library_groups`, `library_group_declined` | path / IMDb id | every list | "Episode, not in a show" reason, Group as / Keep as a film | `group-episodes`, `keep-as-film` |
| Special feature | `special_features` | **Jellyfin item id** | every list except Continue Watching | separate Special features pane | special-feature routes |
| Other cut of a film | `film_versions` (`path <> primary_path`) | path | every list except Continue Watching | version block in the pane | `versions`, `merge-versions` |
| Scheduled release | `library_rollout_slots` (`revealed_at IS NULL`) | path or IMDb id | every list | Rollout panel | `rollout` |
| Parental control | Jellyfin rating + `content_warnings` | IMDb id, per viewer | every list, for that viewer | — | — |
| Part of a show | `library_groups` | path | not hidden here; folded into one tile later (`collapseEpisodeGroups`) | "Shows" chip | `group`, `ungroup`, ... |
| Duplicate | computed (`duplicate-titles.ts`) | item | **not hidden** | "Duplicates" chip | — |

Three consequences:

- **The curator has to know the stack.** "Why isn't Phantasm III on the site?"
  means opening each chip in turn. A file can be held for two reasons at once
  (damaged *and* no metadata), and fixing one leaves it hidden with no sign of
  the other.
- **The site hides silently.** A viewer following a link to a scheduled title
  or a special feature gets the page with nothing saying what it is or when
  it arrives.
- **Every new reason grows four places**: a rule in `filterVisible`, a flag in
  `library-review.ts`, a chip/badge/button in `curator.html`, and an endpoint.
  PR #24 did exactly that.

## 2. The model

Every library file has one **catalogue state**, derived by one pure function
from the facts the existing tables already hold:

```
facts (existing tables + the Jellyfin item)  ──derive──▶  { state, reasons[], placement }
                                                          │
                     per-viewer rules (parental control) ─┤
                     list context (discovery / resume /   │
                     a show's own episode list)          ─┴─▶ listed or not
```

Nothing new becomes a source of truth. Every existing table keeps being
written by what writes it today; the state is a reading of them. Dropping
everything this design adds returns the system to exactly what it is now.

### 2.1 Reasons

A **reason** is one fact about a file that matters to whether, or how, it is
shown. Each reason says, as data rather than as scattered `if`s:

- which **list contexts** it hides the file in;
- whether it **needs the curator** (puts the file in the inbox);
- its **plain words**, built from the fact's own detail;
- the **actions** that answer it.

| Code | From | Hides in | Needs you | Plain words (example) | Actions |
|---|---|---|---|---|---|
| `excluded` | `library_excluded` | all | no (a decision already) | "Hidden by you: duplicate copy" | unhide |
| `damaged` | `file_checks` damaged, not allowed | all | yes | "Damaged: 74 broken pieces of picture" | show_anyway, replace_recheck, hide |
| `ungrouped_episode` | PR #24 rules | all | yes | "Episode 3 of Nirvanna the Band the Show, in no show" | place_as episode (group), place_as film, hide |
| `no_metadata` | Jellyfin item + not whitelisted | discovery, resume | yes | "Not identified: nothing knows what this file is" | identify, show_anyway, place_as …, hide |
| `identifying` | `no_metadata` + an open `folder_match_suggestions` row | discovery, resume | yes | "Probably *Amblin* (1968): from its folder, Steven Spielberg" | accept suggestion, identify, show_anyway, hide |
| `scheduled` | `library_rollout_slots` unrevealed | all | no | "Coming 21 Oct" | release now, reschedule |
| `special_feature` | `special_features` | discovery, show episodes | only if mapped nowhere | "Extras for Tenet" | place_as …, unmark |
| `version` | `film_versions`, not primary | discovery, show episodes | no | "Director's cut of Blade Runner" | make primary, split off |
| `episode` | `library_groups` | none here (folded later) | no | "Episode 7 of E.R." | move, take out |
| `duplicate` | `duplicate-titles.ts` | none | yes | "Duplicate: 2 copies of *Heat*" | keep this one (hides the rest), keep as versions |
| `damaged_allowed` | `file_checks` damaged, allowed | none | no | "Shown despite damage: 74 broken pieces of picture" | take off the site, recheck |

"Hides in" reproduces today's behaviour exactly (section 6), including its two
existing exceptions: special features and other cuts stay in Continue
Watching (and only there), and a show's own episode list ignores the
no-metadata rule. The equivalence tests found the "only there": a show's own
list hides features and other cuts as well, which the first draft of this
table missed.

Some questions are already answered another way, so they don't put the file
in the inbox even though the reason still holds and is still shown:

- a file the curator **hid** asks nothing else (the console has always
  skipped excluded files);
- a file **in a show** isn't asked about its missing metadata or a
  same-named copy (grouping answered "what is this?"). A damaged episode
  still is. Changing
any of that is a later, separate decision, not part of the migration.

### 2.2 States

The state is a **summary** of the reasons, for people: what the console sorts
and counts by and what the site's status line says. It is never consulted
instead of the reasons when deciding whether something is listed.

| State | Means | When |
|---|---|---|
| `visible` | Listed on the site in its own right | no reason hides it in discovery |
| `placed` | Not listed on its own, but part of something that is | `episode`, `special_feature` or `version`, and nothing worse |
| `held` | Kept off by a decision or a date | `excluded` or `scheduled`, and nothing needs you |
| `needs_decision` | Kept off until the curator answers | any reason that needs you and hides |
| `identifying` | Kept off while the system is working it out | `identifying` and nothing worse |
| `new` | Seen by a scan, not yet checked | **not used yet** (see 9.1) |

When reasons combine, the state is the first that applies in this order:
`needs_decision`, `identifying`, `held`, `placed`, `visible`. All reasons are
kept, not just the winner: the damaged file with no metadata shows both, with
both sets of actions. A reason that needs you without hiding the file
(`duplicate`) leaves the state alone and still puts the file in the inbox.

`placement` is carried beside the state: `{ as: "film" }`,
`{ as: "episode", groupId, groupName }`, `{ as: "special_feature", of }`,
`{ as: "version", of, label }`.

## 3. Backend

### 3.1 One function

`src/lib/catalogue-state.ts`, pure and import-free like `series-detect.ts`:

```ts
deriveCatalogueState(facts: CatalogueFacts): CatalogueState
isListed(state: CatalogueState, context: "discovery" | "resume" | "show_episodes"): boolean
```

`CatalogueFacts` is everything about one file the rules read: its path, item
id, IMDb id, the metadata fields, and one entry per source (excluded? check
verdict and detail? whitelisted? group? feature? version? rollout slot? folder
suggestion? episode evidence?). A `server-only` companion,
`catalogue-facts.ts`, builds them in bulk from the existing tables with the
same per-request memoisation `filterVisible` uses today.

`filterVisible` becomes:

```ts
items.filter((item) => isListed(derive(factsFor(item)), context) && viewerMayWatch(item, session))
```

where `viewerMayWatch` is the one per-viewer rule (parental control). Rollout
stays a reason, not a viewer rule: today it is global, not per viewer.

The site keeps deriving **live, per request**. That keeps today's promise that
a curator's change shows on the very next page load.

### 3.2 `catalogue_items`: a projection, not a source

```sql
CREATE TABLE IF NOT EXISTS catalogue_items (
  path        TEXT PRIMARY KEY,
  item_id     TEXT,
  name        TEXT,
  state       TEXT NOT NULL,     -- visible | placed | held | needs_decision | identifying
  reason      TEXT,              -- the primary reason code, null when visible
  reasons     TEXT NOT NULL,     -- JSON: every reason with its detail
  placement   TEXT,              -- JSON, see 2.2
  detail      TEXT,              -- plain words for the primary reason
  decided_by  TEXT,              -- from the latest decision, if any
  decided_at  INTEGER,
  derived_at  INTEGER NOT NULL
) STRICT;
```

It is rewritten whole by `refreshCatalogue()` after a library scan, after
every decision, and nightly. It serves the console's inbox and counts, the
health tab, and anything that would otherwise rebuild the whole library to
answer "how many need me?". The site never reads it to decide visibility, so
a stale row can only make a count lag, never hide or show a film wrongly.
Dropping it loses nothing.

### 3.3 Who decided what

```sql
CREATE TABLE IF NOT EXISTS catalogue_decisions (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  action     TEXT NOT NULL,
  params     TEXT,            -- JSON
  reason     TEXT,            -- the reason it answered, when one
  decided_by TEXT NOT NULL,   -- "curator" (console/admin key), "auto-group", "folder-match", ...
  decided_at INTEGER NOT NULL
);
```

An append-only log written by the decision API, never read to derive a state.
It fills `decided_by` / `decided_at` and the console's History view. Automated
writers (the auto-grouper, folder matching) log here too.

### 3.4 One decision API

`POST /api/admin/catalogue/{path}/decide` (the path URL-encoded as one
segment), body `{ action, reason?, ...params }`:

| Action | Params | Does (through the existing function) |
|---|---|---|
| `show_anyway` | `reason?` | `damaged` → `setDamagedAllowed(true)`; `no_metadata` → `whitelistPath`. Without `reason`: every reason that has it. |
| `take_off` | `reason` | the inverse: `setDamagedAllowed(false)`, `unwhitelistPath` |
| `hide` / `unhide` | `note?` | `excludePath` / `unexcludePath` |
| `replace_recheck` | | `requestRecheck` |
| `place_as` | `as: "film"` | `keepAsFilm` (and takes it out of a group, a version set, the features) |
| | `as: "episode", groupId \| seriesKey` | `addToGroup` / `groupSeriesNow` |
| | `as: "special_feature", target?` | `markSpecialFeature` (+ `addTarget`) |
| | `as: "version", of, label?` | `createVersionSet` / add to an existing set |
| `accept_suggestion` | | `acceptFolderSuggestion` |
| `release_now` | | the rollout's reveal |

It answers with the file's new `CatalogueState`, so a client redraws one card
without reloading the library. Every action is idempotent.

The scattered endpoints (`exclude`, `whitelist`, `file-check`, `keep-as-film`,
`group-episodes`, ...) stay, as thin wrappers over the same functions plus the
decision log, until the console no longer calls them. Then they are removed in
their own PR.

Identifying a film (TMDB search, manual metadata) stays where it is. It changes
metadata, not state, and the state follows it on its own.

## 4. Console and /admin: one inbox

### 4.1 Shared without sharing a framework

The old console is one static HTML file opened from disk (`curator.html`). The
`/admin` port in progress elsewhere is React inside the site, and has not
merged anywhere at the time of writing. So the inbox is split in two halves
that both can use:

- **Server: `GET /api/admin/catalogue/inbox?view=…`** returns **cards**, with
  everything already decided on the server: title, kind, show, poster, state,
  every reason in plain words, and each reason's actions with their labels and
  the exact `decide` body to send. No client re-derives a rule, so the console
  and /admin cannot drift apart.
- **Client: `<catalogue-inbox>`**, a dependency-free custom element served
  by the site (`/catalogue-inbox.js`). It fetches cards, renders them and
  posts decisions. `curator.html` loads it with a `<script>` from the site URL
  it already talks to (the admin key goes in a header, as today). React in
  `/admin` renders the same element, or uses the same API with its own JSX if
  it prefers. Either way the words and the actions come from the server.

If `/admin` merges first, the element lands there first and the console
follows.

### 4.2 What it shows

- **One list: "Needs you".** Every file whose state is `needs_decision` or
  `identifying`, plus any with a needs-you reason that does not hide
  (`duplicate`). Same card for a film and an episode.
- **Filter chips are views of that list**, not separate lists: by reason
  (`damaged`, `no_metadata`, ...), by state (`held`, `placed`), and "Everything".
  A chip's count is the length of its view.
- **A card**: poster, title (the filename under it), and each reason as one
  line of plain words followed by its action buttons. "Damaged: 74 broken
  pieces of picture" → *Show anyway* · *Check again after replacing* · *Hide*.
- **Shows are flagged only by counts.** The show row says "3 of 144 episodes
  need you". Opening it lists its episodes with the **same cards** inline. A
  show is never "damaged" or "needs you" as a whole.
- **Batches**: select several cards with the same action, apply once. Each card
  is still decided through `decide`, one at a time, as the console's bulk
  actions do now.

## 5. Site: one status component

`<CatalogueStatus state=… />` (`src/components/media/CatalogueStatus.tsx`) is
the one place a viewer is told an item is in a degraded or unusual state. It
renders a small pill with one sentence, the same on desktop, phone and TV (on
TV it is text, never a focus stop):

| State / reason | Says | Where it can be seen |
|---|---|---|
| `scheduled` | "Coming 21 Oct" | item page from a direct link; a series row's slot |
| `special_feature` | "Extras for Tenet" (links to Tenet) | item page, Continue Watching card |
| `version` | "Director's cut of Blade Runner" (links to the main one) | item page, Continue Watching |
| `episode` | "Episode 7 of E.R." | item page reached directly |
| `damaged_allowed` | "Picture breaks up in places" | item page |
| anything hidden (`excluded`, `needs_decision`) | nothing to a viewer | direct link only, as today |

It replaces the one-off notes that do this job now (the "Leaving soon" note
stays separate: it is about a date, not the catalogue).

## 6. Not changing behaviour while moving

The migration must not move a single film on or off the site. Three guards:

1. **Equivalence tests.** The test file keeps a verbatim, pure copy of today's
   `filterVisible` rule and checks that the new `isListed` agrees with it for
   **every combination** of facts (each source on/off; whitelisted or not;
   with or without metadata, IMDb id, path) in each of the three contexts.
   That is a few thousand cases, and it is exhaustive, which a sample of the
   live database is not.
2. **A snapshot of the real database.** `scripts/catalogue-snapshot.mts` runs
   on the host against the live database and Jellyfin listing and prints
   every path where the old rule and the new one disagree, per context. The
   expected output is empty. It runs before deploying step 2, with the result
   pasted into that PR.
3. **One step at a time.** Step 2 switches `filterVisible` to the derivation
   with no other change. Nothing in the console moves until that has been live.

## 7. Tests

- **Derivation**: each reason alone gives the right state, placement, plain
  words and actions. Every pair gives the documented precedence and keeps both
  reasons.
- **Listing equivalence** as in 6.1.
- **Decision round trips**: for each action, apply it to facts in memory (the
  same writes, against an in-memory SQLite with the real schema), derive again
  and check the state; then apply the inverse and check the original state
  comes back. `show_anyway` then `take_off` on a damaged file;
  `hide` then `unhide`; `place_as film` on an ungrouped episode then
  `place_as episode`.
- **Inbox cards**: the cards for a fixture library, including a show with
  some episodes needing you, which shows a count and no show-level flag.

## 8. Steps

1. **This document.**
2. **Derivation, no behaviour change.** `catalogue-state.ts`,
   `catalogue-facts.ts`, `filterVisible` on top of them, the equivalence tests,
   the snapshot script. Nothing visible changes.
3. **Projection and decisions.** `catalogue_items`, `catalogue_decisions`,
   `refreshCatalogue()`, the `decide` endpoint, the old endpoints rewritten as
   wrappers that also log. Round-trip tests.
4. **The inbox.** The inbox API, `<catalogue-inbox>`, `curator.html`'s Needs
   you switched to it, show rows with counts and inline cards. The old chips
   and badges go in the same PR.
5. **The site status component**, on the item page and Continue Watching cards,
   desktop/phone/TV.
6. **Removing the old endpoints** once nothing calls them.
7. **Behaviour changes, each its own decision** (9).

## 9. Open questions (behaviour changes, deliberately not in the migration)

1. **`new`.** A file a scan has found but nothing has checked yet (no
   `file_checks` row) is listed today as soon as it has metadata. Holding it
   until the worker has read it through would stop a half-copied file being
   offered, at the cost of new films appearing a little later. Proposed: yes,
   with a time limit, as step 7a.
2. **Duplicates.** Listed today; only flagged. Should the second copy be
   `placed` under the first automatically?
3. **Special features are keyed on Jellyfin item id**, everything else on path.
   A rescan that re-mints ids silently un-marks them. Proposed: re-key on path
   in step 3, with a migration that maps the current ids through the library
   listing.
4. **A show's episode list and the no-metadata rule.** Kept as today: a grouped
   episode with no metadata is listed inside its show and nowhere else.
5. **Rollout per viewer.** Today a scheduled title is hidden from everyone,
   curator included, until its date. Should the curator see it on the site
   with "Coming 21 Oct"?
