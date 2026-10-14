# Running Watch on the Mac

Since 2026-10-14 the site runs on a Mac mini (Apple Silicon) with OrbStack,
the films on the external exFAT drive `Elements`. This folder holds
everything that lives on the Mac outside the repo checkout, so the setup can
be rebuilt from git. The restore guide that first set it up is
`watch-mac-restore/RESTORE-ON-MAC.md` on the film drive.

## Where each file goes

| Here | On the Mac | What it does |
|---|---|---|
| `docker-compose.override.yml` | `~/watch/` | Mac settings: no tunnel container, no start-up library scan, Jellyfin `cpus: "6"`, the worker `cpus: "8"` (it only runs when nobody is watching and Final Cut isn't open) |
| `host-jobs/watch-up.sh` | `~/watch-host/` | Every 2 min (launchd `com.watch.up`): starts the site once the drive is mounted, stops it if the drive vanishes, honours a deliberate disconnect, restarts OrbStack when it can't see a re-plugged drive |
| `host-jobs/jellyfin-gate-*.sh`, `backup-to-e.sh` | `~/watch-host/` | The backup the site schedules (launchd `com.watch.hostjobs`, every minute). All reads and writes on the drive go through `docker run`: macOS refuses launchd jobs access to external drives |
| `host-jobs/yield-to-fcp.sh` | `~/watch-host/` | Every 15 s (launchd `com.watch.yield`): freezes the worker (`docker pause`) while Final Cut Pro is open and resumes it when Final Cut quits. The worker already pauses itself while anyone is watching, so with both it can have 8 cores |
| `launchd/*.plist` | `~/Library/LaunchAgents/` | The three agents above (`__HOME__` etc. filled in by `setup.sh agents`) |
| `control/control.sh`, `control/WatchControl.applescript` | `~/watch-ops/control/`, built to `~/Desktop/Watch Control.app` with `osacompile` | The owner's app: status, disconnect drive, start, deploy latest merged code, roll back, off-hours schedule |
| `control/schedule-*.py/.sh`, `com.watch.schedule.plist` | installed as root by the app into `/Library/Application Support/watch/` and `/Library/LaunchDaemons/` | Weekday/weekend shutdown and start-up times (`pmset schedule`, re-booked hourly), settings in `~/.config/watch/schedule.json` |
| `ops/*.sh` | `~/watch-ops/` | `playing.sh` (who is watching), `api.sh` (admin API), `check.sh` (types + tests), `build-dev.sh`, `deploy.sh` |
| `dev-stack/docker-compose.yml` | `~/dev-stack/` | The test copy on 127.0.0.1:3100; run with `COMPOSE_FILE=docker-compose.yml` because `~/watch/.env` names production's compose files |
| `setup.sh` | anywhere | The restore steps (`env`, `volumes`, `console`, `agents`, `ops`, `check`) |

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
