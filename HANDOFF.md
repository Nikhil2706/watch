# Session handoff: the Watch site

Written 2026-10-25, at the end of a session (begun 2026-10-22) that merged and
deployed everything open, finished the 2026-10-14 session's leftovers, then
built the watch-history, friends, coming-soon and subtitle work below.
Paste this file into a new chat to resume. The previous handoff (2026-09-05,
from the Windows PC) is in git history; `HANDOFF-2026-09-06.md` and
`HOST-SETUP.md` describe the older hosts.

---

## Read this first

1. **The site runs on a Mac mini** (M4, macOS 26, OrbStack), since 2026-10-14.
   What runs where is in [deploy/mac/README.md](deploy/mac/README.md). Films
   are on the external drive at `/Volumes/Elements/Da Moveesh`; the public
   address is `watch.abhigyanverma.com` through a cloudflared launch daemon.
2. **The owner's rules** (all still in force):
   - No image build, container restart, test-copy start or deploy without the
     owner's word, and never while anyone is watching
     (`~/watch-ops/playing.sh` prints how many are).
   - Never "rebuild the library" in Jellyfin, or scan while the drive is away.
   - Never permanently delete their files: move to the Trash and say so.
   - Never prune scraped data, never skip Jellyfin artwork in backups.
   - Reports short and plain: done, checked how, not done.
   - Never print the console's secret address (`~/console-server/console-url.txt`).
   - The automatic subtitle sync (alass) is not to be added to the worker
     image without the owner's OK.
3. **How changes go live:** a PR against `platform-additions`, merged by the
   owner on GitHub, then Watch Control's **Deploy latest** (or
   `~/watch-ops/control/control.sh deploy`). Deploy type-checks and tests,
   builds while the site runs, waits for viewers and running jobs, snapshots
   the database to `~/deploy-snapshots/`, and rolls itself back if the site
   doesn't answer. **Claude's permission mode refuses merging PRs and pushing
   to `platform-additions`**: open PRs and let the owner merge. **Every PR
   targets `platform-additions`**, never another PR's branch (see "Things
   that bit").
4. **Never edit `~/watch`**: it is the live checkout (the old console serves
   `curator.html` from it, and Deploy fast-forwards it). Work in a worktree
   under `~/watch-work/`. The one untracked file there that is edited by hand
   is `~/watch/docker-compose.override.yml` (see "Backups" below).

---

## What is live (`b911395`, schema 65)

Everything up to the 2026-10-22 handoff (`86295f4`, schema 61), plus, all
deployed through Deploy:

- **#62** the Duplicates tab dropped from /admin (`dupefinder/` kept, dormant).
- **#63** an Admin tab in the phone tab bar for admin accounts; Invites →
  Users gives or removes admin (`users.is_admin`). Checked on the phone.
- **#65** Recently watched on Home and `/history` (everything watched, by month).
- **#71** (one catch-up PR for the stacked #66, #68–#70):
  - Continue watching gets each show's next episode; ✕ removes a card;
    "Mark unwatched" (`continue_removed`, schema 62).
  - Friends: what friends watched and are watching, "only friends" privacy
    (`watch_log`, `friendships`, `users.activity_visibility`, schema 63), and
    "Watch together" from a friend watching now (`watch_together`, schema 64).
  - Coming soon: announce a film by IMDb id, and scheduled releases (single
    films by date; franchises one a day already existed) (`coming_soon`, schema 65).
- **#67** TV left/right held scrubs faster the longer it is held, one seek
  on release. **Not checked on the real TV** (adb refused, see Open).
- **#72** a friend's diary: their watch history from the Friends page.
- **#73** Friends hides people who haven't watched anything.
- **#74** next-up also when an episode was opened but never started (Nathan
  For You now shows "Next: S1 E2").
- **#75** subtitle downloads give a **list to choose from**, best guess on
  top (`subtitle-choices.ts`: same file hash, then same release name /
  release group, name similarity, trusted uploader, plain before hearing-
  impaired, rating, downloads). Picks are written beside any existing file
  (`.eng.srt`, else `.2.eng.srt`...).
- **#76** the sync screen, `/admin/subtitles/sync`: the video with the
  subtitle drawn over it; nudge by fractions of a second (buttons or
  `[ ] { }`), "Said now" on a line, a two-point fit for drift; Save keeps the
  first version as `<name>.orig`, Put back restores it.
- **#77** Try before keeping: plays a downloaded candidate against the video
  in the sync screen (Previous/Next, Keep this one). A tried file is held 24 h,
  so keeping it costs no second download.
- **#78** after syncing one episode, shift every other episode by the same amount.
- **#79** a TV mini-series kept as one file (Salem's Lot 1979) shows as the
  film it is: Identify → "A TV mini-series kept as one file?" links the file
  to the TMDB show (`tmdb_links` path→tv) and writes name, year, summary and
  poster to Jellyfin; the IMDb id stays.
- **#80** films kept in parts (Out 1 in 8, My Undesirable Friends in 2): the
  group links to the TMDB film (group→movie, by IMDb id), and "Subtitles for
  the whole film" cuts one whole-film subtitle across the parts at their
  lengths, or uses an upload that comes one file per part.

Tested live on 2026-10-25 after the `b911395` deploy, as the owner:
- Out 1's page has TMDB backdrop, cast and Rivette; Salem's Lot has its
  title, summary and cast (but no director: #81).
- The Others: the choice list; Try (one download) and Keep wrote
  `.2.eng.srt`; Save +0.5 s moved the first line 19.086 → 19.586 s, Put back
  returned it.
- Nathan For You: 24/24 episodes have subtitles; the shift-all panel lists
  23 episodes (but ticked none: #82).
- Out 1 "Subtitles for the whole film": 8 parts, 4 candidates, the 8-file
  upload first. **Not applied**: each part already has 3 built-in English
  tracks and a Subs folder.
- Friends hides empty profiles.

## Open

- **#81, waiting for the owner to merge:** Salem's Lot's director. The
  mini-series' credits now take its episodes' crew (TMDB lists the director
  per episode, not on the show). Then Deploy and check the Salem's Lot page.
- **#82, waiting for the owner to merge:** the sync screen's subtitle didn't
  show in the browser pane (clock on animation frames only; now also the
  video's events), and shift-all ticked 0 files (`.srt` vs `.eng.srt`; now
  alike, plus Tick all / None). Then Deploy, and redo the Nathan shift-all
  check (S1E01 was put back to its original; nothing else was shifted).
- **The real TV.** adb to the Hisense (192.168.1.8:5555) is refused: network
  debugging needs switching back on in its Developer options. Then test #67
  (held scrub), #60 (phone remote clock) and the party changes from #34/#37.
- **Cloudflare Cache Rule for #42,** in the dashboard (only the owner can):
  cache `/jf/Items/*/Images/*`, `/api/tmdb-image*`, `/api/person-photo/*`,
  edge TTL from the origin's header. Posters are still `cf-cache-status: DYNAMIC`.
- **Retiring the old console** (`jellyfin-gate-console`, :3200): the owner's
  call; steps in `deploy/mac/README.md`.
- **The Whip and the Body shows twice in Continue watching.** Not looked into;
  probably two copies of the file.
- **Automatic subtitle sync (alass)** in the worker: proposed, waiting for the
  owner's OK before it goes in the image. Syncing by eye (#76) covers it until then.
- **OpenSubtitles quota:** 100 downloads a day (80 were left on 2026-10-25).
  Searches are free; Try and Keep each cost one download at most.

## Next pieces of work

- **A day on Browse: its order, and personalising it.** Owner, 2026-10-22:
  films a viewer has already seen should sink in Browse, but **not now**:
  it gets a separate day of its own, with the rest of Browse's ordering and
  personalisation. Don't fold it into other work. Starting points: Browse
  reads `getAllMovies` (`media.ts`) and each item's `UserData.Played`; the
  viewer's own "Hide what I've seen" switch (`users.hide_watched`) already
  hides them on Home, which is a different thing from ordering them.
  `watch_log` (#71) now records who watched what and when, for "liked by
  friends"-style ordering.

- **Live sessions step 3** (`docs/playback-sessions.md`): the remote as a
  two-member session. Do it after #60 has been checked on the real TV.
  Step 4: one `session-control.ts`. Step 5 (watch a screening together)
  needs the owner's decision first.
- **Catalogue step 4** (`docs/catalogue-state.md`): the inbox, built on #61's
  `catalogue_items` and decide endpoint; the old chips and badges go in the
  same PR. Then 5 (the site's status component), 6 (removing the old
  endpoints once nothing calls them; they all log decisions now), 7 (the
  behaviour changes in section 9, each its own decision).

## Backups (changed 2026-10-22)

- The backup is a job the **worker** runs (`scripts/backup.mjs`, #41), every
  day at midnight, keeping only the newest. Its folder must be on the drive.
- This Mac's `.env` predates #41 and has **no `BACKUP_PATH`**, so the worker
  had fallen back to `~/watch/backups` on the Mac's own disk (which the backup
  refuses). The live, untracked `~/watch/docker-compose.override.yml` now
  mounts `/Volumes/Elements/jellyfin-gate-backups` at `/backups` for the
  worker; verified after the `86295f4` deploy. A fresh install writes
  `BACKUP_PATH` itself (`setup.sh env`).
- The old launchd agent `com.watch.hostjobs` was removed (its plist is in the
  Trash). Only `com.watch.up` and `com.watch.yield` remain.

## Things that bit

- **Stacked PRs merged into each other's branches.** #66 and #68–#70 were
  opened on top of earlier PR branches; merging them landed them in those
  branches, not `platform-additions`, so #71 had to carry them all. Always
  base a PR on `platform-additions`, even if it depends on an open one.
- **The test copy shares the real Jellyfin.** Anything it writes to Jellyfin
  (metadata, images, the scan schedule) is live at once: Salem's Lot's name and
  poster were fixed from the test copy before #79 was deployed.
- **The test copy's worker can't write films** (read-only mount). Stop it
  (`docker stop jellyfin-gate-worker-dev`) when testing the gate.
- **OpenSubtitles and TMDB drop connections** (ECONNRESET, "fetch failed")
  now and then; the site retries 5 times and can still fail, which through
  Cloudflare shows as a 502. Trying again a minute later works.
- **A deploy stopped part-way leaves `~/watch` ahead of what runs.** Claude's
  permission mode refuses `git reset --hard` in `~/watch`; the owner runs it.
- **zsh's `echo` turns `\n` in JSON into newlines.** Write request bodies to a
  file (or build them in Python) before `api.sh`.
- **Signing in to the test copy needs the owner.** The live site's cookie,
  imported into the browser pane, works for the live site only. Admin API
  calls to either go through `~/watch-ops/api.sh dev|prod`.
- **The listing's catalogue facts are deliberately thin** (no show
  membership or allowed damage): anything that counts or decides must add
  them, as `catalogue-decisions.ts` does.
- **`npm test` can't load `server-only` modules,** and tests import with a
  `.ts` extension (`./subtitle-choices.ts`). Keep rules pure and test those.
- **`src/lib/cache.ts` holds a byte that makes grep call it binary.** Use `grep -a`.

## Where things are

- Live checkout `~/watch` (branch `platform-additions`); worktrees
  `~/watch-work/*`; test copy `~/dev-stack` on :3100, built with
  `~/watch-ops/build-dev.sh <worktree>` (needs `COMPOSE_FILE=docker-compose.yml`
  for compose commands there).
- Ops scripts `~/watch-ops/` (`check.sh` type-check + tests in a container,
  `playing.sh`, `api.sh`, `deploy.sh`); host jobs `~/watch-host/`; logs in
  `~/Library/Logs/` (`watch-deploy.log`, `watch-control.log`).
- Restore kit and the PC-era notes on the drive:
  `/Volumes/Elements/watch-mac-restore/` (`RESTORE-ON-MAC.md`,
  `payload/notes/`).
- Design docs: `docs/playback-sessions.md`, `docs/catalogue-state.md`.
- Subtitle code: `subtitle-choices.ts` (ranking), `subtitle-chooser.ts`,
  `subtitle-try.ts`, `srt-timing.ts` + `subtitle-sync.ts` (the sync screen),
  `subtitle-show-shift.ts`, `subtitle-parts.ts` + `subtitle-parts-apply.ts`
  (films in parts); panels in `src/app/admin/library/SubtitlePanels.tsx`.
