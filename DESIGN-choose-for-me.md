# Design: Choose something for me

A button that picks one thing and plays it, from what this viewer has
watched, rated and kept. Netflix ships the same idea as "Play Something":
not a random pick but a weighted one, drawn from what you already watch,
what's on your list, and what you started and abandoned, with a one-line
card saying why it chose that — and a "play something else" that re-rolls.
That decomposition — weighted, explained, re-rollable — is the right one
and this document assumes it.

**Headline: this feature needs no new tables and no schema bump.** Every
signal it wants already exists. That is unusual here and it is worth
protecting: the moment a design decision requires writing down what
somebody watched, this feature has walked into the territory that got the
viewing-metrics dashboard parked on 2026-09-05. See "Privacy" below.

---

## What data actually exists to reason from

Nothing new needs collecting. Assembled per request, from the viewer's own
session:

| Signal | Where it lives | Notes |
|---|---|---|
| Played / not played | Jellyfin `UserData.Played`, already in `LIST_FIELDS` (`src/lib/media.ts:106`) | Per-user, fetched with the viewer's own token |
| Resume position | `UserData.PlaybackPositionTicks`, `PlayedPercentage` | Drives "finish something" and the abandonment signal |
| Recency + play count | `UserData.LastPlayedDate`, `UserData.PlayCount` | **Verify first.** `fields=UserData` returns the whole object, so these are probably already arriving unread; `MediaItem["UserData"]` in `media.ts:58` simply doesn't declare them |
| Favourites / rewatch | `user_lists` (`src/lib/lists.ts`) | Local, explicit, the strongest positive there is |
| Star ratings | `user_ratings`, 1–10 ints (`schema.ts:799`) | 7+ is 3.5 stars and up, a positive; 4 and under, a negative |
| Directors / actors | `browse_people_cache`, 12h TTL (`src/lib/browse-data.ts`) | The People field costs ~20s against Jellyfin — never fetch it on this path |
| Genre, decade, IMDb rating + votes | `BrowseMovie` (`browse-data.ts:47`) | Already assembled, already filtered |
| Quality prior | `basePopularity()` (`browse-data.ts:174`) | Bayesian weighted rating; reuse it, do not invent a second one |
| Curator signal | `curations`, `curator_accolade_entries`, `article_film_links` | "He wrote about this one" is a real prior in this library |

What does **not** exist, deliberately: any local record of what anyone
watched or when. Playback telemetry is stored nowhere on this box today —
`Player.tsx` reports to `/jf/Sessions/Playing` and the proxy passes it
straight through. This feature must not change that.

## Candidate pool

Start from `buildBrowseData(session)` (`browse-data.ts:415`), which has
already applied `filterVisible()` — exclusions, thin metadata, scheduled
rollout, special features, parental control — and already collapses TV
episodes into group tiles.

**This is the single biggest correctness risk in the feature.** Everything
`filterVisible()` hides is hidden for a reason a viewer must not be able to
route around, and a rollout-hidden title surfacing through a shuffle button
would be a leak of unreleased content, not a cosmetic bug. If anyone later
"optimises" the picker by calling `fetchAllMoviesCached()` directly, that is
exactly what happens. Write the test that proves a rollout-hidden and a
parental-restricted title can never be returned, and write it first.

Then subtract:

- anything `Played` — unless it is on the viewer's `rewatch` list, or the
  mode is "watch again";
- anything already offered in this sitting (see re-rolls, below);
- anything with `MediaSourceCount` of 0.

Titles mid-conversion (`media_jobs`) fall out for free: Jellyfin has never
heard of them.

## Scoring

Build a taste profile from the viewer's positives and negatives, score
every candidate against it, then **sample** rather than take the maximum.

```
score = w_genre·genreAffinity
      + w_dir·directorAffinity
      + w_act·actorAffinity      (top-billed only, first ~8 credits)
      + w_dec·decadeAffinity
      + w_pop·basePopularity(normalised)
      + w_cur·curatorBoost       (has a pick / accolade / part of a series they started)
      − penalties                (rated 4 or under, abandoned, near-duplicate of the last pick)
```

Affinity is a weighted count over the profile's positives, recency-weighted
by `LastPlayedDate` where present and unweighted where it isn't. Negatives:
rated 4 or under, plus **abandoned** — started past ~5 minutes, under 20%
watched, untouched for 30+ days. Abandonment is the most informative signal
in the set and it costs nothing to read; if `LastPlayedDate` turns out not
to be returned, drop the negative rather than guessing from position alone.

### Sample, do not maximise

Argmax kills this feature on the second press: same input, same film,
forever. Softmax over the top ~25 with a temperature knob is the entire
user experience. Temperature is the one number worth tuning by feel after
it ships.

### Return a slate, not a pick

The API returns **ten** ranked-and-shuffled candidates with their reasons,
not one. Re-rolling then walks the slate client-side: instant, no second
request, no rate-limit question, and no way for a stuck client to hammer
Jellyfin. Only when the slate is exhausted does it ask for another.

### Say why

"Because you liked *Blood and Black Lace*." "Bava again." "From the 1970s,
which you keep coming back to." One line, taken from the top-contributing
term. This is not decoration: it is the difference between a magic button
and a random one, and it quietly demonstrates that the pick came from the
viewer's own data rather than from someone watching over their shoulder.

### Cold start

A brand-new invitee has no signals at all. Fall back to curator-forward
defaults — Curator's Picks, accolade-carrying titles, the popularity prior,
spread across genres — and say so on the card: "You haven't watched
anything here yet, so this one's a house favourite." Never show an empty
state to someone who just joined.

## Modes

A bare button answers one question. These four answer the questions people
actually have, and each is a different candidate pool over the same scorer:

- **Something new** — unseen, taste-weighted. The default.
- **Finish something** — from `getResume()`, ordered by how close to done.
- **Watch it again** — the `rewatch` list first, then highly-rated-and-played.
- **Pure random** — an honest dice roll over the whole visible library. Not
  a joke mode; some nights that is the actual request, and it is the
  fallback when the model has nothing to say.

Plus optional constraints, all skippable: **runtime** (under 90 / under 2h
/ any — `RunTimeTicks` is already on every item) and **genre chips**. Keep
"mood" out of v1; it is a mapping table someone has to maintain, and genre
chips get most of the way there for free.

## Where the pick lands

**On a card, not straight into the player.** Netflix plays instantly
because its catalogue is interchangeable. This library's whole argument is
the film page — the curator's note, the accolades, the trivia, the ratings
row. Landing on a result card (poster, year, the one-line reason, Play,
"something else", "tell me more") respects that, and it dodges a real
failure: a title whose file is missing or unplayable would otherwise dump
the viewer straight into a dead player. Offer "start it playing right away"
as a preference for people who disagree.

Entry points: the home page beside the Hero; the AppBar; and Browse's
"No films match this filter" state, which is the exact moment someone has
given up on choosing for themselves.

## The re-roll ledger, and where it is *not* stored

Pressing again must not return the same film, and must eventually be
allowed to.

The server does not remember what it offered. The slate lives in
`sessionStorage`, and the client sends recently-offered ids up as an
exclusion list. Nothing about what anyone was shown is written to disk.
The alternative — a `pick_offers` table with a TTL — is simpler to reason
about and is the wrong trade here: it creates precisely the persistent
per-person viewing record that the metrics work was parked over, in service
of a button. The cost of the client-side version is that re-rolls don't
follow you between devices, which nobody will ever notice.

After about five re-rolls, offer an exit: "just show me the shelf" → Browse
with the current constraints applied. Decision paralysis is the enemy this
feature exists to fight; a fifth re-roll means it is losing.

## Scenarios worth designing for now

1. **Everything filters out** — small library, aggressive constraints, a
   parental-controlled account. Show a real empty state with a "loosen
   this" affordance, not a spinner.
2. **One candidate.** Return it without pretending to shuffle.
3. **A TV show or a franchise group wins.** A group tile has a synthetic id
   and no Jellyfin item behind it (`browse-data.ts`, `pseudoItem`). Resolve
   it to the first **visible, unwatched** member — visible matters, because
   the next episode may be rollout-hidden. If everything is watched, offer
   the first episode and label it a rewatch.
4. **A multi-part film.** `library_groups` with `partsUnit: "parts"` means
   one film split across files. Picking part 2 of *Fanny and Alexander* is
   a bug; always resolve to part 1 unless the viewer already has progress.
5. **Cold `browse_people_cache`.** A cold cache means a 20-second Jellyfin
   call. Never block a click on it: score without the director/actor terms,
   soften the reason line accordingly, and kick off
   `warmBrowsePeopleCache()` in the background.
6. **Stale `UserData`.** The all-movies cache is 20s (`media.ts`), so
   marking something watched and immediately re-rolling can still offer it.
   Acceptable; not worth a cache bust.
7. **Television.** This feature is worth more on the TV app than anywhere
   else — a remote is a terrible instrument for browsing 450 films. The
   sheet has to be reachable through `tv/spatial-nav.ts` from the first
   press, and the whole flow has to work with four arrows and OK.
8. **Offline.** On `/downloads` the same idea reduces to "pick from what is
   on this device" — cheap, self-contained, no network. Parity backlog
   item, not v1.

## Shape of the code

Mirroring the `browse-filters.ts` / `browse-data.ts` split that already
exists here, and for the reason that split documents: a decade bug survived
unnoticed because the logic wasn't importable by the test runner.

- **`src/lib/picker.ts`** — pure, zero runtime imports, no `server-only`,
  no db handle. `buildTasteProfile()`, `scoreCandidates()`,
  `pickSlate(candidates, { seed, size })`. Seeded RNG, so a slate is
  reproducible in a test.
- **`src/lib/picker-data.ts`** — `server-only`. Assembles signals from
  `buildBrowseData`, `lists`, `ratings` and Jellyfin `UserData`.
- **`src/lib/picker.test.ts`** — runs under
  `node --test --experimental-strip-types` alongside the other 68. Must
  cover: a rollout-hidden title is never returned; a parental-restricted
  title is never returned; a special feature is never returned; a group
  resolves to part 1; cold start returns something.
- **`GET /api/pick`** — session-authenticated, returns a slate of 10 with
  reasons.
- **`src/components/media/PickButton.tsx`** plus a result card, and a real
  `/pick` page so the apps and the TV can deep-link to it.

No schema change. No `SCHEMA_VERSION` bump. Nothing to migrate, so none of
this project's migration traps apply to this feature at all.

## Privacy

Worth stating plainly, because this sits right next to something that was
deliberately stopped.

The viewing-metrics dashboard was parked because it would have created an
indefinite record of what invited friends watched, when, and where they
gave up — readable by one person. This feature reads the same underlying
facts and is still fine, for three reasons that must all stay true:

1. It reads only the **viewer's own** data, through the viewer's own
   session token.
2. It computes **on demand and writes nothing** — no history table, no
   offer log, no taste profile cached to disk.
3. Its output is visible **only to that viewer**. Nothing aggregates to a
   curator view.

If a future change breaks any of those three — a stored taste profile "for
performance", an offer log "for debugging", a curator-facing "what your
friends are into" panel — this stops being the parked feature's harmless
cousin and becomes the parked feature. Re-open that conversation first.

## Phasing

1. Pure module, `/api/pick`, slate, result card, home button. Modes:
   something new, pure random.
2. Reason lines, finish-something, watch-again, runtime and genre
   constraints, cold-start copy.
3. TV remote polish, offline picker, temperature tuned by feel.

## Open questions

1. **Does Jellyfin actually return `LastPlayedDate` and `PlayCount`** in
   the `UserData` this app already asks for? One `curl` against `/Items`
   answers it. Recency weighting and the abandonment signal both depend on
   it; without it the scorer still works, just blunter.
2. **Should the curator be able to bias the picker** — a "prefer these" or
   "never pick this" list beyond the existing exclusions? `curations` could
   carry it. Leaning no for v1: a curator's thumb on the scale undercuts
   the claim that the pick came from the viewer's own taste.
3. **Card or instant play as the default?** This document argues card.
   Worth one real evening of use before committing.
