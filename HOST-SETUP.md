# HOST-SETUP — how the HP host is actually set up

What `jellyfin-gate-restore/RESTORE.md (on the media drive)` did not know, written after the
2026-09-23/26 restore onto the HP laptop. Where this and RESTORE.md disagree,
this is current. No secrets in here — only where they live.

## The machine

- HP laptop, Windows 10 Home 22H2, i7-7500U (2c/4t), **8 GB RAM** — the same
  ceiling as the old Dell, so the memory discipline below still matters.
- Virtualisation had to be switched on in the BIOS before WSL2 would start.
- The media drive is **H:** here (it was E: on the Dell). Everything on it —
  `Da Moveesh`, `_Excluded`, `jellyfin-gate-backups`, `jellyfin-gate-restore` —
  is unchanged.

## Never start Jellyfin without H:

If H: is not mounted, Docker creates an empty `/mnt/h/Da Moveesh` and Jellyfin
sees an empty library. A scan could then drop every item — and item ids are
what lists, sessions and screening rooms hang off (see RESTORE.md). Before
unplugging H:

```bash
cd ~/watch && docker compose --env-file .env --env-file .env.wsl-paths stop
cd ~/dev-stack && docker compose -f docker-compose.yml --env-file ../watch/.env --env-file ../watch/.env.wsl-paths stop
sudo umount /mnt/h
```

If Windows still says H: is in use, shut the PC down and unplug it while off.
Bring it back as **H:** — the paths below assume that letter.

## WSL and Docker

- Ubuntu 26.04 under WSL 2.7, **systemd on** (`/etc/wsl.conf`), default user
  `jellyfin`. Docker CE inside it, as before — not Docker Desktop.
- `C:\Users\HP\.wslconfig` is the old host's, verbatim: `memory=4GB`,
  `vmIdleTimeout=-1`, `autoMemoryReclaim=gradual`.
- **Keepalive.** Scheduled task `JellyfinGateWslBoot` runs
  `C:\Users\HP\jellyfin-gate\wsl-keepalive.vbs` (hidden) holding a
  `sleep infinity` in the distro, so the VM never idles out and takes Docker
  with it — which it did, every ~60s, until this existed.
  Its trigger is **at logon**, not at boot: a boot trigger needs admin. After
  an unattended reboot nothing runs until someone signs in to Windows.
- `wsl-mem-reclaim` is back (`/usr/local/bin/wsl-mem-reclaim.sh`, every 5 min
  from `/etc/cron.d/wsl-mem-reclaim`), same rule as the Dell's.
- **Known fault:** after the PC sleeps, WSL's NAT can stop reaching some
  networks (Cloudflare, GitHub, TMDB, Docker Hub) while Windows still can.
  A Windows restart clears it. Check with
  `curl -4 -s -o /dev/null -w '%{http_code}' https://github.com` inside WSL.

## Checkouts

- `~/watch` — the production checkout, on `platform-additions`, exactly what
  is deployed. Compose project name is `watch` (volumes `watch_gate-data`,
  `watch_jellyfin-config`, …), not `jellyfin-gate` as on the Dell.
- `~/watch-dev` — a git worktree for branch work, so a routine rebuild of
  production can never pick up untested code.
- `.env` is the restored one. `.env.wsl-paths` holds this host's overrides:
  media paths on `/mnt/h`, and `COMPOSE_FILE=docker-compose.yml:docker-compose.token.yml:docker-compose.override.yml`.
- `docker-compose.override.yml` (untracked, host-only) puts the compose
  `tunnel` service behind a profile nobody activates — see the tunnel below.

## The Cloudflare tunnel runs on Windows

Scheduled task `JellyfinGateTunnel` runs `cloudflared.exe` natively and hidden,
from `C:\Users\HP\jellyfin-gate\cloudflared-tunnel.vbs`, with `--protocol http2
--edge-ip-version 4` as before. The token is
`C:\Users\HP\jellyfin-gate\cloudflared-token` (user-only ACL); the original is
still on H: in `jellyfin-gate-restore\host\cloudflared\token`.

Why not in WSL or compose: the dashboard's ingress is `http://localhost:3000`,
which inside the compose `edge` network means the tunnel container itself; and
WSL's NAT stopped reaching Cloudflare's edge while Windows could. From Windows,
`localhost:3000` reaches the gate through WSL's localhost forwarding.

Probes, as in RESTORE.md: public 530 = tunnel down, 502 = gate down. The log is
`C:\Users\HP\jellyfin-gate\cloudflared.log`.

## Scheduled jobs (inside WSL)

`/etc/cron.d/jellyfin-gate-backup` (daily 18:30 UTC) and
`/etc/cron.d/jellyfin-gate-weekly` (Sundays 20:00 UTC) run the installed copies
in `/usr/local/bin`. Their paths come from `/etc/default/jellyfin-gate`:

```bash
JFG_REPO=/home/jellyfin/watch
JFG_BACKUP_ROOT=/mnt/h/jellyfin-gate-backups
```

After changing a script in the repo, reinstall it:

```bash
sudo install -m 0755 scripts/backup-cron.sh /usr/local/bin/jellyfin-gate-backup.sh
sudo install -m 0755 scripts/backup-to-e.sh /usr/local/bin/backup-to-e.sh
sudo install -m 0755 scripts/weekly-maintenance.sh /usr/local/bin/jellyfin-gate-weekly.sh
```

The watchdog is deliberately **not** restored (RESTORE.md's warning stands).

## Curator console on the home network

`scripts/console-server.mjs` runs as container `jellyfin-gate-console`
(`--restart unless-stopped`) from `~/console-server/`, serving
`~/watch/curator.html` on port 3200 and adding the admin key server-side.

- Sign-in links: `C:\Users\HP\jellyfin-gate\console-url.txt`. The token and a
  copy of the admin key are in `~/console-server/console.env` (mode 600).
- Other devices reach it through a Windows portproxy on the Wi-Fi address plus
  a firewall rule limited to Private networks and the local subnet —
  `open-console-on-wifi.ps1` / `close-console-on-wifi.ps1` in
  `C:\Users\HP\jellyfin-gate\`, run as admin. The Wi-Fi address (192.168.1.9)
  is DHCP; if it changes, re-run both with the new one.
- Never on the internet: the tunnel points only at port 3000.
- To sign every device out, put a new `CONSOLE_TOKEN` in `console.env` and
  `docker restart jellyfin-gate-console`.

## Dev copy and phone testing

`~/dev-stack/docker-compose.yml` runs `jellyfin-gate-dev` (port 3100) and
`jellyfin-gate-worker-dev` from images built out of `~/watch-dev`, sharing
production's Jellyfin but with **their own database volume**
(`watch-dev_gate-data`, seeded from a VACUUM INTO snapshot) and **media mounted
read-only**. Always pass `-f docker-compose.yml`: production's `COMPOSE_FILE`
otherwise leaks in.

Phone, over USB — no LAN exposure, no admin:

```powershell
$adb = "$env:USERPROFILE\platform-tools\adb.exe"
& $adb install -r "$env:USERPROFILE\watch-dev-apk\watch-dev-1.5.apk"   # -r keeps login and downloads
& $adb reverse tcp:3100 tcp:3100
```

Build the dev APK (installs beside the real app as "Watch dev"):

```bash
DEV_SERVER_URL=http://localhost:3100 bash apps/mobile/build-apk.sh      # --apk-only to skip icons/sync
```

Debug builds are WebView-inspectable: forward
`localabstract:webview_devtools_remote_<pid>` to a local port and use the
DevTools protocol.

## Quoting traps on this host

Claude Code's Bash tool is Git Bash, and its PowerShell is 5.1:

- Anything non-trivial for WSL goes in a script file, run with
  `wsl -d Ubuntu -- bash /mnt/c/.../script.sh` — inline `$( )` and nested
  quotes get mangled on the way in.
- Prefix Git Bash commands that pass `/paths` or `-v a:b` to Windows programs
  with `MSYS_NO_PATHCONV=1`.
- Never mount anything at `/lib` in a container: it hides the system's own.
