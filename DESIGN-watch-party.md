# Design: watch party

Not implemented yet — this is a scoping pass, not a spec ready to build
from. It's the largest single feature on the backlog (real-time sync,
chat, a new kind of session, notifications, home page, the player UI) and
per your own framing in the last handoff, deserves a design pass before
any code. Full spec from that handoff, preserved:

- Instant party: creator starts one, gets a shareable link; everyone else
  on the platform gets a notification that a party is happening.
- Scheduled party: shows on the home page, sends a notification at the
  scheduled time.
- Chat alongside the movie: side panel (video main/left, chat right),
  including in fullscreen — not just windowed. Also reachable as a
  separate browser tab, and via QR code/URL to open chat on a phone while
  watching on another device.
- Playback controls (pause/rewind) default to creator-only; creator grants
  them to specific participants via a three-dot menu in the participant
  list.
- Full sync on rejoin: dropping and rejoining lands you exactly where
  everyone else currently is.

## The one decision everything else depends on: how sync actually travels

This app is a single Next.js process built with `output: "standalone"`
(`next.config.ts`), run in production as `node server.js` — an
**auto-generated** file (`Dockerfile:56`, copied straight from
`.next/standalone/`, never hand-edited, overwritten every `next build`).
Next.js Route Handlers don't support WebSocket upgrades in any runtime;
getting real-time bidirectional sync means either replacing that
auto-generated entrypoint with a hand-written custom server, or running
sync as its own process. Two real options:

**A — custom server.ts, checked into the repo.** Write a server that
creates the HTTP server explicitly, hands normal requests to Next's
handler, and attaches a `ws` server on the same port for `/ws/party`
upgrades. Dockerfile's runtime stage changes to build and run this file
instead of the generated `server.js`. Single process, single container —
no new service in `docker-compose.yml`. Downside: it's a permanent fork
away from Next's own generated entrypoint, and every future
`output: standalone` upgrade risk (config changes, `next build` behavior)
now has a hand-maintained integration point to keep working.

**B — a small, separate `party` container**, same shape as `worker`
(`media-worker.mjs`) and `tunnel` already are in `docker-compose.yml` — a
plain Node process running `ws` (or `socket.io`), nothing Next.js about
it, added as its own service on the internal `edge` network. The gate app
stays exactly as it is today; this is additive, not a fork of its build.
Cloudflared already proxies arbitrary HTTP(S) to `http://gate:3000`
(`docker-compose.yml`'s `tunnel` service) — a second `ingress` rule
pointing `watch.example.com/ws/party` (or a dedicated path) at
`http://party:PORT` over the same tunnel needs no new DNS record, no new
port exposed to the internet, and cloudflared proxies WebSocket upgrades
transparently (it's a generic HTTP(S) proxy at the edge, nothing
WS-specific to configure beyond routing the path correctly) — **should**
work but hasn't been verified against this project's actual cloudflared
config (`cf/config.yml`, minted via `cloudflared tunnel login` per the
README) and is worth a five-minute smoke test before committing to this
path.

**Leaning B.** It matches how this codebase already isolates concerns
(worker does file processing, tunnel does networking, gate does the web
app) rather than making the main app's entrypoint a permanent departure
from what `next build` generates. It's also easier to reason about
failure: a `party` container crash-looping is exactly as visible and
independently restartable as `worker` or `tunnel` already are, and
doesn't threaten the site's actual pages.

## Auth for the party service

Every request today carries the `jfg_session` httpOnly cookie
(`src/lib/session.ts`), resolved by a DB lookup
(`getSessionFromRequest()`). The `party` service needs to turn that same
cookie into a userId on WebSocket connect. Two ways:

- **Shared DB read.** Mount the same SQLite file (already WAL-mode,
  already tuned for concurrent readers — `src/lib/db.ts`) read-only into
  the `party` container, and have it run the same session-lookup query
  itself. No network hop per connect. Given SQLite's single-writer model,
  this only works cleanly if `party` never writes to the *same* tables the
  gate app owns — but see below, it likely wants its own tables for chat
  history anyway, which is a different concern from reading `sessions`.
- **Validate via the gate app.** `party` calls an internal
  `/api/internal/session-check` route on `gate` (reachable over the
  `internal` compose network, never exposed past the tunnel) with the
  cookie value, gets back `{ userId, username }` or 401. Simpler mental
  model (one writer, one process that understands sessions), one extra
  hop per connect only, not per message.

Leaning toward the DB-read option for connect-time auth (cheap, no new
route) but keeping all party-owned data (chat messages, room membership,
control grants) in party-owned tables rather than writing into any table
`gate` already owns — same "who owns which write" discipline this schema
already follows (e.g. `library_group_overview` kept separate from
`library_groups` specifically so a rename can't risk it, per that table's
own comment in `schema.ts`).

## Data model sketch

Party state itself (who's connected, who's playing right now, who has
control) is inherently live/ephemeral — living in the `party` process's
memory is simplest and matches this app's scale (a personal server, not a
clustered service; a `party` container restart legitimately ending live
parties is an acceptable trade here). What needs to survive a reload or a
brief disconnect goes to SQLite, in tables `party` owns:

```sql
CREATE TABLE party_rooms (
  id           TEXT PRIMARY KEY,
  jellyfin_id  TEXT NOT NULL,          -- what's being watched
  creator_id   TEXT NOT NULL,
  scheduled_at INTEGER,                -- NULL = instant party
  started_at   INTEGER,
  ended_at     INTEGER,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE party_messages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE party_controllers (
  room_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
) STRICT;
```

"Full sync on rejoin" reads as: current `positionSeconds` + `paused`
tracked in the room's live memory state (not persisted — it changes many
times a second while playing), broadcast to a newly-connected socket
immediately on join. `party_messages` gives chat history on rejoin;
`party_controllers` gives the current control-grant list.

## Playback sync

`src/components/media/Player.tsx` already reports play/pause/progress to
Jellyfin's own Sessions API on an interval and on state-change events
(`onPlay`/`onPause`/the `PROGRESS_INTERVAL_MS` timer) — the same event
hooks are the natural place to also emit to the party socket. The new
work is the *receiving* side: a participant's player needs to apply a
remote "seek to X, now playing/paused" command without re-broadcasting it
as if the local viewer caused it (an echo loop). A simple
`suppressNextEmit` ref guarding one state-change cycle, set right before
`player.current.currentTime = ...` / `.play()`/`.pause()` calls driven by
an incoming socket message, mirrors the existing `seeded` ref pattern
already in `Player.tsx` for the resume-on-load case.

Drift correction: rather than trying to keep every participant's video
element frame-accurate (fragile over varying network/buffering
conditions), periodically reconcile — the controller's position broadcasts
every few seconds regardless of state-change events, and a participant
whose position has drifted more than ~2s snaps to match. Good enough for
"everyone's watching together," not frame-sync.

## Chat across three surfaces

The spec's three access paths — beside the player, a separate tab, and a
phone via QR/URL — all just need the same `/watch/[id]?party=roomId` (or
a dedicated `/party/[roomId]` route) chat panel to be a standalone
component that opens its own WebSocket connection to `party`,
independent of whether a `<Player>` is also mounted on the same page.
That falls out of the architecture above for free: the chat panel doesn't
care whether it's next to a video element or alone on a phone screen, it
only needs `roomId` + the session cookie.

**Fullscreen** is the one real wrinkle: the browser Fullscreen API
promotes exactly the element you call `requestFullscreen()` on (currently
`.player-stage`, per the `:fullscreen` CSS rules in `globals.css`) and
only *that element's own descendants* render in the fullscreen surface —
anything outside it, including a chat panel currently rendered as a
sibling, would vanish the moment fullscreen engages. Fix: during a watch
party, fullscreen a wrapper containing both `.player-stage` and the chat
panel (a CSS grid switching from side-by-side to the video filling most
of the space with chat as a docked column), not `.player-stage` alone —
and only reach for that wrapper when a party is actually active, so a
normal solo watch keeps fullscreening just the video like it does today.

## Permissions

Creator has playback control by default; `party_controllers` names anyone
else who's been granted it. The three-dot menu next to a name in the
participant list is a client-side affordance calling a `party`-owned
"grant control" message, which only the room's `creator_id` can send
(checked server-side in the `party` process — the client-side menu being
creator-only in the UI is a courtesy, not the actual enforcement).

## Notifications & home page

Reuses the notification system extended this session
(`src/lib/notifications.ts`) — two more kinds fit the same shape as
`new_show`/`new_episodes`:

- `watch_party_live`: fired once, to everyone, the moment an instant
  party starts (or a scheduled one's start time arrives) —
  `notifyAllUsers()`, same as `new_item`.
- A scheduled party additionally needs a tick (same shape as
  `runTvNotifyTick()`) that fires `watch_party_live` at `scheduled_at`
  and flips the room from "scheduled" to "started" — this is the one
  place watch party needs a `setInterval` loop registered in
  `src/instrumentation.ts` on the **gate** side (not `party`), since it's
  reading `party_rooms.scheduled_at` and calling the existing
  notification helper, not doing anything socket-related.

Home page (`src/app/page.tsx`) gets a banner for any `party_rooms` row
that's `started_at IS NOT NULL AND ended_at IS NULL` (live now) or
`scheduled_at` in the future (upcoming) — a straightforward query against
the new table, no new infra.

## What's deliberately left open

- Exact UI for the participant list / three-dot menu — a mockup pass,
  not a backend question.
- Whether a party can span episodes of a show (queue the next episode
  automatically) or is scoped to one `jellyfin_id` for its whole
  lifetime. Leaning toward one item per room for a first version —
  cross-episode continuity is a real feature but not needed to ship
  "watch this movie together."
- Rate limiting / abuse handling on chat — this is a private server for
  people you know, so probably not worth building before it's ever been a
  problem, but flagging it since nothing here currently addresses it.
- Whether `party` needs its own `Dockerfile` stage or can reuse the
  `worker`'s existing Node base image with a different `CMD` — a build
  detail, not a design one, but affects how much new Docker plumbing this
  costs to ship.
