# Design: scheduled rollout for TV shows / film series

Not implemented yet — written for review per your answers on 2026-08-20:
released items should just work normally, with no hard block on
not-yet-released ones either; the point is signaling "more is coming," not
access control. Pick apart anything that doesn't match what you meant.

## What this is

A curator sets a release cadence for a `library_groups` show (or, later, a
film series) — release everything now, N items per day, or a specific
weekday+time — and the site reveals episodes/films on that schedule instead
of all at once the moment they're grouped and fetched. The curator can also
declare the total episode count upfront (e.g. "this show has 22 episodes
this season") and keep adding files before each one's actual release slot,
rather than needing every file present before scheduling starts.

## Behavior (per your answer)

- **Already-released items work exactly like today.** No new gate on
  playback, `/watch/[id]`, or direct links — nothing in this design touches
  `src/app/item/[id]/page.tsx` or the player route at all.
- **Not-yet-released items are absent from discovery** (Browse, Search, the
  show's own collection page listing, "In this series" rows) but **not
  access-controlled**. This matches the site's own existing precedent:
  `hasNoMetadata()`-excluded and thin-metadata items already work exactly
  this way today — hidden from listings, still directly reachable if you
  somehow have the id (see `src/app/item/[id]/page.tsx:46`, which only
  404s on "Jellyfin has genuinely never heard of this id," nothing else).
  Rollout reuses that precedent rather than inventing a stricter one.
- **"Let them know new is coming"**: the show's collection page
  (`src/app/collection/[id]/page.tsx`) gets a line like "12 more episodes
  releasing through October" below the episode grid. No countdown timer,
  no per-episode "unlocks in 3 days" tile — that's the "visible everywhere
  with a badge" option you didn't pick.

## Data model

Two new tables, additive-only (`CREATE TABLE IF NOT EXISTS` in
`SCHEMA_SQL`, version bump, no `runVersionedMigrations()` entry needed —
same as `known_library_groups` this session).

```sql
CREATE TABLE IF NOT EXISTS library_rollout_plans (
  group_id       TEXT PRIMARY KEY,
  mode           TEXT NOT NULL,          -- 'immediate' | 'daily' | 'weekly'
  per_release    INTEGER NOT NULL DEFAULT 1,
  weekday        INTEGER,                -- 0=Sunday..6=Saturday, 'weekly' only
  time_of_day    TEXT,                   -- "HH:MM", 24h, server-local
  start_at       INTEGER NOT NULL,
  expected_total INTEGER,                -- curator's upfront count, optional
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS library_rollout_slots (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  slot_index  INTEGER NOT NULL,          -- release order, 1-based
  release_at  INTEGER NOT NULL,
  path        TEXT,                      -- NULL until a matching file exists
  revealed_at INTEGER,
  UNIQUE(group_id, slot_index)
) STRICT;
```

Why slots are separate from `library_groups` rows: the "declare 22 episodes,
add files as they arrive" requirement means a release schedule can exist
before the file does. A slot is a release-order position with a computed
timestamp; `path` fills in later when the curator groups the actual file
(or, for an episode arriving out of order, whichever slot it's assigned
to). Regenerating a plan (curator changes cadence mid-rollout) means
recomputing `release_at` for every slot with `revealed_at IS NULL` —
already-revealed slots are left alone so nothing already shown gets pulled
back.

`expected_total` isn't load-bearing for the schedule itself (slot count
grows as the curator creates slots, e.g. "add 22 slots" up front from the
declared total) — it exists so the UI can show "12 of 22 scheduled" instead
of just "12 scheduled" while the rest haven't been created as slots yet.

## Reveal tick

Same shape as `runLibraryNotifyTick()` / `runTvNotifyTick()` in
`src/lib/library-notify.ts` — a `setInterval` registered in
`src/instrumentation.ts`, reusing `TICK_INTERVAL_MS` (10 min; a schedule
measured in days/weeks doesn't need finer granularity):

```
for each slot where release_at <= now AND path IS NOT NULL AND revealed_at IS NULL:
  UPDATE ... SET revealed_at = now
```

"Revealed" doesn't move any file or touch Jellyfin — it only flips whether
`buildLibraryBrowse()` / the collection page query includes the row. The
actual gate is one more condition alongside the existing
`hasNoMetadata()` check:

```
visible = hasConfirmedMetadata(item)
  AND (no rollout slot for this path OR slot.revealed_at IS NOT NULL)
```

This reveal tick is also the natural place to fire the **existing**
`new_episodes` / `new_show` notifications from this session's TV-notify
work (`runTvNotifyTick()`) — a revealed slot is functionally identical to
"episode just got confirmed metadata" from that tick's point of view, so
either the two ticks run back-to-back and TV-notify picks up the change
naturally next pass, or the reveal tick calls the same `notifyAllUsers()`
helper directly. Leaning toward the former (let TV-notify stay the single
source of "an episode became visible, tell people" — the reveal tick's
only job is flipping the gate) to avoid two code paths that can announce
the same episode twice if they ever run in the same tick window.

## Curator UI

New panel in `curator.html`, likely a tab on the group-manage view next to
the existing "Series IMDb link" field (`curator.html` around the
`fetch-all-episodes` action from this session's West Wing work):

- Mode picker: Release now / N per day / Weekly on `[day]` at `[time]`.
- "Declare total episodes: `[22]`" → creates that many slots at once from
  `start_at`, cadence-spaced; existing grouped-but-unslotted files
  auto-fill the earliest open slots in filename order (same
  `parseEpisodeInfo` ordering already used for episode-fetch).
- A slot list showing release date, filled/empty, revealed/pending — so a
  curator can see "slot 14 has no file yet, releases in 3 days" and go
  find it before then.

## Open questions before building

1. **Film series scope**: everything above is written against the TV
   `library_groups` model. A film series (Wikipedia-sourced
   `film_series`/`film_series_entries`, feeding `SeriesRow.tsx`) has no
   equivalent "group of owned paths" — it's a list of IMDb ids, some
   owned, most not (especially after this session's SeriesRow change to
   hide unowned entries entirely). Rolling out a film series would need
   `group_id` above to sometimes mean "film_series.id" instead of a
   `library_groups` id, or a parallel table. Worth confirming whether film
   series rollout is actually needed now, or whether "show/series" in the
   original ask meant TV shows specifically and film series can wait.
2. **Timezone**: `time_of_day` as "HH:MM" needs a defined zone — server
   local (this Windows box's clock) is simplest and matches how
   `scrape-schedule.ts`'s "Wednesday 5:30am" already works, but worth
   saying explicitly since curator and viewers could be in different
   zones.
3. Does regenerating a plan need an audit trail (curator changed the
   schedule after some episodes already shipped), or is silently
   recomputing pending slots enough? Leaning toward "enough" — this is a
   personal-scale library, not a service with an SLA to prove.
