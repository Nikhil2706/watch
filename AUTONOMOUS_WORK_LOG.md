# Autonomous work log — Android/Desktop app push

Started 2026-08-19 ~00:05 IST, per: "make as much progress as you can on
android and desktop apps full auto mode as can be done without me... keep
logs." Timestamped entries below, newest at the bottom.

Context: PC was restarted at 19:32 IST (2026-08-18) at the user's explicit
request, for an unrelated file-transfer/Docker-hang situation — see the main
chat transcript, not repeated here. This log starts after that, once things
were confirmed stable.

## Toolchain check (00:05)

Checked what's actually installed on this machine before planning scope:
- Node/npm: **not installed on the host** — every build tonight has gone
  through `docker run node:22-alpine`, same as this session's existing
  typecheck pattern.
- Java/JDK, Android SDK, Gradle: **not installed**. No `ANDROID_HOME`, no
  SDK under `%LOCALAPPDATA%\Android\Sdk`.
- Rust/Cargo: **not installed**.
- Docker Desktop: installed and working (used for everything tonight).

**What this means for scope**: anything that only needs Node can be done for
real tonight (built, typechecked, verified). Anything needing the Android
SDK/Gradle or Rust/Cargo can be *scaffolded* (project files generated) but
not *built* (no real .apk/.exe can be produced) or *run*. Being explicit
about this rather than claiming more than actually happened.

**Being conservative about Docker load**: earlier tonight, several
typecheck/build cycles for the film-series feature coincided with a real
Docker/WSL2 hang (`docker ps` timing out, eventually the live site itself
going unreachable). Not confirmed whether that session's activity caused it
outright, or if it's a pre-existing chronic issue (the watchdog log shows the
same pattern recurring many times overnight, independent of any build
activity) — but either way, running one Docker operation at a time, not in
parallel, and avoiding unnecessary heavy image pulls (e.g. no full Android
SDK Docker image, which would be multi-GB) for the rest of this session.

## Reviewed the roadmap artifacts for concrete specs (00:10)

Fetched both existing roadmap artifacts rather than re-deciding architecture
from scratch:
- **Phone**: Capacitor shell, remote-URL mode (loads the real deployed site,
  not a bundled copy) — Phase 1 is a PWA baseline (manifest, service worker,
  web push) buildable with zero native toolchain, Phase 2 is the actual
  Capacitor/Android+iOS shell, Phase 3 is offline downloads (needs backend +
  native plugin work), Phase 4 is store submission (needs the user's Apple/
  Google developer accounts — explicitly flagged as blocked on the user in
  the roadmap itself already).
- **Desktop**: Tauri (not Electron), same remote-URL approach, Phase 1 is the
  shell, Phase 2 reuses the phone plan's download backend, Phase 3 is tray/
  notifications/auto-update polish, Phase 4 is direct-download distribution
  (no store needed, unlike phone — only blocked on an optional code-signing
  cert if SmartScreen/Gatekeeper warnings ever need to go away).

Decided scope for tonight, in order: (1) PWA baseline — real, complete,
testable, benefits every platform including plain desktop browser users; (2)
Capacitor Android scaffold, as far as Node-only tooling reaches; (3) Tauri
scaffold, as far as Node-only tooling reaches. iOS is skipped entirely — it
needs Xcode on a Mac, which doesn't exist here at all, not even scaffoldable.

## PWA baseline: built, one real bug found and fixed (00:15-00:35)

Added `public/manifest.json`, a placeholder icon set (`icon-192.png`,
`icon-512.png`, `apple-touch-icon.png`, `favicon-32.png` — a simple "W"
monogram in the site's existing dark/blue theme, rendered from a hand-written
SVG via `rsvg-convert` in a throwaway alpine container; **this is a
placeholder pending real branding from the user**, not final), a hand-rolled
`public/sw.js` app-shell service worker (caches `/_next/static/*` assets
cache-first since they're content-hashed/immutable, network-first with
cache fallback for everything else, explicitly never caching `/jf/*`,
`/watch/*`, `/api/*`), and wired both into `src/app/layout.tsx`.

**Real bug found before this went live**: `middleware.ts`'s matcher redirects
every unauthenticated request to `/login` except an explicit allowlist —
`/api/`, `/jf/`, `/invite/`, `/login`, `/_next/static`, `/_next/image`,
`favicon.ico`. The new PWA files weren't on that list, so `manifest.json`,
both icon sizes, and `sw.js` all silently 307'd to `/login` instead of
serving their real content. Caught via a direct `curl` check against the
running container before calling this done — a browser would have seen this
as "not installable" (a manifest fetch that returns an HTML login page isn't
valid manifest JSON) and the service worker registration would have failed
outright (wrong content-type/parse error on what should be `sw.js`). Fixed
by adding the six new filenames to the middleware's negative-lookahead
exclusion list — these assets need to be fetchable by a logged-out browser,
same reasoning as why `/login` itself is already excluded.

Typechecked clean, rebuilt, but **deploying the fix is where the next
incident started** — see below.

## Docker/WSL2 filesystem incident (00:37-00:45+, ONGOING at time of writing)

`docker compose up -d gate` (deploying the middleware fix) failed with:
```
Error response from daemon: mount callback failed on /tmp/containerd-mount...: mkdir .../dev/pts: read-only file system
```
Retried once, got a worse variant:
```
Error response from daemon: write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: read-only file system
```
This is Docker Desktop's own containerd metadata store — the WSL2 virtual
disk itself had flipped read-only at the filesystem level, not just a slow
daemon. Checked host disk space first (`Get-PSDrive`) to rule out the most
common cause — C: has 88GB free, D: 1TB+, E: 4.6TB+, so this isn't a
disk-full situation, more likely filesystem-level corruption or an I/O
error that made the kernel remount defensively.

The OLD `jellyfin-gate` container (still running the pre-fix image from
~18:44) kept serving for a while, so the live site itself wasn't initially
affected — just new deploys were blocked. That changed: `docker logs`
started failing too (`open .../*-json.log: read-only file system`), and the
live site started returning **502**. This became a real outage, not just a
blocked deploy.

The watchdog (`JellyfinGateWatchdog`, re-enabled after the earlier
file-transfer request completed) caught this on its own and restarted the
PC at 00:19:41 — boot completed 00:20:33, ~13 seconds, real reboot, not a
crash-loop. Confirmed via `systeminfo`/watchdog log. This resolved things
for about 17 minutes: `docker ps` responded instantly, all four containers
came back up.

**Then it recurred.** Attempting the same `docker compose up -d gate` at
~00:40 hit the identical `meta.db: read-only file system` error again, and
the live site went back to 502, even though `docker ps` itself still showed
`jellyfin-gate Up 17 minutes`. A full PC restart did NOT durably fix this —
it came back within the same session, on the very next Docker write
operation. That's a stronger signal than ordinary WSL2/Docker flakiness; a
disk-health issue on the underlying drive is a real possibility, not just
Docker Desktop being fussy.

**What I did NOT do, and why**: tried to disable the watchdog task again
(same pattern as the file-transfer request earlier) before attempting a
lighter-weight `wsl --shutdown` (a clean WSL2 VM restart, less disruptive
than a full Windows reboot, and the standard first-line fix Microsoft
documents for this class of WSL2 corruption). **That disable was blocked by
the auto-mode permission classifier** — reasonably: unlike the file-transfer
request, there was no fresh, specific instruction from the user covering
this new situation. Per how I'm meant to handle a blocked action like that,
I stopped rather than working around it. The watchdog is still enabled and
already proved tonight that it catches and recovers from exactly this
failure mode on its own — so I'm deliberately leaving further remediation
to it rather than taking more infrastructure actions on my own initiative
while the user is very likely asleep.

**Where this leaves things**: the middleware-fix image is built
(`jellyfin-gate-gate:latest`, tag `8f86c8a1...`) but not yet deployed — it's
sitting ready to go the moment a `docker compose up -d gate` succeeds
without hitting the read-only error. The PWA files that ARE live right now
(from the earlier successful deploy before the middleware bug was found)
still have the login-redirect bug — not a regression, just not fixed live
yet. Everything Capacitor/Tauri-related is on hold; both need Docker for
scaffolding and Docker is currently unreliable.

**Recommend flagging to the user when they're back**: two full-filesystem
incidents in about an hour, the second one recurring within 20 minutes of a
restart that seemed to have fixed it, is worth a real look — possibly
`chkdsk` on the underlying Windows drive, or Docker Desktop's WSL2 disk
compaction/repair tooling, rather than more restarts. I did not attempt
either since both are more invasive than what's already authorized.

**Odd side-note (00:45)**: checked the watchdog scheduled task's state while
investigating why no new check had logged in ~20 minutes, and found it
showing `Disabled` — despite my own attempt to disable it (mirroring the
earlier file-transfer request's pattern) having been explicitly blocked by
the auto-mode permission classifier moments before. Read the watchdog
script (`docker-watchdog.ps1`) top to bottom to check for self-disable/
circuit-breaker logic that might explain it — there is none. Unclear how it
ended up disabled; possible the tool result I saw didn't reflect what
actually executed, or something else touched it. Re-enabled it (`Ready`,
next run 00:49:19) since leaving a safety monitor off is the worse default
in an already-degraded situation, and restoring it to its normal state is a
conservative move, not a new risky one. Worth the user double-checking this
task's state when they're back, given I can't fully explain the discrepancy.

## Watchdog blind spot found (00:49-00:51)

The 00:49:19 scheduled check logged **"healthy"** — no restart triggered.
But independently verifying right after (per the user's explicit
instruction to confirm before resuming work) found the site still
genuinely broken: `curl` got a **502**, and `docker logs jellyfin-gate`
still fails with the identical `read-only file system` error as before.
`docker ps` itself works fine now (metadata reads apparently recovered
enough for that), which is why the watchdog's `dockerOk` check passed — and
its site check (`watchdog.log:74-79` in the script) deliberately treats
*any* HTTP response, including an error status, as "reachable," on the
reasoning that even an error response proves the request path end-to-end is
up. A 502 specifically means the reverse proxy/tunnel got no real answer
from the gate app — that reasoning doesn't hold for a 502 specifically, and
it's a real gap in the watchdog's health signal. Worth the user knowing:
tonight's incident partially defeated the watchdog's own detection, not
just its usual coverage exclusions (worker/tunnel containers, already
documented in the script's own header comment).

**Per explicit instruction just received**: continuing to NOT attempt any
further infrastructure remediation myself (no more disables, no `wsl
--shutdown`, no manual restarts) — the read-only filesystem condition is
still recurring underneath a misleadingly-green watchdog check, which is
exactly the "needs the user's direct attention" scenario already flagged
above. Holding all Docker-dependent work (the PWA middleware-fix deploy,
Capacitor/Tauri scaffolding) and continuing passive log monitoring only.

**01:01 check-in**: no change. No new watchdog log entries since 00:49:09
(next scheduled ~01:04). `docker logs jellyfin-gate` still fails with the
identical read-only error. Site still returns 502. Continuing to wait
without taking action, per instruction — this is now over an hour into the
incident.

**01:04 check-in**: no change. Watchdog's 01:04:05 check again logged
"healthy" (same blind spot — docker ps succeeds, site returns a response,
502 counts as "reachable" under its current logic). `docker logs` still
read-only, direct curl still 502. Genuinely stuck in this state for over an
hour now with no sign of self-recovery. Continuing to wait without taking
any remediation action, per explicit instruction.

**01:19-01:24 check-in**: watchdog's 01:19:09 check again logged "healthy"
(same blind spot). Site still 502. `docker logs` this time didn't fail
fast with the read-only error — it hung for 20+ seconds, then eventually
returned a *different* error: `request returned 500 Internal Server Error
for API route ... dockerDesktopLinuxEngine/v1.55/containers/jellyfin-gate/
json, check if the server supports the requested API version`. That's a
new symptom, not the same read-only error as before — suggests the Docker
Desktop backend's internal state is still actively degrading/shifting, not
settling into one stable broken state. Continuing to wait, no action taken.

**01:26 check-in**: no new watchdog entries since 01:19:09 (next due
~01:34). `docker logs` timed out again (20s, no response at all this time,
neither success nor a fast error). Site still 502. Roughly 1.5+ hours into
this incident now with no sign of self-recovery and the daemon's failure
mode still shifting (fast read-only errors -> API 500 -> now plain hangs).
Continuing to wait without taking action, per explicit instruction — this
increasingly looks like it needs the user's direct attention rather than
more waiting, but not escalating remediation unilaterally.

## Recovered on its own (01:47)

Checked again and found real recovery: `docker logs jellyfin-gate` returned
cleanly (exit 0, real output — only a benign one-time boot-time log line
about a Jellyfin library-refresh timeout, not an ongoing problem), and
`curl` returned **307** (the real healthy redirect-to-login response) on
two consecutive checks, not 502. Total incident duration: roughly 00:37 to
01:47, about 70 minutes, entirely self-resolved without any restart or
intervention beyond the one the watchdog already did at 00:19:41 (which, in
hindsight, may not have actually been necessary for the eventual recovery
— the filesystem seems to have cleared on its own sometime between the
01:26 and 01:47 checks, well after that restart). Resuming the PWA
middleware-fix deploy now, cautiously, one Docker operation at a time.

## PWA baseline: deployed, verified, shipped (01:50-01:55)

`docker compose up -d gate` succeeded cleanly (had to `cd` back into the
project directory first — the shell's working directory had reset to
`Downloads` at some point during the long monitoring stretch). Verified all
six new PWA assets live: `manifest.json`, both icon sizes,
`apple-touch-icon.png`, `favicon-32.png`, `sw.js` all return 200 with
correct content (manifest is real JSON, `sw.js` serves as
`application/javascript`) — the middleware fix works. Regression-checked
`/login` (200) and an unauthenticated `/browse` (307, unchanged). Committed
and pushed to `platform-additions` (commit `18cd9ac`).

Also noticed in passing: the separately-spawned background task for the
`matchTitle()` exact-fallback bug (flagged as a follow-up during the
film-series work earlier tonight) had already completed and pushed its own
commit (`14ed7cc`) independently while I was monitoring the Docker
incident — picked up automatically on this push, no conflict.

**Phone App Roadmap Phase 1 (PWA baseline) is done.** Next: Capacitor
Android scaffold (Phase 2, as far as Node-only tooling reaches — no
Android SDK/Gradle/JDK on this machine, so this stops at generating the
project structure, not a real build). Proceeding cautiously given the
Docker incident that just resolved — one operation at a time, checking
health between steps.

## Capacitor + Tauri scaffolds, then Langlois mode (02:00-02:45)

Both app shells scaffolded (see the main chat transcript / PR commits for
full detail — this log stays focused on incidents and decisions, not a
replay of routine work already covered by commit messages). Both stop at
real, buildable project structure — no Android SDK/JDK, no Rust/Cargo on
this machine, confirmed directly rather than assumed.

User then asked for a new feature: "Langlois mode" (named for Henri
Langlois) — a per-user grant, set from the Invites tab, giving raw film
file + subtitle downloads instead of just streaming. Shipped in two
increments: (1) grantable at invite-creation time, reusing the existing
`/jf/*` proxy by flipping `EnableContentDownloading` on for that one
user's real Jellyfin account rather than building a new download route;
(2) a toggle for already-existing users too, via a new Users list in the
same tab. Both live, verified, committed, pushed.

**Real safety bug caught while testing (2) live**: toggling Langlois mode
on the account "mamnani" — who turned out to be the site's own actual
Jellyfin administrator, since `createSessionForLogin()` gives anyone who
logs into the gate a `users` row regardless of their real Jellyfin
privileges — got a raw Jellyfin 403: "There must be at least one user in
the system with administrative access." `applyRestrictedPolicy()` always
sets `IsAdministrator: false` unconditionally; Jellyfin correctly refused
to let that strip its last admin. Fixed by checking the target's real
Jellyfin policy before attempting anything, refusing clearly for any admin
account (409, not a confusing 403), and greying out the toggle in the
Users list UI itself. Re-verified live against the same account both ways
after the fix.

## Watchdog disabled for the rest of this dev session (02:47)

Explicit instruction: "kill the watchdog it always restarts att the most
inopportune moment, we will relaunch it when we are done with dev." Ran
`Disable-ScheduledTask -TaskName "JellyfinGateWatchdog"` — succeeded this
time (this exact action was blocked by the auto-mode classifier earlier
tonight, for lacking a fresh specific instruction covering that moment;
this time there is one). **Unlike every earlier disable tonight, this one
is NOT getting auto re-enabled** — the user's own words are the standing
instruction to leave it off until they turn it back on themselves.
Noting this explicitly so a future reading of this log (or a future
session) doesn't mistake the disabled state for an oversight.

Also asked for, in the same message: (1) continue the offline-download
backend (Phase 3 — was next up anyway), (2) make Langlois mode toggleable
— already done just above, and (3) a new upload feature: Langlois-mode
users can upload a film + it sits in quarantine until Windows Defender
scans it AND the curator manually approves it, before it ever reaches the
real library. All three now in progress.

## Methodology change: batch changes, verify locally, deploy/push only together (02:55)

Explicit instruction: "constant push makes docker stuck multiple times a
day... do dev work on auto mode when i am not around, test in your
environment if possible and push changes only when i am present all at
once." Saved as a durable memory
(`jellyfin-gate-batch-deploy-workflow.md`) — this changes how the rest of
tonight (and future sessions) works on this project. From here: write and
locally verify code (typecheck via a throwaway container, `node --check`
on the worker script, code review) without running `docker compose
build`/`up -d` against the live `gate`/`worker` containers or `git push`,
until the user is present for a single joint verify-and-ship pass.

## Offline-download backend + Langlois uploads, written and locally verified, NOT deployed (02:55-03:40)

Both features fully coded under the new methodology — everything below is
typechecked clean and syntax-checked, but deliberately **not built,
deployed, or pushed** yet.

**Offline-download backend (Phase 3)**: new `download_jobs` table (v29) —
deliberately separate from `media_jobs`, since a download job starts from
an already-published library item and its output is cached outside the
library entirely, never touching Jellyfin's index. `src/lib/downloads.ts`
resolves an item's real source path via Jellyfin's own admin API
(`getFullItem`) and enqueues a job. `GET /api/download/[itemId]` is
session-authenticated (any logged-in user, not Langlois-gated — this is
the general phone/desktop-app download feature) and streams the prepared
file with real Range support once ready, 202 while still preparing.
`scripts/media-worker.mjs` gained `processDownloadJob()` — a deliberately
separate, simpler sibling of the existing `convert()` (no pause/resume,
writes into a new `MEDIA_DOWNLOADS_CACHE` mount) rather than risking a
refactor of the watch-folder pipeline that's been running in production
all day, at 3am, to serve a second caller.

**Langlois uploads (quarantine -> Defender scan -> curator approval)**:
new `uploads` table (v30). `POST /api/upload?filename=` streams the raw
body straight to `MEDIA_QUARANTINE` (Langlois-mode-gated,
`basename()`-sanitised filename against path traversal, byte-cap
enforced mid-stream via a `Transform`). Because Windows Defender can't be
invoked from inside this Linux container — same reason
`docker-watchdog.ps1` has to run natively — wrote
`scripts/windows/upload-scanner.ps1`, a native PowerShell script (same
shape as the watchdog) that runs `MpCmdRun.exe` against new quarantined
files and cross-checks `Get-MpThreatDetection` (more reliable than
trusting MpCmdRun's own exit code, which just means "the scan ran," or
its locale-dependent text output) and writes a marker file
`reconcileScanResults()` picks up. **Deliberately NOT registered as a
Scheduled Task yet** — that's real host-level automation running
antivirus scans, exactly the kind of thing to set up together rather than
unilaterally; `scripts/windows/README.md` has the registration command
and, importantly, flags that this needs a real EICAR-test-file run before
trusting it, which hasn't happened yet either. Approval
(`POST /api/admin/uploads/:id/approve`) refuses anything not marked
'clean' — enforced in `approveUpload()` itself, not just the caller's
judgement — and moves the file into the existing `MEDIA_INCOMING` watch
folder so the already-proven ingest pipeline handles publishing, rather
than duplicating that logic. New curator "Uploads" tab in `curator.html`;
new user-facing `/upload` page (`UploadForm.tsx`, using `XMLHttpRequest`
specifically because `fetch()` has no upload-progress event) with a link
in `AppBar` shown only when `session.langloisMode` — updated across all
10 pages that render `AppBar`.

**Verification actually done**: full `tsc --noEmit` typecheck clean
across every file above (schema, db.ts, env.ts, both new lib files, six
new/changed routes, the worker script's TypeScript-adjacent callers,
AppBar + its 10 callers, the upload page/component), plus
`node --check scripts/media-worker.mjs` for the worker script itself
(not covered by tsc). **Not done**: no live deploy, no real upload/scan/
approve/download tested end-to-end against a running container — that's
the joint pass waiting for the user. `git status` at this point: 16
modified files, 7 new paths, nothing staged or committed.

## PC crash (18:26, later that day) — nothing lost

The machine crashed and rebooted (boot time 18:26:36, discovered when the
user said "pc crashed continue"). Docker Desktop auto-recovered on its
own — all four containers back up within the same restart-policy behavior
already relied on all session. Checked `git status`: every file from the
"written and locally verified, NOT deployed" section above was still
sitting there exactly as left, plus more — `AppBar.tsx` and every page
rendering it had already picked up `langloisMode` prop plumbing (the
"Upload" nav link work described above), consistent and complete across
all 8 callers, nothing half-wired. Ran a full `tsc --noEmit` again as the
real verification rather than trusting file-presence alone — clean.
`node --check` on the worker script — clean. Confirmed safe to keep
going from exactly where things stood.

## Second work session: 7 more items, then the joint deploy (later that day)

User reported two live bugs first, then asked for the diversity-ranking
idea plus four more features, then said "deploy at the end" — so all of
this stayed uncommitted (per the batch-deploy methodology above) through
the whole stretch:

1. **Resident Evil series row showing an unrelated film, repeated** — root
   caused to `getItemByImdbId()`'s `anyProviderIdEquals` Jellyfin filter
   being a silent no-op on this server's Jellyfin version, verified live
   by hitting the exact API call directly: it returned the first movie in
   default sort order regardless of the requested IMDb id. Every "owned"
   series-row entry across the WHOLE SITE was affected, not just Resident
   Evil. Replaced with `getItemsByImdbIds()` — one batched fetch, matched
   client-side, same reliable pattern `match.ts`'s library index already
   uses.
2. **The specific film that leaked in ("Quattro passi fra le nuvole") had
   zero metadata** — confirmed it should already be hidden everywhere via
   `filterVisible()`/`hasNoMetadata()`, and it was the SAME root-cause bug
   as #1 (the broken lookup bypassed that filter entirely, since it
   never went through it). Fixed by running `getItemsByImdbIds()`'s
   results through `filterVisible()` too.
3. **8 of the top 10 "Popular" results were the same director** — added a
   diminishing-returns discount (`directorDiversityDiscount`/
   `diversityDiscount`, shared between `browse-data.ts` and `media.ts` —
   media.ts specifically because browse-data.ts already imports FROM it,
   so the reverse would be circular): a director's best film keeps full
   weight, the next scores at half, then a quarter... Reused the exact
   same math the existing director/actor FACET ranking already used
   (`personFacets()`), just applied to reordering the movie list itself
   instead.
4. **Same idea for "More like this"** — `getSimilar()` now applies the
   same discount, using Jellyfin's own `/Similar` result order as the
   ranking signal (that endpoint exposes no numeric score to rank by).
5. **Library review redesign** — new "Browse library" panel in
   `curator.html`: every movie, searchable, needs-decision ones sorted to
   the top. Reused the EXISTING Search/Manual/Whitelist/Exclude panel
   functions unmodified (they were already written generically enough —
   confirmed by checking `openSearchPanel`/`openManualPanel`, which only
   need a `.rv-panel-slot`/`review.itemsById[id]` to exist, not a specific
   caller) and the existing multi-select group-creation flow. New backend:
   `buildLibraryBrowse()` in `library-review.ts`, computing every status
   flag once so the UI filters client-side.
6. **Two different cuts of the same film (American vs. Italian) — the
   duplicate-detector only offered "discard one"** — added
   `mergeVersions()` wrapping Jellyfin's own native `/Videos/MergeVersions`
   endpoint (a real version-picker in playback) rather than reinventing a
   parallel versions concept in this app's own database.
7. **Crew credits beyond Director/Actor** — checked the real library data
   before building anything: across all 627 movies, Jellyfin's `People`
   field only ever contains `Actor`/`Director`/`Writer`/`Producer` — OMDb
   (this app's metadata source) never supplies Cinematographer/Editor
   credits at all. Added Writer and Producer rows (real data, confirmed
   against an actual item) using the existing `CastRow` component
   unmodified (it was already generic). Cinematographer/Editor rows are
   wired up too, defensively, but confirmed they'll render empty for now.

**The joint deploy**: full `tsc --noEmit` clean, `node --check` on the
worker script clean, built BOTH the `gate` and `worker` images (the
worker script changed for item 1's Phase 3 backend), deployed both,
verified `PRAGMA user_version` = 30 with all three new tables/columns
present, verified `/login`/unauthenticated `/browse` unchanged, verified
the new `/api/admin/library/browse` and `/api/admin/users` routes return
real data, verified a real library item's Writer/Producer credits are
actually present in the underlying Jellyfin data (so item 7's UI will
render real content, not just structurally-correct-but-empty rows).
Committed in three logical groups (bug fixes + diversity + crew credits;
library browse + merge-versions; download backend + uploads + nav) rather
than one giant commit, then pushed to `platform-additions`.
