# Session handoff — jellyfin-gate

Written 2026-09-05, end of a long session of user-led testing: the user
exercised the site and the curator console feature by feature, reported what
was wrong, and the fixes were batched and deployed together. Paste this whole
file into a new chat to resume. The durable lessons are also saved as
persistent memory (auto-loads in a new chat regardless) — this file covers
exact in-flight state.

---

## READ THIS FIRST — three things that matter immediately

1. **The boot SSD is failing, and it got worse today.** Bugcheck `0x154`
   UNEXPECTED_STORE_EXCEPTION — a failed read from Windows' memory-compression
   store. Previously one crash every few days (30 Aug, 2 Sep); **three on
   5 Sep** (07:35, 09:41, 13:12). The 13:12 one happened while a Docker image
   rebuild ran *and* the console was in use at the same time.
   - Never rebuild while the site or console is being used. That combination
     is what crashed it.
   - `Get-PhysicalDisk` still says "Healthy" — worthless here. The reliability
     counter shows 3 read errors, 5,646 power-on hours.
   - No `chkdsk /r`, no vhdx compact, until the drive is imaged.
   - Every crash so far has left the SQLite database intact
     (`PRAGMA integrity_check` = ok). That is luck, not design.

2. **A crash mid-deploy leaves a half-created container.** Symptom: site 502,
   `docker ps -a` shows `<hash>_jellyfin-gate` as *Created* and the real one
   *Exited (255)*. Recovery:
   ```
   docker rm -f <hash>_jellyfin-gate
   docker compose --env-file .env --env-file .env.wsl-paths up -d --no-deps gate
   ```

3. **curator.html needs no deploy.** It is a local `file://` page, not in the
   image, not served by Next.js. Console-only changes = save the file and
   reload the browser tab. Check `git diff --name-only` before rebuilding; if
   nothing under `src/`, `next.config.ts`, `package.json`, `Dockerfile` or
   `middleware.ts` changed, do not rebuild. This matters because rebuilds are
   the heaviest write load on a dying drive.

---

## How this is deployed

Docker CE **inside the Ubuntu WSL distro** (not Docker Desktop, which still
has a 31.9 GB disk on C: doing nothing — see "Open items").

```
cd /mnt/c/Users/Dell/Downloads/jellyfin-gate
docker compose --env-file .env --env-file .env.wsl-paths build gate
docker compose --env-file .env --env-file .env.wsl-paths up -d --no-deps gate
```

`--no-deps` is deliberate: Jellyfin takes minutes to load its database, and
restarting it is what turned a WSL restart into a long outage this morning.

Boot is handled by `jellyfin-gate.service` → `/usr/local/bin/jellyfin-gate-up.sh`,
which waits for the USB media disk before bringing things up. **That script had
been failing silently for eight days** — it named the retired `party` service,
so compose exited 1 and started nothing (the containers only came up because
of `restart: unless-stopped`). Fixed 5 Sep; backup at `.bak-20260905`.

### Verifying without deploying

Everything below runs against the existing image — no rebuild, no writes:

```
# TypeScript
docker run --rm --user 0 --entrypoint node \
  -v /mnt/c/Users/Dell/Downloads/jellyfin-gate:/src -w /src jellyfin-gate-gate \
  node_modules/typescript/bin/tsc --noEmit --incremental false

# Tests (35 of them)
docker run --rm --user 0 --entrypoint node ... jellyfin-gate-gate \
  --test --experimental-strip-types src/lib/*.test.ts
```

Two console checks worth keeping (they each caught a real bug this session):

- **`check-curator.sh`** — parses every inline `<script>` in curator.html with
  `new Function`. Catches syntax breakage a diff will not show you.
- **`check-ids.py`** — proves every `$("id")` the script reaches for exists in
  the markup. It found two dangling references left by deleted cards, each of
  which would have thrown at load and broken the **entire** console.

And the technique that found the rest: copy curator.html to `/tmp`, append a
harness that stubs `window.fetch` with canned data, serve **that copy only**
(never the repo directory — `.env` lives there), and drive it in a browser. No
admin key is ever typed into a field.

---

## What shipped today (13 commits, all deployed)

**Bugs the user found by using it:**

- **Watch-party chat and guest-link rows were unusable** — one global rule,
  `form button[type="submit"] { width: 100% }`, made the button eat the row.
- **Every PATCH the console makes was blocked** before leaving the browser:
  `Access-Control-Allow-Methods` omitted PATCH. That is why neither Langlois
  mode nor parental control could be toggled for anyone — and why accolade
  trivia edits and builder renames had silently never worked.
- **Library posters could never have loaded in the console.** `/jf/` images
  authenticate on a session cookie and the console is a `file://` page, so
  cookies are never sent. Now served from a signed thumbnail route.
- **Admin search took 10–20 seconds** to return a few hundred bytes: it asked
  Jellyfin for `MediaSources` (every subtitle track of every film) on each
  keystroke. 4.1 MB/13 s with it, 0.9 MB/0.4 s without. Now 2.5 s cold,
  0.03 s warm.
- **Two episode-naming shapes matched nothing**: `03x02` (43 of E.R.'s files)
  and `s01e01e02` doubles. Neither could be identified in bulk at all.
- **"Changes that didn't take"** — they had taken; the cache added earlier the
  same day was serving the old listing. Three routes changed Jellyfin state
  without invalidating.

**Redesigns:**

- **Library tab** rebuilt as one workspace: rail to find, pane to do, chips
  that carry counts. Replaced five stacked cards, three of which needed their
  own button pressed. Shows are one row; duplicates compare side by side with
  resolution/size/subtitle count.
- **Accolades tab** rebuilt the same way. The finding that shaped it: nine
  sources had scraped 3,324 articles into 187,799 trivia candidates across 330
  films, and **zero had ever been chosen** — because the tab opened on a search
  box. Candidates are now ranked by readability and capped, with a "Surprise
  me" entry point.
- **Worker** got the same shape. **Uploads** and **People** deliberately kept
  their tables (every column is read *across* rows) and gained counted chips.
  **Health** and **Notify** were left alone on purpose.

**Features:** episodes-vs-parts wording from OMDb's `Type` (with a curator
override), revoke-a-person's-access (suspend + sign out everywhere), curator
notes on picks shown on the film page and a new "Picked for you" section,
person-bio expansion, missing-episode markers, pop-out watch-party chat with a
phone QR.

**Config:** `PUBLIC_URL` moved from `watch2.` to `watch.abhigyanverma.com`.
The watchdog outside the repo had the old host hardcoded — that one mattered,
because it decides whether the machine is having an outage and its recovery
ladder ends at a reboot.

---

## Open items

- **Test the backdrop question.** Does re-mapping a film via Search leave the
  *previous* film's backdrop on its page? `backdropUrl()` reads
  `BackdropImageTags` before the poster, and this was observed for real on the
  episode-fetch path. A defensive `clearItemBackdrop()` now runs after
  apply-match either way. See memory note `jellyfin-gate-backdrop-remap-check`.
- **E.R. re-fetch.** 44 files that previously could not parse now can. Open the
  show's settings and run "Fetch all from OMDb" — it skips the 260 already
  done. Watch for OMDb numbering drift on a 15-season show.
- **Viewing metrics are parked**, not cancelled — pending the user talking to
  the friends who use the library, on privacy grounds. Full plan artifact
  linked in memory.
- **~33 GB reclaimable**: Docker Desktop's `docker_data.vhdx` (31.9 GB, dead
  since the 2026-08-27 migration) and the retired `jellyfin-gate-party` image.
  Planned, **not** done — image the drive first.
- **Console latency is fine.** All 15 admin endpoints measured ≤0.4 s warm.
  Two apparent outliers were first-hit route compilation, not real.

---

## Traps hit this session (all now in memory)

- A literal backtick in a **SQL comment** inside `schema.ts`'s big template
  string truncates it. Caught by tsc.
- Writing JS into curator.html through a shell heredoc silently ate one level
  of backslash, turning `\n` inside a `confirm()` string into a real newline
  and breaking the whole script block.
- `.env` is gitignored; **`.env.bak-*` was not.** A backup made before editing
  was swept into a commit by `git add -A`. Caught before any push; the file is
  now at `C:\Users\Dell\jellyfin-gate-backups\` and `.gitignore` covers the
  pattern. Keep secret backups outside the repo in the first place.
- `applyRestrictedPolicy()` hardcoded `IsDisabled: false`, so any policy write
  would have silently un-suspended a revoked account. It now takes `suspended`
  as a **required** argument — forgetting it is a compile error.
