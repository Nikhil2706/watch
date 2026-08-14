# jellyfin-gate

Invite-only authentication gateway in front of a self-hosted Jellyfin server.

Jellyfin stays the identity source of truth. This app stores no passwords: it
creates real Jellyfin accounts, proxies credentials to Jellyfin at login, and
holds the resulting access token server-side, keyed to an opaque session id. The
browser only ever sees that session id, in an httpOnly cookie.

---

## curl cookbook

Everything below is a real, runnable command. Set these two once per shell:

```bash
export GATE=https://watch.example.com
export ADMIN_KEY=paste-your-ADMIN_API_KEY-here
```

On Windows PowerShell, use `$env:GATE = "https://watch.example.com"` and
`curl.exe` rather than `curl` — PowerShell aliases `curl` to `Invoke-WebRequest`,
which does not understand these flags.

### Create an invite

Single use, expires in 7 days (the defaults):

```bash
curl -s -X POST "$GATE/api/admin/invites" -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"label":"alice"}'
```

```json
{
  "id": "81b0b859-dcb1-405f-be07-53e59fe80937",
  "token": "owsycqjLpc2uXisGL3GWss26kkiXUJqku2hpnO82l9A",
  "url": "https://watch.example.com/invite/owsycqjLpc2uXisGL3GWss26kkiXUJqku2hpnO82l9A",
  "label": "alice",
  "max_uses": 1,
  "expires_at": "2026-08-16T16:11:25.233Z",
  "note": "Save the url now. The token is hashed on storage and cannot be shown again."
}
```

Copy `url` straight into the chat window. **This is the only time the token is
shown.** Only its SHA-256 hash is stored, so if you lose the link you issue a new
invite — there is no recovery path, by design.

Three uses, valid for a fortnight:

```bash
curl -s -X POST "$GATE/api/admin/invites" -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"label":"housemates","max_uses":3,"expires_in_days":14}'
```

Just the pasteable link, nothing else:

```bash
curl -s -X POST "$GATE/api/admin/invites" -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"label":"bob"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).url'
```

### List invites

```bash
curl -s "$GATE/api/admin/invites" -H "X-Admin-Key: $ADMIN_KEY"
```

```json
{
  "invites": [
    {
      "id": "81b0b859-dcb1-405f-be07-53e59fe80937",
      "label": "alice",
      "max_uses": 1,
      "use_count": 1,
      "remaining_uses": 0,
      "created_at": "2026-08-09T16:11:25.233Z",
      "expires_at": "2026-08-16T16:11:25.233Z",
      "revoked_at": null,
      "status": "exhausted",
      "redeemed_usernames": ["alice"]
    }
  ],
  "count": 1
}
```

`status` is one of `active`, `revoked`, `expired`, `exhausted`.

A readable table, one line per invite:

```bash
curl -s "$GATE/api/admin/invites" -H "X-Admin-Key: $ADMIN_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).invites.map(i=>[i.status.padEnd(10),(i.label||"-").padEnd(16),i.use_count+"/"+i.max_uses,i.expires_at.slice(0,10),i.redeemed_usernames.join(",")||"-",i.id].join("  ")).join("\n")'
```

Only the ones still usable:

```bash
curl -s "$GATE/api/admin/invites" -H "X-Admin-Key: $ADMIN_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).invites.filter(i=>i.status==="active").map(i=>i.id+"  "+(i.label||"-")).join("\n")'
```

### Revoke an invite

Take the `id` from the listing (not the token — you no longer have it):

```bash
curl -s -X DELETE "$GATE/api/admin/invites/81b0b859-dcb1-405f-be07-53e59fe80937" -H "X-Admin-Key: $ADMIN_KEY"
```

```json
{ "id": "81b0b859-dcb1-405f-be07-53e59fe80937", "revoked": true }
```

Idempotent — revoking twice is still a 200. An unknown id is a 404. Revoking
marks the row rather than deleting it, so `redeemed_usernames` still tells you
who came in through it afterwards.

Revoking does **not** disable accounts already created from that invite. To
remove someone, delete their user in the Jellyfin dashboard and revoke their
sessions below.

### Revoke a session

List sessions to find the id:

```bash
curl -s "$GATE/api/admin/sessions" -H "X-Admin-Key: $ADMIN_KEY"
```

```json
{
  "sessions": [
    {
      "id": "gTiXwv2sm5Lp8hK3nQeR4uYbA1cZdF6oJ0vN7xW9tPk",
      "username": "alice",
      "user_id": "b2c4e6a8-1f3d-4b5c-9e7a-0d8f6c4b2a1e",
      "created_at": "2026-08-09T16:12:12.269Z",
      "expires_at": "2026-09-08T16:12:12.269Z",
      "ip": "203.0.113.42",
      "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
    }
  ],
  "count": 1
}
```

Kill it:

```bash
curl -s -X DELETE "$GATE/api/admin/sessions/gTiXwv2sm5Lp8hK3nQeR4uYbA1cZdF6oJ0vN7xW9tPk" -H "X-Admin-Key: $ADMIN_KEY"
```

```json
{ "id": "gTiXwv2sm5Lp8hK3nQeR4uYbA1cZdF6oJ0vN7xW9tPk", "revoked": true, "jellyfin_token_invalidated": true }
```

Effective on the very next request — no waiting for an expiry. This is why
sessions are database rows and not JWTs. `jellyfin_token_invalidated` reports
whether Jellyfin also accepted the upstream logout; `false` means the local
session is dead but Jellyfin was unreachable, so retry once it is back if you
care about killing the token upstream too.

Revoke every session for one person:

```bash
curl -s "$GATE/api/admin/sessions" -H "X-Admin-Key: $ADMIN_KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sessions.filter(s=>s.username==="alice").map(s=>s.id).join("\n")' | xargs -I{} curl -s -X DELETE "$GATE/api/admin/sessions/{}" -H "X-Admin-Key: $ADMIN_KEY"
```

### Check it is alive

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$GATE/login"
```

`200` means the app is up. `502` from a login attempt means the app is up but
Jellyfin is not.

---

## What this app does

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/admin/invites` | `X-Admin-Key` | Create an invite, returns the link once |
| `GET /api/admin/invites` | `X-Admin-Key` | List invites with use counts |
| `DELETE /api/admin/invites/:id` | `X-Admin-Key` | Revoke an invite |
| `GET /api/admin/sessions` | `X-Admin-Key` | List live sessions |
| `DELETE /api/admin/sessions/:id` | `X-Admin-Key` | Revoke a session immediately |
| `GET /invite/<token>` | none | Redemption page |
| `POST /api/invite/redeem` | none, rate limited | Create the Jellyfin account, sign in |
| `POST /api/auth/login` | none, rate limited | Sign in against Jellyfin |
| `POST /api/auth/logout` | session | Destroy session, log out of Jellyfin |
| `GET /` | session | Authenticated placeholder |
| `/jf/*` | session | Authenticated proxy to Jellyfin |

`/api/admin/*` is authenticated **only** by the `X-Admin-Key` header, compared in
constant time, and is excluded from the session middleware entirely.

### Not included, deliberately

No admin UI, no email, no OAuth, no password reset, no media browsing UI, no
player. Reset passwords in Jellyfin's own dashboard.

---

## Security model

**The Jellyfin token never reaches the browser.** It is written to the session
row at login and attached inside `/jf/*` server-side. If client-side JavaScript
could read it, a user could talk to Jellyfin directly and this app's deny-list,
rate limits and revocation would all become optional. The browser holds only a
43-character opaque session id in an httpOnly cookie.

**The real authorisation boundary is the Jellyfin user policy**, applied at
redemption: `IsAdministrator: false`, no live TV, no downloads, no content
deletion, no sync transcoding. Jellyfin enforces this itself on every request.
The `/jf/*` deny-list is a second layer on top — a path list can never be
complete across Jellyfin versions, so it must not be the only thing in the way.
It blocks the routes that would be catastrophic, including
`/Users/AuthenticateByName` and `/Auth/Keys`, either of which would let a user
mint their own Jellyfin credential and walk around this app entirely.

**Sessions are revocable rows, not JWTs.** A JWT cannot be withdrawn before it
expires, and would have to carry the Jellyfin token to the browser to be useful.

### Jellyfin streams video anonymously — bind it to loopback

**This is the most important operational fact in this document.** Verified
against Jellyfin 10.11.11:

```
curl -r 0-1000 "http://<jellyfin>:8096/Videos/<itemId>/stream?static=true"
→ 206 Partial Content, real video bytes, no token, no session, no credential
```

`/Videos/{id}/stream` and `/Items/{id}/Images/*` are anonymous endpoints.
Jellyfin does this on purpose, to support players that cannot attach auth
headers, but it means **the item id is the only thing standing between an
anonymous request and the file**. The catalogue endpoints (`/Items`, `/Users`,
`/System/Info`) do require a token — so an attacker cannot browse — but every
signed-in user already knows the ids of everything they can see, and ids travel
in URLs, logs and `Referer` headers.

What this means for this app:

- A user whose session you revoke can still stream anything whose id they wrote
  down — **if** they can reach Jellyfin's port. Revocation cuts off discovery
  and the API; it cannot cut off a direct hit on a known id.
- Therefore the port binding is not hardening. It is the control.

Jellyfin binds to `0.0.0.0:8096` by default, which on a home network means
every device in the house can stream the entire library with no credential.
Fix it in `network.xml` (Dashboard → Networking → LAN networks):

```xml
<LocalNetworkAddresses>
  <string>127.0.0.1</string>
</LocalNetworkAddresses>
<AutoDiscovery>false</AutoDiscovery>
```

Then confirm from another machine that it is actually shut:

```bash
curl --max-time 6 -r 0-1000 "http://<lan-ip>:8096/Videos/<itemId>/stream?static=true"
```

A connection refused is the correct answer. Anything else means the bypass is
open. Block 8096 at the host firewall too, and never port-forward it.

**The database file is as sensitive as a password store.** `sessions.jellyfin_token`
holds live bearer credentials for Jellyfin. Keep `data/` off any shared drive and
out of any backup that leaves the machine unencrypted. Invite tokens are stored
only as SHA-256 hashes, so a stolen database yields no usable invite links.

**Constant-time comparison** guards `ADMIN_API_KEY` (`src/lib/crypto.ts`). A
plain `===` returns as soon as it hits a differing byte, and that timing
difference is measurable over a network.

**CSRF**: the session cookie is `SameSite=Lax`, which stops cross-site POSTs from
carrying it. The admin routes need a custom header a browser will never attach
on its own.

### One thing to get right before going live

`TRUST_CF_CONNECTING_IP` defaults to `false`. Only turn it on once the app
genuinely cannot be reached except through Cloudflare. `CF-Connecting-IP` is an
ordinary request header — if anything can reach the origin directly, it can
forge a new value per request, get a fresh rate-limit bucket every time, and the
login limiter effectively stops existing. Bind `next start` to `127.0.0.1` and
let cloudflared be the only route in.

Note also that Next route handlers do not expose the raw socket address, so with
this flag off the limiter falls back to `X-Forwarded-For` / `X-Real-IP` and
finally to a single shared `unknown` bucket. That fails closed — unattributable
traffic is limited collectively rather than exempted.

---

## Setup

Requires **Node 22.13 or newer** (for unflagged `node:sqlite`) and a running
Jellyfin.

```bash
npm install
cp .env.example .env
```

Generate the admin key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Get a Jellyfin API key from **Dashboard → Advanced → API Keys → +**. Name it
`jellyfin-gate` so it can be revoked on its own. Put both in `.env` along with
`PUBLIC_URL`.

```bash
npm run build
npm start
```

The schema is created on boot if the database file is absent, so there is no
migration step to remember. `npm run db:init` does the same thing standalone —
useful for checking the path is writable before installing the service.

The `ExperimentalWarning: SQLite is an experimental feature` line on startup is
expected and harmless. Silence it with
`NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

### Dependencies

Next.js, React, and one 0-byte package: [`server-only`](https://www.npmjs.com/package/server-only),
which turns "this secret-handling module got imported into a client component"
from a silent token leak into a build error. Everything else — SQLite, hashing,
random tokens, constant-time comparison, HTTP — is a Node built-in.

`node:sqlite` rather than `better-sqlite3` specifically so that a Windows host
needs no Visual Studio C++ build tools.

---

## Going live on a public hostname

```bash
cloudflared tunnel login                        # you must do this — opens a browser
scripts/go-live.sh watch.example.com
```

The first command uses your Cloudflare login and picks the zone, so it is yours
to run; the script refuses to do anything until `~/.cloudflared/cert.pem`
exists. The second creates the tunnel, adds the DNS record, writes the tunnel
config, flips the app to production settings and restarts it. It is re-runnable.

The three settings it changes are the ones that are easy to forget and quietly
dangerous to leave wrong:

| | dev | live | why |
| --- | --- | --- | --- |
| `COOKIE_SECURE` | false | **true** | otherwise session cookies travel in cleartext |
| `TRUST_CF_CONNECTING_IP` | false | **true** | otherwise rate limiting buckets every visitor as one client |
| `GATE_BIND` | 0.0.0.0 | **127.0.0.1** | otherwise the app stays open on the LAN as well |

`TRUST_CF_CONNECTING_IP` is only safe once the tunnel is the sole route in —
which is exactly what `GATE_BIND=127.0.0.1` guarantees. Set it without that and
anyone who can reach the origin directly can forge the header and get a fresh
rate-limit bucket per request.

The tunnel runs as an ordinary compose service — it starts with `docker compose
up -d` like everything else — and reaches the gateway at `http://gate:3000` over
the compose network, not via the host. That is why nothing needs to be published
at all in production. To bring the stack up without exposing it, use
`docker compose up -d --scale tunnel=0`.

### If the tunnel will not connect

Four separate things broke on first deployment. All are in the compose file now,
but the symptoms are worth recognising because none of them says what is wrong.

**"requires the ID or name of the tunnel"** — cloudflared could not read its
config. The official image sets **no `HOME` environment variable**, so `~` does
not expand and `~/.cloudflared/config.yml` is never found. The mount goes to
`/etc/cloudflared`, which is in its default search path regardless.

**Same error, config mounted correctly** — a permissions problem wearing the
same mask. `~/.cloudflared` is `0700` and its credentials `0600`, owned by you;
the image runs as uid **65532**, which cannot even traverse the directory. Hence
`user: "${CF_UID}:${CF_GID}"`. The image is distroless, so there is no shell to
go and look with — `docker inspect` and reasoning about uids is the whole
toolkit.

**QUIC handshake timeouts** — cloudflared prefers QUIC over UDP/7844, which
plenty of consumer ISPs drop. Here TCP/7844 connected fine while every QUIC
handshake timed out. `--protocol http2` uses TCP instead.

**`i/o timeout` on one edge range** — the edge has two regions, and this
network reaches only one of them at a time. Measured an hour apart: `region1`
(`198.41.192.x`) 0/10 reachable with `region2` (`198.41.200.x`) 10/10, then the
exact inverse. All IPv6 edge addresses fail throughout, so `--edge-ip-version 4`
is worth setting.

Do **not** try to pin the working region with `--edge`. Two reasons: the
reachable half flips, so any pinned list eventually points at dead addresses;
and cloudflared's startup precheck resolves the whole `--edge` value as a single
hostname, so both `a:7844,b:7844` and repeated `--edge` flags abort with
"failed to resolve any edge address" before connecting at all.

To tell these apart quickly, probe the edge directly rather than reading
cloudflared's retry spam:

```bash
docker run --rm --network jellyfin-gate_edge node:22-alpine sh -c \
  'for ip in $(nslookup region2.v2.argotunnel.com | awk "/^Address: /{print \$2}"); do
     nc -z -w5 $ip 7844 && echo "$ip open" || echo "$ip blocked"; done'
```

A healthy start logs `Registered tunnel connection ... location=bom12`.

Before handing the URL to anyone:

- **Rotate anything that has been on a screen.** `ADMIN_API_KEY`, the Jellyfin
  API key, the Jellyfin admin password. Regenerate the admin key with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
  put it in `.env`, and `docker compose up -d --force-recreate gate`.
- **Delete test accounts** in Jellyfin's dashboard. Any account created while
  testing has a password someone else has seen.
- Remember Cloudflare's terms discourage serving large volumes of video through
  their proxy. Widely done at this scale; just know it is there.

## Running it with Docker

```bash
cp .env.example .env          # fill in ADMIN_API_KEY and PUBLIC_URL
export MEDIA_PATH=/path/to/movies

docker compose up -d jellyfin

# The bootstrap runs INSIDE the compose network, because the jellyfin service
# publishes no port for the host to talk to — that is the whole point of it.
# This also means the host needs no Node installed: the worker image has one.
docker compose run --rm --no-deps --entrypoint node \
  -v "$PWD/scripts:/s:ro" worker \
  /s/bootstrap-jellyfin.mjs --url http://jellyfin:8096 \
  --admin mamnani --password 'a-long-password' --media /media
# paste the printed JELLYFIN_API_KEY into .env

docker compose up -d --build gate
```

A fresh Jellyfin refuses every API call until its setup wizard is done, so
`docker compose up` alone leaves a server you cannot use. `bootstrap-jellyfin.mjs`
performs the wizard, creates the movie library and mints the gateway's API key,
so rebuilding from empty volumes is repeatable. It is idempotent — rerunning it
reuses the existing user, library and key.

The wizard has one non-obvious ordering requirement, which is why the script
exists at all: `GET /Startup/User` must be called before `POST /Startup/User`,
because the POST *updates* the default first user that the GET materialises.
Posting first returns 404 and leaves you with a "completed" wizard and no
accounts.

### The important line in docker-compose.yml is one that isn't there

The `jellyfin` service publishes **no ports**. Given that Jellyfin streams video
to anyone who asks (see below), that is what closes the bypass — structurally,
rather than through a config setting somebody can forget. Jellyfin sits on an
`internal: true` network reachable only by the gate container; only the gate
publishes a port.

Do not add a `ports:` mapping to the jellyfin service. If you need its
dashboard, use an SSH tunnel or `docker compose exec`.

### Testing from another device on your network

Set these in `.env`:

```
PUBLIC_URL=http://192.168.1.20:3000
COOKIE_SECURE=false
```

`COOKIE_SECURE=false` is required and is the thing people lose an hour to:
browsers silently discard `Secure` cookies over plain http, so login appears to
succeed and the next request looks logged out. **Set it back to `true` before
this ever faces the internet** — the app logs a warning on every boot while it
is off.

Then open `http://192.168.1.20:3000` on the phone. Confirm the gateway is the
only way in:

```bash
curl --max-time 6 http://192.168.1.20:8096/System/Info/Public
```

Connection refused is the correct answer.

## The browsing UI

Jellyfin remains the organisation layer — this app renders what Jellyfin already
knows rather than maintaining its own metadata.

| Route | What it shows |
| --- | --- |
| `/` | Hero, Continue Watching, Recently Added, one row per genre |
| `/browse` | Full catalogue as a grid, filterable by genre |
| `/item/:id` | Backdrop, overview, cast, container/size/audio/subtitle facts |
| `/watch/:id` | Player |
| `/search?q=` | Title search |

Rows come from Jellyfin's own endpoints (`/UserItems/Resume`, `/Items/Latest`,
`/Genres`). Artwork is requested through `/jf/*` with Jellyfin's image `tag` in
the URL, so posters are cacheable by the browser but still require a session.

Pages are server components that read from Jellyfin with the session's token
directly, skipping the proxy — server-side rendering has no need to hide a
token from itself, and it saves a hop per render. Only the browser's own
requests (artwork, video, progress reports) go through `/jf/*`.

### Playback

`PlaybackInfo` decides, using a deliberately conservative browser profile:

- **Direct play** for H.264 + AAC in MP4. The original file is streamed
  byte-for-byte and the `<video>` element does its own Range requests. No
  transcoding, so no CPU cost.
- **HLS** for anything else — MKV containers and HEVC in particular. Safari
  plays that natively; other browsers get `hls.js`, dynamically imported so it
  is only downloaded when a title actually needs it.

Progress is reported to `/jf/Sessions/Playing*`, which is what keeps Jellyfin's
Continue Watching accurate, and tells it to stop transcoding when you navigate
away.

### Transcoding performance, and why you should avoid it

There is no pre-transcode step. Jellyfin transcodes on demand — per viewer, from
scratch, and again on every seek. That makes the cost of a transcode the single
biggest performance factor in this app.

**The transcode ladder is capped at 1080p / 8 Mbps** in `BROWSER_PROFILE`
(`src/lib/media.ts`). This matters more than it sounds. Without the
`CodecProfiles` conditions, Jellyfin builds a `scale=` filter bounded by the
*source* dimensions — a no-op — and re-encodes a 4K file at 4K. Measured on a
16-thread i5-1240P transcoding a 3840×1920 HEVC 10-bit source:

| | speed |
| --- | --- |
| Re-encoding at full 3840×1920 | **1.77× realtime** — stalls after any seek |
| Capped to 1920×960 | **2.3–3.3× realtime** — comfortable |

Anything under 1× realtime buffers forever. On the i3-6100 this is actually
deployed to — four threads, and Skylake has no hardware decode for 10-bit HEVC
at all — a 4K HEVC source lands well under 1× no matter what you configure.

**Hardware acceleration** is off by default in Jellyfin (Dashboard → Playback).
Turning it on is worth roughly 2.5× on the encode side; measured here,
software-decode + VAAPI-encode ran at 2.79× against 1.06× for libx264 under
identical settings. Two caveats:

- A distro ffmpeg often cannot do it. Ubuntu 22.04's ffmpeg 4.4 failed both QSV
  (`Error initializing an MFX session`, missing Intel runtime) and VAAPI 10-bit
  HEVC decode on a 12th-gen chip. **The Docker image solves this** — the
  official `jellyfin/jellyfin` image ships its own `jellyfin-ffmpeg` with
  working QSV/VAAPI, which is why `docker-compose.yml` passes `/dev/dri`
  through.
- It accelerates *encoding*. Decoding 10-bit HEVC stays on the CPU on anything
  older than Kaby Lake, so on the i3-6100 hardware acceleration does not rescue
  these files.

**So pre-convert them instead.** One command, once:

```bash
scripts/pretranscode.sh /path/to/movies          # dry run
scripts/pretranscode.sh /path/to/movies --write  # convert
```

It converts only what a browser cannot play, to 1080p H.264 + AAC in MP4, using
hardware encoding when available. Originals are never modified — output lands
beside them as `<name> [1080p].mp4`. On a real 15 GB library of three 4K HEVC
films that is about 5 GB out.

After that those titles direct-play: the server does no work beyond reading
bytes off disk, seeking is instant, and several people can watch at once. That
is the difference between a media server that works on an i3 and one that
doesn't.

## Watch folder: automatic ingest

Drop a file in, and it appears in the catalogue — converted first if a browser
could not have played it.

```bash
node scripts/media-worker.mjs        # or: docker compose up -d worker
cp ~/Downloads/"Some Film 2021.mkv" "$MEDIA_INCOMING"/
```

While it converts, viewers see the title on the home page as a dimmed,
non-clickable card reading *Converting — 43% · 2.6× realtime*. It becomes a real
poster once the file lands in the library and Jellyfin has scanned it.

### Three directories, and why they must be three

```
MEDIA_INCOMING              drop zone      — Jellyfin never looks here
MEDIA_LIBRARY               published      — the only path Jellyfin indexes
$MEDIA_INCOMING/.processed  originals kept — never deleted
```

This separation is not tidiness. **Jellyfin indexes a converted file sitting
beside its source as a second movie with the same name, not as another version
of it.** Verified: dropping `Catwoman … [1080p].mp4` next to `Catwoman … .mkv`
produced two separate "Catwoman: Hunted" entries in the catalogue. Keeping
originals outside the library is what makes pre-transcoding safe.

Originals are moved to `.processed/`, never deleted. If a conversion turns out
badly you still have the source.

### What it does per file

1. **Waits for the file to stop growing** — two consecutive polls at the same
   size. Without this it would happily start transcoding a half-finished copy.
2. **Probes it.** Already H.264 in MP4 at ≤1080p? Moved straight across, no
   re-encode. Only the files that need work cost CPU.
3. **Converts** to 1080p H.264 + AAC, hardware-encoded if `/dev/dri` is usable.
4. **Publishes** as `Title (Year).mp4` — Jellyfin's preferred naming — carrying
   any `.srt` sidecars with it, then triggers a library rescan.

One conversion runs at a time. Two parallel ffmpeg jobs on a four-thread box
finish later than the same two run in sequence, and starve anyone actually
watching.

Anything left `running` when the worker restarts is re-queued, so a card cannot
sit at 40% forever after a crash.

### Watching the queue

```bash
curl -s "$GATE/api/admin/jobs" -H "X-Admin-Key: $ADMIN_KEY"
```

```json
{
  "jobs": [
    { "title": "Barbie (2023)", "status": "running", "progress": 17, "speed": 2.6,
      "size_in_gb": 5.47, "size_out_gb": null, "error": null }
  ],
  "by_status": { "running": 1, "done": 4, "skipped": 2 }
}
```

`skipped` means "already playable, moved without re-encoding" — the good
outcome, not a problem. Failures appear here with their ffmpeg error and are
deliberately never shown to viewers: a failed conversion is an operator problem.

## Deployment topology

The Windows box is not on the same network as whoever administers DNS. It sits
at a friend's house, on their power and their uplink. That constrains the design
more than it first appears.

```
viewers ──▶ Cloudflare edge ──▶ cloudflared ──▶ jellyfin-gate ──▶ Jellyfin
                  │                        (one Windows box, loopback)
                  └── Worker: maintenance page when the box is unreachable
```

**Everything runs on the one Windows box.** The app talks to Jellyfin over
loopback. This is not just convenience — the app is a streaming proxy, so any
hop between it and Jellyfin is paid twice for every byte of video. Putting a
relay in another building would mean each stream crosses the internet twice and
burns the relay's uplink, which is the scarce direction on a home connection.
Keep them adjacent.

**Ingress is `cloudflared` on that box.** Outbound-only, so no port forwarding
and no static IP, and it works behind CGNAT. It registers against your
Cloudflare account, so DNS stays under your control even though the hardware
is not.

Once cloudflared is the only route in, set `TRUST_CF_CONNECTING_IP=true` and
bind with `-H 127.0.0.1`. Those two go together: the header is only trustworthy
when nothing can reach the origin directly.

### Who holds the admin key

`ADMIN_API_KEY` and the Jellyfin API key both live on the Windows box, so
whoever runs that machine is the administrator — they issue invites with the
cookbook above and reset passwords in Jellyfin's own dashboard.

Worth knowing: it is a single shared static secret, not a per-person login.
There is no audit trail distinguishing one holder from another. If two people
need to issue invites, they share the key; if that stops being acceptable,
rotate it and restart the service.

Jellyfin's dashboard is deliberately unreachable through this app — `/web`,
`/dashboard` and `/System/*` are all on the proxy deny-list. Administration
happens on the box itself, at `http://127.0.0.1:8096/web`, or over a private
link such as Tailscale. Do not expose port 8096 to get around this.

### Maintenance page when the box is down

If the Windows box is off, rebooting, or has lost its connection, nothing on it
can answer — so the fallback cannot live there either. `deploy/maintenance-worker.js`
is a Cloudflare Worker that runs at the edge and substitutes a plain "be right
back" page for Cloudflare's raw 522/530 error.

```bash
npx wrangler deploy deploy/maintenance-worker.js --name watch-maintenance
```

Then add Worker routes for **only** the page URLs:

```
watch.<domain>/
watch.<domain>/login*
watch.<domain>/invite/*
```

Not `watch.<domain>/*`. Streaming through `/jf/*` issues a great many Range
requests, and routing those through a Worker would consume the free tier's
daily request budget to no purpose — a failed XHR does not need styled HTML,
and by the time one fires the viewer has already been shown this page by the
route that served their tab.

The Worker passes 4xx and 500 straight through untouched. An application bug
should surface as an application bug, not be disguised as scheduled
maintenance. It answers with `503` and `Retry-After`, so uptime monitors report
the outage honestly rather than seeing a cheerful `200`.

Edit the `CONFIG` block at the top to change the wording. Setting
`fallbackOrigin` there makes the Worker try a second origin — a Pi serving a
status page, say — before falling back to the built-in page. That box is only
contacted after the primary has already failed, and the Worker only runs on the
page routes, so it never lands in the media path.

## Deploying to the Windows box

The whole stack runs in Docker Desktop — Jellyfin, the gateway, the ingest
worker and the tunnel. Nothing is installed natively, which is what makes the
Linux laptop and the Windows box run the same four containers from the same
compose file.

Two things in that file are not portable, and both live outside it: GPU
passthrough (`docker-compose.linux.yml`, unused here) and the cloudflared
credentials path (`CF_CREDS_DIR` in `.env`).

### Prerequisites

- **Windows 11** with virtualisation enabled in the BIOS.
- **WSL2.** `wsl --install` from an elevated PowerShell, then reboot.
- **Docker Desktop**, WSL2 backend. In Settings → General tick *Start Docker
  Desktop when you log in*, and in Settings → Resources give WSL at least 4 GB
  and half the cores — ffmpeg will use everything it is given.
- **Git for Windows.** The repo carries a `.gitattributes` that forces LF, so
  the default `core.autocrlf=true` will not corrupt the shell scripts or `.env`.
- **cloudflared for Windows**, from the Cloudflare downloads page. Only needed
  once, to mint credentials; the running tunnel is a container.

No Node.js. The bootstrap runs inside the worker image.

### Steps

Run everything in **PowerShell**, from the repo root. Two phases: get it
working on the local network first, then put it on the internet.

---

### Phase 1 — running on the LAN

```powershell
git clone git@github.com:abhigyanverma/watch.git jellyfin-gate
cd jellyfin-gate
```

**1. Point at the films.** There is no copying step. Docker Desktop's WSL2
backend bind-mounts a Windows path straight into the container, so a collection
that already exists stays exactly where it is — you name it in `.env`.

Use the `//<drive-letter>/...` form, not `E:/...` or `E:\\...`:

```ini
MEDIA_PATH=//e/Films          # wherever they already live
MEDIA_INCOMING=//e/Media/incoming
```

This is not a style preference. A drive-letter path has a colon in it, and
compose bind-mount syntax is itself `source:target:mode` — colon-delimited. A
newer Compose build recognises `C:\` (backslash) as Windows and special-cases
it, but plenty of installs still hit a parser that does not, splits on every
colon it sees, and fails with exactly this:

```
Error response from daemon: invalid volume specification: 'E:/Films:/media:ro'
```

`//e/Films` has no colon anywhere in it, so there is nothing for any version of
the parser to trip over. Slashes, not backslashes — a real Windows path here
resolves one level too high, into the whole `E:\` drive.

The drop zone must sit **outside** the library. Jellyfin indexes a converted
file beside its source as a second movie with the same name, not another
version of it. Anywhere else, on any drive, is fine.

```powershell
mkdir E:\Media\incoming
```

(`mkdir` here takes an ordinary Windows path — it is PowerShell, not a compose
value. The `//e/...` rule above applies only inside `.env` and compose files.)

> **Set `LIBRARY_SCAN=false` before the first start if you are pointing at a
> collection that already exists.**
>
> The default is `true`, which makes the worker walk the entire library, probe
> every file, convert anything a browser cannot direct-play, and **move each
> original out to `MEDIA_ARCHIVE`**. Nothing is deleted, but on a large
> collection it will re-encode for weeks at software speed and relocate the
> lot — and when the archive is on another drive, each move is a full copy of a
> multi-gigabyte file.
>
> With the scan off, the library is served exactly as it is, and only new drops
> into `MEDIA_INCOMING` are converted. Turn it on later, deliberately, once you
> know what it would touch.

If the films are spread across several folders, mount each one under `/media`
instead of trying to make `MEDIA_PATH` cover them all. Put this in
`docker-compose.override.yml`, which compose picks up on its own:

```yaml
services:
  jellyfin:
    volumes:
      - //e/Films:/media/films:ro
      - //f/Archive/Cinema:/media/cinema:ro
  worker:
    volumes:
      - //e/Films:/media/films
      - //f/Archive/Cinema:/media/cinema
```

Jellyfin's library still points at `/media`, so the two appear as one catalogue.

**2. Write `.env`.** Copy `.env.example`. Start in **LAN mode** — get the stack
working on the local network before anything is exposed publicly, so that when
something breaks you know whether it is the app or the tunnel.

```ini
ADMIN_API_KEY=<64 random hex characters, kept by Mamnani>
PUBLIC_URL=http://192.168.1.50:3000     # this box's LAN address
COOKIE_SECURE=false                     # no HTTPS yet
TRUST_CF_CONNECTING_IP=false            # no Cloudflare in front yet
GATE_BIND=0.0.0.0                       # reachable from other devices

MEDIA_PATH=//e/Films
MEDIA_INCOMING=//e/Media/incoming
LIBRARY_SCAN=false

OMDB_API_KEY=<optional>
```

`COOKIE_SECURE=false` is required here: a `Secure` cookie is discarded by the
browser over plain HTTP, so with it on you would log in successfully and land
back on the login page forever. `TRUST_CF_CONNECTING_IP=false` matters just as
much — with `GATE_BIND=0.0.0.0` anyone on the LAN could otherwise forge the
header and get a fresh rate-limit bucket per request.

Find the LAN address with `ipconfig` (the IPv4 address of the active adapter).

**3. Start Jellyfin and run the bootstrap.**

```powershell
docker compose up -d jellyfin

docker compose run --rm --no-deps --entrypoint node `
  -v "${PWD}/scripts:/s:ro" worker `
  /s/bootstrap-jellyfin.mjs --url http://jellyfin:8096 `
  --admin mamnani --password '<a long password>' --media /media
```

Paste the printed `JELLYFIN_API_KEY` into `.env`.

**4. Bring up the app, without the tunnel.**

```powershell
docker compose up -d --build --scale tunnel=0
docker compose ps
```

`--scale tunnel=0` is how you skip a service that is part of the stack.

**5. Test it on the LAN.** From the box itself, then from a phone on the same
Wi-Fi:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:3000/login
```

Then open `http://192.168.1.50:3000` on the phone. Mint yourself an invite with
the admin key (see the curl cookbook at the top of this README), redeem it,
and play something. **Do not go further until a film plays from another
device.** Everything after this is networking; if playback is broken now, the
tunnel will only make it harder to see why.

---

### Phase 2 — going public, without logging in on that box

Cloudflare has two kinds of tunnel. The one this project used first is
*locally-managed*: `cloudflared tunnel login` opens a browser, drops a
certificate on the machine, and the routing lives in a `config.yml` you write
by hand. That means signing into a Cloudflare account on somebody else's
computer and leaving a credential there.

The other kind is *remotely-managed*, and it is the better fit here. You create
the tunnel in **your** dashboard, in **your** browser, and all that machine ever
receives is a connector token. No login, no certificate, no config file — the
ingress rules live in the dashboard where you can change them without touching
his box.

**6. Create the tunnel — on your own machine.**

1. **Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel**
2. Choose **Cloudflared**, name it something like `watch-mamnani`, save.
3. The install instructions that appear contain the token — the long
   `eyJ...` string after `--token`. Copy that; it is the only part you need.
4. Open the tunnel's **Public Hostname** tab and add:
   - Subdomain `watch`, domain `abhigyanverma.com`
   - Type **HTTP**, URL **`gate:3000`**

   `gate` is the service name on the compose network, which is why nothing has
   to be published on the host.

The DNS record is created for you. If the hostname already points at the old
tunnel, the dashboard will offer to overwrite it — accept.

> The token is a credential in its own right: anyone holding it can run a
> connector for this tunnel and receive your traffic. Send it to that box the
> way you would send a password, and keep it in `.env`, which is gitignored.

**7. Stop the old tunnel first.** On the laptop:

```bash
docker compose stop tunnel
```

If both connectors run, Cloudflare has two healthy origins for one hostname and
will send traffic to whichever it likes — so roughly half of all requests would
land on a laptop that may be asleep. This is the single easiest way to make the
site look randomly broken.

**8. Switch `.env` to public mode** on the Windows box:

```ini
TUNNEL_TOKEN=eyJ...                     # from step 6
PUBLIC_URL=https://watch.abhigyanverma.com
COOKIE_SECURE=true
TRUST_CF_CONNECTING_IP=true
GATE_BIND=127.0.0.1                     # nothing but cloudflared reaches it now
```

All four changes go together. `TRUST_CF_CONNECTING_IP=true` is only safe
*because* of `GATE_BIND=127.0.0.1`; and `COOKIE_SECURE=true` is only correct
once traffic actually arrives over HTTPS.

**9. Bring the whole stack up, tunnel included.**

```powershell
docker compose up -d
```

**10. Check it.**

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://watch.abhigyanverma.com/login
docker compose logs tunnel --tail 40 | Select-String "Registered tunnel connection"
```

200, and at least one registered connection. If you get **error 1033** or a
**530**, the tunnel has not registered yet — give it two minutes. This network
can only reach one of Cloudflare's two edge regions at a time and cloudflared
has to time out the unreachable half first; see *If the tunnel will not
connect* above.

### Afterwards

**Adding films.** Drop them into `E:\Media\incoming`. The worker picks
up each file once its size has been stable across two polls, converts anything a
browser cannot direct-play, publishes the result into the library and
moves the original to `incoming\.processed`. Watch it with
`docker compose logs -f worker`.

### Keeping it up

- **Sleep is the enemy.** Set *Power & battery → Screen and sleep* to Never on
  both entries. A sleeping box is indistinguishable from a dead one to
  Cloudflare, and viewers get error 1033.
- **Auto-login.** Docker Desktop starts *when you log in*, not at boot. After an
  unattended reboot — a Windows update at 3am — nothing comes back until
  somebody signs in. Either enable auto-login (`netplwiz`, untick *Users must
  enter a user name and password*) or accept that reboots need a person.
- **Restart policy.** All four containers are `unless-stopped`, so once Docker
  is running they come back on their own. That does not help if a container was
  removed with `docker compose down` — then it needs `docker compose up -d`.
- **Firewall.** Nothing needs an inbound rule. The tunnel is outbound-only and
  the gateway is bound to loopback.

### Hardware transcoding: you do not get it here

Docker Desktop's WSL2 backend cannot pass an Intel or AMD render node through to
a container, so both Jellyfin and the ingest worker encode in software on this
box. That is a deliberate trade, not an oversight:

- **Playback is mostly unaffected.** The worker normalises everything to 1080p
  H.264 + AAC in MP4, which every browser direct-plays. No encoder runs at all
  for a normal viewing.
- **Ingest is slower.** A conversion that ran at several times realtime with
  VAAPI on the laptop will run at roughly 0.7–1x in software. A two-hour film
  therefore takes about two hours. The worker already stands down while anybody
  is streaming, so this costs patience rather than playback quality.

If ingest speed becomes the problem, convert on the laptop and copy the
finished files over, rather than trying to get GPU passthrough working under
WSL2.

### Backups

Two things matter and neither is the media:

- `gate-data` — the volume holding invites, sessions, watchlists and the
  curator's writing. `docker run --rm -v jellyfin-gate_gate-data:/d -v ${PWD}:/b busybox tar czf /b/gate-data.tgz -C /d .`
- `jellyfin-config` — users, library layout, playback positions.

Back up the `.db` file *and* its `-wal` sidecar, or stop the gate first. Copying
the `.db` alone while it is running gives you a database missing the most recent
commits.

---

## Layout

```
src/lib/
  env.ts          Validated environment. Refuses to boot on a weak admin key.
  db.ts           node:sqlite handle, WAL, boot migration, transaction helper.
  schema.ts       The schema, as a string constant.
  crypto.ts       Token generation, SHA-256, constant-time comparison.
  jellyfin.ts     Jellyfin REST client, admin and user scoped.
  invites.ts      Invite lifecycle. The atomic claim lives here.
  session.ts      Opaque sessions, cookie serialisation, sliding renewal.
  ratelimit.ts    In-memory sliding-window limiter.
  admin-auth.ts   X-Admin-Key gate.
  validation.ts   Request body parsing and account input rules.
  ip.ts           Client IP resolution and its caveats.
src/app/
  jf/[...path]/   The proxy.
  api/            Admin, auth and redemption routes.
  invite/[token]/ Redemption page.
middleware.ts     Cookie-presence redirect. Not an auth check — see the file.
scripts/init-db.mts  Standalone schema initialiser.
```

The security-sensitive reasoning is in comments next to the code it applies to:
the transaction boundary in `invites.ts` and `api/invite/redeem/route.ts`, the
constant-time comparison in `crypto.ts` and `admin-auth.ts`, and why the Jellyfin
token stays server-side in `session.ts` and `jf/[...path]/route.ts`.
