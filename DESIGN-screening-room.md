# Design: Screening Room

An expiring link that lets one person watch **one film**, with no account,
no library, and no way to wander. The opposite of an invite: an invite is a
permanent door into everything, this is a temporary door into one room.

The closest real-world precedent is the festival screener. Vimeo's screener
links expire in up to 90 days and start their countdown **when the
recipient first clicks the link**, not when it was sent, and are
browser-only — no app playback. Eventive's virtual cinema adds availability
windows, capped stream counts, geo-restriction and per-session forensic
watermarking. The mechanics worth stealing here are the two clocks, the
device/stream caps, and the honest framing that a link sent to one person
sometimes reaches five.

---

## The wall this feature runs into on line one

Everything playable in this app goes through `/jf/*`
(`src/app/jf/[...path]/route.ts`), and `proxy()` starts with
`getSessionFromRequest(request)` — a real `ResolvedSession`, carrying a
real Jellyfin access token belonging to a real Jellyfin account. Without
one, there is no stream.

This project already hit this wall and blinked. Watch-party guest links
give someone a nameable identity with no signup, and the room page says so
outright: *"Guests never get a player here … there is no Jellyfin
credential to stream on their behalf."* A guest can talk about the film;
they cannot watch it.

### Two different things, routinely confused

The obvious objection is: *a unique link plus a name they type is already a
login — why is any of this hard?* It is a login, and the design treats it
as one. Token in the URL, exchanged for an opaque cookie, resolved against
a `screening_sessions` row: that is authentication (they hold something
only the recipient was sent), identity (the name), a revocable session, and
a countable device — every property `sessions` has for a member. Nothing
below is an attempt to invent an identity that a link and a name have
already established.

The gap is elsewhere. **The gate does not serve video; it proxies it**, and
`proxy()` has to attach *somebody's* Jellyfin token on the way out. That
token is a Jellyfin-side credential, and no amount of gate-side identity
produces one. A name typed into a box is a fact about a person; a Jellyfin
token is a fact about an account on another server.

So the question these three options answer is **not** "who is this person"
— that is settled — but the much narrower **"whose Jellyfin token does the
proxy attach for them?"**

### A. One throwaway Jellyfin account per screening

Reuse the redemption machinery — `createUser()` with a random name, a
random password nobody is ever shown, `applyRestrictedPolicy()`, and a
session row bound to the screening.

Playback then works exactly as it does for a member: direct play,
transcode, HLS, subtitles, seeking, resume, all of it, with zero new
playback code.

Against it: account sprawl on a server whose entire security model is "a
handful of accounts, all deliberately invited", and cleanup becomes
load-bearing. A sweep that dies quietly leaves real accounts behind
indefinitely. Two Jellyfin round trips on the creation path, and two more
to tear down.

And one trap specific to this option, worth naming because the name step
invites it: **do not use the name they typed as the Jellyfin username.**
`users.username` is UNIQUE here and Jellyfin enforces uniqueness of its
own, so the second "Ana" fails at account creation — days or weeks after
the first one worked, in a code path nobody is watching. Generate an
opaque username (`screening-7f3a`) and keep the typed name as a label,
exactly as option B does anyway.

### B. One shared service account, many scoped screening sessions — **recommended**

Create a single Jellyfin account once (`_screening`), restricted policy,
never shown in any UI. Every screening session borrows its token but gets
its **own** `jellyfin_device_id`, so Jellyfin's own session list keeps them
apart the same way two browsers of one member are kept apart today.

- Creating a screening is a pure SQLite write — no Jellyfin call at all,
  so it cannot fail halfway the way redemption can.
- Cleanup is deleting rows. A failed sweep leaves dead rows, not live
  accounts.
- One account to audit in Jellyfin's own dashboard.

The cost: everyone shares one account's `UserData`, so Jellyfin's resume
position and played flag would bleed between strangers. Which means **we
track playback position ourselves**, per screening session, and hand the
player a start time from our row instead of from `UserData`. That is a
bounded, well-understood piece of work (the player already accepts
`startSeconds` as a prop) and it removes a genuine privacy leak — guest B
should not be able to infer where guest A stopped.

### C. Skip Jellyfin: serve a prepared file directly

The machinery already exists. `/api/download/[itemId]` streams a prepared
MP4 off disk with full `Range` support via `parseRange()`, and the worker's
`processDownloadJob()` already produces that file — copying it verbatim
when `alreadyPlayable()`, transcoding when not.

Beautifully simple security story: one route, one file, one token, no
Jellyfin identity anywhere. But it needs the file **prepared first** — an
ffmpeg pass on an i3-6100, writing gigabytes onto a boot SSD that is
already failing, for something the curator wants to send *now*. And no
adaptive bitrate: whatever was prepared is what the guest gets.

**Verdict: B is the default. C is a per-screening option, later** — "prepare
a compatible copy first" for a recipient on hardware that will not direct
play. The two are not exclusive; the same screening row can point at either
delivery mode.

---

## The crux: scoping, and why the proxy must invert its default

Note what `applyRestrictedPolicy()` sets: `EnableAllFolders: true`. That is
correct for members and it means the service account, at the Jellyfin
level, can see **the entire library**. Jellyfin will not enforce "one film"
for us — it has no concept of item-level permission. The gate is the only
thing standing between a screening link and everything on the shelf.

`proxy()` today is written as a **deny-list** with a documented rationale:
the real boundary is the Jellyfin policy, and the path list is defence in
depth. For a screening identity that reasoning collapses, because the
Jellyfin policy grants everything. So:

> **For screening identities, `/jf/*` must be default-deny with an explicit
> allow-list.** If anyone implements this by adding entries to
> `DENIED_PATHS`, the screening link becomes a full library account. This is
> the one thing in this document that must not be got wrong.

Permitted, and only with the item id matching this screening's:

| Path | Why |
|---|---|
| `POST Items/{itemId}/PlaybackInfo` | The playback plan |
| `Videos/{itemId}/stream*` | Direct play |
| `Videos/{itemId}/main.m3u8`, `Videos/{itemId}/hls1/...` | Transcode — the item id is in the path, so it is matchable |
| `Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.vtt` | Subtitle tracks (`subtitles.ts:158`) |
| `Items/{itemId}/Images/*` | Poster and backdrop on the landing card |
| `Sessions/Playing/Progress`, `Sessions/Playing/Stopped` | Transcode keep-alive and teardown |

Everything else, 403. The existing traversal guard and percent-decoding
order stay exactly as they are — decode, reject `..`, *then* match.

One honest exception: `Sessions/Playing` carries an arbitrary `ItemId` in
its **body**, which the path allow-list cannot see. A screening viewer
could therefore write play state onto the throwaway service account for
some other item. That is a write-only scribble on an account nobody reads,
it reveals nothing, and validating request bodies in the proxy would mean
buffering them. Allow it, and write the reason down next to the code so
the next person does not "fix" it into a body parser on the video path.

---

## Two clocks, and a third if you want to be strict

The single most consequential design choice, and the one Vimeo already
answered: **the countdown starts when the link is opened, not when it is
sent.** A screener sent on Friday to someone who opens it on Wednesday
should still give them their full window.

1. **Link expiry** (`expires_at`) — if it is never opened by then, it is
   dead. Default 7 days, matching `INVITE_DEFAULT_EXPIRY_DAYS`.
2. **Viewing window** (`window_hours`) — starts at first open. Default 48h.
   "You have two days from when you start."
3. **Play window** — the rental model: the clock starts at first *play*,
   not first open. Strictly better for a real screener; worse for "watch
   this when you get a chance". Offer it as a mode
   (`window_starts_on: 'open' | 'play'`), default `'open'`.

Plus the two caps that decide what happens when the link is forwarded:

4. **Max devices** (`max_devices`, default 2). One device is too strict —
   phone plus television is a legitimate single person. Three or more is a
   group chat. Extra devices get a polite refusal and the curator sees the
   attempt count.
5. **Max concurrent streams** (`max_concurrent`, default 1). Two
   simultaneous streams means it has been shared, and it is also real
   transcode protection: this box is an i3-6100 that struggles with one
   4K transcode, let alone two.

And **revoke**, which is immediate. Because the proxy checks per request,
a revoked screening kills a stream in progress within one HLS segment.
That is the correct behaviour, not a bug.

### Expiring mid-film

Do not rip the last twenty minutes of a film away from someone. Two parts:

- **Server**: if a stream is live when the window closes, grant a grace
  period (30 minutes past the end, hard-capped) rather than 403-ing
  mid-segment.
- **Client**: the page polls a small `/api/screening/state` every minute
  and shows "this screening ends in 5 minutes", then pauses and shows the
  ended card. A player that simply dies mid-scene reads as a bug; a player
  that warns and then closes reads as a rule.

---

## What the guest sees

A deliberately narrow site. No AppBar, no search, no Browse link, no
comments, no "back to library" anywhere — it must be structurally obvious
that this is one film and not the front door of something bigger. The
watch-party ended-card is the tonal precedent.

**Landing** (`/s/{id}`): backdrop, title, year, runtime, **the curator's
note** — the free-text message saying why he is sending it, which is the
actual point of the feature and not a nicety — subtitle availability, the
content warning if one is cached (`content-warnings.ts` already has it),
and a countdown: "Available for another 41 hours." One Play button.

**Player**: `PlayerMount` unchanged, with `startSeconds` fed from our own
`screening_progress` row rather than Jellyfin's `UserData`. Subtitle track
selection works exactly as it does everywhere else. No download
affordance — Langlois mode has no meaning here.

**After it ends**: a graceful page naming who sent it and what it was
(both snapshotted at creation, so this still renders after the film has
been renamed, regrouped or removed), and a line about how to ask for
another. Never a 404, and never a login form — a login form to someone
with no account is the most confusing possible ending.

---

## Schema

New tables only, so `CREATE TABLE IF NOT EXISTS` covers it and nothing
belongs in `runVersionedMigrations()`. `SCHEMA_VERSION` 42 → 43. **No bare
`ALTER TABLE` in `SCHEMA_SQL`** — it replays in full on every later bump.
**No backticks anywhere in the SQL string**, not even inside a comment: one
truncates the whole template literal.

```sql
CREATE TABLE IF NOT EXISTS screenings (
  id                  TEXT PRIMARY KEY,
  token_hash          TEXT NOT NULL UNIQUE,   -- SHA-256 only, exactly like invites
  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_label     TEXT,                   -- "Ana" — for the curator's list, shown to nobody else
  recipient_email     TEXT,
  message             TEXT,                   -- the curator's note, rendered on the landing page
  expires_at          INTEGER NOT NULL,       -- link dies unopened at this point
  window_hours        INTEGER NOT NULL,       -- viewing window once it starts
  window_starts_on    TEXT NOT NULL,          -- 'open' | 'play'
  window_started_at   INTEGER,                -- set once, by whichever event window_starts_on names
  max_devices         INTEGER NOT NULL DEFAULT 2,
  max_concurrent      INTEGER NOT NULL DEFAULT 1,
  stamp_name          INTEGER NOT NULL DEFAULT 0,  -- the name overlay, see "Leaks"
  device_attempts     INTEGER NOT NULL DEFAULT 0,  -- including refused ones
  first_opened_at     INTEGER,
  revoked_at          INTEGER,
  created_at          INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS screening_items (
  screening_id     TEXT NOT NULL REFERENCES screenings(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  jellyfin_item_id TEXT NOT NULL,
  item_path        TEXT,     -- survives a Jellyfin id change; ids here are not stable
  imdb_id          TEXT,     -- second fallback
  title            TEXT NOT NULL,  -- snapshot, so the ended card still renders
  PRIMARY KEY (screening_id, position)
) STRICT;

CREATE TABLE IF NOT EXISTS screening_sessions (
  id                 TEXT PRIMARY KEY,   -- opaque, and the cookie value
  screening_id       TEXT NOT NULL REFERENCES screenings(id) ON DELETE CASCADE,
  jellyfin_device_id TEXT NOT NULL,      -- per device, so Jellyfin keeps them apart
  display_name       TEXT,               -- what they typed; a label, never a claim
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  user_agent         TEXT,
  ip                 TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS screening_progress (
  screening_session_id TEXT NOT NULL REFERENCES screening_sessions(id) ON DELETE CASCADE,
  jellyfin_item_id     TEXT NOT NULL,
  position_ticks       INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (screening_session_id, jellyfin_item_id)
) STRICT;
```

Two notes on shape.

**Why `screening_items` is a table and not a column.** This library is full
of films split across two files and shows grouped into series — the whole
`library_groups` / `partsUnit: "parts"` apparatus exists because of it.
Sending "a film" that is really part one of *Fanny and Alexander* would be
a silently broken screening. One table now, and the v1 UI can still offer
only "this film" or "this whole grouped set". A double bill falls out for
free later.

**Why `item_path` and `imdb_id` ride along.** Jellyfin item ids are not
stable across a library rebuild — this codebase says so repeatedly and its
entire curation layer is keyed on path for exactly that reason. A screening
keyed on the item id alone quietly dies after the next rescan, days after
anyone would connect the two events. Resolve by id, fall back to path, then
to IMDb id.

---

## Flow, end to end

1. **Curator creates** — `POST /api/admin/screenings`, from a new
   **Screening Room** tab in `curator.html` (which needs no rebuild to
   ship, though it is useless until the routes are deployed). Pick a film
   from the existing library browser, type a recipient name, a note, pick a
   window, optionally an email. Response returns the URL **once**, exactly
   like `createInvite()` — the plaintext token is never persisted and
   cannot be recovered.
2. **Send** — copy the link, or let the server email it, reusing the
   `sendInviteEmail()` transport as `sendScreeningEmail()`. Same rule as
   invites: a failed send never fails the creation, because a working link
   the curator can paste by hand is the thing that actually matters.
3. **Open** — `GET /screening/{token}` is a route handler, not a page. It
   validates, **claims a device slot in one conditional `UPDATE` inside a
   `transaction()`** (copy `claimInvite()` verbatim — two browsers opening
   the same link at the same instant must not both take the last slot),
   sets an httpOnly cookie holding a new `screening_sessions.id`, and
   302s to `/s/{id}`. The token leaves the address bar immediately, so it
   is not sitting in a screenshot, a `Referer`, or shoulder-surfing range.
   This is precisely the watch-party guest-link pattern
   (`/party/{roomId}/g/{token}`).
4. **Name themselves** — one field, once per device, written to
   `screening_sessions.display_name`. If the curator already labelled the
   screening, pre-fill it: *"Watching as Ana — not you?"*, which is one tap
   for the intended recipient and a small, useful speed bump for anyone
   the link was forwarded to. Skippable; a blank name is "Guest", the same
   default the party guest links already use.
5. **Watch** — landing card, then `PlayerMount`, with `/jf/*` scoped as
   above. Progress posts to `/api/screening/progress`.
6. **End** — expiry, revocation, or the grace period running out. Ended
   card.
7. **Purge** — a sweep (alongside the party sweep and the scrape tick)
   deletes screening rows some weeks past their end, cascading to sessions
   and progress. Without it the database slowly becomes a permanent record
   of who was sent what, which is the exact thing the metrics decision was
   about.

### What the name is, and is not

`screening_sessions.display_name` is a **courtesy label, not a claim**.
Whoever holds the link types whatever they like; nothing verifies it, and
nothing should pretend otherwise. It is worth having anyway, for three
concrete jobs:

- the curator's list reads "Ana, two devices, opened Tuesday" instead of
  two anonymous rows;
- the name stamp (see "Leaks") has something to stamp;
- if a link has been passed around, the names are usually the first
  evidence of it, volunteered.

The authorisation decisions — can this device open it, is the window still
open, can it stream this item — are all made from the token and the session
row, never from the name. A curator UI that shows the name must show it as
what someone typed, not as who they are: "opened by someone calling
themselves Ana" is the honest rendering, and it costs nothing.

### Middleware

`/screening/` and `/s/` must be added to `middleware.ts`'s matcher
exclusions, next to `party/`. Miss this and every guest is redirected to a
login page for an account they do not have — the feature will look
completely broken and the cause will not be in any of the code you just
wrote.

---

## Leaks, and being honest about them

Eventive can promise Nagra NexGuard forensic watermarking and Widevine-class
DRM. This app has neither and will not. What it can do:

- **Caps and expiry** (above) — makes a forwarded link a small problem
  instead of an open one.
- **A name stamp** (`stamp_name`, off by default): the recipient's name and
  a short code at low opacity in the player, repositioned every few
  minutes. A screen recording captures it, which is the point; someone
  pulling the stream URL directly defeats it entirely. It is a deterrent
  against casual re-sharing, not protection, and the console should say so
  in those words rather than implying more.
- **Telling the guest.** The landing page says plainly: this link is for
  you, it expires on this date, and the sender can see when you have opened
  it. Being upfront is what makes the "opened" signal acceptable rather
  than surveillance.

## Privacy line

A screener sender knowing that a screener was opened is normal and expected
— Vimeo shows exactly that, and the recipient is told. So a
`screening_opened` notification to the curator is fine. What is **not** fine
is letting this become the parked viewing-metrics feature by the back door.

The rule: store **first opened, last seen, a resume position, and a device
count**. Not a timeline of plays, pauses and seeks. Not "they gave up at
minute 34" as a stored event stream. And purge it after the screening dies.
If a future request is "show me a chart of how far people got through the
films I send", that is the parked feature and it needs the same conversation
the parked feature is waiting on.

---

## Scenarios worth designing for now

1. **The link is forwarded to a group chat.** Device cap, concurrency cap,
   and an attempt counter the curator can see. Optionally "lock to the
   first device", which is the strict-screener setting.
2. **The file will not direct play** — 4K HEVC, 10-bit, DTS — so Jellyfin
   transcodes, and a CPU spike lands on a failing box at whatever hour the
   guest chooses. The worker already has the predicate for this
   (`alreadyPlayable()`); surface it **at creation time** as a warning,
   with "prepare a compatible copy first" (delivery mode C) as the answer.
3. **They start on a phone and finish on a television.** Two devices, both
   inside the cap, each with its own progress row.
4. **The library is rescanned and the item id changes.** Covered by
   `item_path` / `imdb_id` above. Without it, screenings silently break.
5. **The film is excluded, rollout-hidden, or a special feature.** A
   screening deliberately bypasses discovery filters — same precedent as
   `getItem()` not applying `filterVisible()`. Sending a screening is an
   explicit curatorial act, and it should work for a title not yet public.
   Say so in the console so it is not mistaken for a bug.
6. **Revoked mid-film.** Immediate, by design. The client's state poll
   turns it into an explanation rather than a broken player.
7. **Clocks.** Everything is epoch-ms UTC per the schema rule. This matters
   more than usual here: the WSL distro runs UTC while the Windows host runs
   IST, and a window computed from a local-time string would be off by five
   and a half hours in whichever direction hurts most.
8. **The guest wants to keep watching things.** The ended card is the right
   place to say "ask him for an invite". Converting a screening into a real
   invite in one click is a nice v2; it must stay an explicit curator
   action, never automatic.
9. **Apps and televisions.** Screening is browser-only, matching Vimeo's
   own restriction — a guest has no app installed and no reason to install
   one. The phone/desktop shells wrap the real site, so a link opened in
   them would work, but nothing needs porting.
10. **Rate limiting.** Add `SCREENING_OPEN_LIMIT` per IP alongside the
    existing rules. Guessing a 256-bit token is not the threat; a stuck
    client retrying is.
11. **Error copy.** Follow `peekInvite()`: distinguish "this screening has
    expired" and "this screening was revoked" from "this link is not
    valid". The first two are useful to an honest recipient and give an
    attacker nothing.
12. **Members using the feature.** Letting any member send a screening of
    something they loved is genuinely attractive and is a real change in
    the trust model — one person's judgement about who deserves access
    becomes several people's. Out of scope for v1; if it ever ships, it
    needs a per-member quota and a curator-visible log.

---

## Phasing

1. **Core.** Schema, `src/lib/screening.ts`, admin API, console tab, the
   token→cookie route, the landing page and player, the scoped `/jf/*`
   identity, expiry, revoke, middleware exclusion.
2. **Around the edges.** Email send, curator notification on open, the
   countdown and grace period, device-cap UX, the unplayable-file warning
   at creation, the purge sweep.
3. **Later.** Name stamp, prepared-copy delivery mode (reusing
   `download_jobs`), double bills and grouped parts in the UI,
   member-initiated screenings.

## Verification, given how this box has to be treated

Nothing here can be tested by hammering deploys — Docker build churn is
the dominant write load on a failing SSD, and the site is the same box.
So:

- Typecheck and `node --test` in a throwaway container against the existing
  image, as the handoff already documents.
- `scripts/checks/check-console-syntax.sh` and `check-console-ids.py` for
  the new console tab — console-only changes need no rebuild at all.
- The `/jf/*` scoping deserves a real unit test over path strings: for a
  screening identity, assert that every permitted shape passes with the
  right item id and fails with a different one, and that a representative
  sample of everything else (`Items`, `Users`, `Sessions`, an image for a
  different film) is refused.
- Manual, once deployed: an incognito window for the guest view; a second
  device to hit the cap; a two-minute window to watch expiry land; a
  revoke while a stream is running; `PRAGMA user_version` reporting 43.

## Open questions

1. **B or A** — shared service account, or a throwaway account per
   screening? This document argues B, mainly because a failed cleanup
   leaves rows rather than live accounts. The counter-argument is that A
   needs no per-guest progress tracking and no shared-identity reasoning at
   all. Worth ten minutes before writing the schema, because it is the one
   decision that is expensive to reverse.
2. **Default window.** 48 hours from first open is proposed. A festival
   screener would say 7 days; a "watch this tonight" would say 24.
3. **Should a screening appear anywhere to members?** A quiet "the curator
   sent this to someone" is probably charmless and slightly invasive.
   Leaning: no, screenings are invisible to everyone but the curator and
   the recipient.
