# Running Watch on the Mac

Since 2026-10-14 the site runs on a Mac mini (Apple Silicon) with OrbStack,
the films on the external exFAT drive `Elements`. This folder holds
everything that lives on the Mac outside the repo checkout, so the setup can
be rebuilt from git. The restore guide that first set it up is
`watch-mac-restore/RESTORE-ON-MAC.md` on the film drive.

## Where each file goes

| Here | On the Mac | What it does |
|---|---|---|
| `docker-compose.override.yml` | `~/watch/` | Mac settings: no tunnel container, no start-up library scan, Jellyfin `cpus: "6"` (the Mac also runs Final Cut), the worker `cpus: "8"` (it only runs when nobody is watching and Final Cut isn't open), the override itself mounted into the worker for the backup |
| `host-jobs/watch-up.sh` | `~/watch-host/` | Every 2 min (launchd `com.watch.up`): starts the site once the drive is mounted, stops it if the drive vanishes, honours a deliberate disconnect, restarts OrbStack when it can't see a re-plugged drive |
| `host-jobs/yield-to-fcp.sh` | `~/watch-host/` | Every 15 s (launchd `com.watch.yield`): freezes the worker (`docker pause`) while Final Cut Pro is open and resumes it when Final Cut quits. The worker already pauses itself while anyone is watching, so with both it can have 8 cores |
| `host-jobs/watch-health.sh`, `watch-health-checks.mjs` | `~/watch-host/` | Nightly at 04:30 (launchd `com.watch.health`), or by hand: a read-only health report in `~/Library/Logs/watch-health/latest.txt` (30 days kept), and a macOS notification only when something needs looking at. Drive and dropouts, containers that can't see `/media`, the site locally and publicly, merged-but-not-deployed code, files Jellyfin knows only as they were before the worker rewrote them, newly damaged files, failed browser audio, TV episodes missing against TMDB. It fixes nothing; each finding says what the fix is. The `.mjs` half runs inside the worker (`docker exec -i … node -`) |
| `host-jobs/jellyfin-gate-*.sh`, `backup-to-e.sh` | not installed | RETIRED 2026-10-14. The old backup, run by launchd `com.watch.hostjobs` every minute. The backup is now a job the worker runs (`scripts/backup.mjs`), on the schedule in the console's Health tab. Kept so the site's "host" runner still has a working example |
| `launchd/com.watch.up.plist`, `launchd/com.watch.yield.plist`, `launchd/com.watch.health.plist` | `~/Library/LaunchAgents/` | The agents above (`__HOME__` etc. filled in by `setup.sh agents`). `com.watch.hostjobs.plist` is the retired one; `setup.sh agents` removes it |
| `control/control.sh`, `control/WatchControl.applescript` | `~/watch-ops/control/`, built to `~/Desktop/Watch Control.app` with `osacompile` | The owner's app: status, disconnect drive, start, deploy latest merged code, roll back, off-hours schedule |
| `control/schedule-*.py/.sh`, `com.watch.schedule.plist` | installed as root by the app into `/Library/Application Support/watch/` and `/Library/LaunchDaemons/` | Weekday/weekend shutdown and start-up times (`pmset schedule`, re-booked hourly), settings in `~/.config/watch/schedule.json` |
| `ops/*.sh` | `~/watch-ops/` | `playing.sh` (who is watching), `api.sh` (admin API), `check.sh` (types + tests), `build-dev.sh`, `deploy.sh` |
| `dev-stack/docker-compose.yml` | `~/dev-stack/` | The test copy on 127.0.0.1:3100; run with `COMPOSE_FILE=docker-compose.yml` because `~/watch/.env` names production's compose files |
| `setup.sh` | anywhere | The restore steps (`env`, `volumes`, `console`, `agents`, `ops`, `check`) |

## What runs when

Everything on a schedule is in /admin's Health tab (Scheduled jobs),
with its last runs: the site's own jobs, the backup (run by the worker), the
library scan, and the worker's conversions, upload virus scan and
damaged-file check. The only things still scheduled on the Mac itself are
listed there too, under "Runs on its own": `com.watch.up` and the off-hours
schedule.

- **Backup:** the worker, with the drive's `jellyfin-gate-backups` mounted
  (`BACKUP_PATH` in `.env`), Jellyfin's config and `.env` read-only. It reads
  the new backup back before deleting the older one.
- **Library scans:** only the site. Jellyfin's own 12-hourly "Scan Media
  Library" is unscheduled at every boot; the site's "Library scan" job runs
  instead, and refuses (logged, and failed in the Health tab) when the film
  drive looks absent.

## Rules that matter

- Deploys: Watch Control's "Deploy latest merged code" (or `control.sh deploy`)
  checks, builds while the site runs, waits while anyone is watching or a
  conversion or scheduled job is running (a restart cuts those off), keeps
  `watch-gate:pre-<stamp>` for "Roll back", and rolls back itself if the site
  doesn't answer.
- Merging anything under `apps/mobile/**` publishes the Android app; bump
  `versionCode`/`versionName` in `apps/mobile/android/app/build.gradle` or
  installed apps are not offered the update.
- Never start Jellyfin while the drive is missing, and never "rebuild the
  library": the item ids key everything in the site's database.
- The tunnel is a cloudflared launch daemon on the Mac
  (`cloudflared service install <token>`), pointing at `http://localhost:3000`.


## Retiring the console

The curator's console (`curator.html`, container `jellyfin-gate-console` on
:3200 behind a secret link) has moved into the site at `/admin`, behind the
normal sign-in for accounts with `users.is_admin`. Its page now says so.

`/admin` has every tab the curator uses. The console's **Duplicates** tab
(the `dupefinder` sidecar, matching files by their frames) was dropped rather
than ported (owner's choice, 2026-10-22): it never ran on this Mac, and
same-title copies are the Library tab's Duplicates filter. Its code stays in
`dupefinder/` to revive later; see that README.

When the owner decides to retire it:

1. `docker stop jellyfin-gate-console && docker rm jellyfin-gate-console`
2. Move `~/console-server/` to the Trash (it holds the secret link and the
   admin key the console used).
3. Nothing else: Watch Control's Start and Deploy only touch the console while
   the container exists, and `setup.sh console` is then not needed on a
   restore.

`ADMIN_API_KEY` stays in `.env`: scripts such as `~/watch-ops/api.sh` still
use it with `X-Admin-Key`.
