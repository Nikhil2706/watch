# Project Knowledge — Everything About This Site

This is the living reference for the whole project: what it is, how it's put
together, and a full record of what's been built. It's written for a
non-technical reader — you shouldn't need to open any code to understand
what's here. It gets updated every time we do more work, so this is always
the place to come back to for "wait, what does this thing do again?"

For hands-on operational stuff (how to run curl commands, how the Cloudflare
tunnel works, backup commands) see `README.md` — that one's more of a
technical reference. This file is the story and the map.

---

## 1. What this actually is

A private, invite-only movie and TV streaming site — your own version of
Netflix, but the only films on it are the ones you actually own, sitting on
a hard drive. Nobody signs up on their own; you send someone a one-time
invite link, they pick a username and password, and from then on they log in
like any other site.

Under the hood it's two programs working together:

- **Jellyfin** — an open-source media server. It's the thing that actually
  knows where your movie files are, reads their metadata, and streams video.
  Jellyfin normally has no login screen worth trusting on its own (it's built
  to be self-hosted for one household), so it never talks to the internet
  directly.
- **jellyfin-gate** (this project) — the front door. It's the login page,
  the invite system, the pretty browsing pages people actually see, and the
  Curator's Dashboard where you manage everything. It sits in front of
  Jellyfin and is the *only* thing the internet can reach.

Both run as Docker containers on your Windows machine, and a Cloudflare
tunnel punches a hole outward (not inward) so the site is reachable at a
real web address without you having to open any ports on your router.

## 2. Where things actually live

- **The whole project (all the code):** `C:\Users\Dell\Downloads\jellyfin-gate`
  on this Windows machine, run via Docker Desktop.
- **The movies themselves:** `E:\Da Moveesh` — mounted into Jellyfin
  read-only, so nothing running in a container can ever delete or modify a
  film. To remove something, you delete the file from that folder yourself
  and then trigger a library scan.
- **The drop-zone for new files:** `C:\Media\incoming` — the watch-folder
  worker picks up anything dropped here, converts it if needed, and moves it
  into the real library automatically.
- **The public site:** `https://watch2.abhigyanverma.com`
- **The Curator's Dashboard:** `curator.html`, right in the project folder —
  you open it as a local file in a browser and it talks to the running site
  using an admin key (from `.env`) to do everything: manage invites, review
  the library, run the conversion queue, and — as of this session — manage
  Accolades.
- **The admin key and other secrets:** in a file called `.env` in the
  project folder. Never shared, never committed anywhere, never printed in
  logs.
- **Automatic library scanning is currently switched off**
  (`LIBRARY_SCAN=false`) — after adding or removing a file, someone needs to
  trigger a scan by hand (a button in the dashboard, or the watch-folder
  worker does it automatically when it drops in a converted file).

## 3. The shape of the system, in one picture

```
you & your invited friends
        │
        ▼
  Cloudflare (handles the public web address)
        │
        ▼
  jellyfin-gate  ← the only thing the internet can reach
   - login, invites, browsing pages, film pages
   - the Curator's Dashboard (curator.html)
   - its own small database (SQLite) for invites, sessions,
     watchlists, curator-written content, and now Accolades data
        │  (talks over a private connection only this machine can see)
        ▼
  Jellyfin  ← never reachable from the internet directly
   - reads your movie files, knows their metadata
   - actually streams the video bytes
```

The "Everything runs on one Windows machine" part matters: streaming a movie
means Jellyfin hands bytes to jellyfin-gate, which hands them to the viewer.
If any of that hopped to a different computer, every byte of every movie
would travel that hop too — so everything stays on one box, on one network,
right next to each other.

## 4. Everything that's been built

### Earlier work (before this session)

The project started as a bare invite-gateway (login, invite links, session
handling — described in detail in `README.md`) and a basic movie-browsing
site rendered from Jellyfin's own data. Before the work covered in detail
below, a long stretch of earlier sessions built:

- **TV show support.** Jellyfin sees a folder of episode files as a pile of
  unrelated movies; a curation layer was built so you can group them into
  one show, correct mis-matched episode metadata, and have the dashboard
  show them as a single collapsed entry instead of 10 separate posters.
- **Real per-episode metadata from OMDb**, and a series-level poster/
  backdrop/rating stored once per show rather than guessed from whichever
  episode Jellyfin happened to match first.
- **The watch-folder worker**, which watches a drop-zone folder, converts
  anything a browser can't play directly, and publishes the result into the
  real library automatically — and was later changed from "always running
  and scanning" to "only wakes up when the dashboard asks it to" (
  `WORKER_MODE=queue`), so it doesn't compete for CPU with someone actively
  streaming.
- **The dashboard was renamed and redesigned as the "Curator's Dashboard"**
  — the name for the whole idea that you're not just an admin, you're
  curating what's presented and how.
- Several rounds of fixing real bugs found while testing all of the above
  against the real library (stale artwork after a correction, episodes
  sorted wrong, a "More like this" row filling up with a show's own
  episodes instead of actually similar films, and so on).

### This session: two large features, built, tested, and shipped

#### A. "Accolades" — reviews, awards, and trivia on every film's page

**The idea:** beyond the IMDb/Rotten Tomatoes/Metacritic scores Jellyfin
already shows, a film's page can now show a short review quote, an award or
ranking mention ("Won: Best Sound Editing, 92nd Academy Awards" or "#7 · The
Ringer's 25 Best Sports Movies"), and a small list of trivia facts — all
sourced automatically, with you able to review, override, or hand-write any
of it from the dashboard.

**Where the content comes from**, each one checked against the source
site's own rules before being used at all (see §5 below):

- **yearendlists.com** — an index of *other* publications' best-of-the-year
  film lists. Gives ranked-list entries.
- **Wikipedia**, through its own official data API (never by scraping the
  page itself) — gives a film's real awards/nominations table, plus
  interesting facts pulled from its "Production" writeup.
- **PDF books you upload yourself** — share a PDF of a film book or essay
  collection, and the system reads it, finds every film in your library it
  mentions, and pulls out quotable passages and trivia automatically.

**How you manage it:** a new "Accolades" tab in the Curator's Dashboard,
with three parts:
- **Films** — search for a film, see everything found about it, read the
  full source article, pick which quote/award/fact should actually show
  (or write your own), and lock it in so it stops changing automatically.
- **Builder** — make your own award lists from scratch ("Mamnani's
  Favourite Car Movies"), searching your library to fill in each slot, with
  a blurb for each one. You can even list a film you don't own yet — it
  links itself in automatically the moment it's added to the library.
- **Sources** — turn scraping sources on or off, run a scrape on demand,
  upload books, and review what a book matched (confirm a fuzzy guess,
  link something the system couldn't place on its own).

**A real safety rule, built in structurally, not just by habit:** the full
text of anything scraped or uploaded is stored privately for the dashboard
to read from, but the public film page is only ever able to show one short
selected passage — the code for the public page literally cannot reach the
full text at all, by design.

**Rich text.** Anywhere you write a blurb or trivia fact, you get a small
formatting toolbar (bold/italic/underline/strikethrough) — a deliberately
narrow, safe set of formatting options rather than free-form HTML.

**Sites we checked and stayed away from**, per your standing instruction to
never risk violating a site's terms: IMDb (their terms explicitly forbid
scraping), Letterboxd, MUBI Notebook, Roger Ebert, and IndieWire. All
ruled out after checking their actual rules, not assumed.

#### B. A completely redesigned Browse page

The old "Browse" page was a flat grid you could only filter by genre. The
new one, built from a detailed design you approved first, lets you explore
the library four different ways:

- **Genre** (same as before, but now ranked more intelligently)
- **Director** — click into a filmmaker and see every film of theirs in
  your library, plus their photo and bio, ranked so a director with two or
  three genuinely great films ranks above one who directed ten
  forgettable-but-decent ones (not just "most films")
- **Actor** — same idea, for cast
- **Decade**

Films are ranked by a proper "how good and how trusted is this rating"
formula (the same kind of math IMDb itself uses for its Top 250) rather than
a plain average — so one perfect score from a single voter doesn't outrank
a film thousands of people rated very highly.

**TV shows show up correctly.** A grouped show appears as one tile (with a
"12 parts" badge), using the show's own overall genre/cast/rating — not as
12 separate, duplicate-feeling entries, and not letting a show's director
get credited once per episode in the ranking.

**Hidden files stay hidden.** Anything excluded from the library, or with no
metadata yet, is left out of Browse the same way it's left out everywhere
else on the site.

**A real performance problem, found and fixed.** Asking Jellyfin for every
film's full cast list in one go turned out to be genuinely slow on
Jellyfin's own side — about 20 seconds, no matter how the request was
shaped. The fix: that one expensive piece is now fetched once and kept in
the site's own database for 12 hours, and — as of this session — is also
pre-fetched automatically the moment the site starts up, so nobody visiting
the page ever has to wait for it.

#### C. A health monitor for the Curator's Dashboard

**The idea:** a new "Health" tab that answers, at a glance and in plain
language, "is everything actually working right now?" — without needing to
open a terminal or read a log file.

**What it checks**, all gathered fresh every time the tab is opened (and
every 30 seconds while you're on it):
- **The public site** — can it actually be reached from the outside, the
  same way a viewer would reach it (through Cloudflare, not just locally)?
- **Jellyfin** — is the media server itself responding, and how fast?
- **Who's watching** — how many devices are currently signed in, and how
  many are actually streaming something right now.
- **Storage space** — how much room is left on the drive the library lives
  on, so running out of space is a warning here instead of a mystery later.
- **The conversion queue** — anything waiting, anything running, anything
  that's been "running" so long it's probably actually stuck, and anything
  that failed in the last week.
- **Accolades scraping** — any scrape job that's failed in the last week.
- **When the library was last scanned** — since scanning is manual on this
  setup, it's easy to forget; this just says how long it's been.
- **The database file's size** — a simple, honest number, mostly useful for
  noticing if something starts growing unexpectedly.

Each one gets its own small card, color-coded green/amber/red, plus one
overall banner at the top so you never have to read all eight cards just to
know if something needs your attention.

**A deliberate boundary, not an oversight:** this does *not* show whether the
Jellyfin or worker *containers themselves* are up or down — only whether they
*respond*. Doing the former would mean giving jellyfin-gate access to the
Docker socket, which is a real permissions expansion worth a separate
conversation before building, not something to slip in as part of a
dashboard feature. Left out of this version on purpose.

#### D. A real error and activity log, feeding the Health tab

**The idea:** the health monitor (above) answers "is everything working right
now?" This answers the next question: "when something breaks, what actually
happened, and how often?" Every one of the following now gets written down
in one place, automatically, as it happens:

- **The outside services this site calls** — OMDb (ratings, episode
  metadata), Wikipedia, and yearendlists.com. Every call is counted
  (success and failure, per day), and every failure is recorded with what
  went wrong. OMDb specifically has a hard 1,000-calls-a-day free-tier
  limit, so the Health tab now shows today's usage against that number —
  before, running low on quota would have just looked like ratings randomly
  going stale with no visible cause.
- **This site's own pages and API failing for a real visitor** — signing
  in, redeeming an invite, and the video-streaming proxy all now report it
  when Jellyfin doesn't answer or answers with an error.
- **Playback actually breaking in someone's browser** — a video that
  won't decode, a file the browser says it can't play, a stream that drops
  mid-way. This is the direct answer to "how would we ever know about a
  corrupt file?": the browser itself now tells the server when this
  happens, since from the server's side a failed stream otherwise just
  looks like a viewer who stopped asking for more of the file.
- **The site itself crashing in someone's browser** — any unexpected
  JavaScript error while a page is rendering gets caught and reported,
  rather than just silently breaking for whoever hit it.
- **Conversion failures from the watch-folder worker** — an unreadable/
  corrupt source file, a failed conversion, a failed move — now land in
  the same feed as everything else above, not just the worker's own log.

**Where it shows up:** the Curator's Dashboard's Health tab grew two new
sections — "External APIs" (today's call counts, with OMDb's usage shown
as a fraction of its daily cap) and "Recent activity log" (everything
above, newest first, filterable by category and severity, each row
expandable for the full detail).

**A deliberate scope limit:** the log only remembers 30 days, and at most
5,000 rows — old noise ages out on its own rather than growing forever.
Reporting a client-side error has no login requirement (a crash on the
login page is still worth knowing about) but is rate-limited per visitor,
since it's the one thing anyone who can reach the site can trigger.

#### E. A plan for OMDb's daily limit as the library grows

**The concern:** OMDb's free tier allows 1,000 lookups a day. That was never
a problem while ratings only get fetched the moment someone actually visits
a film's page — real traffic naturally spreads that out. But as the library
grows toward and past 1,000 titles, a different risk shows up: a big import,
or a cluster of titles that all first got a rating on the same day, could
all go stale on the same day a week later — and nothing was making sure
that catch-up happened gradually instead of all at once.

**What's built:** a background process that quietly works through the
library's ratings a small handful at a time — checking every ten minutes,
never doing more than a handful of OMDb lookups per check, and stopping for
the day entirely once it's used a fixed, conservative share of the daily
1,000-request allowance (leaving the rest for real visitors and for you
fixing up a show's episodes by hand). It always works on the most useful
thing first: a film with **no** rating yet, before one that's merely a
week old.

**Why this works at any size:** a small library catches up within a day
and then just idles, doing nothing until something actually goes stale.
A library with thousands of titles simply can't finish in one day — so it
doesn't try. It makes steady, bounded progress every day instead, and
picks up exactly where it left off. There's no size where this either
does nothing or does too much.

**Where it shows up:** the Health tab's "External APIs" card now shows,
under OMDb, how many titles have never been rated, how many are overdue,
and how many total — plus when the last batch ran and how many it did.

#### F. Accolades: the CRUD pieces that were missing

Building Accolades earlier left a few real gaps: renaming and deleting a
whole curator-built list, and editing a slot, were already possible — but
unlinking a wrongly-matched article from a film, reviewing what a book or
article actually matched, and reordering a list or a film's trivia, were
not. All of that is filled in now:

- **Unlink an article from a film.** Every article listed under a film's
  "Linked articles" now has an Unlink button.
- **Review matches, for real.** Opening any article or book's full text
  now also shows every film it mentions — matched ones with an Unlink,
  and unmatched ones with a small search box to link them by hand, or a
  Discard button to reject the mention entirely. This is the "review
  matches" step the original plan called for, which never actually got
  built into the dashboard until now.
- **Reorder.** Both a Builder list's slots and a film's curated trivia
  facts now have up/down arrows.
- **Edit a trivia fact you wrote yourself**, in place, without removing
  and re-adding it.

**Other places checked for the same gap**, not yet acted on: Curator's
Picks (the separate public reading-list feature) has no dashboard UI at
all — it's still add-only via the admin API directly. Invites can be
created and revoked but not edited afterward. Conversion jobs can be
paused/resumed but a stuck or failed one can't be deleted or retried from
the dashboard. Flagged for later, not built this round.

#### G. Fixed: individual episodes leaking into recommendations

**The bug:** to Jellyfin, every episode of a grouped TV show is just another
"Movie" item — the grouping (turning ten files into one show) only exists
in this app's own database, layered on top. That meant anywhere this site
asked Jellyfin for a plain list of titles, Jellyfin had no way to know an
episode should read as part of its show — so individual episodes could
show up as their own separate entries, often under a mis-matched filename-
derived title, exactly like the Browse page and Search results used to do
before those were fixed earlier this session. "More like this" was doing
it too, along with a few other rows nobody had checked yet: Recently
added, the homepage's genre rows, an actor's filmography, and the curator
dashboard's own film search.

**The fix:** one shared rule, applied everywhere a browse-style list of
titles is shown — the first episode of a show encountered becomes a single
"N parts" tile (the show's own name and poster, linking to its collection
page); every other episode from that same show is dropped rather than
shown again. Applied to: More like this, Recently added, the homepage's
genre rows, an actor's/director's filmography, and — on the curator side —
the Accolades dashboard's film search, which now also resolves to the
show's own IMDb id instead of one episode's.

**Deliberately left alone:** "Continue watching" and a viewer's watchlist.
Those aren't browse-titles lists — they point at a specific episode's own
resume position or a specific thing someone chose to save, so collapsing
them would replace a working "pick up where I left off" link with a link
to the show's episode list instead, which would be a regression, not a
fix. A show's own collection page (its own episode list) and an
individual episode's own page are unaffected for the same reason — those
are exactly the places episodes are supposed to show individually.

**Verified against the real library**, not just by inspection: simulated
the exact grouping logic against real grouped-path data (three real
episodes of "The Curse" collapsed correctly to one tile, an unrelated real
movie passed through untouched), and confirmed live that searching the
curator dashboard for "curse" now returns exactly one hit — the show
itself, with its real linked IMDb id — instead of ten separate episodes.

#### H. "Us" — the people actually watching this together now have a voice

Every film and show page now has, right below the facts (ratings,
accolades), what's effectively a small private conversation about it:

- **Rate what you've watched**, 1 to 10, right there on the page. Everyone
  else's ratings blend into a new "Us" number sitting alongside IMDb/RT/
  Metacritic in the ratings row — the room's own opinion, not an outside
  one.
- **Leave a comment**, and **reply to someone else's** — one level of
  replies, enough for a real back-and-forth without turning into an
  unreadable nested thread.
- **A notification bell**, in-app only — no push, no email, exactly as
  asked — lights up when someone replies to *your* comment specifically
  (not just any activity on a film you've also commented on), so you know
  to go answer back. Opening it marks everything read.

**A few decisions worth knowing about:**
- A TV show's comments and rating live under the **show's own** identity,
  not any one episode's — so the conversation about a show stays in one
  place no matter which episode someone's actually on.
- Deleting your own comment doesn't erase it outright — it becomes
  "[deleted]" and stays in place, because a reply underneath it deserves
  to survive even if the message it was replying to gets pulled.
- You (the curator) can remove any comment via an admin-gated route, kept
  in reserve for the rare case — not wired into a dashboard view yet,
  flagged the same way the last round's other loose ends were.

**How it was verified**, beyond typecheck/build/deploy: two throwaway
test accounts were created, used to run the entire real flow against the
live site — rate, comment, reply, get notified, mark read, edit, delete —
including the edge cases that actually matter (replying to a reply gets
refused, replying to a now-deleted comment gets refused, one person can't
edit another's comment, a deleted comment's reply survives underneath it)
— then everything was deleted afterward, leaving no trace in the real
data.

#### I. Ratings moved from 1-10 to half-star

The "Us" rating changed from a plain 1-10 number picker to 0.5-5 stars in
half-star steps — and each person's comment now shows their own rating
next to their name, so "4 stars, and here's why" reads as one thing
instead of two separate places to look. Under the hood this is still
exactly the same 1-10 scale as before (a whole number 1-10 is just a
half-star count relabeled: 7 = 3.5 stars) — no database change was needed,
only the display and the click target changed.

#### J. Closing the loop on "have we scraped everything?"

Checked honestly rather than assumed, and the answer was no on both counts
— see the two items below for what that meant and what's been done since.

**Wikipedia now has its own background catch-up**, same idea as the OMDb
one: a few films every ten minutes, forever, with no daily cap to respect
(Wikipedia has none) — just steady, polite progress. "Already tried"
(including "tried and there's genuinely no Wikipedia page") is now tracked
per-film, so nothing gets re-attempted forever for no reason. Verified
live: the very first real batch processed 5 films with 310 still to go.

**yearendlists.com's coverage was expanded** from the single year already
done to five more (2024, 2019, 2014, 2012, 2017), adding 73 more accolade
mentions matched to real library films. Also learned something useful in
the process: the site's real coverage window is roughly 2011 onward — 2010
and 2003 both came back with zero lists, not an error, just nothing there
to find. No point running years further back than that.

**A first real test of a "back pocket" review site** — Reverse Shot,
vetted for ToS earlier but never actually built against. It works: 9 real
reviews fetched and stored with real full text, film titles accurately
picked out using the site's own "*Title*, Dir. Director" convention. Zero
of those 9 matched a film in this library, which is a coverage story, not
a bug — Reverse Shot's front page is current releases, and this library
leans toward older titles. Worth more later (an archive crawl reaching
further back), not urgent now.

**Curator's Dashboard was renamed Curator's Console** — cosmetic, no
behavior change (`curator.html`'s title/heading only).

**Accolade badges now link back to their source**, matching what blurbs
already did. `resolveAccolade()` (`src/lib/scraping/resolve.ts`) now
carries a `sourceUrl` alongside badge/detail — set whenever the mention
came from a real scraped URL (never set for a curator-built list, which
has nowhere to link to). `RatingsRow.tsx`'s accolade cell renders a
"Read the source →" link when it's present. Verified live against a real
film (Marty Supreme, tt32916440) via a throwaway invite/session — the
page correctly linked out to the yearendlists.com article it was scraped
from, and picked the most-prominent (lowest-rank) mention among several
real matches, confirming `resolveAccolade()`'s existing "best wins" logic
still holds with the new field threaded through every return path.

### 5. A standing rule we follow: never scrape somewhere without checking first

Every time a new source has come up (for Accolades, or for anything that
pulls data from another website), the actual robots.txt file and terms of
service get checked for real — not assumed — before anything is built
against it. Sites cleared this way: The Ringer, Bright Wall/Dark Room,
Reverse Shot, yearendlists.com, Wikipedia (via its official API). Sites
ruled out this way: IMDb, Letterboxd, MUBI Notebook, Roger Ebert, IndieWire.

## 6. Mistakes made and fixed (worth knowing about)

- **A real outage, caused mid-session, fixed the same session.** A database
  change was written in a way that worked the first time but broke on the
  *next* unrelated update, taking the whole site down for a few minutes.
  No data was lost — the change was written safely enough to roll itself
  back — but the underlying mistake (a database change that only works
  once) has since been fixed properly, and the fix itself now guards
  against the same category of mistake happening again.
- **A rich-text encoding bug** made some demo files show garbled characters
  (`â€"` instead of a dash) — a Windows text-encoding quirk, fixed and now
  checked for automatically before any file is sent.

## 7. What's still open / not done yet

- **TMDB integration** (for picking between multiple poster/backdrop
  options per film) is designed but waiting on you to provide a
  `TMDB_API_KEY`.
- **Review sites kept "in reserve."** The Ringer, Bright Wall/Dark Room and
  Reverse Shot are all cleared and wired up in the system, but left switched
  off until you want to turn one on and see how it does with real content.
- **Container-level up/down status** (as opposed to "does it respond") for
  Jellyfin and the worker isn't shown on the health monitor — it would
  require giving jellyfin-gate access to the Docker socket, which needs its
  own conversation before it's built, not just a dashboard add-on.

---

## Changelog

Newest entries at the top. Each one is a short "what changed and why," not a
full replay of the work.

### 2026-08-28 (latest) — The logo: the aperture finished, and every surface made to agree
`Brand.tsx` has always drawn an aperture, with a comment explaining why it is
not a play triangle. The app icon and favicon never got the memo: they shipped
a blue **W** — a letter, in `--accent`, which is the one colour the palette
comment reserves for things you can press. Two identities for one product, and
the one strangers meet first said nothing. This finishes the existing mark
rather than inventing a new one.

- **The mark is a lit iris.** Six leaves in cool metal around a hexagonal
  opening lit warm from behind, which is the projector-in-a-dark-room the
  sign-in page already sets up. Warm stays the brand and sits at the centre;
  the accent blue never touches the logo.
- **It is a construction, not a drawing.** Six chords across a circle of
  radius R leave a hexagon of circumradius R/√3, apothem R/2, and each chord
  is trisected by it. Every leaf is the circular segment its chord cuts off,
  so the six tile the disc exactly — no seam, no gap. One parameter (the
  chord's half-span; 60° is the logo, 90° is shut) opens and closes the whole
  thing. `brand/gen.py` re-renders the entire system from it.
- **Four cuts**, because one drawing cannot survive every size: full (48px+),
  line (`currentColor`, in the app), small (ring and opening only, under 24px
  — this is why the 16px favicon still reads as a lens), and single-ink with
  the leaf edges masked out, so print does not get a washer.
- **`Mark()` now draws the opening explicitly** and six leading edges instead
  of twelve half-chords. The old version showed both halves of every chord,
  which reads as a hex lattice rather than as six leaves. All six lean the
  same way; that chirality is what stops it looking like a snowflake, so the
  mark must never be mirrored.
- **Two changes that are easy to miss, and both are load-bearing.**
  `middleware.ts`'s matcher is an explicit allowlist of PWA assets, so the new
  `icon-maskable-512.png` had to be named there or it would have 307'd to
  `/login` and Android would have silently fallen back. And `sw.js` precaches
  the icons under a versioned cache name that `activate` only purges when the
  name changes — without bumping `watch-shell-v1` → `v2`, every already
  installed app would have kept the blue W forever.
- **Rendering PNGs on this box needs the container.** There is no node on the
  Windows PATH; `sharp` (libvips, with the SVG loader) lives in the running
  `jellyfin-gate` image. `brand/raster.js` runs there with
  `NODE_PATH=/app/node_modules`.

### 2026-08-28 (last) — Watch party moved off WebSockets to SSE; it now actually works
The blocker from the audit below is fixed: the transport changed rather than
the infrastructure, because the infrastructure could not be changed from here.

- **Realtime moved into the gate process** as `src/lib/party-bus.ts`, an SSE
  stream down (`GET /api/party/{roomId}/events`) and plain POSTs up
  (`POST /api/party/{roomId}/send`). Ordinary HTTP to the same origin the
  tunnel already serves — no Cloudflare dashboard access needed, which was the
  thing blocking the WebSocket route.
- **It had to move into the gate, not stay a service.** Room state (playback
  position, who is present) is in-memory, and a separate process cannot see
  the gate's subscribers.
- **The `party` container is retired, and leaving it running would have been
  actively harmful** — not merely redundant. Its empty-room sweep counts its
  own WebSocket connections; with clients now connecting to the gate it would
  have seen zero for every room and auto-ended every live party after fifteen
  minutes. The sweep moved into party-bus.ts with everything else. The compose
  service is renamed `party-retired` behind a profile so `up` cannot start it,
  and `NEXT_PUBLIC_PARTY_WS_PATH` is gone.
- **Protocol kept identical** (chat / sync / grant / revoke, same payloads) so
  only the transport changed, and `usePartySocket` keeps its name and return
  shape — no caller needed rewriting.
- **Verified end to end on a throwaway clone** with two signed-in users and a
  live room: both streams get history/state/participants on join; chat reaches
  the other participant; a non-controller's sync is ignored (`applied:false`)
  while the host's is broadcast; a non-creator's grant is refused 403; a grant
  flips `isController` in the participants broadcast; the host's own sync is
  NOT echoed back to them (which would make their player fight itself); chat
  history persists for a later joiner; a non-creator cannot end the party;
  the creator's end reaches **both** streams instantly; and afterwards
  GET/HEAD/POST all answer 410 while the page renders the "ended" card.

### 2026-08-28 (later still) — Watch party start/end journey audited; six issues, five fixed
- **The blocker, not fixed here because it can't be from this machine**: the
  whole feature is dead in production. `usePartySocket` connects to
  same-origin `/ws/party`, and nothing routes that anywhere — no middleware
  rewrite, no `next.config` rewrite, and the `party` container's 4001 is not
  published. The tunnel is `cloudflared tunnel run --token-file`, i.e.
  *remotely managed*, so its ingress lives in the Cloudflare dashboard rather
  than on this box. The gate CAN reach `http://party:4001` container-to-
  container (verified, HTTP 200), so the service itself is fine — only the
  edge path is missing.
- **Ending a party was impossible.** The button called `socket.end()` only,
  over the socket that never connects. There was already an HTTP route
  (`POST /api/party/{roomId}`) doing exactly this, unused. The button now ends
  over HTTP and additionally sends the socket message when a connection
  happens to exist (instant notify instead of waiting for a sweep).
- **That HTTP route ignored its own documented body.** The comment said
  `{ end: true }` but nothing checked it, so *any* POST to the URL ended the
  party — a stray prefetch or double-submit would do it. Now validated.
- **An HTTP end told nobody.** `endPartyRoom()` writes `ended_at` and stops;
  the realtime process only broadcast when it did the ending itself. The sweep
  in party-server.mts now also closes rooms it finds ended in the shared
  database, broadcasting `ended` and closing sockets. Up to one sweep interval
  (60s) of lag, instant when the socket path works.
- **Ended parties rendered as live rooms.** The page only checked `!room`, so
  a finished party still showed player, chat and the End button, while the
  realtime server 404'd the upgrade — leaving the client reconnecting every
  two seconds forever with nothing on screen explaining it. The guest-link
  route had the `endedAt` check; the main page did not. It now shows an
  "ended" card linking to the film.
- **Silent failure everywhere else.** The reconnect was a fixed 2s retry with
  no ceiling and no user-visible state, so a party looked completely normal
  while doing nothing. Now: exponential backoff to a 30s cap, an `unreachable`
  flag after three failures, a banner saying live chat and sync are offline,
  and the chat composer disabled while disconnected — it previously accepted a
  message, cleared the field, and dropped it.

### 2026-08-28 (later) — Phone remote: control the TV from your phone, as a web page
The TV browser is bad at exactly three things — text entry, dense information,
and pointer-precision UI — and a phone is good at all three. So the phone now
drives the television.

- **`/remote` on your phone**: now-playing panel with poster, progress and
  transport (play/pause, ±10s, ±30s), navigation (Back/Browse/Home/Reload),
  and library search that opens a result **on the TV**. Search matters most:
  typing with a D-pad and an on-screen keyboard is the single biggest
  drop-off point on a television.
- **`/screen` on the TV** shows a six-character pairing code. The alphabet
  excludes O/0, I/1/L, S/5 and Z/2 — someone is reading this off a TV from
  across a room.
- **Built as a web page, not an app**, deliberately. Everything a remote needs
  the phone browser already does, and it works on iOS with no store account or
  build pipeline. The Capacitor shell wraps the real site anyway, so the
  native app inherits `/remote` for free. An install nudge (`beforeinstallprompt`
  on Chromium, Share → Add to Home Screen instructions on iOS, since Safari
  fires no such event) pushes people to a home-screen icon.
- **SSE, not WebSocket — and the reason matters.** `scripts/party-server.mts`
  already speaks play/pause/seek and was the obvious home for this, but it
  needs a `/ws/party` upgrade route at the edge, and production runs a
  *remotely-managed* Cloudflare tunnel (`cloudflared tunnel run --token-file`)
  whose ingress lives in the Cloudflare dashboard, not on this box. So a
  WebSocket route cannot be added from here. SSE is plain chunked HTTP to the
  same `:3000` origin the tunnel already serves. Verified empirically before
  building on it: ticks arrive ~1s apart through Cloudflare, not buffered.
- **Registry is in-memory** (same reasoning as `device-pairing.ts` /
  `ratelimit.ts`: one process, one Jellyfin box) so there is no schema
  migration. A gate restart drops it and that is survivable by design — the TV
  keeps its screenId in localStorage and re-registers, the phone keeps the id
  it paired with, so the pairing heals itself without anyone retyping a code.
- **Authorisation is ownership, nothing more**: you can only see and drive
  screens belonging to your own account. Pairing codes pick the right TV; they
  are not a security boundary. `navigate` accepts same-origin paths only — a
  remote that can be talked into pointing a television at an arbitrary URL is
  an open redirect with a screen attached.
- The TV agent drives the DOM's own `<video>` element rather than Player.tsx's
  Vidstack API, so it stays decoupled from that component's lifecycle.
- **Fixed same day, two bugs that made every command fail** with "that screen
  isn't connected". First: `ScreenAgent` only activated on TV mode, a stored
  screenId, or `?screen=1` — so on a first-ever visit to `/screen` it bailed
  and never opened its SSE stream, while `ScreenCode` registered the screen
  regardless. Being on `/screen` is now itself an activation trigger, and
  activation is re-evaluated on navigation instead of only at mount. Second,
  and the reason it was confusing rather than merely broken: `online` was
  computed from `lastSeen`, so a screen that had registered but never opened a
  command stream advertised itself as *connected* and then rejected everything
  sent to it. `online` now means exactly "a command sent right now would be
  delivered" — a live subscriber, nothing else — and the phone shows an
  actionable "isn't listening, reload the page on that screen" banner instead.
- **Both routes are now linked from the AppBar and the login page**
  (`?next=` carried through, since both sit behind auth), because a feature
  nobody can find is a feature nobody uses.
- **Tested end-to-end against a throwaway clone**, since the real thing needs
  two signed-in sessions and nobody's credentials should be involved: a second
  gate container on :3100 with its own database and a synthetic user, driven
  through two real browser tabs. That found two things static review had not.
  - **The remote controlled itself.** `screenId` lives in localStorage, which
    is shared across tabs, so the phone registered as the *same* screen it was
    driving and every command was delivered to the remote's own tab too —
    pressing "Home" navigated the phone away from the remote. ScreenAgent now
    stays dormant on `/remote`: a browser being used as the remote must never
    also be a screen.
  - **With two screens, nothing was selected**, so the UI rendered the screen
    dropdown *and* the "connect to your TV" pair form simultaneously — a
    select that looks chosen above a page insisting nothing is connected. It
    now auto-selects the first screen that is actually listening.
  - Also confirmed under test: cross-account isolation (a second user sees an
    empty list, gets 404 on a direct fetch, cannot command, and is refused the
    SSE stream — with both failure modes returning 409 so there is no oracle),
    the same-origin guard on `navigate`, code pairing including lowercase
    input, and state round-tripping.

### 2026-08-28 — Browse's decade filter was completely broken; loading states added everywhere
- **Every decade filter returned zero films.** The sidebar linked the
  facet's display *name* (`?value=1990s`) while `filterMovies()` compared
  against the bare decade (`"1990"`), so nothing ever matched and Browse
  said "No films match this filter" for all ten decades. The page title
  gave it away independently by rendering "1990**ss**" — it appends its
  own "s" to a value that was already pluralised. Genre/director/actor
  were never affected; their id and name are identical.
- **The fix lives where it can be tested.** The filtering logic moved to
  `src/lib/browse-filters.ts`, which is deliberately free of *all* runtime
  imports — no `server-only`, no SQLite handle — so it can be loaded
  directly by `node --test`. `browse-data.ts` couldn't be imported that
  way, which is exactly how a filter this broken survived unnoticed.
  `npm test` now exists and runs 17 cases.
- **Worth knowing if you touch this**: the first version of those tests
  passed against the broken code. `filterMovies()` was never wrong — given
  `"1990"` it always worked. The defect was purely the *wiring* in the
  page's JSX, which a unit test calling the function directly sails past.
  So the id-vs-name decision now lives in a tested `facetLinkValue()` and
  the test is a round trip: the value the sidebar links must select that
  facet's films. Old `?value=1990s` links still work — the parser accepts
  both forms so anything bookmarked pre-fix doesn't return an empty grid.
- **Also fixed**: typing in the sidebar's facet search silently cleared
  your selected genre/director and reset the grid to the whole library. It
  carried `dim` and `sort` through as hidden inputs but not `value`.
- **Loading states, because pages take about a second.** The app had no
  `loading.tsx` anywhere, so in the App Router a link click showed
  *nothing* until the server finished rendering — which reads as "my click
  didn't work." Sign-in now distinguishes its two waits: "Signing in…"
  (password check) then "Signed in — loading your library…" (the
  destination page render), so a slow load no longer looks like a rejected
  password.
- **Revised the same day after seeing it.** A generic `loading.tsx` was the
  wrong shape for most routes: its presence makes Next *unmount the current
  page*, so a plain spinner blanked the whole app — AppBar and all — then
  brought it back, which reads as a flicker rather than as progress. Only
  Browse keeps a `loading.tsx`, because its skeleton mirrors the real
  layout closely enough that replacing the page looks like the page
  arriving. Everywhere else the route-level loaders were deleted and
  replaced with `NavProgress`: a 2px bar across the top, which keeps the
  current page on screen. It waits 150ms before appearing (most navigations
  beat that, and a bar that flashes on every quick click is worse than
  none) and eases toward 90% without reaching it, since it cannot know real
  progress and a bar sitting at 100% while you wait is a lie.
- **Where the second actually goes** (measured, not guessed): the
  catalogue fetch from Jellyfin is ~1.1 MB / 1159 items, ~355 ms warm and
  ~1.4 s cold. JSON parsing is 19 ms and the facet maths 2 ms — the CPU
  side is noise. The catalogue cache holds for only 20 s, so ordinary
  browsing pays that fetch again on nearly every page load. Raising the
  TTL is the obvious lever but it trades freshness of watched-state, which
  is a product call, so it was left alone.

### 2026-08-19 (later still) — Site-wide series-row bug fixed, popularity diversity, redesigned library review, alternate versions, full crew credits, offline downloads, Langlois uploads
A big batch, all built, verified, and deployed together in one joint pass
(per a new working rule — see "Batch changes, deploy together" below).

- **Real bug, site-wide**: a film's "In this series" row could show a
  completely unrelated film, repeated, in place of the real series
  entries — traced to `getItemByImdbId()`'s Jellyfin query silently
  ignoring its own filter and just returning whatever movie came first in
  default order. Fixed with one batched, client-side-matched lookup
  instead. Also closed a second bug this exposed: the broken lookup had
  been bypassing the normal "hide anything with no fetched metadata"
  rule, so a film hidden everywhere else on the site could still leak
  into a series row.
- **"Popular" no longer means "whichever director has the most films"**:
  a director's best film counts in full, their next-best at half weight,
  then a quarter, and so on — the same math already used to rank
  directors themselves, now applied to reordering the movie list. Applied
  to both the Popular sort and "More like this."
- **Library review, redesigned**: the Curator's Dashboard's Library tab
  now has a full "Browse library" panel — every movie, searchable, with
  anything needing a decision sorted to the top, instead of only ever
  showing pre-flagged problems.
- **Different cuts of the same film** (an American print vs. an Italian
  print, say) can now be marked as such instead of the duplicate-checker
  treating them as an accidental copy to discard — they show up with a
  real version picker when playing, using Jellyfin's own built-in support
  for this rather than a new custom mechanism.
- **Writer and Producer now show on a film's page**, alongside the
  existing Director and Cast. (Cinematographer and Editor are wired up
  too, but checked against the real library first — the metadata source
  in use, OMDb, doesn't supply those two credit types at all right now,
  so those rows will stay empty until/unless that changes.)
- **Offline downloads (the phone/desktop apps' Phase 3) and film
  uploads** — the biggest pieces. Any logged-in viewer can now trigger a
  device-ready download of a film (prepared once, cached, reused for
  everyone after); Langlois-mode users can also upload their own film
  file, which sits in quarantine — invisible to everyone else — until a
  Windows Defender scan and a curator's own manual check both clear it,
  same idea as a real archive accepting a donated print. The antivirus
  scan itself runs as a small script outside Docker (Windows Defender
  can't be reached from inside a container), written but not yet
  switched on — needs a one-time setup step together, documented in
  `scripts/windows/README.md`.

**Batch changes, deploy together** (new working rule, replacing the
old "ship one feature, deploy, repeat" habit): redeploying the live site
after every small change was landing on real Docker instability more
than once a day. From now on, a work session collects up several changes,
checks them as thoroughly as possible without touching the live
containers, and only rebuilds/redeploys/pushes once, together, when
actually being watched.

### 2026-08-19 (later) — "Langlois mode": per-user raw film + subtitle downloads
Named for Henri Langlois, the film archivist who believed prints belonged
in people's hands, not just on a screen. A curator can now grant a
specific invited person the ability to download a film's actual original
file (not a stream) plus its subtitle track, straight from the film's
page — everyone else still only ever streams.

- **How it's granted**: a new checkbox in the Invites tab, "Langlois mode —
  raw film file + subtitle download, not just streaming." Set at
  invite-creation time; whoever redeems that invite gets it on their
  account permanently (editing or deleting the invite afterward has no
  effect on accounts already created from it — the flag is copied onto the
  new user's own row at the moment of signup, not looked up live).
- **How it actually works, technically**: no new download route was
  needed. Every user's Jellyfin account already gets a full permissions
  policy pushed on signup (`applyRestrictedPolicy()`), which explicitly
  turns off Jellyfin's own "allow downloading" permission for everyone —
  Langlois mode is that one setting flipped to on, for that one account,
  in Jellyfin itself. The existing proxy that already handles all
  streaming traffic was never blocking the download endpoint in the first
  place; it simply never worked before because Jellyfin itself said no.
  Subtitle downloads reuse the exact link the video player already uses to
  show subtitles on screen — Langlois-mode users just get a "save this
  file" version of that same link.
- **Verified live**: created a real test invite with the flag on through
  the admin API, confirmed it shows correctly in the Invites list, revoked
  it to clean up. Schema change (v28) confirmed against the running
  database directly, not just by reading the code.

### 2026-08-19 — Phone/desktop app work begins: PWA baseline shipped, Android and desktop app shells scaffolded
Per "make as much progress as you can on android and desktop apps full auto
mode as can be done without me" — the first real slice of the Phone App and
Desktop App Roadmap artifacts, not just planning anymore. Full session
detail in `AUTONOMOUS_WORK_LOG.md` at the repo root; this entry is the short
version.

- **PWA baseline shipped and live** (Phone App Roadmap Phase 1): a real
  `manifest.json`, a placeholder icon set (simple "W" monogram in the
  site's existing dark/blue theme — not final branding), and a hand-rolled
  app-shell service worker (`public/sw.js`) that caches Next's
  content-hashed static assets cache-first and everything else
  network-first-with-cache-fallback, explicitly never touching `/jf/*`,
  `/watch/*`, or `/api/*`.
- **Real bug caught before it shipped**: `middleware.ts`'s allowlist for
  unauthenticated requests didn't include any of the new PWA files, so
  `manifest.json`/the icons/`sw.js` all silently redirected to `/login` —
  which would have made the site permanently uninstallable (a manifest
  fetch returning an HTML login page isn't valid JSON) and broken service
  worker registration outright. Fixed and verified live: all six now
  return 200 with correct content, no regression on `/login` or the normal
  auth redirect.
- **Android (Capacitor) and Desktop (Tauri) app shells scaffolded**, both
  in **remote-URL mode** — they load the actual deployed site through a
  WebView, not a bundled static copy, per both roadmap artifacts'
  architecture decision. This machine has no Android SDK/Gradle/JDK and no
  Rust/Cargo installed, confirmed directly (not assumed) by running each
  toolchain's own diagnostic — `gradlew tasks` fails on a missing
  `JAVA_HOME`, `tauri info` reports rustc/cargo as not installed — so both
  stop at real, buildable project scaffolding rather than an actual
  `.apk`/installer. Each app's own `README.md` documents exactly what's
  needed to pick up the build later. One piece *did* complete for real
  without Rust: `tauri icon` is a pure image-processing command, so the
  desktop app's Windows/Mac/iOS/Android icon set was generated from the
  same placeholder brand SVG, not left as Tauri's generic default logo.
- **A roughly 70-minute Docker/WSL2 incident in the middle of this**,
  unrelated to app work directly but worth recording: deploying the
  middleware fix hit a genuine read-only-filesystem fault in Docker
  Desktop's containerd store (not just a slow daemon), which took the live
  site down (502) for a stretch. The existing health watchdog caught and
  restarted through the first occurrence, but the fault recurred within 20
  minutes of that restart with shifting symptoms (read-only errors → API
  500s → plain hangs) before finally clearing on its own. Also found a real
  gap in the watchdog's own health check during this — it treats any HTTP
  response, including a 502, as "reachable," so it logged "healthy" more
  than once while the site was still genuinely down. Full blow-by-blow,
  including what was deliberately *not* attempted (further restarts,
  `wsl --shutdown`) and why, is in `AUTONOMOUS_WORK_LOG.md`.

### 2026-08-19 — Fixed the same-titled-remake matching bug flagged yesterday
Closes the "known limitation" called out at the bottom of the entry just
below this one: the shared `matchTitle()` matcher (used by every scraper —
yearendlists, Wikipedia accolades, PDF uploads, film-series, and the
library-scan relink pass) fell back to a same-titled library film even when
nothing was within a year of the scraped entry, still labeling it "exact"
confidence. The real case that surfaced it: an unreleased 2026 "Resident
Evil" reboot silently resolved to the 2002 film's IMDb id, purely because it
was the only same-titled entry in the library.

- **The fix**: an exact title match now only counts as "exact" confidence
  when a candidate's year actually falls within tolerance. When it doesn't,
  it falls through to the existing fuzzy-matching pass and, from there, to
  "unmatched" if nothing else fits — the same safe outcome a title with no
  library match at all gets. Checked how "fuzzy" vs "unmatched" are treated
  everywhere downstream first: nowhere does the codebase currently treat
  "fuzzy" any differently from "exact" (same DB storage, same "Matched" row
  in the curator's review panel, same real poster rendered on public pages)
  — only a null `imdb_id` triggers the safe placeholder tile, lands the item
  in the curator's actionable search box, and gets retried on the next scan.
  So "unmatched" was the only choice that actually changes behavior, and the
  right one for a same-titled collision nothing can be certain about
  automatically.
- **Already-stored bad matches, not just future ones**: the relink passes
  (`relinkUnmatchedArticleLinks`, `relinkUnmatchedFilmSeriesEntries`, wired
  into `POST /api/admin/library/scan`) used to only retry rows with a null
  `imdb_id` — so simply re-running them wouldn't have touched the Resident
  Evil row, since it already had a (wrong) `imdb_id` set. Both now also
  re-check existing "exact" rows, writing an update only when the result
  actually changes, so a `matchTitle()` fix like this one self-corrects
  already-scraped data the next time a scan runs, not only new scrapes.
  Verified live: triggered the scan, confirmed the 2026 "Resident Evil"
  entry now correctly comes back `imdb_id: null, confidence: "unmatched"`
  while the real 2002 film's own row is untouched.
- **Also**: while testing this, the `JellyfinGateWatchdog` scheduled task
  restarted the PC mid-deploy (it saw the site as briefly unreachable during
  a container recreate and treated that as a real outage) and left Docker
  Desktop's WSL2 backend in a bad state — `jellyfin-gate` crash-looping with
  `read-only file system` errors on its own container filesystem, `docker
  ps`/`docker exec` giving inconsistent answers about whether it was even
  running. Fixed with a clean `wsl --shutdown` + Docker Desktop relaunch (no
  data lost — the database lives outside the container's writable layer).
  The watchdog task itself has been disabled at the user's request and needs
  a deliberate `schtasks /Change /TN "JellyfinGateWatchdog" /ENABLE` to come
  back — it is not currently protecting against a real Docker/site outage.

### 2026-08-18 (later) — "In this series" row, plus a scraped-data browse dashboard
A film's page now shows every other film in its franchise, in release order —
owned ones link straight to their page, unowned ones show as plain
placeholder tiles ("here's the whole series," not just what you have).

- **Where the data comes from**: not the per-film Wikipedia infobox
  `preceded_by`/`followed_by` fields — checked live on The Dark Knight, Iron
  Man 2, and Halloween II (1981), none had them populated, so that
  convention isn't reliable anymore. Instead, Wikipedia's own maintained
  meta-index at "Lists of feature film series" → eleven "List of feature
  film series with N entries" pages, each written in one consistent
  WikiProject bullet-list format. One regex parser handles all eleven pages
  because of that shared convention.
- **Two real parsing bugs, both caught against the live database before
  this shipped and fixed before the real ingest counted**: (1) a header-line
  regex that only recognised one of the two header formats Wikipedia
  actually uses for a franchise name — missing the second form doesn't just
  skip that franchise, it leaves the parser's "current franchise" pointer on
  whatever opened before it, so every one of the missed franchise's films
  gets silently filed under the WRONG one. First real run: all 14 Sherlock
  Holmes films landed under "Star Trek." (2) A year-capture regex that
  never actually captured a year, on any of the ~7,300 entries scraped — a
  lazy `.*?` followed by an optional trailing group can always succeed by
  matching the year part as absent, so it did, every time. That silently
  defeated the shared `matchTitle()` matcher's year-tolerance check (used by
  every scraper, not just this one) and caused wrong-year matches — "The
  Dark Knight" (2008) matched onto The Dark Knight Rises' IMDb id purely on
  title-word overlap. Fixed both; re-ran the ingest each time until the data
  came back clean (confirmed: Star Trek/Sherlock Holmes correctly split,
  The Dark Knight correctly comes back unmatched since the library doesn't
  own it separately, 25 of 7,283 entries genuinely lack a year on Wikipedia's
  page rather than 7,283 of 7,283).
- **Also fixed in passing**: the item page's watchlist-membership lookup
  only covered the film itself and its future episodes, so list badges on
  the new series row's tiles never reflected whether an owned entry was
  actually on a list.
- **Known limitation, not fixed tonight (flagged as a follow-up)**: the
  shared `matchTitle()` matcher falls back to a same-titled library film
  even when nothing is within a year of the scraped entry, still labeling it
  "exact." Surfaced by a genuine edge case in this data — an unreleased 2026
  "Resident Evil" reboot entry falls back to matching the 2002 film's IMDb
  id. This affects every scraper, not just film-series, so it wasn't changed
  without more thought given to the ripple effects.
- **Real ingest, live**: 699 series, 7,283 entries, 25 matched to the
  library. Route: `POST /api/admin/accolades/run-filmseries`. Schema bumps:
  v26 (film_series/film_series_entries tables — the first attempt at this
  forgot the version bump entirely and was a silent no-op, caught live and
  fixed same session) and v27 (the `filmseries` row in `scrape_sources` —
  same class of mistake as v24/v25's davidbordwell/kinoeye rows, caught the
  same way: a real "FOREIGN KEY constraint failed" against the live database
  on the first real ingest attempt).
- **Also shipped this round, built in a prior session but not yet
  committed**: the scraped-data browse dashboard (new "Browse" sub-tab
  under Accolades in `curator.html` — cross-source stats, per-source
  breakdown, searchable article grid) and wiring
  `relinkUnmatchedArticleLinks()`/`relinkUnmatchedAccoladeEntries()`/
  `relinkUnmatchedFilmSeriesEntries()` into `POST /api/admin/library/scan` —
  the first two existed in the codebase for a while but were never actually
  called anywhere despite their own doc comments claiming otherwise.

### 2026-08-18 — Full-site scrapes: Ringer/BWDR reach their real archives, plus David Bordwell and Kinoeye
The Ringer, Bright Wall/Dark Room, and Reverse Shot adapters had only ever
pulled from a single listing page each ("no pagination crawl, kept
deliberately small for now" per their own original comments) — genuinely
scraping "the whole site" meant building real archive discovery for each,
not just raising a limit number. Also added two new sources never
scraped before.

- **The Ringer** — `/topic/movies` turned out to be JS-rendered (infinite
  scroll, no server-side pagination), and the API behind it is one of the
  two paths its robots.txt actually disallows. Switched discovery to the
  site's own declared `/sitemap.xml` → `sitemaps/articles/index.xml` → 7
  dated "chunk" sitemaps, filtered down to movie-review URLs — fully
  within robots.txt, and the only way to reach the real archive.
- **Bright Wall/Dark Room** — confirmed live at 144 pages of standard
  WordPress pagination (`/page/N/`). Discovery now walks it, stopping when
  a page yields no new article links.
- **Reverse Shot** — left alone this round: every path on the site,
  confirmed directly, currently redirects to a generic "System Error"
  page — a real outage on their end today, not a scraping or robots.txt
  problem. Worth a retry once their site recovers.
- **David Bordwell's site (davidbordwell.net)** — new adapter. robots.txt
  permits ordinary posts (only the usual WordPress admin/plugin paths are
  blocked) but declares `Crawl-delay: 10`, the strictest of any source
  here — `bordwell.ts` uses a 10s delay to match, not the 1200ms used
  elsewhere. No single structured way of naming the reviewed film (many
  posts are theory essays, not single-subject reviews); the blog's own
  convention of writing a title in ALL CAPS on first mention is used as a
  best-effort guess, with the post title as a fallback — a real portion
  of posts come back unmatched, which is inherent to how the blog is
  written, not a parsing bug.
- **Kinoeye (kinoeye.org)** — new adapter, a small finite archive (an
  online European-film journal published 2001-2004, now static). No
  robots.txt exists at all. Its own `archive/*.php` "browse by title"
  indexes return a truncated, near-empty response to a plain fetch on
  every one tried — likely a PHP fatal error in code untouched since the
  mid-2000s — so discovery instead walks a bounded grid of the site's own
  per-issue index pages (`index_VV_II.php`), which work fine.
- **Bug found and fixed during Bordwell's first test run**: a `FOREIGN
  KEY constraint failed` traced to adding the new `davidbordwell` scrape
  source directly into `SCHEMA_SQL`'s seed block without a
  `SCHEMA_VERSION` bump — `SCHEMA_SQL` only replays when the database is
  behind the current version, so an already-migrated database (this one)
  never saw the new row. Fixed with a proper versioned migration (v24,
  and v25 for kinoeye the same way) — the seed block stays too, for a
  fresh install. Second bug, same adapter: Bordwell's own internal links
  are consistently `http://`, not `https://`, so the naive
  `url.replace(BASE_URL, "")` path-stripping silently built a malformed
  double-origin URL for every discovered post and failed quietly (0
  processed, no error). Fixed by normalising to `https://` at discovery
  time. Both caught and fixed before the real run, not after.
- **Verified live, full runs**: Kinoeye 166 articles (0 matched — an
  obscure, decades-old journal against a modern personal library),
  Ringer 326 reviews (4 matched), Bright Wall/Dark Room 1,749 articles
  (24 matched — by far the deepest archive of the four), Bordwell 521
  posts (0 matched, expected per the title-guessing caveat above).
  Nothing from any of this is visible to viewers yet — matching a scraped
  mention to a library title only stores a candidate; a curator still has
  to review and lock a specific blurb or trivia fact by hand for it to
  appear on a film page, same as every existing source.

### 2026-08-17 — OMDb/Wikipedia catch-up now runs on a schedule, not continuously
The OMDb ratings backfill and Wikipedia accolades backfill used to fire
unconditionally every 10 minutes for as long as the process ran. They now
only do real work in two circumstances: a curator clicking the new
"Scrape now" button on the Health tab, or one automatic pass a week
(Wednesday 5:30am) — see `src/lib/scrape-schedule.ts`. Either path runs
the same full-catch-up pass (loops the existing tick functions to
exhaustion, respecting OMDb's daily budget, instead of one small batch),
so both actually clear the backlog rather than nibbling at it.

- **`src/lib/scrape-schedule.ts`** (new) — `isAutoScrapeWindow()`,
  `runFullScrapePass()` (loops `runOmdbBackfillTick()` +
  `runWikipediaBackfillTick()` with a 25-minute wall-clock safety cap),
  `runManualScrapePass()`, `runAutoScrapePassIfScheduled()`.
- **`src/instrumentation.ts`** — replaced the two unconditional 10-minute
  intervals with one `startAutoScrapeLoop()` that checks the clock every
  10 minutes and only calls through during the Wednesday window.
- **`src/app/api/admin/scrape/run-now/route.ts`** (new) — fire-and-forget
  POST, guarded against overlapping runs.
- **`curator.html`** — "Scrape now" button on the Health tab's External
  APIs card.
- **Verified live**: triggered a real pass after deploying. Turned up
  something worth knowing rather than a bug — OMDb (315/315 rated, 0
  missing, 0 stale) and Wikipedia accolade coverage were both already
  fully caught up, because the old unconditional loops had already been
  running continuously for the many hours of this session before the
  schedule gate went in. Confirmed against the database directly, not
  just the tick's own report. The Health tab's Wikipedia "never
  attempted" count (still showing ~20) looks like a pre-existing display
  inaccuracy unrelated to this change — likely duplicate IMDb ids across
  a grouped show's individual episodes throwing off a length-based
  estimate — not a scraping gap; worth a follow-up look someday.

### 2026-08-17 — Invites can email themselves at creation time
`POST /api/admin/invites` now accepts an optional `email`. When given, the
invite still gets created and the link is still returned exactly as before
— but the request also fires off an email to that address via Resend (a
plain `fetch()` POST, no SDK, matching every other third-party integration
in this codebase) carrying the same link. A failed or unconfigured send
never fails the request or rolls back the invite: `email_sent` and
`email_error` come back on the response so the curator can tell at a
glance whether to still share the link by hand.

- **Schema v23** — `invites.email TEXT`, nullable, migrated the same
  guarded way as every other column addition here (`columnExists()` check,
  never a bare `ALTER TABLE` in `SCHEMA_SQL`).
- **`src/lib/email.ts` (new)** — `sendInviteEmail()`. Reads
  `RESEND_API_KEY` / `INVITE_EMAIL_FROM` directly at point of use and
  degrades gracefully with a reason string if either is unset, the same
  optional-key pattern `OMDB_API_KEY` already uses — nothing added to the
  central required-env validation in `src/lib/env.ts`, since this genuinely
  isn't required for the app to function.
- **`curator.html`** — the create-invite form gained an "Email (optional)"
  field. On success it shows "Emailed to X" when `email_sent` is true, or a
  visible "email didn't send, share the link yourself" note (with the
  reason) when it's false — the existing copy-link flow is unchanged for
  the no-email case.
- **Not yet configured on this deployment** — `RESEND_API_KEY` and
  `INVITE_EMAIL_FROM` are still blank in `.env`. Invites work exactly as
  before until a Resend account + verified sender are set up; verified this
  gracefully-degrading path directly (`email_sent: false` with a clear
  reason) with a throwaway invite before writing this entry.

Separately: the 15-minute Docker/site health watchdog (Windows Scheduled
Task, runs as SYSTEM, restarts the PC on sustained failure) had a real bug
since it was registered — it called `docker` by bare name, but SYSTEM's
PATH doesn't include Docker Desktop's CLI directory (only the interactive
user's PATH has it), so every single check saw `docker ps` as "command not
found" and treated that as a Docker outage even though the site was always
healthy. It had been restarting the PC roughly every 30 minutes as a
result. Fixed by calling `docker.exe` via its full path instead of relying
on PATH; confirmed fixed both interactively and by manually triggering the
real scheduled task.

### 2026-08-17 — Second round of performance work: worker image, resource limits, cache decoupling
Researched every Tier 2/3 item from the Performance Roadmap to a real
conclusion, then executed everything that came back "ready" (full research
writeup is in the roadmap artifact, kept up to date at the same link):

- **Worker image, 796MB → 416MB.** `mesa-va-gallium` was pulling in `mesa`
  + `llvm22-libs` (182MB alone, the single biggest thing in the old image)
  for AMD/nouveau VAAPI drivers — wrong GPU vendor for this host's Intel
  iGPU regardless of platform. `intel-media-driver` (39MB) and `ffmpeg-libs`
  (0 unique bytes — `ffmpeg` alone already pulls in the same sub-packages)
  came out too. All three were gated behind a `/dev/dri/renderD128` check
  in `media-worker.mjs` that can never pass on this host (see below), so
  this is a real no-op removal, not a regression.
- **Hardware transcoding: researched and closed, not just deferred.**
  WSL2 exposes GPUs to Docker Desktop's own host distro via `/dev/dxg`, not
  the `/dev/dri` DRM path VAAPI needs, and passing `/dev/dri` through into a
  *nested* container from there is an open, unresolved Microsoft WSL bug —
  confirmed locally too, `/dev/dri` genuinely doesn't exist in this
  machine's `docker-desktop` WSL2 distro. Not pursuable as this stack is
  architected today; revisit only on native Linux.
- **Search's full-library pull: researched and left alone.** Traced
  exactly what it contributes beyond Jellyfin's own title search — genre,
  year, synopsis, and cast/director matching, none of which exist without
  it, explicitly justified in the code's own docstring. Removing it would
  silently drop real functionality. Already mitigated by the Tier-1 cache.
- **globals.css splitting: researched and declined.** Mapped every "route-
  specific" class against what actually uses it — only the Notification
  Bell section is genuinely clean; everything else (`.avatar`, `.hint`,
  `.rating`, `.person-head`) is entangled across 3-7 unrelated routes each.
  Not worth the untangling risk for a file that's already one cached
  resource across the whole site.
- **CPU/memory limits + `cpu_shares`**, sized to this host's real specs
  (Intel i3-6100, 2 cores/4 threads, 7.9GB RAM) and live `docker stats`
  baselines: gate gets the highest `cpu_shares` (wins scheduling under
  contention) despite the lowest `cpus` ceiling, since it's what a real
  visitor is waiting on; jellyfin/worker get the CPU headroom they need for
  software transcoding but can no longer claim the box unbounded.
- **Known-films cache decoupled** from reactive refresh — its own proactive
  timer now keeps the ~90-second admin pull off the critical path of any
  backfill tick.
- **SQLite pragmas** (`cache_size`, `mmap_size`, `temp_store`) added
  alongside the existing WAL/synchronous/foreign_keys settings.

This round hit real infrastructure trouble unrelated to the code changes
themselves: the Docker build hung for over an hour with zero log progress
(genuine CPU burn but no forward progress — Docker Desktop/WSL2 degrading,
not a slow build), requiring a PC restart. A second attempt then hit a
`read-only file system` error from Docker's own internal containerd
metadata store mid-deploy, which briefly took Jellyfin itself down
(confirmed via `docker inspect`, fixed as the immediate priority once
found) — requiring a second restart. Both were host/WSL2-level failures
independent of anything in this diff; verified working end-to-end
afterward with a throwaway test account (real Collection/Browse page
loads, real resource-limit values confirmed via `docker inspect`, real
image sizes confirmed via `docker images`).

### 2026-08-16 — First round of performance work: caching, indexes, image sizing
Executed the "Tier 1" items from a full-stack performance audit (three
parallel investigations across the data-fetching layer, Docker/Jellyfin
infra, and the frontend/DB layer — see the Performance Roadmap sent for
review). Held off on Tier 2/3 deliberately: hardware transcoding on this
Windows host is genuinely uncertain (a research spike, not a safe change to
just make), and Search's full-library pull needs its own investigation into
*why* it's there before it's touched.

- **The big one**: `getAllMovies()` (the up-to-2000-item Jellyfin pull used
  by Browse, Search's fallback, and — via `getCollection()` — every
  Collection page and every grouped-episode item page) now carries a
  20-second, per-user in-memory cache. Doesn't remove the cold-cache cost of
  the first request, but a burst of clicks through one show's episodes, or
  repeat Browse/Collection views, now shares one Jellyfin round trip instead
  of paying for a fresh one every time. Measured live on a real Collection
  page: 1.53s cold → ~0.5s cached, roughly 3x.
- **Two missing indexes**: `rating_cache.fetched_at` (the OMDb backfill
  loop's `WHERE fetched_at < ?` query was a full table scan every 10
  minutes, forever, getting slower as more films get rated) and
  `article_film_links.article_id` (a real query hot spot with no index
  despite being a foreign key — SQLite doesn't auto-index those). Schema
  bumped to v22, purely additive `CREATE INDEX IF NOT EXISTS`.
- **Poster/backdrop images now cache for a year** at the `/jf/` proxy
  (`Cache-Control: public, max-age=31536000, immutable`) — every URL this
  app builds already carries a content-addressed `tag`, so this was free
  correctness the proxy just wasn't asserting.
- **One real size mismatch fixed**: Browse's genre/director/actor filter-list
  photos display at 24×24 CSS px but were fetched at 200×200 — over 8x
  oversized for what's on screen, and Jellyfin had to generate and cache
  that oversized variant for no visual benefit. Dropped to 48×48 (2x
  retina). Checked every other "poster"/"person photo" size across the
  codebase against its actual CSS display size first — the rest turned out
  to already be reasonably matched, so left alone rather than force a
  broader "standardization" the evidence didn't support.

Hit one real bug along the way: a code comment containing backticks broke
the `SCHEMA_SQL` template literal it lived inside, failing the Next.js
production build — invisible in `tsc --noEmit` (which doesn't evaluate the
string), only caught because the build's exit code stopped being silently
swallowed by a `| tail` pipe. Fixed, and the pipe habit dropped for build
commands going forward.

Verified live end-to-end with a throwaway session: real Collection page
timing (above), confirmed cache-control header on a real poster response,
confirmed all page types (Browse/Item/Search/Collection/home) still load
correctly and episode data still renders right, confirmed the schema
actually migrated to v22 with both new indexes present on the live
database. Session and account cleaned up afterward.

### 2026-08-16 — Accolades console brought in line with the approved mockup
Auditing the Curator's Console's Accolades tab against the mockup you'd
approved earlier (`demo-dashboard.html`) turned up four real gaps between
what was shown and what shipped, and you asked for all four to be closed:

- **Poster-grid film picker** — the Films sub-tab's search results switched
  from a plain text list to clickable poster tiles. Needed one small
  backend addition: `admin-search.ts` now returns a `posterUrl` per hit.
  Hit a real bug mid-build — assumed Jellyfin returns a flat
  `PrimaryImageTag` field on movie items (true for the lightweight Person
  sub-objects already used elsewhere in this codebase), but a direct query
  against the real Jellyfin API showed top-level items nest it under
  `ImageTags.Primary` instead. Caught by verifying against a real API
  response rather than trusting the assumption, fixed before shipping.
- **Interactive passage picker** — the article reader (shared by the Films
  and Books sub-tabs) went from read-only to select-text-and-pick: a
  floating toolbar appears near a text selection with "Add to blurb"/"Add
  to trivia," picks collect in a chip list, and "Lock this blurb"/"Save
  trivia facts" post straight to the *existing* lock-blurb/trivia
  endpoints — genuinely needed zero new backend routes, since those
  endpoints already just accept `{ text }` with no way to know if it came
  from a textarea or a selection. Deliberately built as a floating
  selection toolbar rather than the mockup's right-click context-menu
  override, since hijacking the browser's real context menu breaks normal
  copy/paste affordances for a read-heavy tool.
- **Rich-text toolbar** — bold/italic/underline/strike/sub/superscript
  buttons above the custom blurb/trivia fields. Turned out the storage and
  render pipeline (`sanitizeRichText`, an existing six-tag allowlist) was
  already fully wired end to end on the film page — nobody had ever built
  a UI that produced the tags. Implemented via `textarea.setRangeText()`
  rather than a contenteditable region (considered and rejected: no
  toggle-off, silently eaten newlines, messy pasted markup) — guarantees
  the exact tag names the allowlist expects. Verified live with a
  deliberate XSS probe (`<script>alert(1)</script>` alongside real
  `<b>`/`<i>`/`<s>` tags) through the real lock-blurb endpoint: the tags
  were preserved and the script tag was stripped to plain text, confirming
  the sanitizer holds.
- **Visual polish** — accolade rows now show a 🏆 for a win vs. a numbered
  rank pill for a ranked-list mention, plus a "currently showing" marker
  on the locked one, matching the mockup's treatment.

Verified live end-to-end via curl against a real film (Ford v Ferrari) and
a real linked Wikipedia article: simulated both the passage-picker's join-
and-lock flow and the rich-text toolbar's tag-wrapping flow through the
real endpoints, confirmed correct storage and sanitization, confirmed the
grouped-show poster fallback resolves a real absolute OMDb URL and a
movie's resolves a real `/jf/Items/.../Images/Primary` URL, then cleaned
up all test locks/trivia. The interactive JS itself (selection toolbar
positioning, live rich-text preview) could not be visually clicked through
in the browser tool — `curator.html` is a local `file://` page outside the
project folder that talks to the deployed backend, a known limitation
documented earlier this session — so that part rests on careful code
review plus the confirmed-working backend contract, not a live click-test.

### 2026-08-16 — Browse's filter/sort buttons restyled to match mockup
Cosmetic-only change, from a mockup you sent: the Browse page's dimension
tabs (Genre/Director/Actor/Decade) and sort buttons (Popularity/Newest
first/Oldest first) switched from individually outlined "pill" buttons to
a "grouped segmented control" — one bordered container with a subtle dark
background, borderless inner buttons, and a solid accent fill on the
active one. Only `globals.css` values changed; the real Browse page
already used the exact same class names as the mockup, so no JSX/structure
changes were needed. Verified live on the deployed site with a throwaway
test account, then cleaned up.

### 2026-08-16 — Storage breakdown added to the Health tab
The Health tab now breaks down where disk space actually goes: scraped
review/accolade text, cached API responses (people/ratings/series-meta
lookups), the rest of the database, and the codebase itself (the last one
computed once per deploy and cached, since it doesn't change at runtime).
Verified live against the real deployed database — real numbers pulled
via direct API call (roughly 770KB scraped data, 1.2MB cached API data,
2.6MB other database, 135MB codebase). The console-side rendering follows
curator.html's existing bar-chart pattern but could not be visually
screenshotted through the browser tool, since curator.html is a local
`file://` page that isn't part of the deployed app — a known limitation
of that dashboard's setup, not of this feature.

### 2026-08-16 — The Ringer and Bright Wall/Dark Room adapters built
Both remaining "back pocket" review sites now have real, tested adapters
(`src/lib/scraping/ringer.ts`, `brightwalldarkroom.ts`), joining Reverse
Shot. Real markup for both confirmed by fetching live pages, not guessed.

**The Ringer**, filtered to movies specifically per your request: discovery
is scoped to `/topic/movies` URLs whose slug contains `-review-` (the
site's own consistent marker for a genuine single-film review, as opposed
to the oral histories and ranked lists that also live under `/movies/`).
The film's title comes from the URL slug itself (the part before
`-review-`) rather than the headline — verified more reliable across real
examples, since headlines are often a stylised phrase that doesn't
mention the film at all. Test run: 7 real reviews fetched and stored
correctly, 0 matched (all brand-new 2026 releases — consistent with the
library skewing older, same story as Reverse Shot).

**Bright Wall/Dark Room** — the cleanest of the three: the reviewed film
is stated explicitly via `<i>Title</i> (Year)`, either in its own
`.subtitle` element or inline inside the essay's own headline when there
isn't one. Missed on the first pass (checked `.subtitle` only, which
covers just 4 of 10 real essays) — caught by comparing extracted titles
against the real pages, fixed by checking both locations with one shared
extractor, reverified against live data afterward. The other 6 correctly
fall back to the plain headline: those essays are genuinely about
multiple films/directors (a retrospective, an interview), not a single
review, so there's nothing to extract — not a bug.

A new per-source "Test run" button was added to the console's Sources
list (all three review sites, not just these two) so a curator can trigger
a small test batch without needing curl.

Also fixed two unrelated infra issues discovered mid-session: Jellyfin's
main process had become an unkillable zombie (explained a lot of the
day's flaky container behavior — fixed with a forced kill + recreate),
and the gate container's outbound networking briefly broke at the Docker
Desktop level (host had connectivity, the container didn't) — resolved
itself after Docker Desktop was addressed on the host side.

### 2026-08-16 — Fixed: wide-aspect films top-pinned in true fullscreen
Films wider than 16:9 (2.35:1, 2.39:1, etc.) rendered with the video
pinned to the top and a black gap only at the bottom, instead of centered
with the letterbox split evenly top and bottom — but only in real browser
fullscreen (the expand-icon button), not the normal in-page player.

Root cause: `.vds-player`'s `max-height: calc(100dvh - 52px)` reserves
room for our own header bar in the windowed view — correct there, but
still applied once the player is promoted to the browser's fullscreen
top layer, where no such header exists and the ancestor's `place-items:
center` grid (which centers the player in the windowed view) no longer
has any say over it. That left a same-sized shortfall at the bottom
instead of an even top/bottom split. Fixed with `:fullscreen`-scoped CSS
(plus a `:-webkit-full-screen` fallback for older Safari) that clears the
cap and centers explicitly for both plausible fullscreen targets.

Verified the fix compiled and deployed correctly (confirmed present in
the live CSS bundle), but couldn't visually confirm inside true browser
fullscreen — the Fullscreen API doesn't activate inside the sandboxed
browser tool used for verification this session. Confirm on a real
device when you get a chance.

### 2026-08-16 — AFI, Oscars, Cannes, and Venice ingested from Wikipedia
New `src/lib/scraping/wikipedia-lists.ts` fetches a Wikipedia LIST page
(as opposed to `wikipedia.ts`'s per-film page) and stores every entry as
an accolade mention — same "one page, many mentions" shape as
yearendlists.ts. Two shapes of table, both parsed and verified against
real fetched pages, not guessed: a ranked "Film | Year | ... | Rank"
table (AFI's "100 Years..." lists — 100/100 entries parsed correctly,
2 matched real library films) and a "Year | Title | ..." year-by-year
winners table, which comes in two flavors — winners-only (Palme d'Or,
Golden Lion: every row counts) and winner-among-nominees (Academy Award
for Best Picture: only the bold-marked, year-paired row counts). Got the
second flavor wrong on the first pass — defaulted to "winners only" for
Oscars too, which silently stored all ~600 nominees as wins — caught by
the entry count being wildly higher than the real ~98 ceremonies, fixed
by adding an explicit `winners_only` override, then reverified (98
entries, exactly right). All four sources now verified end-to-end with
real matches, right through to a live film page (Oppenheimer showing a
"Won" badge linking to the real Wikipedia article). A new "Wikipedia
lists & awards" card in the console's Sources tab triggers any of the
six presets on demand.

Also concluded the Sight & Sound research: checked three separate
Wikipedia pages for its greatest-films poll (2022, 2012, and "List of
films voted the best") and none have a real wikitable — this path is a
dead end for now. BFI's own site (fresh ToS check needed) or manual
curator entry via the tools already built are the remaining options.

### 2026-08-16 — Manual blurb entry, for sites we don't scrape
The console's existing "write your own blurb" box now also takes a source
name and a review link, so a passage copy-pasted from a site that isn't
(and might never be) scraped still gets the same "who said this, read the
full review" treatment a scraped blurb gets for free. Backed by two new
nullable columns on `film_curation_locks` (`locked_blurb_source_label`,
`locked_blurb_source_url` — schema v21, plain `ALTER TABLE ADD COLUMN`
since both are optional and additive). No film-page changes needed —
`AccoladesSection.tsx` already rendered `blurb.sourceLabel`/`sourceUrl`
for scraped blurbs, so a manually-entered one just flows through the same
path. Verified live on a real film page (source name + working outbound
link both rendered correctly), then reverted back to auto.

### 2026-08-16 — Notifications extended: new-item alerts + Curator's Pick
The `notifications` table (previously just "someone replied to your
comment") now supports two more kinds, both system-generated (no acting
user, no comment): **new_item** — a background tick loop (same 10-minute
cadence as the OMDb/Wikipedia backfills) diffs the library against a
snapshot table and notifies every user the first time it sees a movie it
hasn't seen before; the very first tick after turning this on populates
the snapshot without notifying anyone, so it doesn't blast the whole
existing library at once — verified live (295 movies snapshotted, 0
notified, on the actual first tick). **curators_pick** — a new "Notify"
tab in the console lets the curator search the library, pick specific
users, and send a "Curator's Pick — Just For You" notification; backed by
a new `POST /api/admin/notifications/curators-pick` route and a
`GET /api/admin/users` route (didn't exist before). The bell now renders
different text per kind. Existing reply notifications and their data were
preserved across the schema change (a table rebuild, since SQLite can't
relax a NOT NULL constraint in place — see db.ts's v20 migration). Both
verified live end-to-end with throwaway test accounts, cleaned up after.

### 2026-08-16 — Curator's Console rename; accolade badges now link to source
Curator's Dashboard renamed to Curator's Console (cosmetic). Accolade
badges on the film page now carry a "Read the source →" link back to the
original scraped article, same as blurbs already had — repaying the sites
we scrape with real clicks. Verified live on a real film page.

### 2026-08-16 — Wikipedia backfill, wider yearendlists coverage, first review-site test
Wikipedia now catches up in the background the same way OMDb ratings do —
verified live (5 films processed on the first real batch, 310 to go).
Ran yearendlists.com for five more years (2024/2019/2014/2012/2017),
adding 73 real matched accolade mentions, and learned the site's real
coverage stops around 2011. Built and test-ran a real adapter for Reverse
Shot (one of the "back pocket" review sites) — confirmed it correctly
extracts and stores real reviews; this particular batch of 9 recent
reviews didn't overlap with the library, which is expected given the
library skews older. Also confirmed AFI's "100 Years..." lists have real,
cleanly parseable tables on Wikipedia (build queued); Sight and Sound's
poll does not have one yet found (needs more digging). See §4J above.

### 2026-08-16 — Ratings switched to half-stars; ratings now show on comments
The 1-10 number picker became a 0.5-5 half-star picker (same underlying
1-10 scale, just relabeled — no schema change), and every comment/reply
now shows its author's own current rating next to their name. Verified
live: rated 3.5 stars, posted a comment, confirmed the comment carried the
rating correctly, cleaned up. See §4I above.

### 2026-08-16 — "Us": viewer ratings, comments, replies, and notifications
Planned in full (with a UX demo sent for review) before any code was
written, then built: a 1-10 rating any viewer can leave, a comment thread
with one level of replies, and an in-app-only notification bell that
lights up when someone replies to your comment. Lives right on the film/
show page, next to the existing ratings and accolades. Verified against
the real live site end-to-end with two throwaway test accounts exercising
the full flow and every edge case (reply-depth limit, deleted-comment
replies blocked, soft-delete preserving replies underneath, cross-user
edit protection, admin override) — then fully cleaned up afterward. See
§4H above.

### 2026-08-16 — Individual episodes no longer leak into recommendations
Fixed the same "Jellyfin doesn't know about our TV grouping" bug that
Browse and Search were fixed for earlier, this time in More like this,
Recently added, the homepage's genre rows, an actor's filmography, and the
curator dashboard's film search — all now collapse a show's episodes to
one tile/hit, everywhere except a show's own page, an individual episode's
own page, Continue watching, and the watchlist (all correctly left
episode-specific). Verified against real data: simulated the grouping
logic against "The Curse"'s real 10 episodes (collapsed correctly to one
tile), and confirmed live that the curator dashboard's search for "curse"
now returns exactly one hit with the show's real linked IMDb id. See §4G
above.

### 2026-08-16 — Accolades CRUD gaps filled in
Unlink-article, a real review-matches view (confirm a fuzzy guess, link an
unmatched mention by hand, or discard it), reordering for both Builder
slots and curated trivia, and in-place editing of a curator-written trivia
fact — all built and wired into the dashboard. Verified live against the
real site: created a throwaway Builder list, reordered its slots both
directions, confirmed the boundary correctly refuses to move something
already at the end, deleted the list; added two test trivia facts to a
real film, reordered and edited them, then removed both, leaving the
film's real state untouched. Also audited invites, conversion jobs, and
Curator's Picks for the same kind of gap — findings noted in §4F, nothing
built there yet. See §4F above.

### 2026-08-16 — OMDb batched backfill built and shipped
A background process now keeps ratings coverage catching up a small batch
at a time, so approaching OMDb's 1,000/day free-tier limit as the library
grows never means a burst of simultaneous refreshing. Verified live against
the real library (455 movies, 315 with a usable IMDb id, 266 already
cached): the first real batch fired ten minutes after deploy, made exactly
8 OMDb calls — all successful — for the titles that had never been rated
at all, and the Health tab correctly showed the updated count (46 titles
still missing a rating, 0 stale) immediately after. See §4E above.

### 2026-08-16 — Error and activity logging built and shipped
A unified log now records external API failures (OMDb/Wikipedia/
yearendlists), today's call usage against OMDb's 1,000/day cap, this site's
own route failures for real visitors, playback errors reported straight
from the viewer's browser (the answer to "how would we know about a
corrupt file?"), client-side crashes, and worker conversion failures — all
visible and filterable from two new sections on the Health tab. Verified
live: a real test error was posted through the same endpoint the video
player uses, confirmed to land in the log, and confirmed to be picked up
by the health snapshot's issue count. See §4D above.

### 2026-08-16 — Health monitor built and shipped
A new "Health" tab in the Curator's Dashboard, covering public-site and
Jellyfin reachability, who's currently watching, storage space, the
conversion queue, Accolades scraping failures, last library scan time, and
database size — an overall green/amber/red banner plus one card per check.
Built, rebuilt, redeployed, and checked against the live site with real
data (correctly caught a real past scrape failure and correctly flagged
that no scan has been run through the dashboard yet). See §4C above.

### 2026-08-16 — This knowledge file created
Created as a single place to keep the whole project's story, at your
request, to be kept up to date going forward.
