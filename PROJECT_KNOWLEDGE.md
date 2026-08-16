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
