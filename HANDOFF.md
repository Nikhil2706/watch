# Session handoff — jellyfin-gate

Written 2026-08-21, end of a very long session that started from the
previous handoff (2026-08-20) and ran through a real hardware incident.
Paste this whole file into a new chat to resume. Most durable lessons are
ALSO saved as persistent memory (auto-loads in a new chat regardless) —
this file covers exact in-flight state.

---

## READ THIS FIRST — three things that matter immediately

1. **This machine has a real, unresolved hardware problem** on its primary
   drive (Disk 0, "Matrix 512GB" SATA SSD — where Windows, Docker, WSL2,
   and this whole project live). Repeated kernel crashes (bugcheck
   `0x154` UNEXPECTED_STORE_EXCEPTION, a couple of `0x7a`
   KERNEL_DATA_INPAGE_ERROR) going back to at least July 6, sharply
   accelerating — 3+ crashes in one day by the end of this session. Full
   diagnosis is in this session's own chat transcript; short version: I/O
   retries and read errors on Disk 0, an actual I/O failure mid-`docker
   compose build` tonight, and Docker Desktop's own socket files
   (reparse points under `%LOCALAPPDATA%\Docker\run\` and
   `%LOCALAPPDATA%\docker-secrets-engine\`) getting corrupted badly enough
   that even `Remove-Item -Force` couldn't delete them — only renaming the
   *parent folder* worked, same recovery trick as the earlier containerd
   corruption incident. **As of this handoff, the user has NOT yet run the
   Dell F12 hardware diagnostic or reseated the SATA cable** — both still
   recommended before trusting this machine under sustained write load
   again. If Docker/a build acts up in the new session, check `docker ps`
   responsiveness and Windows System event log (`Get-WinEvent -FilterHashtable
   @{LogName='System'; Id=41,1001}`) before assuming it's a code problem —
   it very well might not be.

2. **A full backup exists at `E:\jellyfin-gate-backup-2026-08-21\`**,
   updated at the end of this session: the whole repo (minus
   `node_modules`/`.next`, both regenerable), `docker-watchdog\`, a
   VACUUM-INTO'd (guaranteed-consistent, integrity-checked) snapshot of
   the live database, and this project's Claude memory + full session
   transcripts. If C: fails entirely, everything needed to rebuild this
   site from scratch is on E:.

3. **The `JellyfinGateWatchdog` Scheduled Task is still DISABLED** (user's
   explicit call, from before this session started) — nothing auto-restarts
   Docker if it goes down. The upload scanner's Scheduled Task
   (`JellyfinGateUploadScanner`) is registered but ALSO currently disabled —
   it had a real bug (fixed this session, see below) and still needs a real
   EICAR-file test before being trusted and turned back on.

## What's deployed and live right now

Everything below shipped tonight — `docker compose build && up -d`
succeeded, schema migrated cleanly straight from v30 to v33, all
containers healthy. This is real, running code, not a pending PR.

- **Mobile player gestures** (`src/components/media/Player.tsx`,
  `globals.css`): tap reveals a center play/pause button instead of the
  whole video pausing on any touch; double-tap the left/right thirds
  seeks ±10s with a brief flash. Touch-only via `(hover: none) and
  (pointer: coarse)`. `clickToFullscreen` also turned off (traded away
  since it collided with the new double-tap-to-seek zones) — desktop
  still has the explicit fullscreen button.
- **Readable URLs** (`src/lib/slugs.ts`): `/item/the-matrix-1999-<id>`
  and `/watch/...` instead of a bare Jellyfin UUID, across every page
  that links to a film. Old bare-UUID links still resolve — the id is
  always just the trailing 32 hex characters either way.
- **TV completion notifications**: `runTvNotifyTick()` in
  `src/lib/library-notify.ts` — `new_show`/`new_episodes` notification
  kinds, same "seed without notifying on first run" pattern as the
  existing movie tick.
- **Watch party** (`src/lib/party.ts`, `src/lib/party-identity.ts`,
  `scripts/party-server.mts`, `src/components/party/*`,
  `src/app/party/*`, `src/app/api/party/*`): rooms, instant or scheduled;
  per-person guest links with QR codes for no-signup chat participants
  (tracked, not anonymous — that was the actual ask); chat; playback sync
  (creator-only by default, grantable via the participant list). Ships as
  its own container (`jellyfin-gate-party`, listening internally on
  `:4001`) — **not reachable from outside yet**, see gaps below.
- **Scheduled rollout** (`src/lib/rollout.ts`) — covers BOTH TV shows
  (`library_groups`) and film series (`film_series`), one schema/tick
  shared by both subject types. Curator UI is in `curator.html`'s Library
  tab: a rollout panel on each TV group's manage view, plus a whole new
  "Film series" card (didn't exist before this session at all) for
  managing series rollouts. `addToGroup()`/`/api/admin/library/group-add`
  is new too — lets a curator add more episodes to an *already-grouped*
  show, which the old "Group checked as one" flow couldn't do.
- **Season-grouped collection pages**
  (`src/app/collection/[id]/page.tsx`): The West Wing (and any 150+
  episode show) now renders as one horizontally-scrolling `Row` per
  season instead of one giant flat grid. Returning to the page
  auto-scrolls (smooth) to whichever episode you're mid-way through, or
  the next unwatched one if you finished the last — one
  `scrollIntoView` call on the target poster's own link handles both the
  vertical (which season) and horizontal (which tile) positioning at
  once. Falls back to the old flat grid for a non-episodic multi-part
  group (no season numbers at all, e.g. "Out 1").
- Small but real fixes along the way: the upload scanner script
  (`scripts/windows/upload-scanner.ps1`) had a genuine Windows PowerShell
  5.1 parser bug — an em dash mixed with a `$(...)` subexpression in a
  string desyncs its brace-matching and throws confusing, unrelated
  parse errors. Fixed (ASCII-only now, with a comment explaining why) and
  re-registered the Scheduled Task with `-WindowStyle Hidden` (missing
  before — the terminal-flashing-every-5-minutes the user saw was this).
  A stray backtick in a SQL comment inside `schema.ts`'s giant template
  literal silently truncated the whole file, caught by `tsc`, not
  eyeballing — same trap already committed to memory this session.

## What's NOT done — resume here

- **Watch party has no edge routing.** `docker-compose.yml`'s `party`
  service has no `ports:` and nothing proxies `/ws/party` to it — the
  frontend will try to connect and fail until either a cloudflared
  ingress rule or an equivalent reverse-proxy rule is added. Given the
  tunnel-architecture-drift memory (prod actually runs on a **native
  Windows Cloudflared service**, not the docker `tunnel` container the
  README describes), that routing almost certainly needs to be added to
  the native service's own config, not the docker-compose `tunnel`
  service (which is stopped anyway — see below).
- **True fullscreen doesn't show the watch-party chat panel.** Documented
  as a known gap in `globals.css`'s own comment — fullscreening the
  player still only promotes `.player-stage`, not a wrapper containing
  both it and `.party-chat`.
- **Film series rollout reveals fire no notification.** TV reveals
  naturally produce one because the existing tick re-checks
  confirmed-and-visible status; a film series' films are typically
  already-owned long before their slot opens, so there's no "just became
  visible" moment to hang a notification off. Documented as a follow-up
  in `rollout.ts`'s own comment, not implemented.
- **Upload scanner EICAR test still not done.** Script is fixed and the
  Scheduled Task is registered correctly (hidden window, 5-min interval)
  but left **disabled** per the user's own call. Test with a real EICAR
  file before trusting it, per `scripts/windows/README.md`.
- **`jellyfin-gate-tunnel` (the Docker container) is stopped**, again —
  empty credentials dir, would just crash-loop. Native Windows
  Cloudflared service is what actually serves production. A plain
  `docker compose up -d` WILL try to restart this container again (it's
  not scaled/profiled out in the compose file) — `docker compose stop
  tunnel` afterward if that happens.
- **Nothing has been committed to git.** 50 changed files, entirely
  uncommitted, as of this handoff — everything above exists only as a
  live Docker deployment and the E: backup, not in git history yet.

## Where things live

- Memory files: `C:\Users\Dell\.claude\projects\C--Users-Dell-Downloads\memory\`
  — `MEMORY.md` is the index, read it first in the new chat.
- E: backup: `E:\jellyfin-gate-backup-2026-08-21\` — repo,
  `docker-watchdog\`, a verified live-DB snapshot
  (`database\jellyfin-gate-backup.db`), and this project's full Claude
  memory + session transcripts (`claude-project-files\`).
- Docker data backup from the *previous* incident (2026-08-20, still
  sitting there, not yet cleaned up): `D:\docker_data_backup_2026-08-20.vhdx`.
- Watchdog: `C:\Users\Dell\docker-watchdog\` — **disabled**, see above.
- `.env` has real secrets (`ADMIN_API_KEY`, `JELLYFIN_API_KEY`,
  `OMDB_API_KEY`) — never commit it; it's backed up on E: now too, treat
  that copy with the same care.
- Fork/PR: branch `platform-additions` on `Nikhil2706/watch`, PR open
  against `abhigyanverma/watch` at
  https://github.com/abhigyanverma/watch/pull/1 — NOT yet updated with
  tonight's work, since nothing's committed.
