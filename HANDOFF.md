# Session handoff: the Watch site

Written 2026-10-22, at the end of a session that merged and deployed everything
open, then carried on with the work the 2026-10-14 session left unfinished.
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
3. **How changes go live:** a PR against `platform-additions`, merged by the
   owner on GitHub, then Watch Control's **Deploy latest** (or
   `~/watch-ops/control/control.sh deploy`). Deploy type-checks and tests,
   builds while the site runs, waits for viewers and running jobs, snapshots
   the database to `~/deploy-snapshots/`, and rolls itself back if the site
   doesn't answer. **Claude's permission mode refuses merging PRs and pushing
   to `platform-additions`**: open PRs and let the owner merge.
4. **Never edit `~/watch`**: it is the live checkout (the old console serves
   `curator.html` from it, and Deploy fast-forwards it). Work in a worktree
   under `~/watch-work/`. The one untracked file there that is edited by hand
   is `~/watch/docker-compose.override.yml` (see "Backups" below).

---

## What is live (`86295f4`, schema 61)

Deployed 2026-10-22 in two goes, both through Deploy:

- **All 20 PRs that were open** (#17, #38–#56) plus #34–#37, which had been
  merged on the 14th but never deployed: the /admin port (every tab), browser
  audio for AC-3 films (#44), cacheable posters (#42), the worker running the
  backup and Jellyfin's own scan schedule removed (#41), Final Cut pause and
  an 8-core worker (#47), catalogue step 2 (#40), live sessions step 1 (#55).
  Two merge conflicts were resolved by keeping both sides: #41/#47 in
  `deploy/mac/`, and #38/#44 both bumping the schema (it ends at 60).
- **#57** one `worker:` entry in the Mac override (the merge had left two).
- **#58** /admin Health fits a phone (a raw JSON job result made it 717 px wide).
- **#59** the old console's banner pointing to /admin, and how to retire it.
- **#60** live sessions step 2: `session-clock.ts`; the phone remote runs on a
  server-kept clock per TV, so two "+10"s make +20 and a TV report can't undo
  a seek. **Not yet checked on the real TV and phone.**
- **#61** catalogue step 3: `POST /api/admin/catalogue/{path}/decide`, the
  `catalogue_decisions` log and the `catalogue_items` summary (schema 61).
  Checked on the test copy with live data.

Tested live after the first deploy, signed in as the owner: every /admin tab
loads with real data, playback resumes and direct-plays, posters come back
`public, immutable`, Health is green. TV behaviour was tested by proxy (the
site's TV mode in a browser, keys as the remote): one OK is one action.

## Merged, not yet deployed

- **#62** the Duplicates tab dropped from /admin (owner's choice).
  `dupefinder/` is kept, marked dormant in its README, to revive later.

## Open

- **#65, waiting for the owner to merge:** Recently watched on Home (under
  Continue watching, heading links to History) and `/history`, everything
  watched to the end by month. Check signed in after deploy: the Jellyfin
  query (played, sorted by date played) hasn't been run for real yet.
- **#66, stacked on #65 (merge #65 first):** Continue watching gets the
  next episode of each show (the site's shows are its own groups, so
  Jellyfin's next-up never saw them; Nathan For You), an ✕ to remove a card
  without marking it watched (`continue_removed`, schema 62), and "Mark
  unwatched" (the tick on Recently watched / History, and the film page's
  button). Check the real Nathan For You row after deploy.
- **#67:** TV left/right held scrubs, faster the longer it's held, one seek
  on release. Check on the real TV that held keys arrive as repeats.
- **#63, waiting for the owner to merge:** an Admin tab in the phone tab bar
  (app and browser) for admin accounts, the links renamed "Admin", and an
  Admin column in Invites → Users to give or remove the site's admin access
  (`users.is_admin`). Until it ships, nothing in the site can make someone an
  admin. Rules: the owner's account always keeps it; nobody removes their own.
  Then Deploy (it ships #62 too), and check the tab on a phone.
- **The real TV.** adb to the Hisense (192.168.1.8:5555) was refused on
  2026-10-22: network debugging needs switching back on in its Developer
  options. Then test #60 (phone play/pause/±10 s, two quick +10s, the bar
  moving smoothly, the TV not jumping back) and the party changes from #34
  (film centred on the TV) and #37 (control handed on when the starter leaves).
- **Cloudflare Cache Rule for #42,** in the dashboard (only the owner can):
  cache `/jf/Items/*/Images/*`, `/api/tmdb-image*`, `/api/person-photo/*`,
  edge TTL from the origin's header. Today every poster is `cf-cache-status:
  DYNAMIC`. Details in #42.
- **Retiring the old console** (`jellyfin-gate-console`, :3200) is now only
  the owner's call; steps in `deploy/mac/README.md`.
- **The Whip and the Body shows twice in Continue Watching.** Not looked into;
  probably two copies of the file (the Library tab lists 15 duplicate titles).

## Next pieces of work

- **A day on Browse: its order, and personalising it.** Owner, 2026-10-22:
  films a viewer has already seen should sink in Browse, but **not now**:
  it gets a separate day of its own, with the rest of Browse's ordering and
  personalisation. Don't fold it into other work. Starting points: Browse
  reads `getAllMovies` (`media.ts`) and each item's `UserData.Played`; the
  viewer's own "Hide what I've seen" switch (`users.hide_watched`) already
  hides them on Home, which is a different thing from ordering them.

- **Live sessions step 3** (`docs/playback-sessions.md`): the remote as a
  two-member session. Do it after #60 has been checked on the real TV.
  Step 4: one `session-control.ts`. Step 5 (watch a screening together)
  needs the owner's decision first.
- **Catalogue step 4** (`docs/catalogue-state.md`): the inbox, built on #61's
  `catalogue_items` and decide endpoint; the old chips and badges go in the
  same PR. Then 5 (the site's status component), 6 (removing the old
  endpoints once nothing calls them; they all log decisions now), 7 (the
  behaviour changes in section 9, each its own decision).

## Backups (changed today)

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

## Things that bit today

- **The test copy shares the real Jellyfin.** Starting it with #41's code
  removed Jellyfin's own library-scan schedule on the live server before the
  deploy did (intended, but early). Anything the site does to Jellyfin at boot
  happens from the test copy too.
- **The test copy's worker can't write films** (the drive is mounted
  read-only there), so jobs like browser audio fail there with "Read-only
  file system". Stop it (`docker stop jellyfin-gate-worker-dev`) when testing
  the gate.
- **Signing in to the test copy needs the owner.** Claude may not reuse a
  stored Jellyfin token to make a test login. The live site's cookie, imported
  into the browser pane, works for testing the live site; it doesn't reach
  `localhost:3100`. Admin API calls to either work through
  `~/watch-ops/api.sh dev|prod`.
- **The listing's catalogue facts are deliberately thin.** `listingFacts`
  leaves out show membership and allowed damage, because neither changes a
  listing. Anything that counts or decides (the summary, the inbox) must add
  them, as `catalogue-decisions.ts` does, or it overcounts (314 instead of 54)
  and "take off" loses track of allowed damage.
- **`npm test` can't load `server-only` modules,** and no test opens the
  database. Keep rules pure (as `catalogue-decide.ts`, `admin-grants.ts`,
  `session-clock.ts` are) and test those; check the rest on the test copy.
- **`src/lib/cache.ts` holds a byte that makes grep call it binary.** Use
  `grep -a` or awk to search it.

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
